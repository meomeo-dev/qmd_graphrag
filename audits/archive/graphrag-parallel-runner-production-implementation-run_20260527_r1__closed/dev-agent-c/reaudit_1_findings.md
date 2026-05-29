# GraphRAG 多书并行 Runner 生产实现复审

## 结论

status: fail

当前实现较上一轮已有明显推进：存在 `coordinator-lock.json`、book lease、
provider slot sidecar、subprocess registry、eventId/sequence、event tail recovery、
以及单进程 worker pool 行为测试。但按 `criteria.md` 的 10 条固定审计基准
逐条复审后，仍不能判定为生产就绪（production ready）。

阻塞原因集中在：fencing 未覆盖所有持久写入，provider semaphore 仍以父进程
内存计数为主，qmd index writer lane 未覆盖所有 SQLite 写入路径，GraphRAG
内部子进程边界不可完全恢复，catalog/book artifact 等 YAML/JSON 写入仍不满足
durable write contract，终态提交顺序未按固定 fenced finalization 实现，测试证据
还缺少关键竞争与崩溃恢复场景。

复审未读取或输出 `.env`、密钥或凭据。未运行测试，因为本任务只允许写入本
审计目录下两个复审文件，行为测试会写入临时目录和运行产物。

## 固定基准逐条判定

| # | 基准 | 判定 | 复审结论 |
|---|---|---|---|
| 1 | 同 runId coordinator exclusivity | partial pass | 实现已有 `coordinator-lock.json`，含 session、pid、heartbeat、expiry、generation、fencing，并有同 runId 双 OS runner 拒绝测试。但 takeover 后对子进程和 provider slot 的恢复仍不完整，相关阻塞归入 C-04。 |
| 2 | item/book lease fencing | fail | book lease 存在，但 item lease 没有独立 durable lease；event、manifest、catalog、qmd build manifest、book artifact 等写入前未统一验证 fencing。 |
| 3 | provider semaphore durable lease | fail | 有 provider slot sidecar，但并发控制仍依赖父进程内存 semaphore；slot lease 不作为 durable CAS 资源池；子进程不验证 slot fencing；wait/generation 状态不完整。 |
| 4 | qmd index writer lane | fail | 父进程 lane 与 `withQmdIndexFileLock` 分裂，qmd CLI SQLite 写入路径没有统一 file lock；缺少 SQLite busy_timeout/bounded retry 证据。 |
| 5 | subprocess process-group recovery | fail | 父进程 top-level command 有 registry 与 process-group kill，但 GraphRAG Python bridge 内部 spawn 未登记、未独立 process group；takeover 不会终止仍存活的旧 child group。 |
| 6 | durable write contract | fail | batch JSON 写入较完整，但 repository YAML、GraphRAG output manifest、cost JSONL、migrate rewrite 等仍缺 fsync file/parent 或 atomic append/rewrite。 |
| 7 | terminal commit fixed order | fail | completed commit 未验证 provider slot，未执行固定 book checkpoint -> item checkpoint -> event -> manifest/status -> release 顺序。 |
| 8 | manifest/status durable projection | fail | status-json 基于 durable checkpoint 读取，但 manifest/status 未以 durable events 为权威；provider wait、slot generation、worker、running command 字段不完整或不准确。 |
| 9 | bounded worker pool | partial pass | 单 coordinator 内 `bookConcurrency` 有 activeCount 上界，已有真实重叠执行测试；同 book 互斥有内存检查和 book lease，但仍依赖 C-01 的 fencing 覆盖。 |
| 10 | behavioral tests | fail | 已覆盖部分行为，但缺同 runId takeover、provider slot 竞争上界、qmd index lock 竞争、process-group grandchild kill、manifest crash recovery、stale item fencing 等测试。 |

## Blocking Findings

### C-01: item/book fencing 没有覆盖所有持久写入

严重性：blocking

