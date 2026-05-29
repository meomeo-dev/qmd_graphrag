# GraphRAG 多书并行 Runner 实施复审 findings: reaudit_4

## 审计范围

- 固定基准来源：
  `/Users/jin/projects/qmd_graphrag/audits/graphrag-parallel-runner-production-implementation-run_20260527_r1__open/dev-agent-a/criteria.md`
- 基准版本（criteria version）：
  `sha256:e763182a90d9aeeeafa11f21379473a3a8e2218dc5d81bbbe9fef6625d9281ca`
- 复审对象：当前工作树中的 GraphRAG 多书并行 Runner 生产实现与测试。
- 约束：未新建审计目录，未修改 `criteria.md`，未读取或输出 `.env`、
  密钥或凭据，未修改生产源码或测试。

## 总体结论

`status: fail`

当前工作树已关闭 `reaudit_3` 的两个核心实现阻塞项：

- qmd corpus/index mutation 已在 SQLite 写入前、写入中和 repository registration
  前校验当前 batch book lease fencing：
  `src/job-state/graphrag-book.ts:1011` 至 `1078`。
- GraphRAG producer manifest 写入已接收 `repo`，写前和 durable write 前校验
  book lease；生产 resume 调用均传入 `repo`：
  `src/job-state/graphrag-book.ts:1528` 至 `1574`，
  `scripts/graphrag/resume-book-workspace.mjs:593` 至 `604`、
  `629` 至 `640`、`666` 至 `677`、`1195` 至 `1206`、
  `1345` 至 `1356`。
- SQLite `busy`/`locked` 已加入 bounded local retry、分类与 metric：
  `src/job-state/graphrag-book.ts:75` 至 `77`、`1081` 至 `1183`，
  并有 contention 测试：
  `test/graphrag-book-state.test.ts:2865` 至 `2973`。
- Terminal completion finalization fence 已覆盖 completed checkpoint、
  `item_completed` 与 `item_worker_completed`：
  `scripts/graphrag/batch-epub-workflow.mjs:2843` 至 `2962`、
  `7366` 至 `7399`、`8047` 至 `8055`，
  并有正向共享 fence 测试：
  `test/cli.test.ts:2516` 至 `2563`。

但按固定 10 条基准全量复审后，仍有阻塞项。主要问题是：
部分 repository book-state YAML 和 GraphRAG sidecar JSON 读路径未使用 durable
checksum/reconcile/quarantine 机制；固定第 10 条要求的生产级测试覆盖仍不完整。

## Blocking Findings

### RA4-B1: durable checksum/reconcile 未覆盖所有 book-state 与 GraphRAG sidecar 读路径

- 影响基准：5, 9
- 严重级别：blocking
- 状态：open
- 位置：
  - `src/job-state/repository.ts:327`
  - `src/job-state/repository.ts:393`
  - `src/job-state/repository.ts:412`
  - `src/job-state/repository.ts:1844`
  - `src/job-state/graphrag-book.ts:915`
  - `src/job-state/graphrag-book.ts:975`
  - `src/job-state/graphrag-book.ts:1284`
  - `src/job-state/graphrag-book.ts:1577`
  - `src/job-state/graphrag-book.ts:1606`
  - `src/job-state/artifact-validation.ts:177`
  - `test/graphrag-book-state.test.ts:3041`

固定基准 5 要求 manifest/status 从 durable checkpoint 和有效 event 派生，
恢复必须处理 temp file 与 drift；固定基准 9 要求 completed item 的 qmd/GraphRAG
闭环证据不能被 repair-only 或 projection state 弱化。本轮实现已增加 durable
YAML/JSON 写入 helper：repository YAML 读写会在通用路径中
`reconcileDurableYamlFile`、写 temp、写 `.sha256` 并 fsync
（`src/job-state/repository.ts:327` 至 `445`）；GraphRAG JSON helper 会解析、
清理 temp、补 checksum、checksum mismatch 或 invalid JSON quarantine
（`src/job-state/graphrag-book.ts:1577` 至 `1647`）。

问题在于这些 durable helper 没有覆盖所有生产读路径：

- `FileBookJobStateRepository.getBookJob` 在
  `src/job-state/repository.ts:1844` 至 `1848` 直接 `readFile` +
  `YAML.parse` book job YAML，没有先执行 `reconcileDurableYamlFile`。这会绕过
  book-state YAML checksum mismatch 检测、missing checksum backfill 和 corrupt
  quarantine。
