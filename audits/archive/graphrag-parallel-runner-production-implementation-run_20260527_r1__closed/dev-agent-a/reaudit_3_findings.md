# GraphRAG 多书并行 Runner 实施复审 findings: reaudit_3

## 审计范围

- 固定基准来源：
  `audits/graphrag-parallel-runner-production-implementation-run_20260527_r1__open/dev-agent-a/criteria.md`
- 基准版本（criteria version）：
  `sha256:e763182a90d9aeeeafa11f21379473a3a8e2218dc5d81bbbe9fef6625d9281ca`
- 复审对象：当前工作树中的 GraphRAG 多书并行 Runner 实现与测试。
- 约束：未新建审计目录，未修改 `criteria.md`，未读取或输出 `.env`、
  密钥或凭据，未修改生产源码。

## 总体结论

`status: fail`

当前工作树已修复 `reaudit_2` 的若干高风险实现项：同 `runId`
coordinator lock 拒绝路径已 fail-closed，live lock 拒绝不会写
`events.jsonl` 或补 `coordinator-lock.json.sha256`；provider slot 已作为
durable lease 容量门使用，并具备 stale recovery 与 release fencing；
same-host live orphan subprocess reconciliation 已加入 SIGTERM/SIGKILL，
remote orphan 会 quarantine 并请求 stop；event log normalization、manifest
rebuild、provider wait exhaustion、status-json 不写路径也有实现证据。

但按 `criteria.md` 10 条固定基准全量复审后，仍有阻塞项。核心缺口仍是：
qmd corpus 与 GraphRAG producer manifest 写路径没有在写入前完成 book lease
fencing；SQLite `busy`/`locked` bounded retry 与可观测 metric 未实现；生产级
测试仍未覆盖固定基准要求的若干并发与恢复场景。因此本轮不能通过。

## Blocking Findings

### RA3-B1: qmd corpus 与 producer manifest 仍可在 book fencing 前写入

- 影响基准：2, 3, 9
- 严重级别：blocking
- 状态：未闭合（still open）
- 位置：
  - `src/job-state/graphrag-book.ts:1016`
  - `src/job-state/graphrag-book.ts:1040`
  - `src/job-state/graphrag-book.ts:1384`
  - `src/job-state/graphrag-book.ts:1423`
  - `scripts/graphrag/resume-book-workspace.mjs:1192`
  - `scripts/graphrag/resume-book-workspace.mjs:1208`
  - `scripts/graphrag/resume-book-workspace.mjs:1341`
  - `scripts/graphrag/resume-book-workspace.mjs:1370`

固定基准 2 要求写入 checkpoint、event、manifest、catalog、artifact 或 qmd
产物前校验 item/book fencing；固定基准 3 要求同一本书的 qmd、GraphRAG、
checkpoint、artifact、query-ready producer 受持久 book lease 排他保护；固定
基准 9 要求 completed item 的 GraphRAG 闭环证据不能被 stale runner 弱化。

当前 repository 层已有 book lease fencing：
`src/job-state/repository.ts:1106` 校验 batch book lease，
`src/job-state/repository.ts:1729` 在 qmd corpus registration 前校验，
`src/job-state/repository.ts:2961` 在 stage checkpoint 写入前校验。runner 也会将
book lease generation/token 传给子进程：
`scripts/graphrag/batch-epub-workflow.mjs:6409` 至 `6415`。

但是两个实际产物写路径仍在 repository fencing 之前发生：

- `registerQmdCorpusDocument` 在 `src/job-state/graphrag-book.ts:1016` 进入
  qmd index file lock 后，先执行 `createStore`、`upsertStoreCollection`、
  `insertContent`、`insertDocument` 等 SQLite/corpus mutation；直到
  `src/job-state/graphrag-book.ts:1040` 才调用
  `repo.recordQmdCorpusRegistration`。若子进程已经 stale，repository 会拒绝
  registration，但 `.qmd/index.sqlite` 已经被修改。
