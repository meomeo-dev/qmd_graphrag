# GraphRAG 多书并行 Runner 生产实施复审

## 结论

Status: **fail**

本轮复审按 `criteria.md` 的 10 条固定基准逐条检查当前工作树。实现相较上一轮
已增加 coordinator lock、book lease、provider slot lease 文件、event
`eventId`/`sequence`、partial tail recovery、subprocess registry、process group
kill 和多项黑盒测试。但仍有生产级阻塞缺口：fencing 未覆盖所有 book-scoped
catalog/artifact/qmd 写入，provider slot lease 不是 durable 全局容量仲裁，event
恢复不处理 duplicate event/manifest drift/temp file，qmd SQLite lock/retry 未闭合，
并行 fail-fast/non-transient quiesce 仍等待既有 worker 自然结束。

## 逐条基准复审

### 1. 同 runId 单协调器（single coordinator）

判定：**partial**

已实现项：

- `scripts/graphrag/batch-epub-workflow.mjs:207` 到 `215` 定义
  `coordinator-lock.json`、provider slot、subprocess 与 book lease 目录。
- `scripts/graphrag/batch-epub-workflow.mjs:2764` 到 `2780` 在启动时用
  `withJsonFileLock()` 获取 coordinator lock，并拒绝未过期且 live 的 lock。
- `scripts/graphrag/batch-epub-workflow.mjs:2795` 到 `2814` 有 heartbeat 续租，
  `2783` 到 `2792` 有 coordinator fencing 检查。
- `scripts/graphrag/batch-epub-workflow.mjs:2688` 到 `2735` 在接管时扫描 provider
  slot 和 subprocess registry；`test/cli.test.ts:2280` 到 `2377` 覆盖相同
  `runId` 第二个 live coordinator 被拒绝。

阻塞缺口：

- `recoverCoordinatorRuntimeArtifacts()` 对 live orphan subprocess 的恢复不完整。
  `scripts/graphrag/batch-epub-workflow.mjs:2711` 到 `2733` 只在
  `record.runnerHost !== runnerHost || !processAlive(record.pid)` 时把 registry 标记
  为 `killed` 并记录事件；对同 host 且 PID 仍存活的旧 coordinator 子进程没有
  调用 `terminateProcessTree()`，也没有隔离或拒绝接管。固定基准要求接管前重建
  subprocess registry 并处理旧子进程。
- heartbeat 续租失败只在 interval callback 中设置 `process.exitCode = 1`
  并清 timer（`scripts/graphrag/batch-epub-workflow.mjs:2817` 到 `2832`），没有全局
  quiesce/cancellation token 来立即禁止当前已经运行的 worker、provider subprocess
  和后续持久写入。后续 `assertCoordinatorLease()` 能挡住部分写入，但子进程仍可能
  继续运行到自然退出。

影响：

coordinator lock 已能防止普通双启动，但 crash/takeover 场景下旧子进程仍可能
持续写 GraphRAG/qmd 输出，接管 coordinator 不能证明共享状态只有一个 live writer。

### 2. Item claim 与 fencing

判定：**fail**

已实现项：

- running checkpoint schema 包含 `runnerSessionId`、`leaseGeneration`、
  `fencingToken`、`leaseExpiresAt`、book lease generation/token
  （`scripts/graphrag/batch-epub-workflow.mjs:534` 到 `545`）。
- `markItemRunning()` 在 item checkpoint file lock 下做原子 claim
  （`scripts/graphrag/batch-epub-workflow.mjs:6524` 到 `6594`）。
- `saveCheckpoint()` 对 running 或 terminal write 可要求 book lease 校验
  （`scripts/graphrag/batch-epub-workflow.mjs:3244` 到 `3280`）。

阻塞缺口：

- item fencing token 没有在所有 item 持久写前重新读取 checkpoint 并 compare。
  `saveCheckpoint()` 只调用 `assertBookLeaseForCheckpoint()` 或
  `assertCoordinatorLease()`，没有校验当前 checkpoint 仍持有相同
  `runnerSessionId`、`workerId`、`leaseGeneration`、`fencingToken` 和
  `leaseExpiresAt`（`scripts/graphrag/batch-epub-workflow.mjs:3270` 到 `3280`）。
