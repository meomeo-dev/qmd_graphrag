# GraphRAG 多书并行 Runner 生产实现复审发现

## 结论

复审状态：**fail**。

当前实现已经补入 coordinator lock、book lease、provider slot lease、
eventId/sequence、subprocess registry 与部分 fsync 写入，较首轮实现明显前进。
但按本目录 `criteria.md` 的 10 条固定基准逐条检查后，生产不变量仍未闭合。
主要缺口不再是字段完全缺失，而是 durable authority（持久权威）仍被分散在
内存 semaphore、非 fenced 仓库写入、弱接管逻辑和未覆盖测试之间。

## 固定基准逐条复审

### 1. Single coordinator ownership is durable

判定：**fail**。

实现新增 `coordinator-lock.json`，并在启动时拒绝未过期且同 host pid 存活的
coordinator。证据见 `scripts/graphrag/batch-epub-workflow.mjs:212`、
`2764` 到 `2779`。

阻塞问题是 takeover guard（接管保护）不满足基准。`coordinatorLockLive()`
在 `expiresAt` 过期时直接返回 false，随后新 coordinator 可获取锁，即使旧
coordinator pid 仍存活。证据见
`scripts/graphrag/batch-epub-workflow.mjs:2737` 到 `2741`。
`recoverCoordinatorRuntimeArtifacts()` 在获得新锁后才运行，且对同 host
仍存活的旧 subprocess/provider slot 不终止、不隔离、也不进入
`stop_until_fixed`。证据见 `2688` 到 `2735`。

这违反“过期后仍需 liveness reconciliation（活性协调）和接管规则”的要求。

### 2. Item and book ownership use lease fencing

判定：**fail**。

实现新增 book lease 文件和 item checkpoint lease 字段。证据见
`scripts/graphrag/batch-epub-workflow.mjs:2131` 到 `2234`、
`6541` 到 `6611`。

阻塞问题有三类：

- item checkpoint 写入没有验证当前磁盘 checkpoint 的 item fencing token。
  `saveCheckpoint()` 只验证 book lease 或 coordinator lease，不读取当前
  item checkpoint 并比较 `fencingToken`、`leaseGeneration`、`runnerSessionId`
  与 `expiresAt`。证据见 `scripts/graphrag/batch-epub-workflow.mjs:3244`
  到 `3280`。
- book-scoped writer 只局部验证。`FileBookJobStateRepository.writeStageCheckpoint`
  调用 `assertBatchBookLease()`，但 `recordArtifacts()`、`appendRunRecord()`、
  `registerBookSource()`、producer manifest 写入和 catalog 改写路径没有等价
  fencing。证据见 `src/job-state/repository.ts:2066` 到 `2147`、
  `2156` 到 `2185`、`src/job-state/graphrag-book.ts:1382` 到 `1425`。
- `assertBatchBookLease()` 在环境变量缺失时直接返回，普通仓库调用可绕过
  batch book lease。证据见 `src/job-state/repository.ts:1081` 到 `1096`。

因此，checkpoint、event、catalog、manifest、qmd index 和 book artifact
commit 并未全部验证当前 fencing token。

### 3. Provider concurrency is enforced at the child-process boundary

判定：**fail**。

实现会在启动 provider 子进程前写 provider slot lease，并把 slot 诊断字段传入
子进程环境。证据见 `scripts/graphrag/batch-epub-workflow.mjs:2273` 到
`2354`、`5597` 到 `5645`。

阻塞问题是 durable slot 文件不是并发权威（concurrency authority）。
实际容量控制仍由 `AsyncSemaphore.active` 内存计数决定，`writeProviderSlotLease()`
只在内存 semaphore 通过后创建文件，不按 durable active slot 计数做 CAS
或拒绝。证据见 `scripts/graphrag/batch-epub-workflow.mjs:2016` 到
`2087`、`2273` 到 `2297`。如果 coordinator 过期接管或多进程异常并存，
新进程的 semaphore 从 0 开始，不能以 slot lease registry 限流。