- `writeGraphRagOutputProducerManifest` 在
  `src/job-state/graphrag-book.ts:1384` 至 `1426` 直接写
  `qmd_output_manifest.json`，函数本身没有读取或校验 book lease。
  `resume-book-workspace.mjs` 在 `repo.completeStage` 之前调用该函数，例如
  `scripts/graphrag/resume-book-workspace.mjs:1192` 写 manifest，
  `scripts/graphrag/resume-book-workspace.mjs:1208` 才 complete stage；另一个
  主路径在 `scripts/graphrag/resume-book-workspace.mjs:1341` 写 manifest，
  `scripts/graphrag/resume-book-workspace.mjs:1370` 才 complete stage。

这仍违反“写前校验”（pre-write fencing）要求。stale child process 可以先修改
qmd corpus 或覆盖 GraphRAG producer manifest，然后才在 fenced repository 写入
处失败。该窗口会削弱 book-scoped mutual exclusion 与 GraphRAG closed-loop gate。

必须修复：

- 在 qmd SQLite/corpus mutation 之前公开并调用 book/document lease assertion，
  或将 qmd corpus mutation 包进同一个 fenced repository 操作中。
- 让 `writeGraphRagOutputProducerManifest` 接收并校验当前 book lease
  generation/token，或在调用前执行不可绕过的 fenced preflight，并保证校验与
  manifest atomic write 在同一受控路径内。
- 补充 stale lease 回归测试：stale child 调用 qmd corpus registration 或
  producer manifest 写入时，不得修改 `.qmd/index.sqlite`、
  `qmd_output_manifest.json` 或后续 closed-loop publication。

### RA3-B2: SQLite busy/locked bounded retry 与可观测 metric 仍缺失

- 影响基准：7, 10
- 严重级别：blocking
- 状态：未闭合（still open）
- 位置：
  - `src/store.ts:855`
  - `src/store.ts:867`
  - `src/job-state/graphrag-book.ts:1089`
  - `src/job-state/graphrag-book.ts:1115`
  - `scripts/graphrag/batch-epub-workflow.mjs:2377`
  - `scripts/graphrag/batch-epub-workflow.mjs:2445`
  - `test/cli.test.ts:2759`

固定基准 7 要求所有 `.qmd/index.sqlite` 与 qmd corpus 写入由 qmd index writer
lane 和 file lock 串行化，同时 SQLite `busy` 或 `locked` 必须按 bounded local
retry 分类，并通过可观测 retry metric 暴露。固定基准 10 要求测试覆盖 qmd
SQLite lock contention。

当前实现已具备 qmd index writer lane 与 file lock：
`scripts/graphrag/batch-epub-workflow.mjs:2377` 至 `2450` 是 runner 侧 file
lock；`src/job-state/graphrag-book.ts:1089` 至 `1132` 是 book runtime 侧 file
lock；`test/cli.test.ts:2759` 的测试验证 writer commands acquire/release file
lock。

但 SQLite 层仍未满足固定基准：

- `src/store.ts:855` 至 `868` 初始化数据库时仅加载 sqlite-vec、设置 WAL 与
  foreign keys；未发现 `PRAGMA busy_timeout`、`SQLITE_BUSY`、
  `SQLITE_LOCKED`、`database is locked` 分类、bounded retry budget 或 retry
  metric。
- qmd file lock 的等待逻辑只处理 lock file 的 `EEXIST` 与 stale lock，
  例如 `src/job-state/graphrag-book.ts:1115` 与
  `scripts/graphrag/batch-epub-workflow.mjs:2445` 的超时；这不是 SQLite
  busy/locked retry。
- 当前测试只验证 file lock acquire/release，没有模拟 SQLite contention，也未
  断言 retry 次数、等待时间、分类事件或 status/recovery-summary 可见性。

该缺口是 blocking，因为 file lock 不能替代数据库层 bounded retry。实际部署中
仍可能出现外部进程、旧 qmd 命令或 SQLite WAL 状态导致的 `busy`/`locked`，而
当前 runner 无法按固定基准给出受限重试和可观测证据。

