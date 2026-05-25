result: FAIL

# 开发审计报告 C：GraphRAG query-ready recovery reopen

caseId: graphrag-query-ready-recovery-reopen

审计对象为固定基准
`audit/graphrag-query-ready-recovery-reopen-run_1/dev-agent-c/baseline.md`。
基准未修改。

## 阻断发现

1. 第二个真实 failure text 缺少 focused reopen regression。

   证据：

   - `test/cli.test.ts:1789` 到 `test/cli.test.ts:1803` 仅验证两个真实
     failure text 的 `classifyFailure()` 分类。
   - `test/cli.test.ts:3767` 到 `test/cli.test.ts:3965` 的 reopen 行为测试只覆盖
     `GraphRAG document identity is missing for query_ready:
     doc-fd8875181a17`。
   - `test/cli.test.ts:3790` 固定了第一个真实 failure text；仓库内未找到以
     `capabilityScope references unknown or not-ready graphCapabilityId(s):
     book-356ff4920cdf-0bbd8bdb:graph_query` 构造 persisted
     `stop_until_fixed` checkpoint 并执行 reopen 的测试。
   - `docs/architecture/unified-retrieval-plane.type-dd.yaml:1971` 到
     `docs/architecture/unified-retrieval-plane.type-dd.yaml:1976` 要求第二个真实
     failure text 在 validated `query_ready` lineage、artifact lineage 和 graph
     document identity 都存在时重建 `graph_query` capability projection，并重新运行
     GraphRAG query command check。

   影响：

   第二个真实失败只能证明被分类为 permanent/local artifact gate，不能证明会从
   persisted `stop_until_fixed` checkpoint 安全 reopen，也不能证明 capability
   projection repair 后会重新运行 `qmd-query-graphrag-json`。

   建议修复：

   增加 focused regression：用第二个真实 failure text 写入 failed
   `stop_until_fixed` batch checkpoint，提供 validated `query_ready` checkpoint、
   artifact lineage 和有效 document identity，断言 reopen 到 pending /
   `continue_pending`，修复 `graph_capability` projection，复用
   `graph_extract`、`community_report`、`embed` producer run ids，并重新进入
   `qmd-query-graphrag-json` command check；同时断言不得直接写成 completed。

2. repair metadata 的语义值与文档、Type DD、data-bus 不一致。

   证据：

   - `docs/operations/graphrag-epub-batch-runbook.md:84` 到
     `docs/operations/graphrag-epub-batch-runbook.md:95` 定义
     `repairReason` 必须为 `graph_identity_projection_missing` 或
     `graph_query_capability_projection_missing`，`repairedProjection` 必须为
     `document_identity_map`、`graph_capability` 或二者。
   - `docs/architecture/unified-retrieval-plane.type-dd.yaml:1681` 到
     `docs/architecture/unified-retrieval-plane.type-dd.yaml:1689` 使用
     `graph_identity_projection_missing` 作为本地 projection repair reason。
   - `catalog/data-bus.catalog.yaml:1088` 到 `catalog/data-bus.catalog.yaml:1095`
     定义 `graph_identity_projection_missing` 和
     `graph_query_capability_projection_missing` 两个本地 projection reason。
   - `scripts/graphrag/batch-epub-workflow.mjs:3160` 到
     `scripts/graphrag/batch-epub-workflow.mjs:3170` 写入的默认
     `repairReason` 为 `local_artifact_gate_projection_repaired`。
   - `scripts/graphrag/resume-book-workspace.mjs:804` 到
     `scripts/graphrag/resume-book-workspace.mjs:819` 输出的
     `repairReason` 为 `local_artifact_gate_projection_repaired`，且
     `repairedProjection` 使用 `stage_checkpoint_projection` 或
     `graph_query_capability_projection`。
   - `test/cli.test.ts:3935` 到 `test/cli.test.ts:3951` 将这些非规范值写入
     回归断言，固化了漂移。

   影响：

   checkpoint/event metadata 的字段名存在，但字段值不能区分
   document identity projection repair 与 graph capability projection repair。
   审计方按 runbook、Type DD 或 data-bus 解读时，会得到与实现不同的状态语义。

   建议修复：

   将实现和测试改为规范值：identity repair 使用
   `repairReason=graph_identity_projection_missing`、
   `repairedProjection=document_identity_map`；capability repair 使用
   `repairReason=graph_query_capability_projection_missing`、
   `repairedProjection=graph_capability`。如需表达多投影修复，使用文档定义的
   “二者”形式，并增加 typed metadata schema 防止再次漂移。

