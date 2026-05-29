# Dev Agent B Final Re-audit

结论：PASS。

本次最终复审仍使用
`audit/graph-query-capability-derived-projection-run_1__closed/dev-agent-b/baseline.md`
的固定 10 条基准。未发现阻断项。

关键结论：

- `scripts/graphrag/resume-book-workspace.mjs` 的 repair-only
  query-ready projection recovery 不再因 derived capability 已可见而短路。
- 无 failed checkpoint 且当前 stages 允许 repair 时，代码先通过
  `queryReadyProducerArtifacts` 校验 producer/query-ready evidence，再必经
  `repo.completeStage({ stage: "query_ready", ... })`。
- `repo.completeStage(query_ready)` 进入 repository completion semantics，
  重新校验 query-ready producer stages、query-ready artifacts、graph identity，
  并调用 `publishGraphCapabilities` 刷新持久 capability projection。
- `python/qmd_graphrag/bridge.py` 新增的 request-scope
  `graphTextUnitIds` 类型校验只作用于 Python graph capability 解析和请求
  scope 校验；`resume-book-workspace.mjs` 的 repair-only 判定和
  `repo.completeStage(query_ready)` 本地 projection repair 不依赖该 Python
  bridge 路径，因此不影响 repair-only 判定。

## 逐条基准结果

1. PASS。`repair-local-artifact-gate-only` 不要求 failed stage checkpoint。
   `checkpoint == null` 时会进入
   `repairQueryReadyProjectionIfPossible`。

2. PASS。repair-only projection recovery 复用 validated query-ready evidence。
   `queryReadyProducerArtifacts` 要求 `graph_extract`、`community_report`、
   `embed` 均 succeeded 且 run id 存在，并调用
   `assertGraphRagStageArtifactsReady`。repair-only 入口在创建 GraphRAG runtime
   前返回，不执行真实 `runtime.graphIndex` rebuild。

3. PASS。projection recovery 通过 repository completion semantics 发布或刷新
   `query_ready` capability projection。证据：
   `repairQueryReadyProjectionIfPossible` 在 `graphQueryScopeFromSync` 前调用
   `repo.completeStage({ stage: "query_ready" })`；repository 对 succeeded
   `query_ready` 调用 `publishGraphCapabilities`。

4. PASS。成功 repair 输出包含 `status: "repaired"`、
   `repairedLocalArtifactGate: true` 和 `requiresRealRebuild: false`。

5. PASS。成功 repair 输出包含固定 metadata：`repairReason`、
   `repairedProjection`、`repairEvidenceLocator`、`reusedProducerRunIds` 和
   `settingsProjectionRepair`。

6. PASS。当前 stages 不完整时，若 `nextStage` 不是 `query_ready`，
   `repairQueryReadyProjectionIfPossible` 返回 `null`，外层 blocked 响应使用
   `sync.resumePlan.nextStage` 计算 `requiresRealRebuild` 和 `rebuildStage`。

7. PASS。projection-only 路径只完成目标 `query_ready` checkpoint、刷新 output
   producer manifest 和 capability projection；未发现清空或重写无关 batch
   state、command checks 或其他 completed book checkpoints。

8. PASS。projection repair 保留同一 book id；`query_ready` run id 优先复用
   既有 checkpoint run id，其次复用 producer manifest 中的 `query_ready`
   run id。batch run id 不在该脚本中被替换。

9. PASS。失败 repair 会返回 blocked JSON，并包含 sanitized `reason`；该路径
   无自旋循环。

10. PASS。既有 graph identity、producer-manifest 和 settings projection
    failure 的成功 repair 行为仍保留；新增 no-failed-checkpoint 路径未删除或
    覆盖原有 failed-checkpoint repair 分支。

## 剩余问题

未发现阻断项。

残余风险：

- TS 测试仍偏向分类、脚本片段和 batch 接收 repair-only 输出后的行为；缺少直接
  执行真实 `repairQueryReadyProjectionIfPossible` 并断言
  `catalog/graph-capabilities.yaml` 被重新发布的端到端 fixture。当前静态路径和
  repository 语义审计足以支持本轮 PASS，但建议后续补测试防回归。
- failed-checkpoint repair 分支中的 query-ready completion 仍未合并既有
  `query_ready` metadata；本轮重点的 no-failed-checkpoint recovery 已通过
  `...(queryReadyCheckpoint?.metadata ?? {})` 保留 metadata。

## 验证

- `node --check scripts/graphrag/resume-book-workspace.mjs`：通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot
  --testTimeout 60000 test/cli.test.ts -t
  "repair-only validates query-ready projection without graph query calls|repair-only blocked can reopen a real GraphRAG rebuild|classifies query-ready projection failures|keeps query_ready resume stage"`：
  4 passed，183 skipped。
- `python -m pytest test/python/test_graphrag_bridge_scope.py -q -k
  "capability_scope"`：12 passed，17 deselected，8 subtests passed。