必须修复：

- 在 qmd index/corpus 写入路径加入 SQLite busy/locked 分类器，覆盖
  `SQLITE_BUSY`、`SQLITE_LOCKED` 与常见 `database is locked` 消息。
- 为 SQLite 写操作设置 bounded local retry budget、最大等待时间与失败分类。
- 将 retry count、waitMs、final classification 暴露为 batch event、metric 或
  recovery-summary/status-json 字段。
- 增加 contention 测试，持有 SQLite write lock 后触发 qmd corpus/index 写入，
  断言 bounded retry、metric 可见、预算耗尽行为和最终一致性。

### RA3-B3: 固定基准 10 的生产级测试覆盖仍不完整

- 影响基准：10，并间接影响 1, 2, 3, 5, 7, 8, 9
- 严重级别：blocking
- 状态：部分闭合（partially fixed, still blocking）
- 位置：
  - `test/cli.test.ts:2141`
  - `test/cli.test.ts:2446`
  - `test/cli.test.ts:2675`
  - `test/cli.test.ts:2759`
  - `test/book-job-state.test.ts:1059`
  - `test/book-job-state.test.ts:1152`
  - `scripts/graphrag/batch-epub-workflow.mjs:3269`
  - `scripts/graphrag/batch-epub-workflow.mjs:3272`
  - `scripts/graphrag/batch-epub-workflow.mjs:8066`
  - `scripts/graphrag/batch-epub-workflow.mjs:8574`

本轮新增/现有测试覆盖了多项上一轮缺口：

- `test/cli.test.ts:2446` 验证 `--book-concurrency 2` worker pool。
- `test/cli.test.ts:2796` 验证 `--book-concurrency 1` 顺序执行。
- `test/cli.test.ts:2516` 与 `test/cli.test.ts:2611` 验证 provider slot stale
  recovery 与 durable capacity gate。
- `test/cli.test.ts:2653` 验证 provider slot release fencing 的正向路径。
- `test/cli.test.ts:3702` 与 `test/cli.test.ts:3816` 验证 partial event tail 与
  duplicate eventId normalization。
- `test/cli.test.ts:13134` 验证 manifest 与 durable checkpoints 不一致时重建。
- `test/book-job-state.test.ts:1059` 与 `1152` 验证 repository 级 book lease
  fencing。

但固定基准 10 要求的生产级覆盖仍缺失或不足：

- duplicate book exclusion 没有直接黑盒测试。`runParallelRunnerFixture` 在
  `test/cli.test.ts:2141` 至 `2150` 创建的是两个不同 source/hash/bookId；
  `test/cli.test.ts:2446` 的并行测试证明不同书并发，但不证明同一 canonical
  `bookId` 的重复 item 不会并发进入 qmd/GraphRAG producer。
- stale item claim fencing 没有直接测试。当前 `book-job-state` 测试覆盖
  repository book lease fencing，但没有覆盖 batch item checkpoint/event 的 stale
  `runnerSessionId`、item fencing token、lease generation 被拒绝。
- qmd SQLite contention、bounded retry 与 retry metric 没有测试；这与 RA3-B2
  的实现缺口一致。
- coordinator recovery 的 same-host live orphan termination 没有 focused test。
  实现已在 `scripts/graphrag/batch-epub-workflow.mjs:3269` 至 `3272` 加入
  SIGTERM/SIGKILL，但当前测试只覆盖
  `test/cli.test.ts:2675` 的 remote orphan quarantine。
- durable JSON temp/checksum reconciliation 没有直接测试。实现事件包括
  `durable_json_temp_reconciled`、`durable_json_checksum_backfilled` 与
  `durable_json_target_quarantined`，但测试未覆盖 temp file、checksum backfill 或
  checksum mismatch quarantine。
- fail-fast/non-transient quiesce 的并行 sibling cancellation 仍缺少端到端测试。
  实现路径在 `scripts/graphrag/batch-epub-workflow.mjs:8066` 至 `8073` 以及
  `8574` 至 `8597` 调用 `terminateActiveSubprocesses`，但测试未断言不可恢复失败
  发生后不再新 claim、已启动 sibling subprocess 被终止、durable events/registry
  可观测。