- `appendCommandCheckCheckpoint()` 基于内存 checkpoint 追加 command check 后直接
  `saveCheckpoint()`（`scripts/graphrag/batch-epub-workflow.mjs:3283` 到 `3297`）。
  如果 item 被新 generation 接管，旧 worker 没有被 item token mismatch 拒绝。
- terminal completed commit 用 `expectedStatus: "completed"` 只校验传入对象状态，
  不是校验磁盘中当前 item claim 仍属于该 worker
  （`scripts/graphrag/batch-epub-workflow.mjs:6482` 到 `6485`）。
- schema 没有顶层 `workerId`，仅把 workerId 放入 metadata
  （`scripts/graphrag/batch-epub-workflow.mjs:6579` 到 `6587`），不满足固定基准
  “live claim 必须包含 worker identity”的强约束。

影响：

stale worker 在旧内存 checkpoint 下仍可能写 command check、terminal checkpoint
或 completed event。book lease 能挡住一部分 GraphRAG 写入，但不能替代 item claim
fencing。

### 3. Book 级互斥（book-scoped mutual exclusion）

判定：**fail**

已实现项：

- `BookLeaseSchema` 已存在，并在 `acquireBookLease()` 中用文件锁获取
  `book-leases/{bookId}.json`（`scripts/graphrag/batch-epub-workflow.mjs:338`
  到 `344`、`2142` 到 `2184`）。
- repository 的 stage checkpoint 写入会校验 batch book lease
  （`src/job-state/repository.ts:1081` 到 `1117`、`2891` 到 `2896`）。
- `test/book-job-state.test.ts:1059` 到 `1130` 覆盖 stale book lease 不能写 stage
  checkpoint。

阻塞缺口：

- book lease fencing 只覆盖 `writeStageCheckpoint()`，没有覆盖同一本书的所有
  catalog/artifact/qmd 写入。以下 book-scoped 写入在 repository 层没有调用
  `assertBatchBookLease()`：
  `registerBookSource()` 写 source/document identity/book catalog
  （`src/job-state/repository.ts:1119` 到 `1211`、`1306`、`1384`），
  `recordDocumentChunks()`（`src/job-state/repository.ts:1629` 到 `1660`），
  `recordQmdCorpusRegistration()`（`src/job-state/repository.ts:1663` 到 `1696`），
  `recordArtifacts()` 写 artifacts.yaml（`src/job-state/repository.ts:2066`
  到 `2147`）。
- `writeGraphRagOutputProducerManifest()` 直接写
  `books/{bookId}/output/qmd_output_manifest.json`，没有 book lease 校验、原子
  rename 或 fsync（`src/job-state/graphrag-book.ts:1382` 到 `1425`）。
- `collectWorkspaceArtifacts()` 后的 `repo.recordArtifacts()` 发生在
  `graphrag-book.ts:1869`，但该路径没有 fencing；旧子进程可覆盖 artifact catalog。

影响：

重复 item 解析到同一 `bookId` 时，stage checkpoint 有防护，但 artifact catalog、
document identity、qmd corpus registration、producer manifest 等仍可被旧 worker
或非持锁写入覆盖，违反“qmd、GraphRAG、checkpoint、artifact 或 query-ready
producer 不得并发执行”的要求。

### 4. 顺序兼容（sequential compatibility）

判定：**partial/pass for covered path**

已实现项：

- `bookConcurrency` 为 1 时使用原顺序循环，不走 worker pool
  （`scripts/graphrag/batch-epub-workflow.mjs:7637` 到 `7677`）。
- `test/cli.test.ts:2546` 到 `2566` 覆盖 `--book-concurrency 1` 两本书按顺序执行，
  且不产生 `batch_worker_pool_start`。

剩余风险：

- 现有顺序测试是 fake qmd/resume happy path，只验证启动顺序，不验证 retry 事件、
  manifest、completed-item 行为与旧顺序语义完全一致。该项本身不是当前 fail 的
  主阻塞，但仍不足以独立支撑生产结论。

