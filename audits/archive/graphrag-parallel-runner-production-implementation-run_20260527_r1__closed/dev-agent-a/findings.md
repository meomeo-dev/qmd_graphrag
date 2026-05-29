# GraphRAG 并行 Runner 实施审计发现

## 结论

Decision: **fail**

当前实现已有单进程 worker pool、`--book-concurrency 1` 顺序路径、部分
provider semaphore、qmd/GraphRAG closed-loop gate 与若干恢复投影。但生产设计
要求的 durable coordinator、lease/fencing、provider slot lease、event recovery
和跨进程资源竞争控制尚未实现，因此不能判定为生产就绪。

## Blocking Findings

### P0-1 缺少同 runId 单 coordinator 持久锁

- 严重性：blocking
- 对应基准：1. 同 runId 单协调器（single coordinator）
- 证据：
  - `scripts/graphrag/batch-epub-workflow.mjs:201` 到 `204` 只定义
    `batchRoot`、`eventsPath`、`manifestPath`，未定义
    `coordinator-lock.json` 或 coordinator lock 状态。
  - `scripts/graphrag/batch-epub-workflow.mjs:6374` 到 `6431` 的 `main()`
    直接 `loadManifest()`、`loadCheckpoint()` 并记录
    `batch_runner_configured`，没有 acquire/reject/takeover/release
    coordinator lock。
  - `scripts/graphrag/batch-epub-workflow.mjs:4685` 到 `4761` 启动子进程
    时没有 durable subprocess registry；coordinator 接管前无法扫描旧
    coordinator 的活跃子进程。
- 影响：
  两个 OS 级 `batch-epub-workflow` 进程可用同一 `runId` 同时写
  manifest、events、item checkpoint、book state 和 qmd index。进程内
  semaphore 与 in-memory worker pool 无法保护跨进程资源。
- 测试缺口：
  `test/cli.test.ts` 未启动两个相同 `runId` 的 runner 并断言一个被拒绝、
  等待或按过期锁接管；也没有 coordinator crash/takeover 测试。
- 修复建议：
  在 `graph_vault/catalog/batch-runs/{runId}/coordinator-lock.json` 实现原子
  acquire。锁内容至少包含 `runnerSessionId`、host、pid、startedAt、
  heartbeatAt、expiresAt、generation。启动时拒绝未过期活锁；接管时必须确认
  旧 pid 不存活并扫描 subprocess registry。运行中持续 heartbeat；续租失败后
  禁止新 claim 和持久写入。

### P0-2 item claim 没有完整 lease/fencing，stale worker 可覆盖状态

- 严重性：blocking
- 对应基准：2. Item claim 与 fencing
- 证据：
  - `scripts/graphrag/batch-epub-workflow.mjs:467` 到 `470` 的 checkpoint
    schema 只有 `runnerSessionId`、host、pid、heartbeat；没有 `workerId`、
    `expiresAt`、`leaseGeneration` 或 `fencingToken`。
  - `scripts/graphrag/batch-epub-workflow.mjs:5663` 到 `5720` 的
    `markItemRunning()` 只在启动时用 checkpoint 文件锁比较少数字段并写入
    `runnerSessionId`。claim 后的命令检查、artifact、event、terminal commit
    没有 fencing token。
  - `scripts/graphrag/batch-epub-workflow.mjs:2561` 到 `2566` 的
    `saveCheckpoint()` 直接写 checkpoint；`2569` 到 `2583` 的
    `appendCommandCheckCheckpoint()` 基于调用方持有的旧 checkpoint 写入，没有
    重新读取并校验当前 lease。
  - `scripts/graphrag/batch-epub-workflow.mjs:5602` 到 `5625` 的 completed
    commit 直接 `saveCheckpoint()` 后追加 `item_completed`，没有验证 claim
    generation 仍然有效。
- 影响：
  worker 失去租约或被恢复流程接管后，仍可能以旧内存对象写 command check、
  checkpoint 或 completed 结果，覆盖新 worker 的状态。该行为违反 stale write
  rejection（过期写拒绝）要求。
