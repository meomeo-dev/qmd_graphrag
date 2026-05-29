# Development Audit Report - Dev Agent C

Development Audit: FAIL

## 审计范围

- 基准（baseline）：`dev-agent-c/baseline.md` 的 10 条固定基准。
- 差异（diff）：当前未提交改动中的 batch runner、resume workspace、
  GraphRAG book state 和相关测试。
- 验证（verification）：定向 Vitest 用例全部通过；未运行完整测试套件。

已运行命令：

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/cli.test.ts -t "repair-only blocked can reopen
  a real GraphRAG rebuild"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-book-state.test.ts -t
  "repairs stale GraphRAG identity sidecar"`
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/integrations/contracts.test.ts -t
  "hydrates legacy repair-only blocked loops back to pending|accepts batch
  execution bus envelopes with real schemas"`

## 逐条结论

| # | 结果 | 结论 |
|---|---|---|
| 1 | PASS | batch item 仍按 `itemId` 独立处理；repair blocked 跳过集合按 item 隔离，未见跨书污染（cross-book pollution）。 |
| 2 | PASS | 新状态仍为 schema-valid 的机器字段（machine-readable fields）；`status`、`recoveryDecision`、延迟字段均能通过当前 Zod schema。 |
| 3 | FAIL | real rebuild 分支的事件字段和持久 checkpoint 字段不一致，阻断通过。详见阻断问题 1。 |
| 4 | PASS | `requiresRealRebuild` 分支清除 `nextRetryAt` 和 `retryDelaySeconds`；`markItemRunning` 也会在普通 resume 前再次清除。 |
| 5 | PASS | 事件日志（event log）包含 `requiresRealRebuild`、`rebuildStage` 和原因，可不读 raw stdout 审计决策；但字段一致性需按阻断问题修复。 |
| 6 | PASS | `recoveryDecisionForBatch` 会把 pending 且 retryable 或 `retry_same_run_id` 的 item 分类为 `retry_same_run_id`。 |
| 7 | PASS | 未见 redaction weakened。新增 reason 经 `redacted()`，事件 metadata 经 `redactJsonValue()`。 |
| 8 | PASS | 新测试覆盖 repair-only blocked 到普通 `resume-book-1` 的同轮转换（same-run transition）。 |
| 9 | PASS | 新测试使用 fake resume runner、临时目录和 `--skip-dotenv`，定向 CI 测试确定性通过。 |
| 10 | PASS | real rebuild reopen 状态不会要求删除或手工编辑 `graph_vault`；checkpoint 可直接同 run 恢复并立即进入普通 resume。 |

## 阻断问题

1. real rebuild blocked 转换的状态字段不一致（field incoherence）。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3860` 的
  `item_local_artifact_gate_repair_blocked` 事件在
  `requiresRealRebuild === true` 时仍写入
  `failureKind: checkpoint.failureKind ?? "permanent"`，同时写入
  `retryable: true` 和 `recoveryDecision: "retry_same_run_id"`。
- 同一分支返回的 checkpoint 在
  `scripts/graphrag/batch-epub-workflow.mjs:3887` 将
  `failureKind` 改为 `"transient"`，并在
  `scripts/graphrag/batch-epub-workflow.mjs:3895` 将 `failedStage`
  改为 `rebuildStage`。
- 事件 top-level `failedStage` 仍是旧的 `checkpoint.failedStage`
  （通常为 `resume-book-1`），而 checkpoint `failedStage` 是
  `graph_extract` 等 rebuild stage。

影响：

- 同一恢复决策同时呈现为 `permanent + retryable=true +
  retry_same_run_id` 和 `transient + retryable=true +
  retry_same_run_id`，机器消费者无法一致解释。
- `failedStage` 在事件和 checkpoint 之间指向不同语义，恢复摘要、
  事件审计和后续自动化可能得出不同结论。
- retryable same-run checkpoint 的 `retryExhausted` 被置为
  `undefined`，而其他 retry same-run 路径通常显式为 `false`。

必须修复：

- 在 `repairLocalArtifactGate` 中先计算共享恢复字段：
  `recoveryFailureKind`、`recoveryRetryable`、
  `recoveryRetryExhausted`、`recoveryDecision`、`recoveryFailedStage`。
- 对 `requiresRealRebuild === true`，事件和 checkpoint 应使用同一组
  值，例如 `failureKind: "transient"`、`retryable: true`、
  `retryExhausted: false`、`recoveryDecision: "retry_same_run_id"`、
  `failedStage: rebuildStage ?? checkpoint.failedStage ?? ...`。
- 如果认为 `"transient"` 不能表达 real rebuild required，应显式扩展
  contract（contract extension）和迁移；不要编码
  `permanent + retryable=true`。

## 建议修复

- 为新增测试补充断言：`item_local_artifact_gate_repair_blocked` 事件的
  `failureKind`、`failedStage`、`retryable`、`recoveryDecision` 必须与
  checkpoint 一致。
- 增加一个 `--status-json` 或 `recovery-summary.json` 用例，直接验证
  real rebuild reopen 后的 summary `recoveryDecision` 为
  `retry_same_run_id`，且无 stale retry delay。
- 如运行人员需要通过 summary 判断 real rebuild 原因，可把
  `localArtifactGateRepairRequiresRealRebuild` 和
  `localArtifactGateRepairRebuildStage` 投影到 recovery summary item。
