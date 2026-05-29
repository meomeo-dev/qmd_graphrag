# Runner Start Book State Repair Boundary Final Report

## 结论

状态：通过并关闭（passed and closed）。

本轮审计目录：
`audits/graphrag-runner-start-book-state-repair-boundary-run_20260529_r1__closed`

固定实施审计基准未变化。Agent A、Agent B、Agent C 均在 R2 使用各自
`implementation-audit-criteria.md` 中的同一 10 条基准复审，结论均为
PASS。

## 范围

触发问题是 normal `runner_start` 在既有 book-scoped durable state 上执行
可写修复，造成 checksum backfill、quarantine 与 corrupt rename 进入普通启动
路径。该行为破坏了生产恢复边界（production recovery boundary），也使审计在
不同修复轮次中难以稳定验证。

本轮关闭后的固定边界：

- normal `runner_start` 对 book-scoped durable target 只能执行
  read-only blocking diagnostic。
- book-scoped target 的 normal runner-start mutation budget 固定为 0。
- checksum backfill、checksum meta backfill、temp cleanup、quarantine 与
  corrupt rename 只能发生在 explicit repair 或 `--migrate-only` 边界内。
- `startupRecovery` 必须记录 `targetCount`、`degradedTargetCount`、
  `mutationCount`、`firstBlocker` 与 `nextOperatorAction`。
- item checkpoint 创建前失败必须发布 failed manifest 与
  `recovery-summary.json`，不得留下 ambiguous running state。

## 设计处理

设计审计 R1 失败后，已更新：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- `docs/records/2026-05-29-runner-start-preflight-module-plan.md`

设计审计 R2 结果：

- Agent A：PASS
- Agent B：PASS
- Agent C：PASS

## 实施处理

新增模块：

- `scripts/graphrag/runner-startup-preflight.mjs`

主要接线与契约更新：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/graphrag-runner-durable-preflight.test.ts`
- `test/graphrag-runner-status-json-readonly.test.ts`
- `test/graphrag-runner-durable-state.test.ts`
- `test/integrations/contracts.test.ts`

关键修复：

- book-scoped YAML/JSON primary、`.tmp-*`、`.lock` 在 normal
  `runner_start` 下全部进入 read-only blocking diagnostic。
- first blocker 后 fail-fast，不继续扫描并改变后续 target。
- `firstBlocker.durableMode` 保留为 `read_only_blocking_diagnostic`。
- `startupRecovery.runId` 与 `startupRecovery.stage` 写入 failed manifest。
- mutation accounting 覆盖 durable recovered/deleted/renamed/written/committed
  事件，以及 checksum meta backfill/quarantine 事件。
- `--migrate-only` repair writer 用例改为成功修复退出，同时保留
  quarantine/backfill 证据断言。

## 实施审计

实施审计 R1 发现的问题已全部修复。实施审计 R2 结果：

- Agent A：PASS，
  `agent-a/implementation-audit-r2.md`
- Agent B：PASS，
  `agent-b/implementation-audit-r2.md`
- Agent C：PASS，
  `agent-c/implementation-audit-r2.md`

固定基准文件未修改：

- `agent-a/implementation-audit-criteria.md`
- `agent-b/implementation-audit-criteria.md`
- `agent-c/implementation-audit-criteria.md`

## 验证

已通过：

```bash
node --check scripts/graphrag/batch-epub-workflow.mjs
node --check scripts/graphrag/runner-startup-preflight.mjs
npm run test:types
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-runner-durable-preflight.test.ts
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-runner-status-json-readonly.test.ts
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-runner-status-json-readonly.test.ts test/graphrag-runner-durable-state.test.ts
CI=true node --max-old-space-size=4096 ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 --pool=forks --maxWorkers=1 --minWorkers=1 test/integrations/contracts.test.ts
```

验证结果：

- durable preflight：4 passed
- status-json readonly：8 passed
- status-json readonly + durable state：19 passed
- contracts：72 passed
- type check：PASS
- syntax check：PASS

## 剩余风险

`scripts/graphrag/batch-epub-workflow.mjs` 仍是历史超长文件。当前轮次已把新增
startup preflight 行为拆入独立模块，runner 文件只保留必要接线；后续新增功能
不应继续沉入该文件。

按用户指令，本轮在实施审计最终关闭后停止，不恢复真实 EPUB 主流程。
