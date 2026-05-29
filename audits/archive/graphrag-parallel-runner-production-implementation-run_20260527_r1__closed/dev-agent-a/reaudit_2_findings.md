# GraphRAG 多书并行 Runner 实施复审 findings: reaudit_2

## 审计范围

- 固定基准来源：
  `audits/graphrag-parallel-runner-production-implementation-run_20260527_r1__open/dev-agent-a/criteria.md`
- 复审对象：当前工作树中的 GraphRAG 多书并行 Runner 生产实现与测试。
- 约束：未新建审计目录，未修改 `criteria.md`，未读取或输出 `.env`、
  密钥或凭据，未修改生产源码。

## 总体结论

`status: fail`

当前实现显著收敛了 `reaudit_1` 的多项阻塞问题：同 `runId`
coordinator lock、heartbeat、live PID 拒绝接管、provider slot durable
capacity gate、qmd index file lock、eventId/sequence、partial tail recovery、
duplicate event normalization、顺序/并行 worker 测试以及 book-state
fencing 测试均已有可核验证据。

但按 10 条固定基准逐条复审后，仍存在阻塞项（blocking findings）。
核心缺口集中在三处：部分 book/qmd 写路径仍未在写前完成 book lease
fencing；qmd SQLite `busy`/`locked` bounded retry 与可观测 metric 仍缺失；
coordinator takeover 的 subprocess registry reconciliation 仍未杀掉同主机
live orphan subprocess/process group。生产级测试覆盖也未覆盖这些剩余
高风险场景。

## Blocking Findings

### RA2-B1: qmd corpus 与 producer manifest 写路径仍缺少写前 book fencing

- 影响基准：2, 3, 9
- 严重级别：blocking
- 状态：未闭合（partially fixed, still open）

固定基准要求 item/book fencing 在写入 checkpoint、event、manifest、
catalog、artifact 或 qmd 产物前校验，并且同一本书的 qmd、GraphRAG、
checkpoint、artifact、query-ready producer 受持久 book lease 排他保护。

当前实现已为 stage checkpoint、artifact、run catalog、book job catalog 等
repository 写路径加入 `assertBatchBookLease`，并在 batch runner 的 running
checkpoint 中携带 item fencing 与 book fencing 字段。但仍有关键写路径不满足
“写前校验”：

- `src/job-state/graphrag-book.ts:1016` 至 `1040` 中，
  `registerQmdCorpusDocument` 先进入 `withQmdIndexFileLock` 并执行
  `upsertStoreCollection`、`insertContent`、`insertDocument` 等 qmd SQLite 写入，
  之后才调用 `repo.recordQmdCorpusRegistration`。若 book lease 已失效或被接管，
  stale runner 可先修改 `.qmd/index.sqlite`，再在 repository fencing 处失败。
- `src/job-state/graphrag-book.ts:1384` 至 `1426` 中，
  `writeGraphRagOutputProducerManifest` 直接写入
  `qmd_output_manifest.json`，没有校验 batch book lease generation/token。
  该函数由 `scripts/graphrag/resume-book-workspace.mjs` 多处调用，然后才进入
  `repo.completeStage` 的 fenced checkpoint 写入；因此 stale child process
  仍可先覆盖 GraphRAG producer manifest。
- batch runner 的 terminal failure checkpoint 写入主要依赖 item checkpoint
  field comparison，未统一要求当前 book lease 文件仍由同一 generation/token
  持有。虽然这降低了 stale checkpoint 覆盖风险，但仍未达到基准中
  “checkpoint 写前必须校验 book lease”的严格口径。

必须修复：

- 在 qmd SQLite/corpus mutation 前校验当前 batch book lease，而不是写完后才由
  `recordQmdCorpusRegistration` 间接校验。
- 让 `writeGraphRagOutputProducerManifest` 或其调用链在写入
  `qmd_output_manifest.json` 前校验 book lease generation/token。
- 对 running item 的 terminal checkpoint/event/manifest 关键写路径统一应用
  item fencing 与 book fencing，避免 lease loss 后继续发布 terminal 状态。

### RA2-B2: qmd SQLite busy/locked bounded retry 与 observable metric 仍缺失

- 影响基准：7, 10
- 严重级别：blocking
- 状态：未闭合（partially fixed, still open）

固定基准 7 要求 `.qmd/index.sqlite` 与 qmd corpus 写入由 qmd index writer lane
和 file lock 串行化，同时 SQLite `busy` 或 `locked` 必须按 bounded local
retry 分类，并通过可观测 retry metric 暴露。

当前实现已补上两个重要部分：

- batch runner 对 qmd writer commands 使用 `qmdIndexWriterLane` 与
  `${qmdIndexPath}.lock`。
- GraphRAG book runtime 的 qmd corpus registration 也使用
  `withQmdIndexFileLock`。

