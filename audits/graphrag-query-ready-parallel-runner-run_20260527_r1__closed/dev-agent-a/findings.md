# 实施审计发现

## 审计结论

当前实现通过本次范围内的阻塞审计。未发现需要阻止合入或继续运行的
blocking finding。结论基于本地代码、测试、文档和真实批次状态的静态审计；
本次未执行测试命令。

## 已验证控制

1. old producer success 不覆盖当前非成功 checkpoint。
   [src/job-state/repository.ts:1012](/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1012)
   将 high-cost stage 的当前非 `succeeded` checkpoint 视为 recovered candidate
   阻断条件；
   [src/job-state/repository.ts:2719](/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2719)
   在构造 effective resume state 时跳过旧 succeeded candidate。对应回归测试见
   [test/book-job-state.test.ts:2025](/Users/jin/projects/qmd_graphrag/test/book-job-state.test.ts:2025)
   和
   [test/book-job-state.test.ts:2107](/Users/jin/projects/qmd_graphrag/test/book-job-state.test.ts:2107)。

2. Graph query capability 不从当前非成功 producer checkpoint 暴露。
   [src/graphrag/capability-catalog.ts:421](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:421)
   读取当前 producer checkpoint；
   [src/graphrag/capability-catalog.ts:435](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:435)
   在任何 producer 当前 checkpoint 非成功时返回 `null`。对应测试见
   [test/book-job-state.test.ts:2363](/Users/jin/projects/qmd_graphrag/test/book-job-state.test.ts:2363)
   到
   [test/book-job-state.test.ts:2370](/Users/jin/projects/qmd_graphrag/test/book-job-state.test.ts:2370)。

3. query_ready producer stage gate 采用 fail-closed 设计。
   [scripts/graphrag/resume-book-workspace.mjs:199](/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:199)
   只在 `graph_extract`、`community_report`、`embed` 三个 producer checkpoint
   均为 `succeeded` 且有 runId 时继续，否则抛出
   `query_ready requires completed graph_extract, community_report and embed stages`。
   [src/job-state/repository.ts:2888](/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2888)
   在写入 `query_ready=succeeded` 前再次验证 producer stage、artifact 和 graph
   identity。

4. 目标错误已进入 local artifact gate 恢复分类。
   [scripts/graphrag/batch-failure-classifier.mjs:200](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:200)
   将 `query_ready requires completed graph_extract` 识别为 local artifact gate；
   [scripts/graphrag/resume-book-workspace.mjs:259](/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:259)
   在 resume repair 侧使用同一类错误识别。hydration 回归见
   [test/integrations/contracts.test.ts:1641](/Users/jin/projects/qmd_graphrag/test/integrations/contracts.test.ts:1641)。

5. local artifact gate status-json 可恢复。
   [scripts/graphrag/batch-epub-workflow.mjs:5505](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:5505)
   的 status-json 只输出 hydrated recovery summary，不执行写修复；
   [scripts/graphrag/batch-epub-workflow.mjs:4173](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:4173)
   通过 `canRepairLocalArtifactGate` 将可修复 local artifact gate 投影为
   `continue_pending`，避免继续停留在不可恢复的 `stop_until_fixed`。

6. blocked repair 有可观测事件。
   [scripts/graphrag/batch-epub-workflow.mjs:4897](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:4897)
   发出 `item_local_artifact_gate_repair_blocked`，并包含 `requiresRealRebuild`、
   `rebuildStage`、`reason` 和 repair metadata；同轮重复尝试通过
   [scripts/graphrag/batch-epub-workflow.mjs:5662](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:5662)
   发出 blocked skip 事件。

7. requiresRealRebuild 不进入 provider wait，且会真实重建一次。
   [scripts/graphrag/batch-epub-workflow.mjs:792](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:792)
   在 checkpoint 已标记 `localArtifactGateRepairRequiresRealRebuild=true` 后禁止再次走
   local artifact gate repair；
   [test/cli.test.ts:4782](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4782)
   验证 repair-only blocked 后正常 `resume-book-1` 会真实重建一次，且
   [test/cli.test.ts:4974](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4974)
   断言没有 blocked skip，避免被错误地放入 provider wait 或 repair loop。