这些不是单纯覆盖率偏好，而是固定基准 10 明确列出的强制场景。缺少这些测试时，
当前生产实现无法按固定审计基准判定为 pass。

必须修复：

- 增加 duplicate book 并发排他测试，构造两个 item 解析为同一 canonical
  `bookId`，断言第二个 item 只出现 `item_book_running_observed`/deferred，不会
  并发执行 qmd、GraphRAG、checkpoint、artifact 或 query-ready producer。
- 增加 stale item checkpoint/event fencing 测试，覆盖 stale runner 写 terminal
  checkpoint 与 event 被拒绝。
- 增加 qmd SQLite contention + retry metric 测试，与 RA3-B2 的实现同步。
- 增加 same-host live orphan subprocess takeover 测试，旧 coordinator PID dead、
  child PID live 时，新 coordinator 必须 terminate/quarantine 后再继续。
- 增加 durable JSON temp/checksum reconciliation 测试，并断言 status-json 不写。
- 增加 fail-fast/non-transient 并行 quiesce 测试，断言不再新 claim、sibling
  subprocess registry 进入 killed/quarantined 终态，事件和 manifest 可重建。

## Criteria-by-Criteria Result

| # | 固定基准 | 复审结果 | 说明 |
|---|---|---|---|
| 1 | 同 runId 单协调器 | partial | durable lock、heartbeat、live PID 拒绝、fail-closed 拒绝路径与 same-host orphan termination 实现存在；live orphan termination 缺少 focused 测试。 |
| 2 | Item claim 与 fencing | partial | item claim 包含 runner session、worker、generation、expiresAt、fencing token；event 与 terminal checkpoint 有部分 fencing；qmd corpus 与 producer manifest 写前 fencing 仍缺失。 |
| 3 | Book 级互斥 | partial | durable book lease 与 repository 写 fencing 已增强；重复 book 黑盒测试缺失，qmd corpus/producer manifest 仍可在 fencing 前写。 |
| 4 | 顺序兼容 | pass | `--book-concurrency 1` 顺序执行测试存在，且 worker pool 只在 concurrency 大于 1 时启用。 |
| 5 | Manifest 与 event 一致性 | partial | eventId/sequence normalization、partial tail、duplicate event、manifest checkpoint projection rebuild 已实现并测试；durable JSON temp/checksum reconciliation 缺少测试。 |
| 6 | Provider slot 治理 | pass | provider slot durable lease、capacity gate、wait metric、release event、stale recovery、release fencing 与 status visibility 有实现与测试证据。 |
| 7 | qmd index 写入安全 | fail | writer lane 与 file lock 已实现；SQLite busy/locked bounded retry 与 observable retry metric 未实现。 |
| 8 | 失败与等待语义 | partial | provider wait exhaustion 不再保持 runnable pending，non-transient stop 会请求 quiesce；并行 sibling cancellation/quiesce 缺少端到端测试。 |
| 9 | GraphRAG 闭环 gate | partial | qmd build evidence、producer lineage、artifact、qmd corpus registration、query check gate 已增强；qmd corpus/producer manifest 写前 fencing 缺口仍削弱闭环发布可信度。 |
| 10 | 生产级测试覆盖 | fail | 新增测试有效，但 duplicate book exclusion、stale item fencing、SQLite contention metric、live orphan kill、durable JSON temp/checksum、并行 quiesce 仍不足。 |

## reaudit_2 blocking findings 关闭情况

- RA2-B1：未闭合。Repository book fencing 已增强，但 qmd corpus 与 producer
  manifest 仍存在写前 fencing 缺口。
- RA2-B2：未闭合。qmd writer lane 与 file lock 已有测试；SQLite busy/locked
  bounded retry 与 metric 仍缺失。
