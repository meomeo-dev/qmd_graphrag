# Implementation Audit R4

审计对象：GraphRAG 多书并行 Runner 的 R3 修复后实现，重点为
durable subprocess envelope、book-scoped YAML rename `ENOENT` 投影、
fail-closed 覆盖、子进程 timeout/kill 清理，以及 R1/R2/R3 修复项回归。

审计基准：仅使用 `criteria.md` 中固定 10 条 Implementation Audit Criteria。

结论：FAIL

## 阻断项

### 1. 聚焦 Vitest 仍不能稳定证明真实 child YAML `ENOENT` 覆盖

- 违反基准：10
- 文件：`test/cli.test.ts:3924`、`test/cli.test.ts:4050`
- 现象：以下聚焦命令执行失败，三条真实 child YAML rename `ENOENT`
  用例均在自身 45000ms 超时内失败：
  `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 180000 test/cli.test.ts -t
  "resume-book child projects|partial durable subprocess envelope|malformed
  durable subprocess envelope|missing durable subprocess envelope"`
- 失败项：
  - `resume-book child projects job.yaml rename ENOENT`
  - `resume-book child projects checkpoints.yaml rename ENOENT`
  - `resume-book child projects artifacts.yaml rename ENOENT`
- 影响：criteria 9 要求的真实 child 覆盖在单测单独执行时存在，但
  criteria 10 要求“聚焦 Vitest 必须作为实施验证证据”。该聚焦验证
  在 R4 中仍不可稳定通过，不能作为合格实施证据。
- 修复要求：降低该 fixture 成本，或把这三条真实 child YAML 用例的
  timeout 与实际耗时留足稳定余量；推荐拆成更小的专用测试文件，避免
  与 fake envelope 用例共享重型 `test/cli.test.ts` 收集和运行成本。

### 2. `runBatchWorkflow` 测试 helper 的 timeout/kill 清理仍有污染风险

- 违反基准：10
- 文件：`test/cli.test.ts:3881`、`test/cli.test.ts:3905`
- 现象：`runBatchWorkflow` 默认 60000ms 才杀 batch runner，但真实 child
  YAML 测试自身 timeout 为 45000ms。测试先超时退出时，helper 的 timer
  未必执行到 kill 分支；R4 验证期间曾观察到前序超时测试留下的
  `batch-epub-workflow.mjs` 进程仍在运行，随后检查确认已自然退出。
- 影响：失败测试可能污染同一 Vitest 进程后续用例，进一步削弱
  criteria 10 要求的聚焦验证可信度。
- 修复要求：让 helper timeout 小于单测 timeout，或在测试 abort/cleanup
  路径中无条件终止父 runner 及其 process group；同时在 `finally` 中等待
  close，确保无 orphan batch runner 或 resume child 遗留。

## 非阻断核查

- criteria 1：`DurableStateError` 对 rename `ENOENT` 投影为
  `local_state_integrity`、`durable_temp_rename_enoent`、
  `retryable: false` 与 `stop_until_fixed`，并保留 rename evidence。
- criteria 2：`resume-book-workspace.mjs` 捕获 `DurableStateError` 后输出
  单行 `QMD_GRAPHRAG_DURABLE_FAILURE` typed envelope。
- criteria 3：父 runner 在 legacy classifier 前解析 typed envelope，并把
  `resume-book-1` 作为 `BatchCommandCheck.name` 和 first-hop carrier。
- criteria 4：`BatchCommandCheck`、item checkpoint、`command_failed`、
  `item_failed`、status-json 与 recovery summary 均有 durable evidence
  投影路径。
- criteria 5：partial、malformed、missing envelope 的 fail-closed 路径
  已覆盖，三条 fake envelope 聚焦测试通过。
- criteria 6：book-scoped `job.yaml`、`artifacts.yaml`、`checkpoints.yaml`
  与 `runs/*.yaml` 均映射到 `checkpointWriterLane` 和 `repository`。
- criteria 7：settings projection 首次缺失创建路径存在，且直接测试通过。
- criteria 8：durable preflight 与 `--status-json` read-only 相关测试有覆盖；
  read-only meta 缺失与 sidecar rename `ENOENT` 用例通过。
- criteria 9：真实 `resume-book-workspace.mjs` child 对
  `checkpoints.yaml` primary YAML rename `ENOENT` 的单条聚焦测试通过；
  阻断点不是覆盖缺失，而是聚焦验证稳定性不足。

## 验证证据

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：通过。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：通过。
- `node --check scripts/graphrag/batch-failure-classifier.mjs`：通过。
- `npm run test:types`：通过。
- Type DD YAML parse：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml` 解析通过。
- `test/graphrag-book-state.test.ts -t
  "creates missing managed GraphRAG settings from project config"`：通过。
- `test/graphrag-runner-durable-preflight.test.ts`：通过。
- `test/cli.test.ts -t "partial durable subprocess envelope|malformed durable
  subprocess envelope|missing durable subprocess envelope"`：三条相关用例通过。
- `test/cli.test.ts -t "resume-book child projects checkpoints.yaml rename
  ENOENT"`：单独执行通过。
- `test/cli.test.ts -t "resume-book child projects job.yaml rename ENOENT"`：
  单独执行通过。
- `test/cli.test.ts -t "resume-book child projects artifacts.yaml rename
  ENOENT"`：单独执行通过。
- 聚合 child YAML 与 fail-closed envelope 聚焦命令：失败，三条真实 child
  YAML 用例 timeout。
