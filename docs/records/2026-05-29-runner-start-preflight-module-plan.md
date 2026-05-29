# Runner Start Preflight 模块化收敛计划

## 目标

将 `runner_start` 的书级 durable state 只读阻断诊断
（read-only blocking diagnostic）从超长 runner 文件中拆出，避免继续扩大
`scripts/graphrag/batch-epub-workflow.mjs`。

## 设计锚点

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- 当前审计目录：
  `audits/graphrag-runner-start-book-state-repair-boundary-run_20260529_r1__open`
- 固定行为边界：
  normal `runner_start` 对既有 book-scoped durable target 只能只读诊断，
  不得 backfill、quarantine、temp cleanup 或 corrupt rename。

## 拆分方案

- 新增 `scripts/graphrag/runner-startup-preflight.mjs`。
- 该模块只承载 startup preflight 的纯辅助逻辑：
  - `StartupNextOperatorActionSchema`
  - `createStartupRecoverySchema`
  - book-scoped target mapping 判定
  - read-only primary target diagnostic
  - startup scan stats 与 mutation event 计数
  - startup failure manifest 构造
- `batch-epub-workflow.mjs` 只保留流程接线：
  - 创建 scan stats
  - 调用 durable preflight
  - 捕获 `DurableStateError`
  - 写 manifest 与 recovery-summary

## 验证

执行以下命令作为本轮最小回归：

```bash
node --check scripts/graphrag/batch-epub-workflow.mjs
node --check scripts/graphrag/runner-startup-preflight.mjs
npm run test:types
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 120000 \
  test/graphrag-runner-durable-preflight.test.ts
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 120000 \
  test/graphrag-runner-status-json-readonly.test.ts \
  test/graphrag-runner-durable-state.test.ts
```

## 收敛规则

- 不新增新的审计基准。
- 不改变 `before_claim` 或 `before_resume_book` 的既有修复语义。
- 若新增逻辑超过接线职责，必须进入新模块。