### 5. Manifest 与 event 一致性

判定：**fail**

已实现项：

- event schema 有 `eventId` 与 `sequence`
  （`scripts/graphrag/batch-epub-workflow.mjs:643` 到 `664`）。
- `event()` 通过 `withJsonFileLock(eventsPath)` 追加并 fsync
  （`scripts/graphrag/batch-epub-workflow.mjs:2506` 到 `2531`）。
- `recoverEventLogTail()` 可截断 partial JSONL tail 并记录
  `partial_event_tail_recovered`
  （`scripts/graphrag/batch-epub-workflow.mjs:2650` 到 `2677`）；
  `test/cli.test.ts:3452` 到 `3564` 覆盖该路径。

阻塞缺口：

- 没有 duplicate event recovery。`migrateEventLog()` 对现有事件逐行 parse 后
  直接保留，未按 `eventId` 或 `sequence` 去重
  （`scripts/graphrag/batch-epub-workflow.mjs:5231` 到 `5339`）。
- `recoverEventLogTail()` 遇到第一条非法 JSON 行就截断后续所有行；它只处理 tail
  情况，没有验证非法行确实是最后一段，也没有 duplicate sequence 诊断。
- manifest 仍是从当前 checkpoint 数组直接写出
  （`scripts/graphrag/batch-epub-workflow.mjs:4946` 到 `5008`），没有 manifest
  generation、event sequence reconciliation、manifest drift 诊断或
  `manifest_rebuilt` 事件。
- `migrateEventLog()` 最后使用 `writeFileSync()` 直接覆盖 events 文件
  （`scripts/graphrag/batch-epub-workflow.mjs:5334` 到 `5338`），未走 durable
  atomic write/fsync helper。

影响：

partial tail 已覆盖，但 duplicate event、manifest drift、temp file 残留、事件
重放一致性仍不能证明。固定基准要求 manifest/status 由 durable checkpoint 和有效
event 派生，并能恢复 duplicate event 与 manifest drift；当前实现尚未满足。

### 6. Provider slot 治理

判定：**fail**

已实现项：

- provider slot lease schema 与文件存在
  （`scripts/graphrag/batch-epub-workflow.mjs:327` 到 `337`、`2273` 到 `2315`）。
- `withSemaphore()` 会写 lease、释放 lease，并发出 acquire/release event
  （`scripts/graphrag/batch-epub-workflow.mjs:2345` 到 `2353`）。
- qmd/query/GraphRAG 子进程获得 slot lease 后通过环境变量传入 slot id/generation/
  token（`scripts/graphrag/batch-epub-workflow.mjs:5607` 到 `5628`）。
- stale slot recovery 有测试覆盖（`test/cli.test.ts:2448` 到 `2544`）。

阻塞缺口：

- 实际容量仲裁仍由进程内 `AsyncSemaphore.active` 决定
  （`scripts/graphrag/batch-epub-workflow.mjs:2016` 到 `2087`）。durable slot
  文件是在 acquire 之后写入，并不参与跨进程 slot CAS，也不按现有 slot 文件计算
  是否还有容量。
- `writeProviderSlotLease()` 直接生成随机 slotId 并写入，不检查同 provider active
  lease 数是否超过 limit（`scripts/graphrag/batch-epub-workflow.mjs:2273`
  到 `2315`）。如果 coordinator lock 异常接管或多个 writer 存在，provider
  concurrency 仍会放大。
- `providerWaitMs` 在 recovery summary 中来自 active slot summary，初始化为 0，
  acquire 时的 waitMs 没有持久写入 lease 或 checkpoint
  （`scripts/graphrag/batch-epub-workflow.mjs:5035` 到 `5048`、`5109` 到 `5113`）。
- 子进程内部真实 OpenAI/Jina 请求没有 request-level enforcement；当前只是
  process-level wrapper。设计允许 process-level slot，但固定基准要求 coordinator
  granted durable slot 控制真实请求，当前没有子进程侧验证 provider slot lease 仍
  有效的机制。

影响：

