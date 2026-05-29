# GraphRAG 多书并行 Runner 生产实现 reaudit_3 发现

## 结论

复审状态：**fail**。

本轮只使用同目录 `criteria.md` 的 10 条固定基准，并基于当前工作树做只读
实施复审。相比 `reaudit_2`，当前实现已经关闭多项阻塞缺口：

- coordinator lock 的拒绝路径先 `acquireCoordinatorLock()`，后
  `reconcileDurableRunFiles()`，第二 coordinator fail-closed，不会先写事件
  或补 checksum。
- provider slot 使用 durable lease 容量门、stale recovery 和 release
  generation/fencing。
- book lease 与 item checkpoint CAS/fencing 覆盖明显增强，repository 主要
  book-scoped writer 已有 batch book lease 检查。
- event log duplicate id/sequence normalization 已改成稳定 token 派生，并写
  normalization diagnostics。
- manifest/status 计数会从 durable checkpoints 重算，mismatch 会写
  `manifest_rebuilt`。
- transient provider recovery wait limit 在正常运行中会进入 failed +
  `stop_until_fixed`，不再保持 runnable pending。
- remote/live orphan subprocess 已有 quarantine/termination 策略。

但按固定 10 条生产基准全量复核后，仍有阻塞项。当前未满足点集中在：
terminal completion 的 fenced commit、qmd index DB 写入前的 book lease
fencing、durable write 协议对 YAML/book state/GraphRAG sidecar 的覆盖，以及
第 10 条固定测试清单中仍缺行为级覆盖。

## 固定基准逐条判定

| 基准 | 判定 | 结论 |
| --- | --- | --- |
| 1. Durable single coordinator ownership | pass | lock 含 session/pid/heartbeat/expiry/generation/fencing；同机 live pid 拒绝接管；拒绝路径 fail-closed。 |
| 2. Item/book lease fencing for all commits | fail | terminal event 与 qmd index DB commit 仍未证明在写入前验证当前 item/book/provider fencing。 |
| 3. Provider concurrency at child boundary | pass | provider subprocess 启动前通过 durable slot lease gate；release 与 stale recovery 可观测。 |
| 4. Crash-recoverable durable writes | fail | runner JSON 已有 checksum/reconcile；repository YAML/book state 与 GraphRAG sidecar JSON 仍缺 checksum/generation 与 restart reconciliation。 |
| 5. Event logs authoritative audit trails | pass | eventId/sequence/runnerSessionId、append fsync、partial tail 和 duplicate id deterministic normalization 已具备。 |
| 6. Manifest/status derived caches | pass | manifest/status 从 checkpoint 重算，mismatch 写 `manifest_rebuilt`；事件日志 normalization 先于 manifest 更新。 |
| 7. Terminal completion evidence gated | fail | qmd/GraphRAG/query evidence 有 gate，但 completed checkpoint 与 `item_completed` event 前缺 current provider lease/terminal event fence。 |
| 8. Stable terminal/retry states | pass | 正常运行 provider wait limit 会落为 failed + `stop_until_fixed` + `retryExhausted:true`；status-json legacy 投影列残余风险。 |
| 9. Crash/restart live subprocess recovery | pass | 同机 orphan child 尝试终止，远端 unknown subprocess quarantine 并 stop current run。 |
| 10. Behavioral recovery tests | fail | 新增测试覆盖多项，但仍缺 SQLite busy、stale worker commit rejection、durable write recovery 等固定清单行为。 |

## 已验证闭合项

- `main()` 在非 status 模式下先 `acquireCoordinatorLock()`，再
  `reconcileDurableRunFiles()`、`recoverEventLogTail()` 和写
  `coordinator_lock_acquired`。第二 coordinator 被拒绝时不会写事件或补
  `.sha256`。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:8132` 到 `8158`；测试断言：
  `test/cli.test.ts:2281` 到 `2442`。
- `coordinatorLockLive()` 对同 host live pid 返回 live，过期锁不能绕过活性
  检查。证据：`scripts/graphrag/batch-epub-workflow.mjs:3337` 到 `3343`。
- provider slot durable gate 在 registry lock 内恢复 stale lease、统计
  active durable leases、低于 limit 才写新 lease；release 会比较
  `runnerSessionId`、`generation`、`fencingToken`。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2573` 到 `2665`。
- book lease acquire/refresh/release 含 generation/fencing，active book lease
  统计已过滤 live lease。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2205` 到 `2305`。
- item checkpoint 写入在文件锁内读取 current checkpoint，并执行
  `assertItemCheckpointFence()`。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:3912` 到 `3970`。
- repository 主要 stage checkpoint、artifact、run catalog 和 book job writer
  调用 `assertBatchBookLease()`。证据：
  `src/job-state/repository.ts:1106` 到 `1141`、
  `src/job-state/repository.ts:1768` 到 `1788`、
  `src/job-state/repository.ts:2131` 到 `2253`、
  `src/job-state/repository.ts:2958` 到 `3051`。