- GraphRAG identity sidecar fallback 在
  `src/job-state/graphrag-book.ts:915` 至 `927` 直接读取
  `qmd_graph_text_unit_identity.json` 并解析，未先执行
  `reconcileDurableJsonFile`。无效 JSON 只会被当作不可用 fallback，不会 quarantine；
  checksum mismatch 也不会被发现。
- LanceDB row-count sidecar 作为 embed/query-ready 证据的一部分，但
  `src/job-state/artifact-validation.ts:177` 至 `194` 直接读取
  `qmd_row_count.json` 并接受正数 `rowCount`，未验证 `.sha256`，也不 quarantine
  invalid 或 checksum-mismatched sidecar。
- 当前新增 checksum/quarantine 测试只覆盖 producer manifest：
  `test/graphrag-book-state.test.ts:3041` 至 `3108`。未覆盖 book job YAML、
  graph text-unit identity sidecar 或 qmd row-count sidecar 的 checksum mismatch、
  missing checksum backfill、invalid target quarantine。

该问题仍阻塞，因为 GraphRAG closed-loop gate 依赖这些 sidecar 和 book-state
YAML 作为生产证据。即使写路径已经产生 `.sha256`，读路径不校验也会允许后续
流程忽略或接受被截断、篡改或无效的 sidecar/book state，无法满足“durable
checksum/reconcile/invalid quarantine”的生产基准。

建议修复方向：

- 将 `getBookJob` 改为通过 durable YAML read helper 读取，或公开一个统一的
  `readYamlFile`/`readBookJobFile` 路径，所有 book-state YAML 读都先 reconcile。
- 为 GraphRAG sidecar JSON 提供统一 durable read helper，读取
  `qmd_graph_text_unit_identity.json`、`qmd_row_count.json`、
  `qmd_output_manifest.json` 前均校验 checksum、清理 temp、补 checksum，并对
  invalid/checksum mismatch 进行 quarantine。
- 增加测试：book job YAML checksum mismatch quarantine；identity sidecar invalid
  JSON quarantine；row-count sidecar checksum mismatch 不得通过 embed/query-ready
  validation；missing checksum backfill 后仍可恢复。

### RA4-B2: 固定第 10 条生产级测试覆盖仍不完整

- 影响基准：10，并间接影响 1, 2, 3, 5, 8, 9
- 严重级别：blocking
- 状态：partially fixed, still open
- 位置：
  - `test/cli.test.ts:2141`
  - `test/cli.test.ts:2446`
  - `test/cli.test.ts:2516`
  - `test/cli.test.ts:2724`
  - `test/cli.test.ts:2808`
  - `test/cli.test.ts:2845`
  - `test/cli.test.ts:7649`
  - `test/cli.test.ts:8011`
  - `test/cli.test.ts:13023`
  - `scripts/graphrag/batch-epub-workflow.mjs:2880`
  - `scripts/graphrag/batch-epub-workflow.mjs:3360`
  - `scripts/graphrag/batch-epub-workflow.mjs:4007`
  - `scripts/graphrag/batch-epub-workflow.mjs:8131`
  - `scripts/graphrag/batch-epub-workflow.mjs:8180`
  - `scripts/graphrag/batch-epub-workflow.mjs:8632`
  - `scripts/graphrag/batch-epub-workflow.mjs:8688`

固定基准 10 明确要求测试覆盖 parallel/sequential worker、duplicate book 排他、
coordinator recovery、stale claim fencing、provider slot contention 与 leak
recovery、qmd SQLite lock contention、event/manifest reconciliation，以及
fail-fast/transient/provider wait 的持久证据。

本轮新增和既有测试已覆盖多项要求：

- parallel worker pool：
  `test/cli.test.ts:2446` 至 `2514`。
- `--book-concurrency 1` 顺序兼容：
  `test/cli.test.ts:2845` 至 `2865`。
- coordinator live-lock fail-closed：
  `test/cli.test.ts:2310` 至 `2444`。
- provider slot stale recovery、capacity gate、release fencing：
  `test/cli.test.ts:2565` 至 `2722`。
- qmd writer file lock：
  `test/cli.test.ts:2808` 至 `2843`。
- qmd SQLite contention retry metric：
  `test/graphrag-book-state.test.ts:2865` 至 `2973`。
- partial event tail、duplicate event id、manifest rebuild：
  `test/cli.test.ts:3761` 至 `3855`、`3875` 之后的 duplicate event test、
  `test/cli.test.ts:13193` 之后的 manifest rebuild test。
- provider recovery wait exhaustion：
  `test/cli.test.ts:4716` 至 `4848`。