实现提供了可观测 slot 文件，但 durable slot lease 不是全局容量来源，不能独立证明
OpenAI/Jina 请求在 crash/recovery 或异常多 writer 下受全局 slot 治理。

### 7. qmd index 写入安全

判定：**fail**

已实现项：

- runner 对 qmd writer commands 使用 `qmdIndexWriterLane`
  （`scripts/graphrag/batch-epub-workflow.mjs:252` 到 `257`、`5801` 到 `5808`）。
- `registerQmdCorpusDocument()` 在写 SQLite 前使用 `.lock` 文件
  （`src/job-state/graphrag-book.ts:1015` 到 `1049`、`1088` 到 `1131`）。

阻塞缺口：

- qmd 子进程执行 `qmd-pull`、`qmd-update`、`qmd-embed`、`qmd-cleanup` 时，runner 只
  持有进程内 `qmdIndexWriterLane` 和一个 provider slot lease，没有获取
  `.qmd/index.sqlite.lock`。相关路径在 `scripts/graphrag/batch-epub-workflow.mjs:5779`
  到 `5810`。跨 coordinator、外部 qmd 进程或旧子进程仍可竞争 SQLite。
- SQLite 连接只设置 WAL 和 foreign_keys（`src/store.ts:867` 到 `868`），未设置
  `busy_timeout`；代码库没有 `SQLITE_BUSY` 或 `database is locked` 的 bounded
  retry 分类与 metric。
- `withQmdIndexFileLock()` 只是等待 lock file，超时后抛普通 Error
  （`src/job-state/graphrag-book.ts:1088` 到 `1131`），没有暴露 `sqliteRetryCount`、
  wait metric 或 bounded local retry 结果。

影响：

单 coordinator 内 qmd writer lane 有序，但固定基准要求所有 `.qmd/index.sqlite`
与 qmd corpus 写入由 writer lane 和 file lock 串行化，并将 SQLite busy/locked
作为 bounded local retry 暴露。当前未满足。

### 8. 失败与等待语义（failure/wait semantics）

判定：**fail**

已实现项：

- failure classifier 区分 transient、data compatibility、provider auth 等路径；
  provider auth reopen/status-json 测试较完整。
- non-transient 失败会阻止新 claim：worker pool 在
  `stopAfterNonTransientFailure` 后不再 launch 新 candidate
  （`scripts/graphrag/batch-epub-workflow.mjs:7129` 到 `7135`），顺序循环也会 break。
- `test/cli.test.ts:7179` 到 `7355` 覆盖已有 non-transient 失败时不会处理下一本书。

阻塞缺口：

- fail-fast 或 non-transient failure 不会取消已经 active 的并行 worker。worker pool
  只等 `activeCount` 归零后 settle（`scripts/graphrag/batch-epub-workflow.mjs:7116`
  到 `7127`、`7196` 到 `7204`），没有 quiesce token 或 cancellation signal 发给
  active subprocess。
- `spawnCommand()` 支持 timeout 时 process group SIGTERM/SIGKILL
  （`scripts/graphrag/batch-epub-workflow.mjs:5450` 到 `5577`），但没有在 fail-fast、
  coordinator lease loss 或 another worker non-transient failure 时终止 active
  subprocess。
- provider recovery wait 会退出当前 runner或等待 retry window，但没有证明“可恢复
  provider wait 不阻塞无关 runnable book”的并行故障测试。

影响：

不可恢复失败发生后，新 claim 基本被停止，但 active worker 可能继续写 checkpoint、
artifact、manifest 或 qmd index，无法满足 quiesce scheduler 与取消未终态 worker
的生产语义。

### 9. GraphRAG 闭环 gate

判定：**pass with fencing caveat**

已实现项：

- completed item 前检查 qmd build、GraphRAG build、GraphRAG query 三类 evidence
  均 succeeded（`scripts/graphrag/batch-epub-workflow.mjs:6408` 到 `6459`）。
- qmd build manifest 记录 source/hash/index/config/command check evidence
  （`scripts/graphrag/batch-epub-workflow.mjs:4384` 到 `4463`），并在 evidence
  检查中验证 hash 与 command set（`4466` 到 `4564`）。
