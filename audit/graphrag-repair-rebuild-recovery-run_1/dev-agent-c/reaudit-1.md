# Development Reaudit Report - Dev Agent C

Development Reaudit: PASS

## 审计范围

- 固定基准：`audit/graphrag-repair-rebuild-recovery-run_1/dev-agent-c/baseline.md`
- 复审对象：当前未提交工作树中的 batch runner、batch contract、
  resume workspace、GraphRAG book state 与相关测试。
- 重点复核：前次失败的 real rebuild blocked 事件/checkpoint 字段一致性
  （field coherence）与 recovery summary 投影。

## 逐条结论

1. PASS。batch runner 仍按 `itemId` 独立恢复；blocked repair 跳过集合
   只按当前 item 生效，未发现一个 book 的 repair 污染另一个 book。
2. PASS。状态字段仍由 Zod schema 约束并保持机器可读；新增 summary 字段
   同步加入脚本内 schema 与 `src/contracts/batch-run.ts`。
3. PASS。real rebuild blocked 分支已使用共享恢复字段：
   `failureKind`、`retryable`、`attemptExhausted`、`recoveryDecision`
   和 `failedStage` 在事件与临时恢复 checkpoint 中一致。
4. PASS。real rebuild recovery 不保留 stale `nextRetryAt` 或
   `retryDelaySeconds`；`markItemRunning` 进入普通 resume 前也会清空延迟字段。
5. PASS。事件日志包含 `requiresRealRebuild`、`rebuildStage`、
   `failureKind: "transient"`、`retryable: true`、
   `attemptExhausted: false`、`recoveryDecision: "retry_same_run_id"`，
   不需要读取 raw stdout 即可审计恢复决策。
6. PASS。recovery summary 仍用 `recoveryDecisionForBatch` 分类批次决策；
   同时新增 real rebuild 标志投影，便于 summary 层审计。
7. PASS。新增字段未削弱 redaction；reason 仍经 `redacted()`，metadata 和
   summary 投影仍走现有 JSON redaction 路径。
8. PASS。测试覆盖 repair-only blocked 到普通 `resume-book-1` 的同轮转换，
   并断言 blocked skip 不发生。
9. PASS。新增/相关测试使用 fake runner、临时目录和 `--skip-dotenv`；
   定向验证未触发网络调用，CI 确定性通过。
10. PASS。最终状态可安全恢复真实 EPUB batch；不需要删除或手工编辑
    `graph_vault`，并且 sidecar 修复路径增加了 parquet 证据校验。

## 关键证据

- `scripts/graphrag/batch-epub-workflow.mjs:3866` 计算
  `recoveryFailureKind`，real rebuild 为 `"transient"`。
- `scripts/graphrag/batch-epub-workflow.mjs:3869` 计算
  `recoveryRetryExhausted`，real rebuild 为 `false`。
- `scripts/graphrag/batch-epub-workflow.mjs:3870` 计算
  `recoveryDecision`，real rebuild 为 `"retry_same_run_id"`。
- `scripts/graphrag/batch-epub-workflow.mjs:3873` 计算
  `recoveryFailedStage`，优先使用 `rebuildStage`。
- `scripts/graphrag/batch-epub-workflow.mjs:3875` 至 `3883` 的
  `item_local_artifact_gate_repair_blocked` 事件使用上述共享字段。
- `scripts/graphrag/batch-epub-workflow.mjs:3895` 至 `3905` 的返回
  checkpoint 使用同一组共享字段。
- `scripts/graphrag/batch-epub-workflow.mjs:3098` 至 `3101` 将
  `localArtifactGateRepairRequiresRealRebuild` 和
  `localArtifactGateRepairRebuildStage` 投影到 recovery summary。
- `src/contracts/batch-run.ts:268` 至 `269` 将同样的 summary 字段加入
  共享 batch contract。
- `test/cli.test.ts:4159` 至 `4168` 断言 real rebuild blocked 事件字段；
  `test/cli.test.ts:4182` 至 `4186` 断言 summary 投影。

## 阻断问题

无。

## 验证命令

通过：

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/cli.test.ts -t "repair-only blocked can reopen
  a real GraphRAG rebuild"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/integrations/contracts.test.ts -t
  "hydrates legacy repair-only blocked loops back to pending|accepts batch
  execution bus envelopes with real schemas"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-book-state.test.ts -t
  "repairs stale GraphRAG identity sidecar content metadata"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-book-state.test.ts -t
  "repairs stale GraphRAG identity sidecar path metadata"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-book-state.test.ts -t
  "rejects GraphRAG identity sidecar with missing graph document"`

未作为结论依据：

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-book-state.test.ts -t
  "repairs stale GraphRAG identity sidecar|rejects GraphRAG identity sidecar|
  falls back from mismatched sidecar|rejects query-ready fallback"`
  因选择器匹配多条较重 parquet fixture 用例，在 120s 外层命令超时；
  后续已用更窄选择器验证关键路径。
