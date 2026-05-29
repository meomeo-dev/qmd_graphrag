# GraphRAG 多书并行 Runner 生产实现 reaudit_5 发现

## 结论

复审状态：**fail**。

本轮只使用 `dev-agent-b/criteria.md` 的 10 条固定基准，并基于当前
worktree 做只读实施复审。上一轮阻塞项已有明显进展：

- terminal checkpoint 与 `item_completed`、`item_worker_completed` 已共享
  terminal finalization fence，并有 stale checkpoint 负向黑盒测试。
- qmd corpus/index SQLite mutation 前已有 current batch book lease 校验，
  SQLite busy/locked 有有界重试、分类和指标。
- repository book-state YAML 写入已增加 checksum、same-dir temp、fsync、
  atomic rename、parent fsync、temp 清理和 corrupt target quarantine。
- GraphRAG identity sidecar、producer manifest、LanceDB row-count sidecar 在
  `src/job-state` 库路径已走 durable JSON helper。
- worker pool 对 duplicate canonical book、parallel non-transient quiesce、
  sibling subprocess termination、same-host live orphan termination 有新增
  行为测试。

但按固定基准全量复核，仍有阻塞项。主要缺口是：生产 batch runner 的
terminal evidence gate 仍直接读取 book-state YAML、producer manifest 和
LanceDB row-count sidecar，绕过 checksum/reconcile/quarantine；同时
`graph-capabilities.yaml` 发布仍是非 durable catalog write，且发布前没有
重新验证 current batch book lease/fencing。

## 固定基准逐条判定

| 基准 | 判定 | 结论 |
| --- | --- | --- |
| 1. Durable single coordinator ownership | pass | coordinator lock 含 session/pid/host/heartbeat/expiry/generation/fencing；第二 live coordinator fail-closed。 |
| 2. Item and book ownership use lease fencing | fail | 主要 checkpoint、qmd index、producer manifest 已 fenced；但 graph capability catalog 发布没有 current book lease/fencing recheck。 |
| 3. Provider concurrency at child boundary | pass | provider/qmd writer subprocess 在 coordinator-granted durable slot lease 后启动；capacity、stale recovery、release metadata 可观测。 |
| 4. Durable writes are crash recoverable | fail | repository YAML 与 GraphRAG JSON helper 已增强；但 runner terminal evidence 读路径和 graph capability catalog 仍绕过 durable protocol。 |
| 5. Event logs authoritative audit trails | pass | event id/sequence、atomic append fsync、partial tail 和 duplicate id deterministic normalization 已覆盖。 |
| 6. Manifest and status derived caches | pass | manifest/status 从 durable checkpoints 重算，mismatch rebuild 已有行为测试。 |
| 7. Terminal completion evidence gated | fail | terminal gate 对 qmd/GraphRAG/query evidence 有 gate，但 runner 读取 producer/row-count/book-state evidence 时不校验 checksum。 |
| 8. Stable terminal/retry states | pass | non-transient stop_until_fixed 与 transient exhaustion 的 deterministic terminal/retry 状态已覆盖。 |
| 9. Crash/restart live subprocess recovery | fail | live orphan 与 stale checkpoint commit 已加强；但 graph capability catalog 仍可在 takeover 边界后被 stale worker 追加。 |
| 10. Behavioral recovery tests | fail | 新增黑盒测试覆盖多项重点；但缺 runner terminal durable sidecar recovery 与 graph capability catalog fencing/durable negative tests。 |

## 前序阻塞项闭合情况