对应基准：2、7

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2142-2184` 创建 book lease，
  `:3244-3268` 只在 `assertBookLeaseForCheckpoint` 中校验 book lease。
- `scripts/graphrag/batch-epub-workflow.mjs:3270-3280` 的 `saveCheckpoint`
  对 running checkpoint 或显式 `requireBookLease` 才校验 book lease；非
  running 写入只校验 coordinator lease。
- `scripts/graphrag/batch-epub-workflow.mjs:2506-2531` 的 event append 不接收
  item/book fencing token，也不验证当前 worker 是否仍拥有 item/book。
- `scripts/graphrag/batch-epub-workflow.mjs:4384-4463` 的
  `writeQmdBuildManifest` 直接写 qmd build manifest，未在写入前校验 book lease
  或 item fencing。
- `src/job-state/repository.ts:2066-2149` 的 `recordArtifacts` 写
  `artifacts.yaml` 前未调用 `assertBatchBookLease`。
- `src/job-state/repository.ts:2891-2987` 的 stage checkpoint 写入会调用
  `assertBatchBookLease`，但这是局部覆盖，不包括 catalog、artifact manifest、
  output producer manifest、qmd index、event、batch manifest 等全部写入。
- `src/job-state/graphrag-book.ts:1382-1425` 的
  `writeGraphRagOutputProducerManifest` 直接 `writeFile`，没有 fencing 校验。
- `src/contracts/batch-run.ts:145-193` 的 item checkpoint 有 `fencingToken`，
  但没有独立持久 item lease 文件或 item lease CAS；item fencing 主要是
  running checkpoint 字段。

影响：

旧 worker 在 book lease 过期、coordinator takeover、或 provider slot 丢失后，
仍可能追加 event、改 manifest、写 qmd build manifest、写 artifact manifest 或
output producer manifest。当前 stale fencing 测试只覆盖
`repo.startStage()` 的 book lease 拒绝，不能证明所有写路径都拒绝 stale worker。

修复要求：

将 item lease 与 book lease 都做成 durable CAS 资源，包含
`runnerSessionId`、`workerId`、`generation`、`fencingToken`、`heartbeatAt`、
`expiresAt`。所有 checkpoint、event、manifest、catalog、qmd index、book
artifact、output producer manifest 写入前都必须验证当前 fencing token 仍有效。

### C-02: provider semaphore 不是完整 durable semaphore

严重性：blocking

对应基准：3、7、8、10

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2016-2087` 的 `AsyncSemaphore`
  是父 Node 进程内存队列。
- `scripts/graphrag/batch-epub-workflow.mjs:2273-2315` 在内存 semaphore 已经
  acquire 后才写 provider slot lease sidecar。slot lease 不是 durable CAS
  资源池的获取依据。
- `scripts/graphrag/batch-epub-workflow.mjs:2317-2335` 释放 slot 时直接
  `rmSync(providerSlotPath(lease.slotId))`，未读回并校验当前 slot fencing。
- `scripts/graphrag/batch-epub-workflow.mjs:2345-2354` 通过 `finally` 释放
  sidecar，但没有 provider slot heartbeat 或 lease renewal。
- `scripts/graphrag/batch-epub-workflow.mjs:5580-5630` 把 provider slot id、
  generation、fencing token 传给子进程环境变量，但仓库检索未发现子进程或
  provider 调用路径读取并验证 `QMD_GRAPHRAG_PROVIDER_SLOT_*`。
- `scripts/graphrag/batch-epub-workflow.mjs:5034-5049` 生成 status summary 时
  `providerWaitMs` 初始化为 `0`，未从 durable slot lease 或 events 重建真实
  wait time。
- `test/cli.test.ts:2448-2544` 只测试 stale provider slot lease 在新
  coordinator 启动时被回收，没有测试 OpenAI/Jina slot 竞争的最大并发上界。

影响：

当前实现可以作为单 coordinator 父进程内的 process-level wrapper，但不满足
durable semaphore（durable provider semaphore）。provider slot 的竞争、续租、
fencing、wait time 和恢复状态都没有形成可重放的持久协议。终态提交也无法验证
“当前 provider slot 仍有效”，因为对应 slot 通常在子命令返回时已经释放。

