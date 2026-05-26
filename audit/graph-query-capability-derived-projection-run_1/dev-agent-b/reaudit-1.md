# Dev Agent B Re-audit 1

结论：PASS。

本次复审继续使用原固定 10 条基准。此前 FAIL 的问题已经修复：
`repairQueryReadyProjectionIfPossible` 不再因 derived
`graph_query` capability 已可见而提前返回；无 failed stage checkpoint
的 repair-only 路径会先复用并校验 query-ready producer evidence，然后调用
`repo.completeStage({ stage: "query_ready", ... })`。该调用进入 repository
completion semantics，重新校验 query-ready evidence、graph identity，并发布
持久 capability projection。

## 逐条基准结果

1. PASS。`repair-local-artifact-gate-only` 不要求 failed stage checkpoint。
   当 `checkpoint == null` 时，`runRepairLocalArtifactGateOnly` 进入
   `repairQueryReadyProjectionIfPossible`。

2. PASS。repair-only projection recovery 复用 validated query-ready
   evidence。`queryReadyProducerArtifacts` 要求 `graph_extract`、
   `community_report`、`embed` 均 succeeded 且 run id 存在，并通过
   `assertGraphRagStageArtifactsReady` 校验 producer/query-ready artifacts。
   repair-only 入口在创建 GraphRAG runtime 前返回，不调用真实
   `runtime.graphIndex` rebuild。

3. PASS。此前 FAIL 已修复。`repairQueryReadyProjectionIfPossible` 现在在
   `graphQueryScopeFromSync` 前必经 `repo.completeStage({ stage:
   "query_ready" })`，不会因 derived capability 可见而短路。repository
   的 `writeStageCheckpoint` 对 succeeded `query_ready` 再次校验 producer
   stages、query-ready artifacts、graph identity，并调用
   `publishGraphCapabilities` 刷新持久 capability projection。

4. PASS。成功 projection repair 后输出包含 `status: "repaired"`、
   `repairedLocalArtifactGate: true` 和 `requiresRealRebuild: false`。

5. PASS。成功输出保留固定 metadata：`repairReason`、
   `repairedProjection`、`repairEvidenceLocator`、`reusedProducerRunIds` 和
   `settingsProjectionRepair`。

6. PASS。当前 stages 不完整且 `nextStage` 不是 `query_ready` 时，
   `repairQueryReadyProjectionIfPossible` 返回 `null`，外层 blocked 响应使用
   `sync.resumePlan.nextStage` 设置 `requiresRealRebuild` 和 `rebuildStage`。

7. PASS。projection-only 路径只重写目标 `query_ready` checkpoint 并刷新
   output producer manifest/capability projection；未发现清空或重写无关 batch
   state、command checks 或其他 completed book checkpoints。

8. PASS。同一 book id 来自当前 sync job；`query_ready` run id 优先复用既有
   checkpoint run id，其次复用 producer manifest 中的 `query_ready` run id。
   batch run id 不在该脚本中被替换。

9. PASS。projection repair 失败会被 catch 成 blocked JSON，包含 sanitized
   `reason`，无循环自旋。真实 rebuild 需求仍由 incomplete-stage blocked 分支
   明确返回。

10. PASS。既有 failed checkpoint 路径仍保留 graph identity、
    producer-manifest 和 settings projection failures 的修复行为；本次新增的
    no-failed-checkpoint 路径未删除原有分支。

## 剩余问题

未发现阻断问题。

残余风险：

- 现有 TS 测试仍主要覆盖分类、批处理接收 repair-only 输出后的行为，以及脚本
  片段不调用 `runtime.graphQuery`。未看到直接执行真实
  `repairQueryReadyProjectionIfPossible`、并断言
  `catalog/graph-capabilities.yaml` 被重新发布的端到端测试。建议后续增加一个
  小型 vault fixture：producer stages 与 `query_ready` 均 succeeded，显式
  graph capability 缺项，然后运行真实
  `resume-book-workspace.mjs --repair-local-artifact-gate-only`。
- failed-checkpoint 路径中的 query-ready completion 分支仍未合并既有
  `query_ready` metadata；本次关注的 no-failed-checkpoint 修复路径已通过
  `...(queryReadyCheckpoint?.metadata ?? {})` 保留 metadata。若希望两个路径
  完全一致，建议后续统一。

## 验证

- `node --check scripts/graphrag/resume-book-workspace.mjs`：通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot
  --testTimeout 60000 test/cli.test.ts -t
  "repair-only validates query-ready projection without graph query calls|repair-only blocked can reopen a real GraphRAG rebuild|classifies query-ready projection failures|keeps query_ready resume stage"`：
  4 passed，183 skipped。
- `python -m pytest test/python/test_graphrag_bridge_scope.py -q -k
  "capability_scope"`：12 passed，16 deselected，8 subtests passed。