- GraphRAG stage evidence 校验 producer run id、stage fingerprint、provider
  fingerprint、book-scoped artifact、corpus content hash
  （`scripts/graphrag/batch-epub-workflow.mjs:3968` 到 `4286`）。
- repository 对 query_ready success 校验 producer stages、query artifacts 与 qmd
  corpus/graph identity（`src/job-state/repository.ts:1901` 到 `2014`、`3122`
  到 `3155`）。
- repair-only blocked 不会弱化 completed gate；相关测试覆盖较多。

保留意见：

- 该 gate 的内容检查基本满足基准，但其底层 artifact/catalog/producer manifest 写入
  缺少完整 book fencing，已在基准 2 和 3 作为阻塞项记录。

### 10. 生产级测试覆盖

判定：**fail**

已覆盖项：

- 双 coordinator 拒绝：`test/cli.test.ts:2280` 到 `2377`。
- parallel/sequential happy path：`test/cli.test.ts:2379` 到 `2446`、
  `2546` 到 `2566`。
- provider slot leak recovery：`test/cli.test.ts:2448` 到 `2544`。
- partial JSONL tail：`test/cli.test.ts:3452` 到 `3564`。
- stale stage checkpoint book lease fencing：`test/book-job-state.test.ts:1059`
  到 `1130`。
- stale/fresh remote running projection：`test/cli.test.ts:9896` 到 `10126`、
  normal stale recovery `10239` 到 `10374`。
- fail-fast transient 和 provider auth/status-json 相关路径有多项测试。

缺口：

- 没有 duplicate same `bookId` 在 `--book-concurrency 2` 下验证 durable book lease
  排他；现有 duplicate 测试只保证相同 EPUB 内容生成不同 checkpoint
  （`test/cli.test.ts:12553` 到 `12625`）。
- 没有 stale item fencing terminal write、旧 worker command check write 被拒绝的
  故障注入测试。
- 没有 provider slot contention 测试证明 durable slot lease 自身限制 provider
  并发；只有 stale lease recovery。
- 没有 qmd SQLite lock contention、`SQLITE_BUSY`、bounded retry exhaustion 或
  `sqliteRetryCount` 测试。
- 没有 duplicate event、manifest drift、checkpoint temp file 残留恢复测试。
- 没有 fail-fast/non-transient 并行 active worker cancellation、process group kill
  或 live orphan subprocess takeover 测试。

## Blocking Findings

### P0-1 item/book fencing 覆盖不足，旧 worker 可写非 checkpoint 共享状态

对应基准：2、3、9

证据：

- `saveCheckpoint()` 未校验当前 item checkpoint 的 fencing token/generation
  （`scripts/graphrag/batch-epub-workflow.mjs:3270` 到 `3280`）。
- `recordArtifacts()` 无 book lease 校验
  （`src/job-state/repository.ts:2066` 到 `2147`）。
- `recordDocumentChunks()` 与 `recordQmdCorpusRegistration()` 无 book lease 校验
  （`src/job-state/repository.ts:1629` 到 `1696`）。
- `writeGraphRagOutputProducerManifest()` 直接写 producer manifest，无 fencing/atomic
  fsync（`src/job-state/graphrag-book.ts:1382` 到 `1425`）。

要求：

所有 checkpoint、event、manifest、catalog、artifact、producer manifest、qmd corpus
registration 写入前必须校验 item lease 与 book lease generation/fencing token。
repository 公共写 API 应统一接入 `assertBatchBookLease()` 或显式非 batch mode
边界，并为 item terminal writes 增加 current checkpoint CAS。

### P0-2 provider slot lease 不是 durable 全局容量仲裁

对应基准：6

证据：

- `AsyncSemaphore` 仍是进程内 active/queue
  （`scripts/graphrag/batch-epub-workflow.mjs:2016` 到 `2087`）。
- `writeProviderSlotLease()` 生成随机 slot 文件，没有扫描 active provider lease
  数量并 CAS claim 容量（`scripts/graphrag/batch-epub-workflow.mjs:2273` 到 `2315`）。