修复要求：

provider slot 必须从持久 registry 中 CAS 获取，按 provider 和 slot 编号进行
bounded claim；lease 需包含 provider、slot、generation、fencing token、owner、
command、item/book、heartbeat、expiresAt、waitMs。子进程或 provider adapter 在
调用 OpenAI/Jina 前必须验证 slot fencing，释放也必须 compare current token。

### C-03: qmd index writer lane 未覆盖所有 `.qmd/index.sqlite` 写入路径

严重性：blocking

对应基准：4、10

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:252-257` 只将 `qmd-pull`、
  `qmd-update`、`qmd-embed`、`qmd-cleanup` 归入 qmd writer command。
- `scripts/graphrag/batch-epub-workflow.mjs:2337-2343` 的
  `qmdIndexWriterLane` 是父进程内存 semaphore。
- `scripts/graphrag/batch-epub-workflow.mjs:5779-5811` 只在父进程包裹部分
  qmd command；qmd CLI 内部 SQLite 写入没有统一 file lock。
- `scripts/graphrag/batch-epub-workflow.mjs:5967-6018` 只在
  `nextStage` 为 `ingest`、`normalize`、`query_ready` 时包
  `qmdIndexWriterLane`；GraphRAG/resume 子进程内部的实际 qmd index 写入依赖
  另一个实现。
- `src/job-state/graphrag-book.ts:1015-1049` 的 `registerQmdCorpusDocument`
  使用 `withQmdIndexFileLock`，但这只覆盖该 direct store 写入路径。
- `src/job-state/graphrag-book.ts:1088-1131` 的 qmd index lock 有 owner pid、
  session、runId、wait timeout 和 stale pid 检查，但 qmd CLI 写 SQLite 时未
  复用该锁。
- `src/store.ts:855-1001` 初始化 SQLite WAL 与 schema；仓库检索未发现
  `PRAGMA busy_timeout`、`SQLITE_BUSY` bounded retry 或统一 lock adapter。

影响：

父进程 qmd writer lane、GraphRAG direct store lock、qmd CLI 自身 SQLite 写入
是三套不同机制。多 worker 或恢复子进程可能在 `.qmd/index.sqlite` 上发生
writer 冲突、busy 失败或 stale lock 误判。当前测试没有 qmd index 文件锁竞争、
SQLite busy retry、或 stale live-owner lock 拒删行为证据。

修复要求：

把所有 qmd index 写入统一到同一个 durable writer lane/file lock。qmd CLI、
GraphRAG/resume child、direct store 写入和恢复流程必须共享 owner/timeout/stale
pid/bounded retry 协议，并在 SQLite 连接层配置 busy timeout 和 bounded retry。

### C-04: 子进程边界仍不能完整恢复

严重性：blocking

对应基准：5、1、3、10

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5450-5578` 的 top-level
  `spawnCommand` 已登记 subprocess record，并在 Unix 使用
  `detached: true`。
- `scripts/graphrag/batch-epub-workflow.mjs:2257-2271` timeout 时会对
  `-child.pid` 发送 signal，具备 process group kill 的父进程实现。
- `scripts/graphrag/batch-epub-workflow.mjs:2688-2735` takeover/recovery 扫描
  subprocess records 时，只在记录的 runner 不可用或 pid 不存活时把 record
  标成 `killed`；若旧 coordinator 已死但旧 child pid 仍存活，当前逻辑不会
  terminate 该旧 child process group。
- `src/integrations/python-bridge.ts:181-238` 的 GraphRAG Python bridge spawn
  没有 durable subprocess registry、没有 `detached` process group，early-stop
  只 kill direct child。
- `test/cli.test.ts:2379-2446` 检查 subprocess records 最终为 terminal 状态，
  但没有验证 command timeout 后 grandchild/process group 被杀。

影响：

GraphRAG Python bridge 或其下游进程可能在 parent command timeout、early stop、
或 coordinator takeover 后继续调用 provider 或写 output。当前 durable registry
只覆盖 batch 父进程启动的 qmd/resume wrapper，不覆盖 GraphRAG bridge 内部的
真实 provider child 边界。