- terminal finalization fence：**已基本闭合**。`event()` 在 terminal event
  上调用 `assertTerminalEventFinalizationFence()`，要求 payload fence 与
  completed checkpoint metadata 中的 finalization token/book/item fence 一致。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:2843` 到 `2960`、
  `scripts/graphrag/batch-epub-workflow.mjs:7366` 到 `7399`、
  `scripts/graphrag/batch-epub-workflow.mjs:8047` 到 `8055`；测试：
  `test/cli.test.ts:2684` 到 `2825`。
- qmd corpus/index write fencing：**已闭合**。`registerQmdCorpusDocument()`
  在 qmd index file lock 内、SQLite mutation 前调用
  `repo.assertCurrentBatchBookLease()`，并在 mutation 后、catalog registration
  前再次校验。证据：`src/job-state/graphrag-book.ts:1029` 到 `1067`；测试：
  `test/graphrag-book-state.test.ts:2793` 到 `2863`。
- GraphRAG producer manifest fencing：**库路径已闭合**。
  `writeGraphRagOutputProducerManifest()` 在读取/写入前后校验 repo book lease；
  resume production 调用传入 `repo`。证据：
  `src/job-state/graphrag-book.ts:1535` 到 `1567`、
  `scripts/graphrag/resume-book-workspace.mjs:580` 到 `604`、
  `scripts/graphrag/resume-book-workspace.mjs:1170` 到 `1206`、
  `scripts/graphrag/resume-book-workspace.mjs:1345` 到 `1356`；测试：
  `test/graphrag-book-state.test.ts:2985` 到 `3044`。
- repository YAML/book state durable write：**repository helper 已闭合**。
  `readYamlFile()` 和 `writeYamlFile()` 调用 `reconcileDurableYamlFile()`，
  写入 checksum sidecar，并在 invalid YAML/checksum mismatch 时 quarantine。
  证据：`src/job-state/repository.ts:327` 到 `452`；测试：
  `test/book-job-state.test.ts:1316` 到 `1349`。
- GraphRAG sidecar durable JSON：**库路径已闭合**。`durable-json.ts` 覆盖
  read/write/reconcile/temp cleanup/checksum/quarantine；identity sidecar、
  producer manifest、row-count sidecar 的库路径使用该 helper。证据：
  `src/job-state/durable-json.ts:18` 到 `80`、
  `src/job-state/graphrag-book.ts:914` 到 `970`、
  `src/job-state/graphrag-book.ts:1277` 到 `1282`、
  `src/job-state/graphrag-book.ts:1462` 到 `1567`、
  `src/job-state/artifact-validation.ts:179` 到 `195`；测试：
  `test/graphrag-book-state.test.ts:3051` 到 `3202`、
  `test/book-job-state.test.ts:1351` 到 `1389`。
- worker pool/crash recovery tests：**明显增强**。duplicate canonical book deferral、
  stale item terminal rejection、parallel fail-fast quiesce/sibling kill 和
  same-host live orphan termination 均有黑盒测试。证据：
  `test/cli.test.ts:2516` 到 `2825`、
  `test/cli.test.ts:3035` 到 `3185`、
  `test/cli.test.ts:3271` 到 `3370`。

## Blocking Findings

### R5-B01: runner terminal evidence 读路径绕过 durable checksum/reconcile

违反基准：4、7、10。

证据：

- batch runner 的 YAML helper 直接 `YAML.parse(readFileSync(...))`，没有调用
  repository 的 `reconcileDurableYamlFile()`，也不验证 `.sha256` 或 quarantine
  invalid target。证据：`scripts/graphrag/batch-epub-workflow.mjs:4305` 到
  `4312`。
- batch runner 的 producer manifest reader 直接 `readJson(path)`，没有调用
  durable JSON reconcile/checksum helper。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:4321` 到 `4327`。
- batch runner 的 LanceDB row-count sidecar reader 直接
  `JSON.parse(readFileSync(qmd_row_count.json))`，不会发现 checksum mismatch，也
  不会 quarantine corrupt target。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:4442` 到 `4450`。
- 这些 direct readers 位于 terminal GraphRAG evidence gate 中：
  `graphBuildEvidence()` 读取 `checkpoints.yaml`、`artifacts.yaml`、
  `qmd_output_manifest.json`，随后 `validateArtifactContent()` 校验
  `lancedb_index` 的 row-count sidecar。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:4973` 到 `4992`、
  `scripts/graphrag/batch-epub-workflow.mjs:4674` 到 `4685`。