但 SQLite 层仍无可核验的 `SQLITE_BUSY`/`SQLITE_LOCKED` 分类、bounded local
retry 或 retry metric。`src/store.ts:855` 至 `868` 仅初始化 sqlite-vec、
`PRAGMA journal_mode = WAL` 与 foreign keys；复核未发现 `busy_timeout`、
`SQLITE_BUSY`、`SQLITE_LOCKED`、`database is locked` 分类 retry 或 metric
事件。新增测试 `qmd writer commands acquire the qmd index file lock` 只验证了
file lock acquire/release，没有覆盖 SQLite lock contention、bounded retry
次数、分类或 metric。

必须修复：

- 在 qmd index 写入路径对 SQLite busy/locked 错误做 bounded retry，并设置最大
  retry/等待预算。
- 将 busy/locked retry 分类与 retry count/wait metric 暴露到 batch event 或
  recovery/status JSON。
- 增加 SQLite contention 测试，验证 retry 发生、受限、可观测，并且不会破坏
  index/corpus 一致性。

### RA2-B3: takeover reconciliation 未杀掉 live orphan subprocess/process group

- 影响基准：1, 8, 10
- 严重级别：blocking
- 状态：未闭合（partially fixed, still open）

固定基准 1 要求同 `runId` 单 coordinator 有 durable lock、heartbeat、过期接管
检查和 subprocess registry reconciliation。固定基准 8 要求不可恢复失败在新
claim 前 quiesce scheduler，并保持 failure/wait 语义区分。

当前实现已改进：

- `coordinator-lock.json` 持久化 runner session、generation、fencing token、
  heartbeat 与 expiry。
- 若 expired lock 的 PID 仍在同主机存活，会拒绝 takeover。
- 正常运行中的 child process 记录到 subprocess registry；当前进程内的 active
  child 可通过 process group 终止。

剩余问题在 takeover/reconciliation 场景：

- `scripts/graphrag/batch-epub-workflow.mjs:3058` 至 `3088` 的
  `recoverCoordinatorRuntimeArtifacts` 对 subprocess registry 只在
  `record.runnerHost !== runnerHost` 或 `!processAlive(record.pid)` 时标记为
  `killed`/`ORPHAN_RECOVERED`。若旧 coordinator 已死亡、coordinator lock 已可
  接管，但同主机 detached child/process group 仍存活，该函数不会调用
  `process.kill(record.pid)` 或 `process.kill(-record.pid)`。
- `terminateActiveSubprocesses` 只覆盖当前 coordinator 进程内的
  `activeChildProcesses`，不能覆盖 takeover 后 registry 中的旧 live
  subprocess。
- 因此新 coordinator 可以获得同 `runId` lock，但旧 live child 仍可能继续写
  GraphRAG/qmd 产物或占用 provider/qmd resource；这与 single coordinator
  fencing 和 quiesce 要求不一致。

必须修复：

- takeover/reconciliation 时，对同主机、registry 中仍 live 且属于旧 runner
  session 的 subprocess/process group 执行有界 SIGTERM/SIGKILL。
- 终止后更新 subprocess record，并释放或恢复关联 provider slot/book lease。
- 增加测试覆盖：旧 coordinator lock 可接管、旧 runner PID dead、旧 child PID
  live 时，新 coordinator 必须杀掉旧 process group 后再 claim 新 item。

### RA2-B4: 生产级测试覆盖仍未满足固定基准 10

- 影响基准：10，并间接影响 1, 2, 3, 5, 7, 8, 9
- 严重级别：blocking
- 状态：未闭合（partially fixed, still open）

测试覆盖有明显增加，且用户提供的主控命令显示新增/聚焦测试已通过：

- live coordinator 拒绝、expired lock live PID 拒绝。
- provider slot lease recovery 与 durable capacity gate。
- `book-concurrency 2` worker pool 与 `book-concurrency 1` sequential 行为。
- partial event tail recovery 与 duplicate event id normalization。
- book-state stale book lease fencing。
- batch execution bus contract。
- qmd writer commands acquire qmd index file lock。

但固定基准 10 要求的若干生产级场景仍无充分覆盖：

- duplicate book 排他（同一 `bookId` 的重复 item 不得并发执行）缺少直接黑盒
  并发测试；现有并行测试主要验证不同书并发。
- stale item claim fencing 缺少直接测试；当前新增 book-state 测试覆盖的是
  book lease fencing，不是 batch item checkpoint fencing 的 stale writer。
- qmd SQLite busy/locked contention、bounded retry、retry metric 缺少测试。
- coordinator takeover 后旧 live subprocess/process group kill 缺少测试。
- temp file recovery 与 manifest drift/event reconciliation 的完整组合测试仍
  不充分；partial tail 与 duplicate event 已覆盖，但 temp file recovery 未见
  直接测试。