3. `recovery-summary.json` 未投影 repair evidence，和 runbook / data-bus
   观测性契约不一致。

   证据：

   - `docs/operations/graphrag-epub-batch-runbook.md:96` 到
     `docs/operations/graphrag-epub-batch-runbook.md:97` 要求 `events.jsonl` 和
     `recovery-summary.json` 投影同一 repair 事实，操作者不应依赖 raw logs。
   - `catalog/data-bus.catalog.yaml:117` 到 `catalog/data-bus.catalog.yaml:125`
     要求 recovery summary 暴露 identity repair evidence、capability repair
     evidence、reused producer run ids、reopened checkpoint、next stage 和需重跑的
     command check。
   - `src/contracts/batch-run.ts:212` 到 `src/contracts/batch-run.ts:241` 的
     `BatchRecoverySummaryItemSchema` 只包含 build status、失败分类、retry 和
     runner 字段，没有 `repairReason`、`repairEvidenceLocator`、
     `reusedProducerRunIds`、`normalCommandChecksRequired` 等 repair metadata。
   - `scripts/graphrag/batch-epub-workflow.mjs:2442` 到
     `scripts/graphrag/batch-epub-workflow.mjs:2491` 构造 summary item 时同样未从
     checkpoint metadata 投影 repair fields。
   - `test/cli.test.ts:3954` 到 `test/cli.test.ts:3959` 只断言
     `events.jsonl` 中的 repair metadata，没有断言 `recovery-summary.json` 的同一
     事实。

   影响：

   真实批处理恢复前，操作者无法仅通过 typed recovery summary 判断某本书为何从
   `stop_until_fixed` reopen 到 pending，也无法在 summary 中审计 repair evidence
   和复用的 producer lineage。

   建议修复：

   扩展 `BatchRecoverySummaryItemSchema`，从 checkpoint metadata 只读投影
   `reopenedFromStatus`、`reopenedToStatus`、`reopenedFromRecoveryDecision`、
   `repairReason`、`repairFailureText`、`repairedProjection`、
   `repairEvidenceLocator`、`reusedProducerRunIds` 和
   `normalCommandChecksRequired`。增加 focused test 同时读取 checkpoint、
   `events.jsonl` 和 `recovery-summary.json`，断言三者事实一致。

4. 真实恢复前的最终决策状态尚未写入状态文件。

   证据：

   - `audit/graphrag-query-ready-recovery-reopen-run_1/status.yaml:60` 到
     `audit/graphrag-query-ready-recovery-reopen-run_1/status.yaml:73` 已记录
     focused tests 与 typecheck 命令及 pass 结果。
   - `audit/graphrag-query-ready-recovery-reopen-run_1/status.yaml:74` 到
     `audit/graphrag-query-ready-recovery-reopen-run_1/status.yaml:82` 仍显示
     `devAudit.result: pending`。

   影响：

   本报告给出 dev-agent-c 的最终判断为 FAIL，但统一状态文件仍未保留最终决策。
   在该状态更新前，不应执行真实批处理恢复。

   建议修复：

   汇总所有开发审计报告后，由协调者更新 `status.yaml` 和最终报告，明确
   `devAudit.result` 与是否允许真实恢复。本代理按任务约束未修改该状态文件。

## 逐条基准结论

1. FAIL。第一个真实 failure text 被 classifier 与 reopen 测试覆盖，但 reopen
   测试使用 fake resume，未验证真实 sidecar / book-scoped output repair。
2. FAIL。第二个真实 failure text 只有 classifier 覆盖，缺少 persisted
   `stop_until_fixed` reopen focused regression。
3. FAIL。metadata 字段存在，但 `repairReason` / `repairedProjection` 值与
   runbook、Type DD、data-bus 漂移。
4. PASS。测试断言 repair 后 checkpoint 未直接 completed，并进入后续 normal run：
   `test/cli.test.ts:3932` 到 `test/cli.test.ts:3964`。
5. PASS。repair-only body 未包含 `runtime.graphQuery`：
   `test/cli.test.ts:1805` 到 `test/cli.test.ts:1821`。
6. PASS。blocked repair 在同一 runner invocation 内只启动一次，并通过 skip event
   避免重复 repair：`test/cli.test.ts:3713` 到 `test/cli.test.ts:3736`。
7. PASS。`npm run test:types` 通过；checkpoint/event/summary metadata 当前满足
   JSON value zod 约束。
8. FAIL。文档、Type DD、data-bus 与实现的 repair reason / repaired projection
   语义不一致，且 recovery summary 未投影 data-bus 要求的 repair evidence。
9. PASS。`saveCheckpoint()` / `loadCheckpoint()` 通过
   `withBuildStatusSnapshot()` 重算并写入 `qmdBuildStatus`、
   `graphBuildStatus`、`graphQueryStatus`：
   `scripts/graphrag/batch-epub-workflow.mjs:1135` 到
   `scripts/graphrag/batch-epub-workflow.mjs:1182`。
10. FAIL。固定基准、测试命令和测试结果已留存，本报告已生成；但状态文件的
    `devAudit.result` 仍为 pending，真实恢复前缺少统一最终决策状态。

## 验证命令

- `node ./node_modules/vitest/vitest.mjs run test/cli.test.ts --testNamePattern
  "keeps batch state typed|keeps query_ready resume stage|keeps transient and
  permanent provider recovery decisions typed|classifies query-ready projection
  failures|repair-only validates query-ready projection|normal run stops
  repair-only|reopens query-ready projection gate failures|status-json hydrates
  event-proven repair-only blocked loops" --testTimeout 120000 --reporter=dot`
  结果：PASS，1 个 test file passed，8 tests passed，168 skipped。
- `npm run test:types`
  结果：PASS，`tsc -p tsconfig.build.json --noEmit` 无错误。

命令通过不消除上述阻断发现；当前实现不应进入真实批处理恢复。
