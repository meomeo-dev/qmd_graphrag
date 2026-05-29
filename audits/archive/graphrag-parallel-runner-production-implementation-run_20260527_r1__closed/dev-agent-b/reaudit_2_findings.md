# GraphRAG 多书并行 Runner 生产实现 reaudit_2 发现

## 结论

复审状态：**fail**。

本轮只使用同目录 `criteria.md` 的 10 条固定基准。当前工作树已经闭合
`reaudit_1` 中若干关键缺口：同机 live coordinator 不再因锁过期被接管，
provider slot 已改为持久容量门（durable capacity gate），provider slot release
已有 generation/fencing 检查，book lease 覆盖了主要 repository mutator，
item checkpoint 写入有 CAS/fencing 检查，事件日志可恢复 partial tail 与重复
event id，qmd writer 命令也会获取 qmd index 文件锁。

但按固定生产基准（production baseline）逐条复核后，仍存在阻塞项。主要
未闭合面是：所有提交面尚未统一验证当前 item/book/provider fencing token，
durable write 缺 generation/checksum 与重启协调，瞬时失败耗尽仍保留为
pending retryable，crash/restart 对父进程死亡但子进程仍存活的风险没有
取消或隔离策略，事件日志重复 id 恢复不是稳定确定性恢复，manifest/status
尚未由 checkpoint 加已协调 event evidence 完整重建，测试覆盖仍低于固定
第 10 条基准。

## 已闭合或明显改善项

- Coordinator 接管保护已改善。`coordinatorLockLive()` 对同 host 且 pid
  存活的旧 coordinator 返回 live，即使 `expiresAt` 已过期也拒绝新协调器
  接管。证据：`scripts/graphrag/batch-epub-workflow.mjs:3091` 到 `3097`，
  测试 `rejects coordinator takeover when expired lock pid is still alive`。
- Provider slot 已有持久 lease 文件作为容量门。`acquireProviderSlotLease()`
  在 provider registry lock 下恢复 stale lease、统计 active durable lease，
  只有低于 limit 才写入新 lease。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2534` 到 `2583`，测试
  `durable provider slots gate capacity across concurrent workers`。
- Provider slot release 已有 fencing。`releaseProviderSlotLease()` 删除
  slot 文件前比较 `runnerSessionId`、`generation` 与 `fencingToken`，不匹配
  时写 `provider_slot_lease_release_rejected`。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2585` 到 `2629`。
- Book lease 覆盖扩大到 stage checkpoint、artifact、run catalog、document
  chunk 与 qmd corpus registration。证据：
  `src/job-state/repository.ts:1106` 到 `1141`、
  `src/job-state/repository.ts:1691` 到 `1731`、
  `src/job-state/repository.ts:2131` 到 `2230`；测试
  `rejects stage checkpoint writes with stale batch book lease fencing` 与
  `rejects artifact and run catalog writes with stale batch book lease fencing`。
- Item checkpoint 写入新增 CAS/fencing。`saveCheckpoint()` 在文件锁内读取
  current checkpoint，并由 `assertItemCheckpointFence()` 比较 runner、lease
  generation、item fencing token 与 book fencing token。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:3625` 到 `3683`。
- Event log 已有 `eventId`、`sequence`、`runnerSessionId`，并在启动时执行
  partial tail/duplicate id/sequence normalization。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2804` 到 `2829`、
  `scripts/graphrag/batch-epub-workflow.mjs:2987` 到 `3047`；测试
  `migrate-only recovers a partial event log tail` 与
  `migrate-only normalizes duplicate event ids`。