- status summary 的 `providerWaitMs` 没有持久来源
  （`scripts/graphrag/batch-epub-workflow.mjs:5035` 到 `5048`）。

要求：

provider slot 文件或表本身必须是容量仲裁源，按 provider+slotId/generation 原子
claim/release；恢复时回收 leak；status-json 暴露 active slot、wait ms、
generation、leak recovery。

### P0-3 qmd SQLite 写入缺少 file lock 覆盖和 bounded busy retry

对应基准：7

证据：

- qmd writer subprocess 只受 `qmdIndexWriterLane` 保护
  （`scripts/graphrag/batch-epub-workflow.mjs:5801` 到 `5808`），未持有
  `${qmdIndexPath}.lock`。
- `withQmdIndexFileLock()` 只保护 internal qmd corpus registration
  （`src/job-state/graphrag-book.ts:1015` 到 `1049`、`1088` 到 `1131`）。
- SQLite store 没有 `busy_timeout`，也没有 `SQLITE_BUSY`/`database is locked`
  bounded retry metric（`src/store.ts:867` 到 `868`）。

要求：

所有 qmd writer subprocess 与 internal qmd corpus registration 必须共享同一 file
lock；SQLite busy/locked 必须按 bounded local retry 分类并暴露 wait/retry metric。

### P0-4 event/manifest recovery 未覆盖 duplicate、drift、temp file

对应基准：5

证据：

- `migrateEventLog()` 不按 `eventId`/`sequence` 去重
  （`scripts/graphrag/batch-epub-workflow.mjs:5231` 到 `5339`）。
- manifest 从 checkpoint 数组直接覆盖，无 generation 与 event reconciliation
  （`scripts/graphrag/batch-epub-workflow.mjs:4946` 到 `5008`）。
- `migrateEventLog()` 用 `writeFileSync()` 覆盖 events，不走 atomic/fsync
  （`scripts/graphrag/batch-epub-workflow.mjs:5334` 到 `5338`）。

要求：

恢复必须去重 duplicate event、截断真正 partial tail、处理 checkpoint/manifest temp
文件，重建 manifest 并记录 drift/rebuild 诊断事件。

### P0-5 fail-fast/non-transient quiesce 不取消 active workers 与 subprocesses

对应基准：1、8

证据：

- worker pool 在失败后停止新 launch，但等待 active worker 自然完成
  （`scripts/graphrag/batch-epub-workflow.mjs:7116` 到 `7204`）。
- `spawnCommand()` 仅在 timeout/buffer exceeded 时 kill process group
  （`scripts/graphrag/batch-epub-workflow.mjs:5515` 到 `5520`、`5541` 到 `5555`），
  没有 fail-fast 或 lease loss cancellation 路径。
- takeover recovery 对同 host live subprocess 不 terminate
  （`scripts/graphrag/batch-epub-workflow.mjs:2711` 到 `2733`）。

要求：

引入 coordinator quiesce/cancellation token。fail-fast、provider auth
stop_until_fixed、non-transient failure 或 lease loss 时，应先禁止新 claim，再取消
active workers，终止 process group，释放 provider/book/item lease，并记录
subprocess_cancelled/subprocess_killed。

### P0-6 测试覆盖仍未达到生产基准

对应基准：10

缺失测试包括 duplicate book 排他、stale item fencing terminal write、durable provider
slot contention、qmd SQLite lock contention/busy retry、duplicate event/manifest drift、
checkpoint temp file recovery、fail-fast active worker cancellation、live orphan
subprocess takeover。

## 已验证的正向进展

- 同 `runId` 普通双启动已有 coordinator lock 和测试。
- event append 已包含 `eventId`/`sequence`，并对 partial tail 有恢复测试。
- book stage checkpoint 写入已有 batch book lease fencing 测试。
- GraphRAG closed-loop gate 的 evidence 内容基本完整，尤其 query_ready 对 producer
  run、artifact、qmd corpus registration 与 graph identity 的校验较严格。
- subprocess registry 与 process group timeout kill 已存在，但还未接入 quiesce/takeover
  的完整取消路径。