仍缺少以下固定场景的直接生产级行为测试：

- duplicate canonical book 排他。`runParallelRunnerFixture` 在
  `test/cli.test.ts:2141` 至 `2150` 创建的是两个不同 EPUB、不同
  `sourceHash`/`bookId`；`test/cli.test.ts:13023` 至 `13095` 只证明相同内容的
  duplicate EPUB 有唯一 checkpoint，但默认 `bookId` 仍包含 path hash，不证明两个
  item 解析到同一 canonical `bookId` 时不会并发进入 worker/qmd/GraphRAG。实现
  路径在 `scripts/graphrag/batch-epub-workflow.mjs:8131` 至 `8142` 和
  `8632` 至 `8649`，但缺少黑盒断言。
- stale item claim/event fencing 负向拒绝。`test/cli.test.ts:2516` 至 `2563`
  只验证 terminal completion events 共享同一个 finalization fence；没有构造 stale
  `runnerSessionId`、item fencing token、lease generation 或 expired lease 并断言
  `assertEventItemFence` / `assertItemCheckpointFence` 拒绝写入。实现位置是
  `scripts/graphrag/batch-epub-workflow.mjs:2880` 至 `2962`、
  `4007` 至 `4050`。
- same-host live orphan subprocess termination。实现会在新 coordinator recovery 时
  对 dead parent/live child 执行 SIGTERM/SIGKILL：
  `scripts/graphrag/batch-epub-workflow.mjs:3360` 至 `3394`。现有测试
  `test/cli.test.ts:2724` 至 `2805` 只覆盖 remote orphan quarantine。
- parallel non-transient/fail-fast quiesce 与 active sibling subprocess termination。
  现有 non-transient/provider-auth tests 证明“下一本书不再启动”
  （`test/cli.test.ts:7649` 至 `7845`、`8011` 至 `8208`），但未在
  `--book-concurrency 2` 下断言一个 worker 出现不可恢复失败后：
  scheduler 不再新 claim、已启动 sibling subprocess 被
  `terminateActiveSubprocesses` 终止、subprocess registry/event/manifest 可重建。
  实现位置是 `scripts/graphrag/batch-epub-workflow.mjs:8180` 至 `8188`、
  `8688` 至 `8712`。
- durable JSON temp/checksum reconciliation 的 runner run files 和 GraphRAG
  sidecar 覆盖。runner 实现有 `durable_json_temp_reconciled`、
  `durable_json_checksum_backfilled`、`durable_json_target_quarantined`
  事件路径（`scripts/graphrag/batch-epub-workflow.mjs:3040` 至 `3085`），但未见
  focused tests 覆盖 temp cleanup、checksum backfill、checksum mismatch
  quarantine 和 `--status-json` 不写路径。GraphRAG sidecar JSON 的测试目前也只
  覆盖 producer manifest checksum，未覆盖 identity/row-count sidecar。

这些缺口不是一般覆盖率偏好，而是固定基准 10 明确列出的生产并发与恢复场景。
因此即使多个实现缺口已经闭合，本轮仍不能按固定审计基准判定为 pass。

建议修复方向：

- 增加 duplicate canonical book 测试：构造两个 item 解析到同一 `bookId`，在
  `--book-concurrency 2` 下断言第二个 item 只 deferred，且没有并发 qmd、
  GraphRAG、checkpoint、artifact 或 query-ready producer 写入。
- 增加 stale item claim/event fencing 负向测试，覆盖 stale terminal checkpoint、
  stale `item_completed`、stale `item_worker_completed`、expired lease。
- 增加 same-host live orphan subprocess 测试，证明 child 被终止或 quarantine，
  registry 进入终态，事件和 batch stop 语义正确。
- 增加 parallel quiesce 测试，证明不可恢复失败发生后 scheduler 不再新 claim，
  active sibling subprocess 被终止，durable events/registry/manifest 可重建。
- 增加 durable JSON/YAML sidecar tests，覆盖 temp、checksum backfill、
  checksum mismatch quarantine、invalid JSON quarantine 和 status-json 边界。

## Criteria-by-Criteria Result