- qmd writer 命令会获取 qmd index file lock。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2354` 到 `2428`、
  `scripts/graphrag/batch-epub-workflow.mjs:6216` 到 `6255`；测试
  `qmd writer commands acquire the qmd index file lock`。

## 固定基准逐条判定

| 基准 | 判定 | 结论 |
| --- | --- | --- |
| 1. Durable single coordinator ownership | pass | 同机 live pid 接管缺口已闭合；远端过期锁仍是残余风险。 |
| 2. Item/book lease fencing for all commits | fail | qmd index、event、manifest/status 与 terminal event 尚未统一验证当前 fencing。 |
| 3. Provider concurrency at child boundary | pass | provider 子进程启动前已有 durable slot lease gate，release 也有 fencing。 |
| 4. Durable crash-recoverable writes | fail | 缺 generation/checksum validation 与 leftover temp/invalid target restart reconciliation。 |
| 5. Event logs authoritative audit trails | fail | duplicate id 恢复使用随机 id，未达到确定性恢复要求。 |
| 6. Manifest/status derived caches | fail | 计数会从 checkpoint 重算，但未从 reconciled event evidence 重建，也无 mismatch rebuild 证据。 |
| 7. Terminal completion evidence gated | fail | 完成 checkpoint/event 前未同时验证当前 item/book/provider leases。 |
| 8. Stable terminal/retry states | fail | transient/provider recovery exhaustion 仍保持 pending retryable。 |
| 9. Crash/restart live subprocess recovery | fail | 父进程死亡但同机子进程仍存活时未 kill/quarantine，远端 orphan 也只能标记。 |
| 10. Behavioral recovery tests | fail | 固定清单中的 duplicate book ids、manifest mismatch rebuild、SQLite busy、stale worker commit rejection、retry exhaustion 等仍缺行为级覆盖。 |

## Blocking Findings

### R2-B01: 所有提交面尚未统一执行当前 fencing 校验

影响基准：2、7、9。

当前实现已经为主要 checkpoint 与 repository mutator 加入 book lease/item
fencing，但固定基准要求 checkpoint、event、catalog、manifest、qmd index、
book artifact commit 都验证当前 fencing token。该要求仍未满足。

证据：

- `event()` 只写入 `coordinatorGeneration`，没有在 append `item_completed`
  或其他 item/book-scoped event 前读取并验证当前 item/book/provider lease。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:2804` 到 `2829`。
- terminal completion 在 `saveCheckpoint(...requireBookLease)` 后立即写
  `item_completed` event；checkpoint 和 event 不是同一个 fenced critical
  section，event 也没有 item/book/provider token 校验。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:6904` 到 `6930`。
- qmd index 的真实 DB 写入位于 `withQmdIndexFileLock()` 内，但 book lease
  校验发生在之后的 `repo.recordQmdCorpusRegistration()`。因此 qmd index
  DB commit 本身没有在写入前验证 batch book lease/fencing token。证据：
  `src/job-state/graphrag-book.ts:1015` 到 `1040`。
- GraphRAG resume 的 qmd-index-write stages 只包了 `qmdIndexWriterLane`
  semaphore；父进程没有包 `withQmdIndexFileLock()`。虽然子流程的
  `registerQmdCorpusDocument()` 会使用 file lock，固定基准要求的是每个
  qmd index commit 具备当前 fencing 校验，而当前 DB 写入前仍未验证。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:6400` 到 `6462`。

必须修复：

- 在所有 item/book-scoped commit 前统一验证当前 coordinator、item、book
  与需要时的 provider slot generation/fencing token。
- qmd index DB 写入必须在写入前验证当前 batch book lease/fencing token，
  不能只在后续 catalog registration 时验证。
- terminal completion 必须把 evidence validation、completed checkpoint、
  `item_completed` event 以及必要 manifest/status 更新纳入可证明的 fenced
  commit 顺序；至少 event append 必须拒绝 stale item/book lease。
- 增加 stale worker/stale lease 对 checkpoint、event、catalog、qmd index
  写入的拒绝测试。

### R2-B02: Durable write 协议仍缺 generation/checksum 与重启协调

影响基准：4、6。

当前 JSON/YAML/producer manifest 写入已大量改为 same-dir temp、fsync、
rename、parent fsync，这比上一轮明显改善。但固定第 4 条还要求
generation 或 checksum validation，以及 restart 时协调 leftover temp files
和 invalid targets。当前实现没有满足。

证据：

- runner `writeJsonAtomic()` 使用 temp、`writeFileDurable()`、rename、
  parent fsync，但目标内容没有 generation/checksum validation，也没有记录
  previous valid state。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2842` 到 `2848`。
- checkpoint 子进程中的 `writeJsonAtomic()` 同样没有 generation/checksum
  validation 与 restart reconciliation。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:3759` 到 `3780`。
- repository YAML 写入已经 durable rename，但没有 checksum/generation，
  也没有启动时清理或协调 `.tmp-*` 与 invalid target。证据：
  `src/job-state/repository.ts:388` 到 `409`。
- GraphRAG producer manifest 写入已 fsync temp 并 rename，但同样缺
  generation/checksum validation 与 leftover temp reconciliation。证据：
  `src/job-state/graphrag-book.ts:1429` 到 `1440`。
