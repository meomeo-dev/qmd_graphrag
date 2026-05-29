result: PASS

# 开发复审报告 C：GraphRAG query-ready recovery reopen 第 2 轮

caseId: graphrag-query-ready-recovery-reopen

复审对象为固定基准
`audit/graphrag-query-ready-recovery-reopen-run_1__closed/dev-agent-c/baseline.md`。
本轮只审计 GraphRAG query-ready recovery reopen 最新修复轮；固定基准未修改。

## 复审结论

第一次报告中的 C 类阻断问题已关闭，第 1 轮复审报告已按状态文件标记为旧代码
作废（obsolete）。本轮复审确认：

- 两个真实 failure text 均具备分类覆盖和 persisted `stop_until_fixed`
  reopen 回归。
- `repairReason` 使用 `graph_identity_projection_missing` 或
  `graph_query_capability_projection_missing`。
- `repairedProjection` 使用 `document_identity_map`、`graph_capability`
  或二者。
- `BatchItemCheckpoint.metadata`、`events.jsonl` 与
  `recovery-summary.json` 投影同一 repair evidence。
- `status.yaml` 已记录第一轮 FAIL、修复轮、第 2 轮 pending；真实恢复前
  未标记开发复审通过。

## 逐条基准结论

1. PASS。第一个真实 failure text
   `GraphRAG document identity is missing for query_ready:
   doc-fd8875181a17` 在 classifier 回归中断言为 permanent /
   non-retryable：`test/cli.test.ts:1789` 到 `test/cli.test.ts:1795`。
   同一文本进入参数化 persisted `stop_until_fixed` reopen 回归：
   `test/cli.test.ts:3776` 到 `test/cli.test.ts:3784`、
   `test/cli.test.ts:3843` 到 `test/cli.test.ts:3879`。

2. PASS。第二个真实 failure text
   `capabilityScope references unknown or not-ready graphCapabilityId(s):
   book-356ff4920cdf-0bbd8bdb:graph_query` 在 classifier 回归中断言为
   permanent / non-retryable：`test/cli.test.ts:1796` 到
   `test/cli.test.ts:1802`。同一文本进入参数化 persisted
   `stop_until_fixed` reopen 回归，并绑定 graph capability repair metadata：
   `test/cli.test.ts:3785` 到 `test/cli.test.ts:3794`、
   `test/cli.test.ts:3843` 到 `test/cli.test.ts:3879`。

3. PASS。repair 成功写入固定 metadata 字段，且 reopen 前通过 schema 校验。
   `RepairMetadataSchema` 固定字段包括 `reopenedFromStatus`、
   `reopenedToStatus`、`reopenedFromRecoveryDecision`、`repairReason`、
   `repairFailureText`、`repairedProjection`、`repairEvidenceLocator`、
   `reusedProducerRunIds` 和 `normalCommandChecksRequired`：
   `scripts/graphrag/batch-epub-workflow.mjs:140` 到
   `scripts/graphrag/batch-epub-workflow.mjs:154`。repair 输出在写入
   checkpoint/event 前经 `parseRepairMetadata()` 校验：
   `scripts/graphrag/batch-epub-workflow.mjs:3247` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3266`。

4. PASS。repair 不直接 completed，后续仍进入正常闭环执行。实现将 repaired
   checkpoint reopen 为 `pending` / `continue_pending`，清空失败状态并设置
   `normalCommandChecksRequired=true`：
   `scripts/graphrag/batch-epub-workflow.mjs:3356` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3394`。回归测试断言 repair 后
   checkpoint 未 completed，且出现后续 `item_start` 事件：
   `test/cli.test.ts:3980` 到 `test/cli.test.ts:4006`。

5. PASS。repair-only 路径不发起 `runtime.graphQuery`。测试截取
   `runRepairLocalArtifactGateOnly` 函数体并断言包含 projection validation 与
   规范 repair reason，同时不包含 `runtime.graphQuery`：
   `test/cli.test.ts:1805` 到 `test/cli.test.ts:1821`。实际
   `runtime.graphQuery` 调用位于正常 query 路径：
   `scripts/graphrag/resume-book-workspace.mjs:922` 到
   `scripts/graphrag/resume-book-workspace.mjs:947`。

6. PASS。repair blocked loop 不会无限重复 repair。执行器用
   `repairBlockedThisRun` 记录本轮已 blocked 的 item，并发出
   `item_local_artifact_gate_repair_blocked_skip` 后跳过重复 repair：
   `scripts/graphrag/batch-epub-workflow.mjs:3810` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3840`、
   `scripts/graphrag/batch-epub-workflow.mjs:3900` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3907`。测试覆盖缺失 repair
   metadata 的 blocked 场景并断言未发出 reopen event：
   `test/cli.test.ts:4309` 到 `test/cli.test.ts:4450`。

