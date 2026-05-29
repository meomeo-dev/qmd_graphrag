Result: PASS

## 复审范围

本次复审仅使用固定基准
`audit/graphrag-query-ready-identity-settings-dev-run_1__closed/dev-agent-a/baseline.md`
和上一轮问题记录
`audit/graphrag-query-ready-identity-settings-dev-run_1__closed/dev-agent-a/reaudit-1.md`。
未重新设计基准，未扩大到无关 CLI 渲染、DSPy、provider model selection
或其他 GraphRAG 行为。

## 验证结论

1. `resume-book-workspace.mjs` 的 repair-only classifier 已覆盖四条
   observed failure text（观察到的失败文本）。

   `scripts/graphrag/resume-book-workspace.mjs:225` 到
   `scripts/graphrag/resume-book-workspace.mjs:255` 的
   `isLocalArtifactGateError()` 现在同时匹配：

   - `GraphRAG document identity is missing for query_ready`
   - `GraphRAG document identity sidecar does not match query_ready`
   - `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`
   - `capabilityScope references unknown or not-ready graphCapabilityId(s)`

   该 classifier 被 stage checkpoint 选择和 repair-only 补偿路径使用：
   `scripts/graphrag/resume-book-workspace.mjs:339` 到
   `scripts/graphrag/resume-book-workspace.mjs:351`，
   `scripts/graphrag/resume-book-workspace.mjs:606` 到
   `scripts/graphrag/resume-book-workspace.mjs:624`，
   `scripts/graphrag/resume-book-workspace.mjs:666` 到
   `scripts/graphrag/resume-book-workspace.mjs:864`。
   上一轮缺失的 sidecar mismatch 和 managed settings projection 文本
   已不再导致 `local artifact gate failure checkpoint not found`。

2. Batch runner 的 persisted `stop_until_fixed` local artifact gate
   已能对 sidecar mismatch 和 managed settings projection failure 进入
   repair/reopen。

   `scripts/graphrag/batch-failure-classifier.mjs:140` 到
   `scripts/graphrag/batch-failure-classifier.mjs:170` 将两条新增真实文本
   归类为 local artifact gate（本地 artifact gate），且在 data
   compatibility classifier 之后、provider transient classifier 之后执行，
   避免误当成 provider transient。

   `scripts/graphrag/batch-epub-workflow.mjs:706` 到
   `scripts/graphrag/batch-epub-workflow.mjs:727` 只允许
   `status=failed`、`retryable=false`、`recoveryDecision=stop_until_fixed`
   且不含 provider status/data compatibility 的 local gate 进入 repair。
   主循环在 `scripts/graphrag/batch-epub-workflow.mjs:4343` 到
   `scripts/graphrag/batch-epub-workflow.mjs:4364` 调用
   `repairLocalArtifactGate()`；成功 repair 后，
   `scripts/graphrag/batch-epub-workflow.mjs:3804` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3844` 将 item reopen 到
   `pending`，清空旧 `commandChecks`，记录 repair metadata，并设置
   `localArtifactGateRepairCompleted=true`。

3. 回归测试已固定两条真实 failure text 的 persisted repair/reopen 行为。

   `test/cli.test.ts:1957` 到 `test/cli.test.ts:1993` 断言 batch classifier
   和 repair-only script 都包含 sidecar mismatch 与 managed settings
   projection 文本。

   `test/cli.test.ts:3966` 到 `test/cli.test.ts:4000` 的参数化 persisted
   reopen 测试已覆盖四条 query-ready projection gate failure text，包括
   上一轮缺失的：

   - `GraphRAG document identity sidecar does not match query_ready`
   - `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`

   该测试在 `test/cli.test.ts:4055` 到 `test/cli.test.ts:4084` 构造
   persisted `status=failed`、`retryable=false`、
   `recoveryDecision=stop_until_fixed` checkpoint，并在
   `test/cli.test.ts:4206` 到 `test/cli.test.ts:4232` 验证 repair 后不会
   直接完成 item，而是记录 reopen metadata、继续正常命令路径，并最终因
   fixture 中的下一条真实命令失败停在 `normalize-epub`。

## 测试

已运行聚焦测试（focused tests）：

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli.test.ts \
  -t "reopens query-ready .* projection gate failures with fixed repair metadata"
```

结果：`1 passed`，`4 passed`，`181 skipped`。

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli.test.ts \
  -t "classifies query-ready projection failures as local artifact gates|repair-only validates query-ready projection without graph query calls"
```

结果：`1 passed`，`2 passed`，`183 skipped`。

## 残余风险

- `resume-book-workspace.mjs` 与 `batch-failure-classifier.mjs` 仍维护重复
  classifier 逻辑；当前四条文本一致，但后续新增文本仍有漂移风险
  （drift risk）。
- Persisted batch repair/reopen 测试使用 fake repair runner 验证 batch
  runner 行为；真实 `resume-book-workspace.mjs` repair-only stage checkpoint
  路径由静态代码审查和 classifier 测试覆盖，未在本次复审中运行完整
  GraphRAG workspace 集成测试。