- 测试缺口：
  没有 stale worker 在旧 claim 下提交 command check 或 completed checkpoint
  的并发测试；没有 fencing token mismatch 测试。
- 修复建议：
  将 item claim 建模为 durable lease。所有持久写入必须走同一个
  compare-and-swap helper：读取当前 checkpoint，校验 `runnerSessionId`、
  `workerId`、`leaseGeneration`、`fencingToken`、`expiresAt`，再写入。过期或
  generation 不匹配时必须拒绝写入并记录 diagnostic event。

### P0-3 book 互斥只依赖内存扫描，没有 durable book lease

- 严重性：blocking
- 对应基准：3. Book 级互斥（book-scoped mutual exclusion）
- 证据：
  - `scripts/graphrag/batch-epub-workflow.mjs:1738` 到 `1749` 的
    `activeRunningBookCheckpoint()` 只扫描当前进程的 `checkpoints` Map。
  - `scripts/graphrag/batch-epub-workflow.mjs:6264` 到 `6287` 的 worker pool
    在本进程内先调用 `activeRunningBookCheckpoint()`，再 `markItemRunning()`。
    该检查不是 book-scoped compare-and-swap。
  - `src/job-state/repository.ts:2813` 到 `2908` 的 `writeStageCheckpoint()`
    写 `books/{bookId}/checkpoints.yaml` 前没有 book lease 或 fencing 校验。
- 影响：
  单进程内可减少同 book 并发，但无法防止两个 coordinator、旧 worker 或两个
  不同 item 同时写同一 `bookId` 的 GraphRAG producer、artifact catalog、
  checkpoint 和 query_ready 结果。
- 测试缺口：
  没有 duplicate `bookId` 在 `--book-concurrency 2` 下互斥的行为测试；没有跨
  进程 duplicate book 写入竞争测试。
- 修复建议：
  新增 durable book lease 文件或记录，例如
  `graph_vault/books/{bookId}/lease.json`。claim 必须包含 `runId`、
  `bookId`、`itemId`、`runnerSessionId`、`workerId`、`leaseGeneration`、
  `fencingToken`、`heartbeatAt`、`expiresAt`。book checkpoint、artifact、
  producer manifest 和 query_ready commit 前必须校验 book fencing。

### P0-4 provider semaphore 是进程内计数器，不是 coordinator slot lease

- 严重性：blocking
- 对应基准：6. Provider slot 治理
- 证据：
  - `scripts/graphrag/batch-epub-workflow.mjs:1859` 到 `1929` 的
    `AsyncSemaphore` 只维护内存中的 `active` 与 `queue`。
  - `scripts/graphrag/batch-epub-workflow.mjs:1932` 到 `1937` 为 OpenAI、
    Jina 和 local CPU 创建进程内 semaphore；没有 durable slot id、
    generation、expiresAt 或 leak recovery。
  - `scripts/graphrag/batch-epub-workflow.mjs:4942` 到 `4968` 的 qmd 命令和
    `5111` 到 `5160` 的 GraphRAG resume 只在启动子进程外层包一层 semaphore。
    子进程内部真实请求没有 slot lease 证据，也无法在 coordinator crash 后回收。
  - `scripts/graphrag/batch-epub-workflow.mjs:4445` 到 `4448` 的
    `status-json` 输出 `buildRecoverySummary()`；实现中没有
    `activeProviderSlots`、`providerWaitMs`、`providerSlotGeneration` 字段。
- 影响：
  同一进程内能粗粒度限制子进程数量，但不能证明所有真实 OpenAI/Jina 请求受
  全局 slot 控制。多个 runner 同时运行时 provider concurrency 会被放大；
  coordinator crash 后也无法发现 leaked provider slot。
- 测试缺口：
  `test/cli.test.ts:1857` 到 `1879` 主要是源码字符串断言。现有并行 fixture
  没有验证 OpenAI/Jina slot contention、status-json slot 字段、slot release
  或 leak recovery。