8. parallel runner 仍被设计性延期。
   [docs/architecture/graphrag-parallel-runner.type-dd.yaml:9](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-parallel-runner.type-dd.yaml:9)
   声明生产 writer 仍为单 runner；
   [docs/architecture/graphrag-parallel-runner.type-dd.yaml:71](/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-parallel-runner.type-dd.yaml:71)
   明确不启用同一 runId 多个无协调 writer，也不在 producer lineage 稳定前并行同书 stage。
   fresh/stale running 行为分别由
   [test/cli.test.ts:9000](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:9000)
   和
   [test/cli.test.ts:9114](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:9114)
   覆盖。

## Findings

### 无阻塞发现

- Severity: none
- Blocking: no
- Evidence: 当前实现已经覆盖本次要求的 producer lineage recovery gate、
  query_ready fail-closed、local artifact gate status-json recovery observability、
  requiresRealRebuild rebuild path 和 parallel runner deferral。
- Suggested fix: 无需阻塞修复。

### 非阻塞建议 1：补充真实批次形态的端到端回归

- Severity: low
- Blocking: no
- Evidence: 已有组件和 CLI fixture 覆盖关键不变量，但真实批次形态同时包含
  当前 `graph_extract=running`、旧 graph_extract artifacts、`query_ready=failed`
  和 batch item `failureKind=unknown`。
  真实状态见
  [graph_vault/books/book-b75032ab9516-ec793703/checkpoints.yaml:39](/Users/jin/projects/qmd_graphrag/graph_vault/books/book-b75032ab9516-ec793703/checkpoints.yaml:39)、
  [graph_vault/books/book-b75032ab9516-ec793703/artifacts.yaml:63](/Users/jin/projects/qmd_graphrag/graph_vault/books/book-b75032ab9516-ec793703/artifacts.yaml:63)、
  [graph_vault/books/book-b75032ab9516-ec793703/output/qmd_output_manifest.json:18](/Users/jin/projects/qmd_graphrag/graph_vault/books/book-b75032ab9516-ec793703/output/qmd_output_manifest.json:18)
  和
  [graph_vault/catalog/batch-runs/epub-batch-20260527-real-resume-1/items/item-b75032ab9516-bd1ba4a2.json:27](/Users/jin/projects/qmd_graphrag/graph_vault/catalog/batch-runs/epub-batch-20260527-real-resume-1/items/item-b75032ab9516-bd1ba4a2.json:27)。
- Suggested fix: 增加一个最小 fixture，固定该组合在 status-json 中被重分类为
  local artifact gate recovery，并在正常运行中先尝试 repair，无法验证旧 lineage 时
  输出 `requiresRealRebuild=true` 与具体 rebuild stage。

### 非阻塞建议 2：在 recovery summary 中投影 blocked reason

- Severity: low
- Blocking: no
- Evidence: blocked repair 事件和 checkpoint metadata 已可观测；
  recovery summary 当前投影 `localArtifactGateRepairRequiresRealRebuild` 与
  `localArtifactGateRepairRebuildStage`，但未直接投影
  `localArtifactGateRepairBlockedReason`。
  相关 summary 投影见
  [scripts/graphrag/batch-epub-workflow.mjs:4108](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:4108)。
- Suggested fix: 非必须。可在 `buildRecoverySummary` 中补充
  `localArtifactGateRepairBlockedReason`，提升 operator 在不读 event log 时的诊断效率。

## 需要补充的测试

1. 真实失败 fixture：当前 running/failed producer checkpoint 与旧 succeeded
   producer artifact 并存，断言旧 success 不覆盖当前非成功 checkpoint。
2. status-json fixture：目标错误从 `unknown + stop_until_fixed` hydrate 为 local
   artifact gate recovery，并投影 `continue_pending` 或 rebuild-required metadata。
3. normal-run fixture：repair-only 返回 `requiresRealRebuild=true` 后，不进入
   provider wait，不重复 blocked skip，并只启动一次真实 GraphRAG rebuild command。
4. capability fixture：当前 `graph_extract` 或 `query_ready` 非成功时，
   `loadGraphQueryCapabilities` 返回空集，即使旧 capability catalog 和旧 run record
   仍存在。