- fail-fast/provider auth/quiesce 有若干状态测试，但缺少“不可恢复失败发生时
  不再新 claim，并终止已启动 sibling subprocess”的并行取消测试。

必须修复：

- 为上述未覆盖场景补充 focused production tests，并将断言落到 durable files、
  events、manifest/recovery-summary 与 subprocess/provider/book lease 记录上。
- 对每个修复的 blocking 行为增加回归测试，避免仅凭结构存在判断通过。

## Criteria-by-Criteria Result

| # | 固定基准 | 复审结果 | 说明 |
|---|---|---|---|
| 1 | 同 runId 单协调器 | partial | lock、heartbeat、live PID 拒绝已实现；takeover 下 live orphan subprocess kill 未满足。 |
| 2 | Item claim 与 fencing | partial | running claim 有 durable fields；qmd corpus/producer manifest 与部分 terminal 写路径仍未统一写前 fencing。 |
| 3 | Book 级互斥 | partial | book lease 与 repository fencing 已增强；qmd corpus/producer manifest 写前 book fencing 仍缺口。 |
| 4 | 顺序兼容 | pass | `--book-concurrency 1` 顺序行为已有聚焦测试证据。 |
| 5 | Manifest 与 event 一致性 | partial | eventId/sequence、partial tail、duplicate event 已修复；temp file recovery 覆盖不足。 |
| 6 | Provider slot 治理 | pass | durable lease、registry lock、wait/release/recovery/status visibility 有实现与测试证据。 |
| 7 | qmd index 写入安全 | fail | writer lane 与 file lock 已修复；SQLite busy/locked bounded retry 与 metric 缺失。 |
| 8 | 失败与等待语义 | partial | fail-fast/transient/provider auth 语义增强；takeover live subprocess quiesce 仍未满足。 |
| 9 | GraphRAG 闭环 gate | partial | qmd build、producer lineage、artifact、corpus、query check gate 增强；producer manifest/qmd corpus fencing 缺口仍影响闭环可信度。 |
| 10 | 生产级测试覆盖 | fail | 新增覆盖有效，但缺少 stale item fencing、duplicate book exclusion、SQLite contention、takeover orphan kill 等强制场景。 |

## reaudit_1 blocking findings 关闭情况

- P0-1 item/book fencing 覆盖：部分关闭。Repository 写路径加强，但 qmd
  SQLite/corpus 与 GraphRAG producer manifest 写前 fencing 仍未闭合。
- P0-2 provider slot durable capacity：已关闭。Provider slot lease 作为
  durable capacity gate 使用，并有 acquire/release/recovery/status 证据。
- P0-3 qmd SQLite writer safety：部分关闭。qmd index file lock 已实现并有
  测试；SQLite busy/locked bounded retry metric 仍未闭合。
- P0-4 event/manifest recovery：部分关闭。partial tail 与 duplicate event 已
  修复；temp file recovery 覆盖仍不足。
- P0-5 fail-fast/stop/lease loss/takeover quiesce：部分关闭。当前进程内
  active subprocess kill 已实现；takeover 后 registry live orphan kill 未闭合。
- P0-6 tests：部分关闭。新增测试有效，但固定基准 10 的若干强制场景仍缺失。

## Evidence Notes

已复核的关键实现证据包括：

- `scripts/graphrag/batch-epub-workflow.mjs:316` 至 `351`：
  lease/coordinator/provider/book schemas。
- `scripts/graphrag/batch-epub-workflow.mjs:2204` 至 `2296`：
  durable book lease acquire/refresh/release。
- `scripts/graphrag/batch-epub-workflow.mjs:2534` 至 `2629`：
  durable provider slot lease acquire/release/recovery events。
- `scripts/graphrag/batch-epub-workflow.mjs:2354` 至 `2428`：
  qmd index file lock。
- `scripts/graphrag/batch-epub-workflow.mjs:2987` 至 `3047`：
  partial/duplicate event recovery normalization。
- `scripts/graphrag/batch-epub-workflow.mjs:3058` 至 `3088`：
  subprocess registry reconciliation 缺少 live orphan kill。
- `scripts/graphrag/batch-epub-workflow.mjs:6996` 至 `7066`：
  item running claim 与 fencing fields。
- `src/job-state/repository.ts:1106` 至 `1176`：
  repository-level book lease fencing。
- `src/job-state/repository.ts:2958` 至 `3103`：
  stage checkpoint/query_ready gate。
- `src/job-state/graphrag-book.ts:1016` 至 `1040`：
  qmd SQLite 写入先于 qmd corpus registration fencing。
- `src/job-state/graphrag-book.ts:1384` 至 `1426`：
  producer manifest durable write 缺少 book lease assertion。
- `test/cli.test.ts:2281` 至 `2688`：
  coordinator/provider slot/qmd file lock/parallel/sequential focused tests。
- `test/book-job-state.test.ts:1059` 至 `1237`：
  stale batch book lease fencing tests。