- completed checkpoint 写入前调用该 evidence gate。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:7315` 到 `7399`。

为什么阻塞：

固定基准 4 要求 checkpoint、manifest、catalog、book state writes 具备
generation/checksum validation 和 restart reconciliation；基准 7 要求 terminal
completion 由可信 qmd/GraphRAG/query evidence gate 控制。当前库层 helper 已经
实现 durable JSON/YAML，但生产 runner 的 terminal gate 未使用这些 helper。
因此 checksum mismatch 的 producer manifest 或 row-count sidecar 仍可被 runner
当作有效证据读取，invalid/corrupt target 也不会在该路径被隔离。

建议修复方向：

- 将 batch runner 的 `readYamlSchemaIfExists()` 改为与 repository YAML helper
  同等的 durable read：temp cleanup、checksum backfill、checksum mismatch
  quarantine、invalid YAML quarantine。
- 将 batch runner 的 `readGraphOutputProducerManifest()` 和
  `readLanceRowCount()` 改为 durable JSON read，并在 checksum mismatch/invalid
  target 时使 terminal completion fail closed。
- 增加生产 runner 黑盒测试：篡改 `qmd_output_manifest.json.sha256`、
  `qmd_row_count.json.sha256`、`checkpoints.yaml.sha256` 或 `artifacts.yaml.sha256`
  后，batch terminal completion 不得写 completed checkpoint 或
  `item_completed` event，并应 quarantine corrupt target。

### R5-B02: graph capability catalog 发布不是 durable/fenced catalog commit

违反基准：2、4、7、9。

证据：

- query_ready succeeded 后，repository 调用 `publishGraphCapabilities()` 并循环
  写入 explicit graph capability catalog。证据：
  `src/job-state/repository.ts:3151` 到 `3152`、
  `src/job-state/repository.ts:3230` 到 `3241`。
- `recordGraphCapability()` 只接收 `graphVault` 和 `capability`，没有 repo、
  run/session、book lease generation 或 fencing token 参数；写入前没有
  `assertCurrentBatchBookLease()` 等价检查。证据：
  `src/graphrag/capability-catalog.ts:721` 到 `745`。
- `recordGraphCapability()` 用 `writeFile(catalogPath, YAML.stringify(catalog))`
  直接覆盖 `catalog/graph-capabilities.yaml`，没有 same-dir temp、file fsync、
  atomic rename、parent fsync、checksum sidecar 或 restart reconciliation。
  证据：`src/graphrag/capability-catalog.ts:744` 到 `745`。

为什么阻塞：

`graph-capabilities.yaml` 是 query_ready 发布后的 catalog commit，会影响后续
GraphRAG route/capability discovery。固定基准 2 要求 catalog commits 验证当前
fencing token；基准 4 要求 catalog writes 使用 durable write protocol。当前
query_ready checkpoint 本身受 book lease gate 保护，但 capability publication
发生在后续函数中，发布前没有重新验证 current lease；若 worker 在 checkpoint
和 capability publish 之间被 takeover，stale worker 仍可写 capability catalog。

建议修复方向：

- 将 `recordGraphCapability()` 纳入 repository book-scoped writer，或向其传入
  repo/book lease context 并在每次 catalog write 前执行 current batch book
  lease/fencing 校验。
- 将 `graph-capabilities.yaml` 写入改为 repository durable YAML helper 或等价
  same-dir temp/fsync/rename/parent fsync/checksum/reconcile/quarantine 协议。
- 增加 stale lease 负向测试：query_ready checkpoint 与 capability publish 之间
  替换 book lease，断言 graph capability catalog 不变。
- 增加 durable catalog recovery 测试：checksum missing backfill、checksum
  mismatch quarantine、invalid YAML quarantine。

### R5-B03: 第 10 条行为测试仍未覆盖剩余生产缺口

违反基准：10。

证据：

- 已有新增测试覆盖 duplicate canonical book deferral、stale item terminal
  checkpoint/event rejection、parallel non-transient quiesce、same-host live
  orphan termination、repository YAML checksum recovery、GraphRAG identity
  sidecar recovery、producer manifest recovery 和 library-level LanceDB row-count
  durable validation。证据：
  `test/cli.test.ts:2516` 到 `2825`、
  `test/cli.test.ts:3035` 到 `3185`、
  `test/cli.test.ts:3271` 到 `3370`、
  `test/book-job-state.test.ts:1316` 到 `1389`、
  `test/graphrag-book-state.test.ts:3051` 到 `3202`。
- `validates LanceDB row-count sidecars through durable checksums` 调用的是
  `src/job-state/artifact-validation.ts` 的 library helper；未覆盖
  `scripts/graphrag/batch-epub-workflow.mjs` 的 terminal runner direct reader。
  证据：`test/book-job-state.test.ts:1351` 到 `1389`、
  `scripts/graphrag/batch-epub-workflow.mjs:4442` 到 `4450`。
- 未发现 graph capability catalog 的 stale book lease rejection、durable
  checksum/reconcile/quarantine 行为测试。`rg` 命中显示生产
  `recordGraphCapability()` 仍是 direct `writeFile()`。证据：
  `src/graphrag/capability-catalog.ts:721` 到 `745`。

为什么阻塞：

固定基准 10 要求测试覆盖 state/recovery behavior，而不是只验证 token 或库层
helper。当前新增测试已经覆盖多项高风险行为，但没有覆盖 R5-B01 和 R5-B02 的
实际生产路径，因此不能证明 terminal completion 和 query_ready publication 在
crash/corruption/takeover 边界 fail closed。

建议修复方向：

- 增加 batch runner 黑盒测试，覆盖 terminal evidence gate 对 corrupted
  book-state YAML、producer manifest、row-count sidecar checksum mismatch 的
  fail-closed 行为。
- 增加 graph capability catalog 的 stale lease negative 与 durable recovery
  测试。
- 将测试断言放在最终 batch artifacts/events/checkpoints 上，证明没有 completed
  checkpoint、`item_completed` event 或 capability catalog side effect。

## 残余非阻塞风险

- `provider slot stale release cannot delete the current durable slot` 测试仍主要
  断言正常 release metadata，没有构造 stale generation/token 的负向 release；
  实现代码已比较 `runnerSessionId`、`generation`、`fencingToken`，因此列为测试
  加强项而非本轮独立 blocker。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2624` 到 `2667`、
  `test/cli.test.ts:3013` 到 `3033`。
- batch runner direct JSON/YAML readers 与 library durable helpers 形成双路径；
  后续应避免同一生产证据面存在多个不等价 reader。

## 本轮证据命令

主控报告以下命令已通过，本轮复审基于源码与测试的只读审计进行判定：

- `node --check scripts/graphrag/batch-epub-workflow.mjs && node --check scripts/graphrag/resume-book-workspace.mjs && node --check scripts/graphrag/batch-failure-classifier.mjs`
- `npm run test:types -- --pretty false`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 180000 test/cli.test.ts -t "book worker pool defers duplicate canonical books|stale item checkpoint ownership rejects terminal event writes|parallel non-transient failure quiesces sibling workers|restart terminates same-host live orphan subprocess records"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 180000 test/book-job-state.test.ts -t "recovers book job YAML checksums and quarantines corrupt targets|validates LanceDB row-count sidecars through durable checksums"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 180000 test/graphrag-book-state.test.ts -t "recovers GraphRAG identity sidecar checksums and quarantines invalid targets|recovers producer manifest checksum and quarantines corrupt targets"`
