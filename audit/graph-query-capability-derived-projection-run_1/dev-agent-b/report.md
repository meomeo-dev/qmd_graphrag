# Dev Agent B Audit Report

结论：FAIL。

审计对象为固定 10 条基准（baseline）和
`scripts/graphrag/resume-book-workspace.mjs` 中
`repair-local-artifact-gate-only` 的新增 query-ready projection recovery
路径。核心阻断问题是：无 failed stage checkpoint 时，代码可能在
`graph_query` capability 可由 book state 派生（derived）时直接报告
`repaired`，但没有通过 repository completion semantics 刷新或发布
持久 capability projection。

## 逐条基准结果

1. PASS。无 failed stage checkpoint 时，`runRepairLocalArtifactGateOnly`
   会进入 `repairQueryReadyProjectionIfPossible`，不再直接要求
   local artifact gate failed checkpoint。

2. PASS。实际 repair 分支复用 query-ready producer evidence，并且
   repair-only 入口在创建 GraphRAG runtime 前返回，不调用
   `runtime.graphIndex` 或真实 GraphRAG rebuild。

3. FAIL。`repairQueryReadyProjectionIfPossible` 在
   `graphQueryScopeFromSync` 成功时直接返回，没有调用
   `repo.completeStage({ stage: "query_ready" })`，因此不会触发
   repository 的 `publishGraphCapabilities`。

4. PASS。成功返回路径包含 `status: "repaired"`、
   `repairedLocalArtifactGate: true` 和 `requiresRealRebuild: false`。

5. PASS。成功返回路径输出 `repairReason`、`repairedProjection`、
   `repairEvidenceLocator`、`reusedProducerRunIds` 和
   `settingsProjectionRepair`。但基准 3 的问题会使这些字段在派生
   capability 已可见但持久 projection 未刷新时产生误导。

6. PASS。当前 stages 不完整且 `nextStage` 不是 `query_ready` 时，
   repair-only 返回 blocked，并把 `requiresRealRebuild` 绑定到实际
   `sync.resumePlan.nextStage`。

7. PASS。审计范围内未发现 repair-only 路径清空或重写无关 batch
   state、command checks 或非目标 completed book checkpoints。

8. PASS。同一 book id 来自输入 source identity 与 source hash；repair
   分支复用既有 `query_ready` checkpoint run id 或 producer run ids。
   未发现 batch run id 被替换的路径。

9. PASS。projection repair 失败会返回 blocked JSON，并包含具体
   `reason`；repair-only 分支没有自旋循环。

10. PASS。既有 failed checkpoint repair 路径仍保留 graph identity、
    producer-manifest 和 settings projection failure 的成功修复行为。

## 发现的问题

### High: capability projection 可被派生可见性短路，未执行持久修复

证据：

- `scripts/graphrag/resume-book-workspace.mjs:685` 到 `691`：
  `graphQueryScopeFromSync` 成功时直接返回
  `repairedCheckpointStages: []`。
- `scripts/graphrag/resume-book-workspace.mjs:696` 到 `719`：
  只有短路未发生时，才会校验 query-ready producer evidence 并调用
  `repo.completeStage`。
- `src/job-state/repository.ts:2472` 到 `2556`：
  `query_ready` succeeded checkpoint 只有通过 `completeStage` 写入时才会
  校验 query-ready evidence 并触发 capability publication。
- `src/job-state/repository.ts:2590` 到 `2661`：
  `publishGraphCapabilities` 是发布显式 capability projection 的路径。
- `src/graphrag/capability-catalog.ts:397` 到 `450`：
  `loadGraphQueryCapabilities` 可从 book state 派生 ready
  `graph_query` capability。于是当 producer stages 和 `query_ready`
  checkpoint 已成功且 artifact/identity 有效时，显式
  `catalog/graph-capabilities.yaml` 缺失或缺项仍可能让
  `graphQueryScopeFromSync` 成功。
- `scripts/graphrag/resume-book-workspace.mjs:812` 到 `832`：
  外层随后输出 `status: "repaired"`、
  `repairReason: "graph_query_capability_projection_missing"` 和
  `repairedProjection: "graph_capability"`，即使没有刷新持久 projection。

影响：

- 违反基准 3：repair-only projection recovery 没有保证通过 repository
  completion semantics 发布或刷新 `query_ready` capability projection。
- 状态和观测字段可能误导：报告声称 `graph_capability` 已修复，但
  explicit projection 可能仍缺失或 stale。
- 依赖显式 capability catalog 的消费方仍可能在后续 query/resume 中再次
  失败，形成同类 stop-until-fixed 循环。

## 建议修复

- 在无 failed stage checkpoint 的 recovery 路径中，不要仅因
  `graphQueryScopeFromSync` 成功就返回 `repaired`。应先确认显式
  capability projection 已 current；否则继续执行 query-ready evidence
  校验并调用 `repo.completeStage({ stage: "query_ready", ... })`。
- 如果确认为无需修复，应返回 `ready` 或明确的 `already_ready` 语义，
  不应输出 `graph_query_capability_projection_missing` 的 repaired metadata。
- `repo.completeStage` 修复 `query_ready` 时应复用原 checkpoint run id，
  并合并保留既有 query-ready metadata，再追加
  `repairMode: "query_ready_projection_only"` 等 repair 观测字段。
- 增加真实 repair-only 集成测试：构造 producer stages 与
  `query_ready` 均 succeeded、显式 `catalog/graph-capabilities.yaml`
  缺失目标 `bookId:graph_query` 的 vault，运行
  `resume-book-workspace.mjs --repair-local-artifact-gate-only`，断言显式
  capability projection 被写回，stdout 包含固定 repair metadata，且未调用
  GraphRAG rebuild。

## 验证

- `node --check scripts/graphrag/resume-book-workspace.mjs`：通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot
  --testTimeout 60000 test/cli.test.ts -t
  "repair-only validates query-ready projection without graph query calls|repair-only blocked can reopen a real GraphRAG rebuild|classifies query-ready projection failures"`：
  3 passed，184 skipped。
