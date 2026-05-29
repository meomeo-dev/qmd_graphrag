# Implementation Audit R5

审计对象：GraphRAG 多书并行 Runner 的 R4 修复后实现。

审计基准：仅使用 `criteria.md` 中固定 10 条 Implementation Audit
Criteria。

结论：FAIL

## 阻断项

### 1. `runBatchWorkflow` timeout 清理仍不能保证无 orphan child

- 违反基准：10
- 文件：
  - `test/cli.test.ts:3868`
  - `test/cli.test.ts:3905`
  - `test/cli.test.ts:3908`
  - `test/cli.test.ts:3909`
  - `scripts/graphrag/batch-epub-workflow.mjs:9353`
  - `scripts/graphrag/batch-epub-workflow.mjs:9359`
  - `scripts/graphrag/batch-epub-workflow.mjs:3818`
  - `scripts/graphrag/batch-epub-workflow.mjs:3865`
- 现象：R4 后 `runBatchWorkflow` 的 timeout 预算已经小于相关 Vitest
  单测 timeout。真实 child YAML 用例使用 120000ms/90000ms，单测 timeout 为
  180000ms；partial/malformed/missing envelope 用例使用 90000ms 或默认
  60000ms，单测 timeout 为 150000ms。
- 问题：helper timeout 分支只对 batch runner 父进程调用
  `proc.kill("SIGTERM")`，2 秒后再调用 `proc.kill("SIGKILL")`。batch runner
  内部的 `spawnCommand` 又以 `detached: true` 启动 resume child，child 拥有
  独立 process group。若 helper timeout 触发并直接杀死 batch runner，batch
  runner 没有 `SIGTERM`/`SIGINT` 信号处理来调用
  `terminateActiveSubprocesses`，因此仍可能留下 detached resume child。
- 影响：criteria 10 要求聚焦 Vitest 作为实施验证证据。当前聚合测试已通过，
  但 helper 的超时失败路径仍不能证明失败时无 orphan，长期看会污染同一
  Vitest worker 或后续审计运行。
- 当前环境检查：`ps -axo ...` 未发现本轮验证遗留的
  `batch-epub-workflow.mjs`、`resume-book-workspace.mjs` 或 fake envelope
  进程。该结果说明本轮未实际触发 orphan，不消除 timeout 分支的设计缺口。
- 修复要求：
  - 在 batch runner 中为 `SIGTERM` 与 `SIGINT` 注册清理路径，调用
    `terminateActiveSubprocesses`，等待或限时等待 active child 退出后再退出。
  - 或增强 `runBatchWorkflow`，在 timeout/finally 路径中终止父 runner 与
    subprocess registry 中记录的 child process group，并等待 `close`。
  - 保留 helper timeout 小于 Vitest 单测 timeout 的约束，并增加一个专门测试
    覆盖 helper timeout 后无 batch/resume child 遗留。

## 通过项

### 真实 child YAML rename ENOENT 聚合测试

`test/cli.test.ts:3924` 至 `test/cli.test.ts:4052` 覆盖真实
`resume-book-workspace.mjs` child 中 `job.yaml`、`checkpoints.yaml` 与
`artifacts.yaml` 的 book-scoped durable YAML primary target rename `ENOENT`。
测试断言 child stderr 中存在 `QMD_GRAPHRAG_DURABLE_FAILURE` envelope，并在
`BatchCommandCheck`、item checkpoint、`command_failed`、`item_failed`、
`recovery-summary.json`、status-json 与 `durableStateFailures` 上投影：

- `failureKind: local_state_integrity`
- `localFailureClass: durable_temp_rename_enoent`
- `retryable: false`
- `recoveryDecision: stop_until_fixed`
- `failedStage: resume-book-1`
- `failedSyscall: rename`
- `errno: ENOENT`
- `lane: checkpointWriterLane`
- `targetMappingOwner: repository`
- `completedPublishRule: forbidden`
- `tempId`、`operationId`、`renameCause`、`leaseGeneration`
- target locator 指向 `graph_vault/books/{bookId}/{targetName}`，且不是
  checksum sidecar