此外，slot release 直接 `rmSync()`，没有校验当前 slot generation/fencing token。
证据见 `scripts/graphrag/batch-epub-workflow.mjs:2317` 到 `2335`。子进程也
只是接收环境变量，没有一个 provider proxy 或 request-level gate 能阻止真实
API 请求绕过 slot lease。

### 4. Durable writes are crash recoverable

判定：**fail**。

runner 侧 JSON 写入已有 temp file、fsync、rename、parent fsync。证据见
`scripts/graphrag/batch-epub-workflow.mjs:2002` 到 `2014`、`2544` 到 `2550`。

但固定基准要求 checkpoint、manifest、catalog、lock、book state 全部具备
same-dir temp、file fsync、atomic rename、parent fsync、generation/checksum
校验，并在 restart 时协调 leftover temp/invalid target。当前仍不满足：

- JSON 文件没有 generation 或 checksum 内容校验，也没有上一有效版本回退。
- `migrateEventLog()` 直接 `writeFileSync()` 重写 event log，没有 durable
  replace 协议。证据见 `scripts/graphrag/batch-epub-workflow.mjs:5351`
  到 `5355`。
- `migrateGraphOutputProducerManifests()` 直接 `writeFileSync()` 写 producer
  manifest。证据见 `scripts/graphrag/batch-epub-workflow.mjs:4332` 到 `4333`。
- repository YAML 写入只 `writeFile(temp) + rename`，没有 file fsync、
  parent fsync、generation/checksum。证据见 `src/job-state/repository.ts:387`
  到 `396`。
- GraphRAG output producer manifest 仍直接 `writeFile()`。证据见
  `src/job-state/graphrag-book.ts:1382` 到 `1425`。

未发现 restart 时清理 leftover temp、拒绝 invalid generation/checksum 或从
previous valid state 恢复的实现。

### 5. Event logs are authoritative audit trails

判定：**fail**。

event schema 已新增 `eventId`、`sequence`，追加路径有文件锁和 fsync。证据见
`scripts/graphrag/batch-epub-workflow.mjs:643` 到 `664`、`2506` 到 `2531`。
partial JSONL tail 有恢复事件。证据见 `2650` 到 `2677`。

但 event log 仍未达到 authoritative audit trail（权威审计轨迹）标准：

- 没有 duplicate `eventId` 或 duplicate `sequence` 的确定性恢复。
- `recoverEventLogTail()` 遇到第一个非法行即截断后续内容，并未证明只恢复
  partial tail，也没有 duplicate diagnostics。证据见
  `scripts/graphrag/batch-epub-workflow.mjs:2650` 到 `2668`。
- `migrateEventLog()` 会解析所有行并直接重写文件；若非 migrate 前恢复路径
  不完整，仍可能因坏行或重复序列破坏审计链。证据见 `5248` 到 `5355`。

### 6. Manifest and status are derived caches

判定：**partial/fail**。

`updateManifest()` 会从 checkpoint 数组重算 completed、pending、running、
skipped、failed 等计数，这符合 derived cache（派生缓存）方向。证据见
`scripts/graphrag/batch-epub-workflow.mjs:4963` 到 `5025`。

但实现没有完整满足固定基准：

- 不比较已加载 manifest 与 checkpoint/event 派生结果，也不记录
  `manifest_rebuilt`。证据见 `loadManifest()` 与 `updateManifest()`：
  `scripts/graphrag/batch-epub-workflow.mjs:2999` 到 `3028`、`4963` 到 `5025`。
- status/manifest 没有从“durable checkpoints plus reconciled event evidence”
  重建；event evidence 没有参与 checkpoint 重建或 mismatch 诊断。
- `activeBookLeases` 使用 JSON 文件数量，未过滤过期 lease。证据见
  `scripts/graphrag/batch-epub-workflow.mjs:4973` 到 `4992`。

### 7. Terminal completion is evidence gated

判定：**fail**。

qmd command checks、GraphRAG stage evidence、producer lineage 与 query evidence
已有终态前检查。证据见 `scripts/graphrag/batch-epub-workflow.mjs:6273` 到
`6375`、`6422` 到 `6476`。

阻塞问题是 finalization（终态提交）没有 fenced transaction：