- `readTypedJsonIfExists()` 在 parse 失败时返回 null；这会把 invalid target
  当成缺失状态处理，而不是按 crash recovery 协议隔离、恢复或失败停机。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:2959` 到 `2965`。

必须修复：

- 为 checkpoint、manifest、catalog、lock、book state 与 producer manifest
  定义 generation/checksum 或等价校验字段。
- 启动时扫描并协调 same-dir temp files、invalid target、partial target，
  明确恢复、隔离或 fail closed。
- 对 parse failure 不应静默降级为 missing；需要 durable corruption event
  与可审计恢复路径。
- 增加崩溃注入或损坏文件恢复测试，覆盖 temp leftover、invalid JSON/YAML、
  checksum mismatch 与 generation regression。

### R2-B03: Transient retry exhaustion 仍会停留在 pending retryable

影响基准：8、10。

固定第 8 条要求 transient provider failure 持久化 `nextRetryAt`、retry
budget、recovery decision，并在 retry budget 耗尽后进入 deterministic
excluded state，而不是继续作为 runnable pending work 循环。当前仍未满足。

证据：

- batch item status enum 仍只有 `pending`、`running`、`skipped`、
  `completed`、`failed`，没有 excluded/retry-exhausted terminal state。
  证据：`src/contracts/batch-run.ts:9` 到 `15`。
- `eventProviderRecoveryWaitLimit()` 将 wait limit 后的 checkpoint 保持为
  `retryExhausted: false` 与 `recoveryDecision: "retry_same_run_id"`，并
  保留 pending/retryable 语义。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:7104` 到 `7150`。
- `handleRunItemFailure()` 在 provider recovery wait limit 达到时也持久化
  `status: "pending"`、`retryable: true`、`retryExhausted: false`。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:7293` 到 `7363`。
- 现有测试仍包含对 `item_retry_exhausted` 不存在的断言，说明测试基线没有
  要求 exhausted excluded state。证据：
  `test/cli.test.ts:3064` 到 `3074`。

必须修复：

- 定义 deterministic excluded state。可以是明确的新状态，也可以是
  `failed` + `retryable: false` + `retryExhausted: true` + 可区分的
  recovery decision，但不得继续被调度器当作 runnable pending。
- provider recovery wait limit 与 command attempt exhaustion 必须持久化
  exhausted decision、预算耗尽证据和不可继续本轮调度的状态。
- 增加行为测试验证 exhausted transient item 不再进入 worker candidates，
  status/manifest/recovery-summary 也稳定反映 excluded/terminal 状态。

### R2-B04: Crash/restart 对 live orphan subprocess 的处理仍不安全

影响基准：9、10。

当前 coordinator lock 能防止同机 live coordinator 被过期锁接管，也有
subprocess registry。但固定第 9 条要求 restart 检测 expired running work、
扫描或记录 subprocess registry、取消或隔离 orphan process groups，并阻止
stale workers 在 takeover 后提交。当前实现仍有 live subprocess 风险。

证据：

- `recoverCoordinatorRuntimeArtifacts()` 只在 subprocess record 属于远端
  host 或本机 pid 已死亡时把记录标记为 `killed`。如果旧 coordinator 父进程
  已死亡，但同机子进程仍存活，条件不成立，既不 kill，也不 quarantine。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:3058` 到 `3088`。
- 对远端 subprocess record，当前代码会直接标记为 `killed`，但没有能力
  实际取消远端进程，也没有进入 quarantine/stop_until_fixed；这会让审计状态
  高估恢复效果。证据同上。
- provider slot recovery 会在 lease 过期或同机 runner pid 死亡时删除 slot，
  但若旧子进程仍存活，它仍可能继续执行外部 provider 或本地 qmd index 写入。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:2163` 到 `2175`。
- stale child 对 repository 写入大多会被 book lease 拒绝，但 qmd index DB
  写入前未验证 book lease，见 R2-B01，仍留有 takeover 后 stale child commit
  风险。

必须修复：

- subprocess registry 必须记录 process group，并在 parent dead takeover 时
  对同机 live child 执行 kill/terminate 或进入 explicit quarantine。
- 对远端 live/unknown subprocess 不应标记为已 killed；应保留 quarantine
  状态、阻止新 worker 覆盖同一 book/item，或要求人工/外部协调确认。
- stale worker 在 takeover 后的 checkpoint、event、catalog、qmd index、
  provider release 路径必须全部被 fencing 拒绝。
- 增加 coordinator crash/restart 行为测试，覆盖 parent dead + child live、
  stale child commit rejection、remote orphan quarantine。

### R2-B05: Event log duplicate recovery 不是确定性恢复

影响基准：5。

固定第 5 条要求 event log 对 partial tail 与 duplicate ids 做 deterministic
recovery。当前实现能把重复 event id 正规化成唯一 id 并重排序列，但使用
随机 token 替换重复 id，因此同一损坏输入在不同恢复运行中不会得到相同
event ids。

证据：

- `normalizeEventLogLines()` 对 duplicate/missing event id 调用
  `randomToken("evt-recovered")`。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2987` 到 `3027`。
