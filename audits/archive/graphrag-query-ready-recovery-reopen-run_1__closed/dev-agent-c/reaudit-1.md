result: PASS

# 开发复审报告 C：GraphRAG query-ready recovery reopen

caseId: graphrag-query-ready-recovery-reopen

复审对象为固定基准
`audit/graphrag-query-ready-recovery-reopen-run_1__closed/dev-agent-c/baseline.md`。
本轮仅审计 GraphRAG query-ready recovery reopen 修复轮；固定基准未修改。

## 复审结论

第一次报告中的 C 类阻断问题已关闭：

- 两个真实 failure text 均具备 classifier 覆盖和 persisted
  `stop_until_fixed` reopen 回归。
- `repairReason` 已限定为
  `graph_identity_projection_missing` 或
  `graph_query_capability_projection_missing`。
- `repairedProjection` 已限定为 `document_identity_map`、
  `graph_capability` 或二者。
- `BatchItemCheckpoint.metadata`、`events.jsonl` 与
  `recovery-summary.json` 已投影同一 repair evidence。
- `status.yaml` 已记录第一次 FAIL、修复轮、验证命令、验证结果和复审
  pending 状态，未在真实恢复前显示开发复审已通过。

## 逐条基准结论

1. PASS。第一个真实 failure text
   `GraphRAG document identity is missing for query_ready:
   doc-fd8875181a17` 在 classifier 回归中断言为 permanent /
   non-retryable：`test/cli.test.ts:1789` 到 `test/cli.test.ts:1795`。
   同一文本也进入参数化 reopen regression，并构造 persisted
   `stop_until_fixed` checkpoint：`test/cli.test.ts:3776` 到
   `test/cli.test.ts:3784`、`test/cli.test.ts:3843` 到
   `test/cli.test.ts:3879`。

2. PASS。第二个真实 failure text
   `capabilityScope references unknown or not-ready graphCapabilityId(s):
   book-356ff4920cdf-0bbd8bdb:graph_query` 在 classifier 回归中断言为
   permanent / non-retryable：`test/cli.test.ts:1796` 到
   `test/cli.test.ts:1802`。同一文本也进入 persisted
   `stop_until_fixed` reopen regression，并绑定规范 repair metadata：
   `test/cli.test.ts:3785` 到 `test/cli.test.ts:3794`、
   `test/cli.test.ts:3843` 到 `test/cli.test.ts:3879`。

3. PASS。repair 成功后写入固定 metadata 字段，字段和值均受 schema 约束。
   实现定义 `RepairMetadataSchema`，包含 `reopenedFromStatus`、
   `reopenedToStatus`、`reopenedFromRecoveryDecision`、`repairReason`、
   `repairFailureText`、`repairedProjection`、`repairEvidenceLocator`、
   `reusedProducerRunIds` 和 `normalCommandChecksRequired`：
   `scripts/graphrag/batch-epub-workflow.mjs:130` 到
   `scripts/graphrag/batch-epub-workflow.mjs:154`。reopen 前通过
   `parseRepairMetadata()` 校验：`scripts/graphrag/batch-epub-workflow.mjs:684`
   到 `scripts/graphrag/batch-epub-workflow.mjs:685`、
   `scripts/graphrag/batch-epub-workflow.mjs:3242` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3256`。

4. PASS。repair 不直接 completed，后续仍进入正常闭环执行。回归测试断言
   repair 后 checkpoint 未 completed、normal command checks 仍 required，并出现
   后续 `item_start` 事件：`test/cli.test.ts:3963` 到
   `test/cli.test.ts:4006`。实现将 repaired checkpoint reopen 为 pending /
   `continue_pending`，清空 failed 状态并保留
   `normalCommandChecksRequired=true`：
   `scripts/graphrag/batch-epub-workflow.mjs:3346` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3385`。

5. PASS。repair-only 路径不发起 `runtime.graphQuery`。测试截取
   `runRepairLocalArtifactGateOnly` 函数体并断言包含 projection validation，
   但不包含 `runtime.graphQuery`：`test/cli.test.ts:1805` 到
   `test/cli.test.ts:1821`。