7. PASS。类型检查结果在状态文件记录为 pass：
   `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:97` 到
   `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:99`。新增
   recovery summary repair metadata 已加入 TypeScript 合约 zod schema：
   `src/contracts/batch-run.ts:212` 到 `src/contracts/batch-run.ts:250`。
   batch runner 内部 summary schema 也包含同名字段：
   `scripts/graphrag/batch-epub-workflow.mjs:491` 到
   `scripts/graphrag/batch-epub-workflow.mjs:529`。

8. PASS。文档、Type DD 和 data-bus catalog 与实现字段名一致。runbook 定义
   repair metadata 字段和规范值，并要求 `events.jsonl` 与
   `recovery-summary.json` 投影同一事实：
   `docs/operations/graphrag-epub-batch-runbook.md:81` 到
   `docs/operations/graphrag-epub-batch-runbook.md:97`。Type DD 使用同一字段
   集合：`docs/architecture/unified-retrieval-plane.type-dd.yaml:375` 到
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:391`。data-bus catalog
   定义相同 reason、projection 和 metadata 契约：
   `catalog/data-bus.catalog.yaml:1088` 到 `catalog/data-bus.catalog.yaml:1102`。

9. PASS。每本书状态快照仍包含 `qmdBuildStatus`、`graphBuildStatus` 和
   `graphQueryStatus`，repair 未绕过快照。`loadCheckpoint()` 和
   `saveCheckpoint()` 都通过 `withBuildStatusSnapshot()` 写入 typed checkpoint：
   `scripts/graphrag/batch-epub-workflow.mjs:1218` 到
   `scripts/graphrag/batch-epub-workflow.mjs:1265`。合约 hydration 仍为缺失
   snapshot 提供 pending defaults：`src/contracts/batch-run.ts:291` 到
   `src/contracts/batch-run.ts:304`。

10. PASS。真实批处理恢复前的可审计证据已保留。状态文件记录最新修复验证：
    focused 12 tests、完整 `test/cli.test.ts` 180 tests、完整
    `test/graphrag-book-state.test.ts` 25 tests 和 `npm run test:types` 均为
    pass：`audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:64` 到
    `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:99`。同一文件
    记录第一轮开发审计 FAIL、修复轮和第 2 轮 pending：
    `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:100` 到
    `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:140`。第 2 轮
    结果仍为 pending，未在真实恢复前提前显示开发复审通过。

## 重点复审项

- 两个真实 failure text 均有分类和 persisted `stop_until_fixed` reopen 回归：
  PASS。
- `repairReason` 仅使用
  `graph_identity_projection_missing` 或
  `graph_query_capability_projection_missing`：
  PASS，见 `scripts/graphrag/batch-epub-workflow.mjs:130` 到
  `scripts/graphrag/batch-epub-workflow.mjs:133`、
  `scripts/graphrag/resume-book-workspace.mjs:772` 到
  `scripts/graphrag/resume-book-workspace.mjs:823`。
- `repairedProjection` 使用 `document_identity_map`、`graph_capability`
  或二者：
  PASS，见 `scripts/graphrag/batch-epub-workflow.mjs:134` 到
  `scripts/graphrag/batch-epub-workflow.mjs:139`。
- `recovery-summary.json` 投影 checkpoint/event 同一 repair evidence：
  PASS，测试同时断言 checkpoint metadata、event metadata 和 summary item：
  `test/cli.test.ts:3963` 到 `test/cli.test.ts:4001`；实现从 checkpoint
  metadata 投影 summary 字段：
  `scripts/graphrag/batch-epub-workflow.mjs:2573` 到
  `scripts/graphrag/batch-epub-workflow.mjs:2581`。
- `status.yaml` 准确记录审计状态，最终通过前不允许真实恢复：
  PASS，`devReauditRound2.result` 仍为 `pending`：
  `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:134` 到
  `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:140`。

## 验证记录

状态文件记录以下验证均为 pass，本复审未重新运行测试命令：

- `node ./node_modules/vitest/vitest.mjs run test/cli.test.ts --testNamePattern
  "keeps batch state typed|keeps query_ready resume stage|keeps transient and
  permanent provider recovery decisions typed|classifies query-ready projection
  failures|repair-only validates query-ready projection|normal run stops
  repair-only|reopens query-ready .* projection gate failures|mixed data
  compatibility|mixed provider failure|blocks repaired local projection
  output|status-json hydrates event-proven repair-only blocked loops"
  --testTimeout 120000 --reporter=dot`
- `node ./node_modules/vitest/vitest.mjs run test/cli.test.ts
  --testTimeout 120000 --reporter=dot`
- `node ./node_modules/vitest/vitest.mjs run test/graphrag-book-state.test.ts
  --testTimeout 120000 --reporter=dot`
- `npm run test:types`

复审未发现阻断项。按固定基准 C，本修复轮可进入后续开发复审汇总与真实恢复
决策流程。