- `migrateEventLog()` 对 duplicate/missing event id 调用
  `randomToken("evt-migrated")`，随后重排 sequence。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:5653` 到 `5768`。

必须修复：

- duplicate id 恢复应使用稳定规则，例如基于 run id、原始行号、原 event id、
  原 sequence 和内容 hash 派生 recovered event id。
- 恢复过程应写入可审计 diagnostic event，说明重复项、保留项、替换项和
  sequence normalization 结果。
- 增加测试验证同一 duplicate event log 输入重复恢复得到相同输出。

### R2-B06: Manifest/status 仍不是完整 derived cache

影响基准：6、10。

`updateManifest()` 会从 checkpoint 数组重算 `pendingItems`、`runningItems`、
`completedItems`、`skippedItems`、`failedItems`，这是正确方向。但固定第 6 条
要求 manifest/status 从 durable checkpoints 加 reconciled event evidence
派生，且 manifest mismatch 必须 rebuild 而非信任。当前只满足其中一部分。

证据：

- `loadManifest()` 仍先 parse 既有 manifest，再原地覆盖部分 locator、配置
  和总量字段；若 manifest 文件损坏或 schema invalid，没有 rebuild 路径。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:3354` 到 `3383`。
- `updateManifest()` 的计数来自 checkpoint 数组，但没有读取 normalized
  event log evidence，也没有 mismatch detection/rebuild diagnostic。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:5366` 到 `5428`。
- `activeBookLeases` 使用 book lease JSON 文件数量，不区分 expired/stale 与
  live lease。证据：`scripts/graphrag/batch-epub-workflow.mjs:5393` 到 `5395`。
- 未发现 manifest mismatch rebuild 行为测试。

必须修复：

- status/manifest 生成应显式从 durable checkpoints 与 normalized event log
  evidence 派生，不信任旧 manifest 的状态与计数。
- schema invalid 或 count/status mismatch 时应 rebuild 或 fail closed，并写
  `manifest_rebuilt`/等价 recovery event。
- live counters 应过滤 stale/expired lease 与 subprocess record。
- 增加 manifest mismatch rebuild、invalid manifest recovery、status count
  derivation 测试。

### R2-B07: 行为级测试仍低于固定第 10 条基准

影响基准：10。

本轮新增/通过的 focused tests 覆盖了部分高风险路径：live coordinator takeover
拒绝、durable provider slot capacity、book-concurrency worker pool、partial
event tail、duplicate event id normalization、book lease stale rejection、
contract envelope 和 qmd index file lock。但固定第 10 条列出的行为清单仍未
全部覆盖。

仍缺或不足的测试：

- duplicate book ids 在多书 worker pool 下的 durable book lease 互斥与
  去重行为。
- provider slot release fencing 的负向测试，即 stale generation/token release
  必须被拒绝且不能删除当前 slot。
- manifest mismatch rebuild 与 invalid manifest fail/rebuild。
- stale worker commit rejection，覆盖 checkpoint、event、catalog、artifact、
  qmd index commit。
- SQLite busy handling 或 qmd index contention 的真实 DB 层行为；当前未发现
  `busy_timeout`、`SQLITE_BUSY` 或等价测试。
- retry exhaustion 进入 deterministic excluded state，并且不再被 worker
  pool 调度。
- coordinator crash/restart 下 parent dead + child live 的 kill/quarantine。
- durable write crash recovery，覆盖 leftover temp 与 invalid target。

必须修复：

- 按固定第 10 条把上述场景补成行为级测试，避免只检查 token/string 存在。
- 测试应断言状态文件、event log、manifest/status、process/subprocess
  registry、provider slot registry 与 qmd index side effect 的实际行为。

## Residual Risks

- 远端 coordinator lock 过期后的接管仍依赖 expiry，无法验证远端 pid 活性。
  单机运行下风险较低；多主机共享 state root 下仍需要额外 fencing/quarantine
  策略。
- qmd index file lock 已能串行化 writer commands，但 DB 层没有看到
  SQLite busy/backoff 证据。file lock 不能替代所有 SQLite busy 场景测试。
- `status-json` 路径会进行内存态 recovery projection 但不写 event log；这是
  可接受的只读行为，但需要保证用户不会把它误认为已持久化修复。

## 审计结论

当前实现已显著接近生产可靠性要求，但仍未满足固定基准。按 `criteria.md`
逐条复审，`reaudit_2` 结论为 **fail**。必须先修复 R2-B01 到 R2-B07，并补齐
对应行为测试后，才可按本固定基准进入 pass 判定。