修复要求：

每个 qmd/GraphRAG provider command 都必须登记 durable subprocess record，包含
pid/pgid、worker、item/book、provider slot、stage、timeout、expected output。
takeover 扫描到旧 live child 时必须 terminate group，等待 close，再 kill group；
无法终止时应进入 `stop_until_fixed`，不能继续提交同 item/book。

### C-05: durable write contract 未覆盖 catalog、book artifact 和迁移写入

严重性：blocking

对应基准：6

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2002-2014` 与 `:2544-2550` 的
  batch JSON 写入已使用 temp、fsync file、rename、fsync parent。
- `scripts/graphrag/batch-epub-workflow.mjs:2506-2531` events 有
  `eventId`、`sequence`、单行 append 和 fsync file。
- 但 `scripts/graphrag/batch-epub-workflow.mjs:4305-4326` 的
  `migrateGraphOutputProducerManifests` 使用 `writeFileSync` 直接覆盖
  `qmd_output_manifest.json`。
- `scripts/graphrag/batch-epub-workflow.mjs:5248-5358` 的 `migrateEventLog`
  使用 `writeFileSync` 整体重写 events，没有 temp/fsync/atomic rename。
- `src/job-state/repository.ts:387-396` 的 `writeYamlFile` 只有 temp + rename，
  没有 fsync temp file 或 fsync parent，影响 catalog、checkpoints、artifacts、
  run records 等 YAML。
- `src/job-state/graphrag-book.ts:1382-1425` 的 output producer manifest 直接
  `writeFile`。
- `src/provider/cost-accounting.ts:21-31` 的 provider cost JSONL 直接
  `appendFile`，没有 flush/fsync 或 tail recovery。

影响：

崩溃或掉电时，batch manifest/item checkpoint 的 durable 程度高于 book catalog、
artifact manifest、stage checkpoint、output producer manifest 和成本 ledger。
恢复逻辑因此不能保证从 durable checkpoint/events/catalog 一致地重建 run 状态。

修复要求：

抽出统一 durable writer API。所有 JSON/YAML 替换必须 temp file、fsync file、
atomic rename、fsync parent。所有 JSONL append 必须单行 append、flush/fsync、
尾部损坏恢复。迁移 rewrite 也必须走同一 contract。

### C-06: terminal commit 没有按固定顺序 fenced finalization

严重性：blocking

对应基准：7

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:6408-6459` 在 `runItem` 中验证
  qmd build、GraphRAG build、GraphRAG query evidence。
- `scripts/graphrag/batch-epub-workflow.mjs:6460-6487` 随后构造 completed
  checkpoint，`saveCheckpoint(... requireBookLease: true)`，然后追加
  `item_completed` event。
- `scripts/graphrag/batch-epub-workflow.mjs:7062-7071` worker 返回后再
  `updateManifestState`、追加 `item_worker_completed`、释放 book lease。
- 该路径没有在 terminal commit 时验证 provider slot lease；对应 provider slot
  在各子命令 `withSemaphore` 结束时已释放。
- 该路径没有显式执行“写 book checkpoint -> 写 item checkpoint -> 追加 event ->
  派生 manifest/status -> 最后释放 lease”的固定顺序。book stage checkpoint 由
  resume 子进程在较早阶段写入，不是 terminal commit critical section 的一部分。

影响：

终态提交前后如果 provider slot 已失效、book artifact 写入未 durable、或
coordinator takeover，旧 worker 仍可能提交 completed item event。固定提交顺序
缺失也使 crash-between-step 的恢复语义不可验证。

修复要求：

实现 terminal commit transaction-like protocol：重新验证 item lease、book
lease、provider slot，验证 qmd/GraphRAG/query_ready durable evidence，写 book
checkpoint，写 item checkpoint，追加 terminal event，由 durable checkpoint/events
派生 manifest/status，最后 compare-release provider/book/item lease。