- 修复建议：
  引入 coordinator 管理的 provider slot lease 表。每个 slot 包含 provider、
  slotId、workerId、itemId、bookId、commandId、generation、fencingToken、
  acquiredAt、expiresAt、releasedAt。启动 provider 子进程前必须 acquire；
  子进程退出、kill、timeout 或 lease loss 后必须 release。`status-json`
  输出 active slot、wait ms、generation 和 leak recovery diagnostics。

### P0-5 event log 与 manifest recovery 不满足 durable consistency 要求

- 严重性：blocking
- 对应基准：5. Manifest 与 event 一致性
- 证据：
  - `scripts/graphrag/batch-epub-workflow.mjs:559` 到 `576` 的
    `BatchEventLogSchema` 没有 `eventId` 或 `sequence`。
  - `scripts/graphrag/batch-epub-workflow.mjs:2099` 到 `2117` 的 `event()`
    直接 `writeFileSync(eventsPath, ..., { flag: "a" })`，没有 event writer
    lane、file lock、sequence allocation、fsync 或 duplicate detection。
  - `scripts/graphrag/batch-epub-workflow.mjs:4475` 到 `4483` 的
    `migrateEventLog()` 对每一行直接 `JSON.parse()`；遇到 partial JSONL tail
    会失败而不是截断并记录 `partial_event_tail_recovered`。
  - `scripts/graphrag/batch-epub-workflow.mjs:4229` 到 `4287` 的
    `updateManifest()` 从传入的内存 checkpoint 数组计算并写 manifest，但没有
    manifest generation、event sequence reconciliation 或 `manifest_rebuilt`
    诊断。
- 影响：
  并发 event append、进程崩溃、partial tail 或 duplicate event 都可能破坏
  event audit trail。manifest 可作为缓存重建的要求没有完整事件证据和恢复诊断。
- 测试缺口：
  没有 partial JSONL tail、duplicate event、manifest 与 checkpoint 不一致、
  checkpoint temp file 残留或 manifest generation mismatch 的恢复测试。
- 修复建议：
  增加 event writer lane 和 durable sequence allocator。Event schema 添加
  `eventId`、`sequence`、`coordinatorSessionId`、`workerId`、lease diagnostics。
  恢复时扫描 JSONL，截断最后一个非完整 JSON 行，忽略 duplicate sequence 或
  eventId，并记录诊断事件。Manifest 必须可完全从 checkpoint 和 event 重建，
  不一致时写 `manifest_rebuilt`。

### P0-6 qmd index writer safety 覆盖不完整，缺少 SQLite bounded retry

- 严重性：blocking
- 对应基准：7. qmd index 写入安全
- 证据：
  - `scripts/graphrag/batch-epub-workflow.mjs:242` 到 `247` 标识 qmd writer
    commands，但 `4942` 到 `4968` 只用进程内 `qmdIndexWriterLane` 包住
    `qmd-pull`、`qmd-update`、`qmd-embed`、`qmd-cleanup`，未对实际
    `.qmd/index.sqlite` 文件获取跨进程 file lock。
  - `src/job-state/graphrag-book.ts:1007` 到 `1041` 的 qmd corpus registration
    使用 `withQmdIndexFileLock()`，但这只覆盖 repository 内部写入，不覆盖
    batch runner 启动的 qmd 子进程写入。
  - `src/job-state/graphrag-book.ts:1048` 到 `1084` 的 file lock 无限等待
    `${qmdIndexPath}.lock`；没有 `busy_timeout` 配置、bounded retry 分类、
    timeout release 诊断或 `sqliteRetryCount`。
- 影响：
  单 coordinator 内 qmd writer command 可被串行化，但跨 coordinator、外部 qmd
  进程或 crash recovery 下仍可能竞争 `.qmd/index.sqlite`。SQLite `locked` 或
  `busy` 错误不会按设计转为 bounded local retry，也无法在 status-json 暴露。
- 测试缺口：
  没有 `.qmd/index.sqlite` lock contention、SQLite `busy`、retry exhaustion
  或 `sqliteRetryCount` 的测试。