6. PASS。repair blocked loop 不会无限重复 repair。正常运行测试断言 blocked
   item 的 repair start 仅出现一次，并存在 skip/block event：
   `test/cli.test.ts:3738` 到 `test/cli.test.ts:3750`。status-json hydration
   从 event-proven repair-only blocked loop 恢复为 pending /
   `continue_pending`：`test/cli.test.ts:4301` 到 `test/cli.test.ts:4447`；
   hydration 实现将该场景标记为
   `recoveredFromRepairOnlyBlockedLoop`：
   `scripts/graphrag/batch-checkpoint-hydration.mjs:65` 到
   `scripts/graphrag/batch-checkpoint-hydration.mjs:99`。

7. PASS。状态文件记录 `npm run test:types` 结果为 pass：
   `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:83` 到
   `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:85`。
   新增 recovery summary metadata 已加入 TypeScript 合约 zod schema：
   `src/contracts/batch-run.ts:240` 到 `src/contracts/batch-run.ts:248`。
   batch runner 内部 summary schema 也包含同名字段：
   `scripts/graphrag/batch-epub-workflow.mjs:519` 到
   `scripts/graphrag/batch-epub-workflow.mjs:527`。

8. PASS。文档、Type DD、data-bus catalog 与实现字段名一致。runbook 定义
   `repairReason`、`repairFailureText`、`repairedProjection`、
   `repairEvidenceLocator`、`reusedProducerRunIds` 和
   `normalCommandChecksRequired`，并要求 events 与 recovery summary 投影同一事实：
   `docs/operations/graphrag-epub-batch-runbook.md:81` 到
   `docs/operations/graphrag-epub-batch-runbook.md:97`。Type DD 和 data-bus
   catalog 使用同一字段集合：`docs/architecture/unified-retrieval-plane.type-dd.yaml:382`
   到 `docs/architecture/unified-retrieval-plane.type-dd.yaml:395`、
   `catalog/data-bus.catalog.yaml:1099` 到
   `catalog/data-bus.catalog.yaml:1102`。

9. PASS。每本书状态快照仍包含 `qmdBuildStatus`、`graphBuildStatus` 和
   `graphQueryStatus`，repair 未绕过快照。`loadCheckpoint()` 和
   `saveCheckpoint()` 都通过 `withBuildStatusSnapshot()` 写入 typed checkpoint：
   `scripts/graphrag/batch-epub-workflow.mjs:1210` 到
   `scripts/graphrag/batch-epub-workflow.mjs:1238`、
   `scripts/graphrag/batch-epub-workflow.mjs:1241` 到
   `scripts/graphrag/batch-epub-workflow.mjs:1255`。contract hydration 仍为缺失
   snapshot 提供 pending defaults：`src/contracts/batch-run.ts:295` 到
   `src/contracts/batch-run.ts:304`。

10. PASS。真实批处理恢复前的可审计证据已保留。状态文件记录第一次开发审计
    FAIL、首轮报告路径和 required implementation actions：
    `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:86` 到
    `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:106`。同一文件
    记录 focused tests、producer manifest tests 和 typecheck 命令及 pass 结果：
    `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:64` 到
    `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:85`。复审状态仍为
    pending，未在真实恢复前提前显示通过：
    `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:107` 到
    `audit/graphrag-query-ready-recovery-reopen-run_1__closed/status.yaml:113`。

## 验证记录

状态文件记录以下验证均为 pass：

- `node ./node_modules/vitest/vitest.mjs run test/cli.test.ts --testNamePattern
  "keeps batch state typed|keeps query_ready resume stage|keeps transient and
  permanent provider recovery decisions typed|classifies query-ready projection
  failures|repair-only validates query-ready projection|normal run stops
  repair-only|reopens query-ready .* projection gate failures|mixed data
  compatibility|blocks repaired local projection output|status-json hydrates
  event-proven repair-only blocked loops" --testTimeout 120000 --reporter=dot`
- `node ./node_modules/vitest/vitest.mjs run test/graphrag-book-state.test.ts
  --testNamePattern "drops stale producer run ids|keeps producer manifest
  portable" --testTimeout 120000 --reporter=dot`
- `npm run test:types`

复审未发现阻断项。按固定基准 C，本修复轮可进入后续开发复审汇总与真实恢复
决策流程。