- event log normalization 使用 `stableRecoveredToken()` 和内容 hash 派生
  recovered event id，并写 `event_log_normalized` diagnostics。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:3148` 到 `3247`、
  `scripts/graphrag/batch-epub-workflow.mjs:5969` 到 `6128`。
- provider wait limit 在正常运行中写 failed terminal retry state。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:7463` 到 `7516`、
  `scripts/graphrag/batch-epub-workflow.mjs:7676` 到 `7744`；测试：
  `test/cli.test.ts:4657` 到 `4789`。
- remote orphan subprocess 会 quarantine 并 stop current run；同机 parent dead
  live child 会尝试 SIGTERM/SIGKILL。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:3258` 到 `3335`；测试：
  `test/cli.test.ts:2675` 到 `2757`。

## Blocking Findings

### R3-B01: terminal completion 仍不是完整 fenced commit

违反基准：2、7、9。

证据：

- `event()` 只在 `payload.itemId` 存在且 event status 不是 `running` 时调用
  `assertEventItemFence()`；但 `assertEventItemFence()` 读取 current checkpoint
  后，如果 current status 已不是 `running` 就直接返回。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2843` 到 `2846`、
  `scripts/graphrag/batch-epub-workflow.mjs:2880` 到 `2887`。
- `runItem()` 先写 completed checkpoint，再追加 `item_completed` event。由于
  completed checkpoint 已清除 running fence 字段，`item_completed` event
  不再验证当前 item/book fence。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:7263` 到 `7289`。
- fixed criterion 7 明确要求 completed item 在 completed checkpoint 和
  `item_completed` event 持久化前具备 current item/book/provider leases。当前
  terminal event 没有 provider slot lease 校验，且 terminal completion 时
  provider slots 通常已在各 command wrapper 结束时释放。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2680` 到 `2688`、
  `scripts/graphrag/batch-epub-workflow.mjs:7285` 到 `7289`。

为什么仍阻塞：

completed checkpoint 受 book lease 与 item CAS 保护，但 terminal event 是
最终审计轨迹的一部分；若 stale worker 在 checkpoint/event 之间或 takeover
边界提交 event，当前 `event()` 不能拒绝该 completed terminal event。provider
lease 也没有作为 terminal evidence gate 的当前凭证被验证。

建议修复方向：

- terminal completion 应在同一个 fenced finalization path 中验证 current
  item lease、book lease 和相关 provider lease/generation evidence。
- `item_completed` event append 必须显式带上并校验 finalization 前读取到的
  item/book fencing token，而不是依赖 current checkpoint 仍为 `running`。
- 增加 stale worker terminal event rejection 测试，覆盖 checkpoint 已完成后
  stale event 不能追加的场景。

### R3-B02: qmd index DB 写入前仍未验证 batch book lease/fencing

违反基准：2、7、9。

证据：

- `registerQmdCorpusDocument()` 在 `withQmdIndexFileLock()` 内打开 qmd index
  并执行 `upsertStoreCollection()`、`insertContent()`、`insertDocument()`；
  这些 DB 写入发生在 `repo.recordQmdCorpusRegistration()` 之前。证据：
  `src/job-state/graphrag-book.ts:1015` 到 `1045`。
- `repo.recordQmdCorpusRegistration()` 会通过
  `assertBatchBookLeaseForDocument()` 验证 book lease，但这是 DB 写入后的
  catalog registration gate，不能保护 qmd index DB commit 本身。证据：
  `src/job-state/repository.ts:1144` 到 `1175`。
- GraphRAG resume 的 qmd-index-write stage 由父进程的 qmd index writer lane
  和子进程内 file lock 串行化，但未看到 DB 写入前验证 batch book lease。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:6417` 到 `6423`、
  `src/job-state/graphrag-book.ts:1015` 到 `1045`。

为什么仍阻塞：

criteria 2 要求 qmd index commit 验证当前 fencing token。file lock 解决并发
写互斥，不等于 batch ownership fencing。stale worker 可在失去 book lease 后
进入 qmd index file lock 并写 DB，然后才在 repository catalog registration
处失败，留下 qmd index side effect。

建议修复方向：

- 在 `withQmdIndexFileLock()` callback 内、任何 DB mutation 前调用与
  `assertBatchBookLeaseForDocument()` 等价的 book lease/fencing check。
- 将 qmd index DB 写入和 qmd corpus registration 组织为可审计的 fenced
  sequence；失败时不能留下未授权 DB side effect。
- 增加 stale book lease 下 qmd corpus DB write 被拒绝且 index 未变更的测试。

### R3-B03: durable write 协议未覆盖 repository YAML/book state 与 GraphRAG sidecar

违反基准：4、6。

证据：

- runner JSON 已有 `.sha256`、temp reconcile、invalid target quarantine。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:2915` 到 `3008`。
- repository YAML 写入只做 same-dir temp、file fsync、rename、parent fsync；
  未写 checksum/generation，也没有启动时 reconciliation YAML temp 或 invalid
  target 的逻辑。证据：`src/job-state/repository.ts:388` 到 `420`。