- 修复建议：
  统一 qmd index write adapter。所有 qmd writer subprocess 启动前必须获取
  `.qmd/index.sqlite.lock` 或等价跨进程锁，并设置 SQLite `busy_timeout`。对
  `SQLITE_BUSY`、`database is locked` 做 bounded retry，记录
  `sqliteRetryCount`、wait ms、lock holder diagnostics 和最终分类。

### P0-7 stop/quiesce/cancellation 与 subprocess recovery 不完整

- 严重性：blocking
- 对应基准：1、8. coordinator recovery 与 failure/wait semantics
- 证据：
  - `scripts/graphrag/batch-epub-workflow.mjs:4685` 到 `4693` 的
    `spawnCommand()` 没有 `detached: true` 或 process group；`4703` 到 `4716`
    timeout 只 kill child pid，不能保证子进程树被终止。
  - `scripts/graphrag/batch-epub-workflow.mjs:6300` 到 `6323` 的 worker pool
    在 worker 失败后只设置 `rejectedError` 或 `stopAfterNonTransientFailure`，
    不会取消其他 active worker 或其 provider subprocess。
  - `scripts/graphrag/batch-epub-workflow.mjs:6137` 到 `6147` 的 fail-fast
    通过 throw 退出当前 worker 路径，但 worker pool 等 activeCount 归零后才
    settle；没有 quiesce token 或 cancellation token。
- 影响：
  non-transient failure 或 fail-fast transient failure 后，其他 worker 可能继续
  写 checkpoint、artifact、manifest 或 qmd index。coordinator crash 后也无法
  定位、隔离或终止 orphan GraphRAG/qmd subprocess。
- 测试缺口：
  没有并行 worker 中一个 non-transient 失败时取消其他 active worker 的测试；
  没有 worker crash with active GraphRAG subprocess、process group kill、
  leaked subprocess registry recovery 的测试。
- 修复建议：
  为 coordinator 和 worker 引入 quiesce/cancellation state。所有子进程以独立
  process group 启动，并在 durable subprocess registry 记录 item、book、
  command、provider slot、pid、pgid、startedAt、expected outputs。fail-fast 或
  non-transient stop 时先禁止新 claim，再取消未终态 worker，释放 provider slot
  和 book/item lease，并记录 stopped/recoverable checkpoint。

## Nonblocking Findings

### P1-1 测试以源码字符串和 happy-path fake runner 为主，竞争覆盖不足

- 严重性：nonblocking
- 对应基准：10. 生产级测试覆盖
- 证据：
  - `test/cli.test.ts:1857` 到 `1879` 的 contract 测试主要断言脚本文本包含
    参数名、函数名和事件字符串。
  - `test/cli.test.ts:2257` 到 `2304` 覆盖 `--book-concurrency 2` 与
    `--book-concurrency 1`，但使用 fake resume/qmd runner，只验证两个书的
    happy path 并发或顺序。
- 影响：
  测试能证明部分 CLI wiring 存在，但不能证明 production invariants，包括
  coordinator exclusivity、lease fencing、provider slot governance、SQLite
  contention、event recovery 和 crash recovery。
- 修复建议：
  增加黑盒并发测试和故障注入测试：相同 `runId` 双进程启动、duplicate book
  claim、stale worker terminal commit、provider slot contention/leak recovery、
  partial JSONL tail、manifest rebuild、SQLite busy/locked、fail-fast 并行取消。

## 已验证的非阻塞观察

- `--book-concurrency 1` 有顺序执行路径，且 `test/cli.test.ts:2284` 到 `2304`
  覆盖两个 fake book 的顺序启动关系。
- GraphRAG query_ready gate 在 `src/job-state/graphrag-book.ts:1537` 到 `1679`
  和 `2813` 到 `2908` 保留了 producer run id、stage fingerprint、provider
  fingerprint、book-scoped artifact、qmd corpus content hash 和 graph identity
  校验；本轮未发现该 gate 被直接弱化。