| # | 固定基准 | 复审结果 | 说明 |
|---|---|---|---|
| 1 | 同 runId 单 coordinator | pass | Durable coordinator lock、heartbeat、expired takeover live-PID check、fail-closed live lock 拒绝、subprocess registry reconciliation 均存在；same-host orphan termination 有实现，测试覆盖仍计入第 10 条缺口。 |
| 2 | Item claim 与 fencing | pass | `markItemRunning` 写入 runner session、worker、lease generation、expiresAt、item fencing token 与 book fencing metadata；event、checkpoint、terminal completion、qmd corpus、producer manifest、repository writes 均有 fencing 实现证据。stale item 负向测试缺口计入第 10 条。 |
| 3 | Book 级互斥 | pass | Durable book lease、active same-book deferral、repository book lease fencing、qmd corpus 和 producer manifest 写前 book fencing 均存在。duplicate canonical book 黑盒测试缺口计入第 10 条。 |
| 4 | 顺序兼容 | pass | `--book-concurrency 1` 不进入 worker pool，并有顺序执行测试覆盖。 |
| 5 | Manifest 与 event 一致性 | partial | Event append 使用稳定 `eventId`/`sequence`，partial tail、duplicate event、manifest drift、runner JSON temp/checksum reconciliation 均有实现；但 repository book-state YAML direct read 与部分 GraphRAG sidecar JSON direct read 未统一执行 checksum/reconcile/quarantine。 |
| 6 | Provider slot 治理 | pass | Provider slot 是 durable lease，具备 generation、capacity gate、wait metric、release event、release fencing、stale recovery、status/manifest visibility。 |
| 7 | qmd index 写入安全 | pass | qmd writer lane + file lock 存在；SQLite `busy`/`locked` 已分类、bounded retry，并通过 `qmd-sqlite-retry-metrics.jsonl` 与 registration metadata 暴露。 |
| 8 | Failure/wait 语义 | pass | fail-fast、transient retry、provider recovery wait、provider auth、non-transient stop 已区分；provider wait exhaustion 会转 failed/stop_until_fixed；不可恢复失败会请求 batch stop 和 active subprocess termination。parallel sibling quiesce 测试缺口计入第 10 条。 |
| 9 | GraphRAG 闭环 gate | partial | qmd build evidence、producer lineage、book-scoped artifact、qmd corpus registration、query-ready validation、GraphRAG query check 均强化；但 row-count/identity sidecar durable read 缺口仍会削弱闭环证据的持久可信度。 |
| 10 | 生产级测试覆盖 | fail | 新测试已覆盖多项并发与恢复路径，但 duplicate canonical book 排他、stale item claim/event 负向拒绝、same-host live orphan termination、parallel quiesce、durable JSON/YAML sidecar recovery 仍缺少直接生产级行为测试。 |

## reaudit_3 blocking findings 关闭情况

- `RA3-B1`：已关闭。qmd corpus/index mutation 与 producer manifest 写入前均有
  current batch book lease fencing，并有 stale lease 测试证明 stale child 不会改变
  qmd index 或 manifest。
- `RA3-B2`：已关闭。SQLite `busy`/`locked` bounded retry、分类和 metric 已实现，
  并有 contention 测试。
- `RA3-B3`：部分关闭但仍阻塞，转为 `RA4-B2`。新增测试覆盖了 qmd SQLite
  contention、terminal finalization fence、producer manifest checksum 等路径；
  固定第 10 条仍有若干强制场景未覆盖。

## Evidence Commands

本轮复审以只读源码与测试检查为主，未重跑完整测试套件。以下命令和主控已报告通过的
命令构成本轮证据：

- `shasum -a 256 audits/graphrag-parallel-runner-production-implementation-run_20260527_r1__open/dev-agent-a/criteria.md`
- `git status --short`
- `rg -n "activeRunningBookCheckpoint|acquireBookLease|assertEventItemFence|assertItemCheckpointFence|terminalFinalization" scripts/graphrag/batch-epub-workflow.mjs test/cli.test.ts`
- `rg -n "registerQmdCorpusDocument|writeGraphRagOutputProducerManifest|SQLITE_BUSY|SQLITE_LOCKED|qmd-sqlite-retry" src/job-state/graphrag-book.ts test/graphrag-book-state.test.ts`
- `rg -n "qmd_graph_text_unit_identity|qmd_row_count|reconcileDurableJsonFile|durable YAML|checksum" src/job-state test`
- 主控已报告通过：`node --check scripts/graphrag/batch-epub-workflow.mjs`
- 主控已报告通过：`node --check scripts/graphrag/resume-book-workspace.mjs`
- 主控已报告通过：`node --check scripts/graphrag/batch-failure-classifier.mjs`
- 主控已报告通过：`npm run test:types -- --pretty false`
- 主控已报告通过 focused CLI、book-state、GraphRAG book-state 与 contracts tests。