- repository YAML 读取在 schema/YAML parse 出错时直接抛出，只有 `ENOENT`
  fallback；没有 quarantine/rebuild/recover。证据：
  `src/job-state/repository.ts:324` 到 `339`。
- GraphRAG sidecar/producer JSON 写入 `writeJsonFileDurable()` 只有 temp +
  fsync + rename + parent fsync，没有 checksum/generation，也没有 restart
  reconciliation。证据：`src/job-state/graphrag-book.ts:1429` 到 `1440`。
- `migrateGraphOutputProducerManifests()` 仍直接 `writeFileSync()` 修改
  `qmd_output_manifest.json`，绕过 durable helper。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:5020` 到 `5024`。

为什么仍阻塞：

fixed criterion 4 要求 checkpoint、manifest、catalog、lock、book state writes
都使用 temp/fsync/rename/parent fsync 以及 generation/checksum validation，并
在 restart 时协调 leftover temp 和 invalid targets。当前只覆盖 runner JSON
状态面，book state/catalog YAML 与 GraphRAG producer sidecar 仍不满足。

建议修复方向：

- 为 repository YAML/book state 写入增加 checksum 或 generation sidecar，并在
  repository 初始化/读取前协调 `.tmp-*`、checksum mismatch 和 invalid YAML。
- 为 GraphRAG producer/identity sidecar JSON 增加 checksum 与 restart
  reconciliation，或纳入 runner 的 durable reconciliation 扫描。
- 替换 `migrateGraphOutputProducerManifests()` 的直接 `writeFileSync()` 为同等
  durable write helper。
- 增加 leftover temp、checksum mismatch、invalid YAML/JSON 的行为测试。

### R3-B04: 固定第 10 条行为级测试仍未完全覆盖

违反基准：10。

证据：

- 当前 focused tests 覆盖了 coordinator live lock、provider slot capacity、
  provider release metadata、worker pool、partial JSONL recovery、duplicate
  event id normalization、qmd writer lock、provider wait limit、remote orphan
  quarantine 和 manifest rebuild。
- 未发现 `SQLITE_BUSY`、`busy_timeout`、`database is locked` 或 SQLite busy
  行为测试。`rg` 在 `src`、`scripts` 和测试中没有命中相关实现/测试。
- 未发现 stale worker commit rejection 的行为测试，尤其是 terminal event、
  qmd index DB commit 与 catalog/artifact 在 takeover 后的负向场景。
- `provider slot stale release cannot delete the current durable slot` 当前只断言
  正常运行没有 release rejection 且 release event 含 generation/fencing；
  没有构造 stale generation/token 去证明 stale release 不能删除当前 slot。
  证据：`test/cli.test.ts:2653` 到 `2673`。
- 未发现 durable write recovery 测试覆盖 checksum mismatch、leftover temp 或
  invalid YAML/JSON target。

为什么仍阻塞：

criteria 10 要求测试覆盖并发 claim、duplicate book ids、provider slot limits、
status count derivation、manifest mismatch rebuild、partial JSONL recovery、
stale worker commit rejection、SQLite busy handling、retry exhaustion、
coordinator crash/restart sequences。当前覆盖已有进展，但固定清单中多个
高风险行为仍缺失，且与 R3-B01 到 R3-B03 的未闭合实现面重合。

建议修复方向：

- 补齐 SQLite busy/qmd index contention 行为测试。
- 增加 stale worker commit rejection 测试，至少覆盖 checkpoint、terminal
  event、qmd index DB write、artifact/catalog write。
- 对 provider slot release fencing 增加负向测试：旧 token/generation release
  被拒绝且当前 slot 文件仍存在。
- 增加 durable write crash recovery 测试：runner JSON、repository YAML、
  GraphRAG sidecar temp/checksum/invalid target。

## 残余非阻塞风险

- `status-json projects exhausted transient failures as provider recovery wait` 仍将
  legacy exhausted transient 投影为 pending/retryable，不写 durable state。
  正常运行路径已会落为 failed/stop_until_fixed，因此列为 status projection
  语义风险。证据：`test/cli.test.ts:4489` 到 `4655`。
- 远端 coordinator 活性仍无法本机验证；当前策略是过期后接管并 quarantine
  remote subprocess。多主机共享 state root 仍需要运维层明确单 writer 主机或
  外部 fencing。
- qmd index file lock 串行化 writer 命令，但不等同 SQLite busy/backoff 策略。
  在非 batch 入口或外部 qmd 写入同时发生时仍需额外策略。

## 审计结论

`reaudit_3` 结论为 **fail**。当前实现已经关闭 `reaudit_2` 中多数阻塞项，但
固定基准仍要求所有提交面拥有当前 fencing、所有 durable state 面拥有
generation/checksum 和 restart reconciliation、以及第 10 条行为级测试全覆盖。
在 R3-B01 到 R3-B04 修复前，不能按该固定基准判定为 pass。