### C-07: manifest/status 观测仍未完全从 durable checkpoint/events 派生

严重性：blocking

对应基准：8

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:4946-5009` 的 `updateManifest` 从
  当前内存 `checkpoints` array 计算并写 manifest，而不是从 durable checkpoint
  加 durable events 重放派生。
- `scripts/graphrag/batch-epub-workflow.mjs:5034-5192` 的 recovery summary 会
  读取 active provider slot sidecar 和 subprocess record，但 `providerWaitMs`
  不是从 durable wait history 派生。
- `src/contracts/batch-run.ts:299-340` 的 summary item 有 provider slot 与
  command 字段，但没有显式 `workerId` 字段。
- `scripts/graphrag/batch-epub-workflow.mjs:5102-5118` 输出 runner、lease、
  activeProviderSlots、providerWaitMs、providerSlotGeneration、current/active
  command；没有输出 worker id，provider wait time 也不准确。

影响：

`--status-json` 能观察部分 durable 状态，但仍不足以满足审计基准要求的 provider
slots、wait time、slot generation、worker、running command 和恢复决策完整性。
manifest 也仍是运行时内存状态的投影写回，而不是 durable checkpoint/events 的
权威重建。

修复要求：

将 manifest/status 统一改为 projection：只从 durable item/book checkpoints、
durable events、durable provider slots、subprocess registry 和 leases 重建。status
schema 增加 workerId、slot owner、slot wait history、slot generation、running
command、recovery decision source。

### C-08: 测试证据未覆盖关键生产竞争与崩溃恢复

严重性：blocking

对应基准：10

已有证据：

- `test/cli.test.ts:2280-2377` 覆盖同 runId 第二个 live coordinator 被拒绝。
- `test/cli.test.ts:2379-2446` 覆盖 `book-concurrency=2` 的真实重叠执行、
  eventId/sequence、slot release、subprocess terminal records。
- `test/cli.test.ts:2448-2544` 覆盖 stale provider slot recovery。
- `test/cli.test.ts:3452-3564` 覆盖 partial event tail recovery。
- `test/book-job-state.test.ts:1059-1150` 覆盖 stale book lease fencing 拒绝
  stage checkpoint write。

缺口：

- 未覆盖同 runId 旧 coordinator 过期后的 takeover，以及 takeover 前必须终止
  旧 subprocess process group。
- 未覆盖 OpenAI/Jina provider slot 竞争的 durable 最大并发上界。
- 未覆盖 qmd index file lock 竞争、SQLite busy_timeout、bounded retry 和 live
  owner stale lock 拒删。
- 未覆盖 command timeout 时 grandchild/process group 必须被 kill。
- 未覆盖 crash during manifest/status rewrite、crash between item checkpoint and
  event、event after checkpoint recovery。
- 未覆盖 stale item fencing 写入拒绝，以及 event/manifest/catalog/qmd index/book
  artifact stale fencing 拒绝。
- worker pool 测试证明单 coordinator overlap，但没有同 book 双 item 真实竞争和
  starvation/retry-window/fail-fast 的组合场景。

影响：

测试仍无法作为生产级行为证据（behavioral evidence）证明 10 条固定基准。当前
通过的用例主要证明部分结构和 happy-path/recovery-path，而非完整并发故障模型。

修复要求：

补齐上述行为测试，优先以 fake qmd/resume provider runner 控制阻塞点和 crash
点，断言最终 durable files、events、locks、process liveness 和 status-json
projection。

## 非阻塞观察

- coordinator lock 的基础字段和 live-runner 拒绝路径已经存在：
  `scripts/graphrag/batch-epub-workflow.mjs:2737-2857`。该部分不再是上一轮的
  “完全缺失”，但 takeover 与 subprocess recovery 仍受 C-04 限制。
- 单进程 worker pool 的 bounded parallelism 已有实现与测试：
  `scripts/graphrag/batch-epub-workflow.mjs:7101-7219`、
  `test/cli.test.ts:2379-2446`。该部分可作为后续修复的保留基础。