- `runItem()` 在验证后写 item checkpoint，再追加 `item_completed` event；
  没有按固定顺序完成 book checkpoint、item checkpoint、event、manifest/status
  的 fenced critical section。证据见
  `scripts/graphrag/batch-epub-workflow.mjs:6477` 到 `6504`。
- `saveCheckpoint()` 对 completed checkpoint 只因 `requireBookLease: true`
  验证 book lease，不验证当前 item fencing token，也不验证 provider slot
  generation。证据见 `scripts/graphrag/batch-epub-workflow.mjs:3244` 到 `3280`。
- GraphRAG producer manifest 与 artifact catalog 写入仍可能在未 fenced 的
  子进程/仓库路径中完成。证据见 `src/job-state/graphrag-book.ts:1382`
  到 `1425`、`src/job-state/repository.ts:2066` 到 `2185`。

### 8. Failure classification leads to stable terminal or retry states

判定：**fail**。

永久失败（non-transient failure）可写入 `failed` 与 `stop_until_fixed`。
但 transient retry exhaustion（瞬时失败重试耗尽）没有进入固定基准要求的
稳定排除状态。

证据：

- checkpoint status enum 仍只有 `pending`、`running`、`skipped`、`completed`、
  `failed`，没有 `failed_retry_exhausted`。证据见
  `src/contracts/batch-run.ts:9` 到 `15`。
- provider recovery wait limit 仍把 item 保持为 `pending`、`retryable: true`、
  `retryExhausted: false`、`recoveryDecision: "retry_same_run_id"`。证据见
  `scripts/graphrag/batch-epub-workflow.mjs:6638` 到 `6695`、`6819` 到 `6889`。
- 测试也断言 wait limit 后仍是 pending/retryable/retryExhausted false。证据见
  `test/cli.test.ts:4363` 到 `4380`。

这违反“exhausted retry budgets must reach deterministic excluded state”的要求。

### 9. Crash and restart recovery handles live subprocess risk

判定：**fail**。

实现新增 subprocess registry，并在 timeout 时尝试 kill process group。证据见
`scripts/graphrag/batch-epub-workflow.mjs:5467` 到 `5595`。

阻塞问题仍存在：

- coordinator takeover 对 expired lock 但 live old pid 的情况不停止，也不
  `stop_until_fixed`。证据见 `scripts/graphrag/batch-epub-workflow.mjs:2737`
  到 `2779`。
- `recoverCoordinatorRuntimeArtifacts()` 对同 host 仍存活的旧 subprocess 不 kill、
  不 quarantine，也不阻止新 writer。证据见 `2688` 到 `2735`。
- non-transient fail-fast 或 provider auth stop 后，worker pool 不取消已运行的
  sibling workers；它只停止继续 launch，并等待 active promises 自然结束。
  证据见 `scripts/graphrag/batch-epub-workflow.mjs:7118` 到 `7236`。
- stale worker commit rejection 依赖未完整覆盖的 item/book fencing，不能保证
  takeover 后旧 generation 持久提交一律被拒绝。

### 10. Tests exercise state and recovery behavior, not only token presence

判定：**fail**。

新增测试覆盖了部分行为：同 runId 第二 coordinator 拒绝、provider slot stale
recovery、partial event tail、stage checkpoint book lease rejection。证据见
`test/cli.test.ts:2280` 到 `2544`、`3452` 到 `3564`、
`test/book-job-state.test.ts:1059` 到 `1150`。

但测试仍没有覆盖固定基准要求的关键行为：

- expired lock 且旧 coordinator/subprocess 仍存活时必须停止或隔离。
- stale worker 在 takeover 后提交 item completed/checkpoint 必须被拒绝。
- duplicate book id 的 durable book lease 竞争。
- provider slot durable count limit、live slot takeover、leaked live slot quarantine。
- manifest mismatch rebuild 与 `manifest_rebuilt`。
- duplicate event id/sequence recovery。
- YAML/JSON temp leftover、invalid checksum/generation recovery。
- SQLite busy/locked bounded retry 与 `sqliteRetryCount`。
- retry budget exhausted 的稳定排除状态。
- parallel non-transient failure 对 sibling subprocess 的 cancel/quiesce。