- RA2-B3：实现侧基本闭合。same-host live orphan subprocess 已有
  SIGTERM/SIGKILL，remote orphan 会 quarantine；但 live orphan termination 缺少
  production test，计入 RA3-B3。
- RA2-B4：部分闭合。新增测试覆盖 coordinator lock、provider slot、worker pool、
  event normalization、manifest rebuild、repository book fencing；固定基准 10 的
  关键剩余场景仍未闭合。

## 已验证覆盖

- 单进程 coordinator + `--book-concurrency` worker pool 已存在：
  `scripts/graphrag/batch-epub-workflow.mjs:7973` 至 `8097`。
- coordinator lock 拒绝路径先检查 live lock，再写新 lock；测试断言拒绝时不写
  events/checksum：`scripts/graphrag/batch-epub-workflow.mjs:3365` 至 `3380`，
  `test/cli.test.ts:2380` 至 `2443`。
- provider slot durable capacity gate、stale recovery、release fencing 已实现：
  `scripts/graphrag/batch-epub-workflow.mjs:2547` 至 `2668`。
- same-host live orphan subprocess termination 与 remote quarantine 实现存在：
  `scripts/graphrag/batch-epub-workflow.mjs:3258` 至 `3335`。
- event log deterministic normalization 已实现：
  `scripts/graphrag/batch-epub-workflow.mjs:3162` 至 `3247`。
- manifest/status 从 checkpoints 派生并可重建：
  `scripts/graphrag/batch-epub-workflow.mjs:5660` 至 `5744`。
- provider recovery wait exhaustion 会转为 failed/stop_until_fixed，并清除
  `nextRetryAt`/`retryDelaySeconds`：
  `scripts/graphrag/batch-epub-workflow.mjs:7452` 至 `7516`。
- status-json 路径不获取 coordinator lock，durable JSON reconcile 在 status-json
  下不写：
  `scripts/graphrag/batch-epub-workflow.mjs:2936` 与 `8132` 至 `8159`。

## Evidence Commands

主控已报告通过的命令：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `npm run test:types -- --pretty false`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli.test.ts -t "rejects a second live coordinator|rejects coordinator takeover when expired lock pid is still alive|recovers stale provider slot leases|durable provider slots gate capacity|provider slot stale release|book-concurrency 2 runs multiple books through the worker pool|book-concurrency 1 preserves sequential book execution|migrate-only recovers a partial event log tail|migrate-only normalizes duplicate event ids|qmd writer commands acquire the qmd index file lock|normal run exits after provider recovery wait limit|provider recovery wait limit preserves checkpoint identity during catalog drift|restart quarantines remote orphan subprocess records|rebuilds manifest mismatched with durable checkpoints"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts -t "rejects stage checkpoint writes with stale batch book lease fencing|rejects artifact and run catalog writes with stale batch book lease fencing"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/integrations/contracts.test.ts -t "accepts batch execution bus envelopes"`

本轮只读复审使用的命令包括：

- `sed -n '1,240p' audits/graphrag-parallel-runner-production-implementation-run_20260527_r1__open/dev-agent-a/criteria.md`
- `sed -n '1,260p' audits/graphrag-parallel-runner-production-implementation-run_20260527_r1__open/dev-agent-a/reaudit_2_findings.md`
- `git status --short`
- `rg -n "coordinator|subprocess|orphan|quarantine|process\\.kill|terminateActiveSubprocesses" scripts/graphrag/batch-epub-workflow.mjs`
- `rg -n "SQLITE_BUSY|SQLITE_LOCKED|database is locked|busy_timeout|sqlite.*retry|contention" src/store.ts src/db.ts src/job-state/graphrag-book.ts scripts/graphrag/batch-epub-workflow.mjs test/cli.test.ts test/book-job-state.test.ts`
- `rg -n "recordQmdCorpusRegistration|qmd_output_manifest|stale.*item|duplicate book|book_running_observed" test/cli.test.ts test/book-job-state.test.ts scripts/graphrag/resume-book-workspace.mjs src/job-state/graphrag-book.ts`