聚焦验证通过：

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 180000 test/cli.test.ts -t \
  "resume-book child projects|partial durable subprocess envelope fails closed|\
malformed durable subprocess envelope fails closed|missing durable subprocess envelope fails closed"
```

结果：1 个测试文件通过，6 个测试通过，249 个跳过。三条真实 child YAML
用例分别耗时约 31.292s、22.192s、20.696s。

### Envelope fail-closed

`test/cli.test.ts:4055` 至 `test/cli.test.ts:4198` 覆盖 partial、
malformed 与 missing durable subprocess envelope。父 runner 在 durable
subprocess boundary 可确认 local durable failure 时 fail closed 为：

- `localFailureClass: durable_subprocess_evidence_incomplete`
- `retryable: false`
- `recoveryDecision: stop_until_fixed`
- `evidenceIncomplete: true`
- `completedPublishRule: forbidden`
- `unavailableFieldSentinels`

实现路径位于 `scripts/graphrag/batch-epub-workflow.mjs:2939`、
`scripts/graphrag/batch-epub-workflow.mjs:3048` 与
`scripts/graphrag/batch-epub-workflow.mjs:3107`。

### Durable evidence 与 envelope projection

- `src/job-state/durable-state-store.ts:90` 将
  `graph_vault/books/{bookId}/job.yaml`、`artifacts.yaml` 与
  `checkpoints.yaml` 映射到 `checkpointWriterLane` 和 `repository`。
- `src/job-state/durable-state-store.ts:1336` 与
  `src/job-state/durable-state-store.ts:1366` 将 async/sync rename `ENOENT`
  分类为 `durable_temp_rename_enoent`，并保留 rename evidence。
- `scripts/graphrag/resume-book-workspace.mjs:120` 与
  `scripts/graphrag/resume-book-workspace.mjs:1527` 输出单行
  `QMD_GRAPHRAG_DURABLE_FAILURE` typed envelope。
- `scripts/graphrag/batch-epub-workflow.mjs:9563` 至
  `scripts/graphrag/batch-epub-workflow.mjs:9581` 先解析 typed envelope，再进入
  legacy text classifier。

### Settings projection

`test/graphrag-book-state.test.ts:2693` 覆盖
`graph_vault/settings.yaml` 首次缺失时创建 managed projection；
`test/graphrag-book-state.test.ts:2773` 覆盖 user-owned settings 拒绝覆盖。

聚焦验证通过：

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 120000 test/graphrag-book-state.test.ts -t \
  "creates missing managed GraphRAG settings from project config|\
rejects user-owned GraphRAG settings when project config is supplied|\
rewrites drifted managed GraphRAG settings"
```

结果：1 个测试文件通过，3 个测试通过，43 个跳过。

### Durable preflight 与 status-json read-only

聚焦验证通过：

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 120000 test/graphrag-runner-status-json-readonly.test.ts -t \
  "status-json reports missing books checksum meta without state mutation|\
repair writer classifies checksum meta sidecar rename ENOENT"
```

结果：1 个测试文件通过，2 个测试通过，3 个跳过。

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 120000 test/graphrag-runner-durable-preflight.test.ts
```

结果：1 个测试文件通过，1 个测试通过。

## 静态验证

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：PASS。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：PASS。
- `node --check scripts/graphrag/batch-failure-classifier.mjs`：PASS。
- `npm run typecheck`：PASS。
- Type DD YAML parse：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml` 解析通过，
  `topLevelKeys=19`，title 为
  `GraphRAG 多书并行 Runner 生产设计`。

## 审计边界

- 未修改 `criteria.md`。
- 未修改源码。
- 未读取 `.env`。
- 未运行生产真实 EPUB runner；执行的是 Vitest 临时最小 EPUB fixture 与
  聚焦静态验证。