同时，`test/cli.test.ts:1827` 到 `1908` 仍包含大量源码字符串存在性断言，不能替代
行为级 recovery 测试。

## Blocking Findings

### B-01. Expired coordinator lock can be taken over while old writer is alive

严重性：blocking

对应基准：1、9。

`coordinatorLockLive()` 先按 `expiresAt` 判定 false，再检查 pid。因此锁过期但
旧 coordinator pid 仍存活时，新 coordinator 可写入新 generation。接管后也没有
强制终止旧 subprocess registry 中仍存活的进程组。该路径允许两个 writer 在同一
runId 上并存。

### B-02. Fencing is not enforced on all item/book-scoped commits

严重性：blocking

对应基准：2、7、9。

`saveCheckpoint()` 没有对当前 item checkpoint 做 fencing CAS；repository 只在
stage checkpoint 写入处验证 book lease，artifact catalog、run record、producer
manifest 和 catalog 路径仍可绕过。`assertBatchBookLease()` 在环境变量缺失时
返回，使普通调用不受 batch lease 保护。

### B-03. Provider slot lease files are observability records, not the durable limiter

严重性：blocking

对应基准：3、9。

实际 provider 并发仍由进程内 `AsyncSemaphore` 控制。slot lease 文件不参与
capacity CAS，也不在 acquisition 时按 durable active lease 拒绝。release 不校验
slot fencing token。restart/takeover 场景下 provider concurrency 不能由持久状态
保证。

### B-04. Durable write contract remains incomplete across state surfaces

严重性：blocking

对应基准：4、5、6。

runner JSON 写入已有 fsync 改进，但缺少 generation/checksum validation 和
startup reconciliation。YAML repository、producer manifest、event migration 等
关键写入仍未使用完整 durable replace 协议。

### B-05. Event log recovery lacks duplicate-id/sequence reconciliation

严重性：blocking

对应基准：5、6。

event line 现有 `eventId` 与 `sequence`，但恢复只覆盖 partial tail，不处理重复
event id 或重复 sequence，也没有 deterministic duplicate diagnostics。因此 event
log 不能作为权威审计轨迹。

### B-06. Terminal completion is not a fenced multi-surface commit

严重性：blocking

对应基准：7。

完成路径有证据门控，但 final commit 未在一个 fenced protocol 中验证 current
item/book/provider generation，并按固定顺序持久写 book checkpoint、item
checkpoint、event 与 derived manifest/status。旧 worker 或部分写失败后仍可能留下
不一致终态证据。

### B-07. Retry exhaustion still cycles as pending retryable work

严重性：blocking

对应基准：8、10。

transient provider wait limit 和 retry budget exhaustion 没有进入
`failed_retry_exhausted` 或等价非 runnable terminal state。实现和测试都把该状态
保持为 `pending`、`retryable: true`、`retryExhausted: false`。

### B-08. Crash/restart recovery does not cancel or quarantine live orphan risk

严重性：blocking

对应基准：9。

subprocess registry 已存在，但 restart/takeover 不会终止同 host 仍存活的旧进程组，
也不会在无法终止时停在 `stop_until_fixed`。parallel non-transient failure 也不
取消 sibling workers 或其 provider subprocess。

### B-09. Test coverage is still below behavior-level production baseline

严重性：blocking

对应基准：10。

新增测试覆盖若干正向和局部恢复路径，但缺少 stale commit rejection、duplicate
book lease、durable provider slot limit、manifest rebuild、duplicate event recovery、
SQLite busy handling、retry exhaustion terminal state、coordinator crash/restart
with live subprocess 等固定基准要求的行为级测试。

## Positive Observations

- `coordinator-lock.json`、book lease、provider slot lease、subprocess registry、
  eventId/sequence 与 fsync helper 已进入实现面。
- qmd、GraphRAG stage、producer lineage 与 query_ready 证据门控仍然存在。
- 部分新测试已从纯 token presence 向行为验证移动，例如 second coordinator
  rejection、partial event tail recovery 和 stale book lease stage write rejection。

这些改进不足以抵消上述 blocking findings。
