# 开发审计基准 A：Batch 状态机与恢复元数据

caseId: graphrag-query-ready-recovery-reopen

## 审计范围

审计实现是否将本地 GraphRAG query-ready / graph-query 投影门控失败，从
persisted `stop_until_fixed` checkpoint 安全重开为正常闭环继续执行。重点文件：

- `scripts/graphrag/batch-failure-classifier.mjs`
- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `test/cli.test.ts`

## 固定基准

1. 两条真实 failure text 必须被稳定分类为本地产物/投影门控失败，且
   `failureKind=permanent`、`retryable=false`。
2. `checkpointFailureText` 必须同时读取 checkpoint 顶层错误和 failed command
   check 错误，并避免重复文本污染 `repairFailureText`。
3. `stop_until_fixed` checkpoint 只能在 local artifact/projection gate 命中时
   尝试 repair；provider/network/data compatibility 失败不得进入本地重开。
4. repair 成功后 batch checkpoint 必须先写为 `pending`，并设置
   `recoveryDecision=continue_pending`，不得直接写为 `completed`。
5. repair 成功后必须清空旧 `failedAt`、`retryExhausted`、`failureKind`、
   `retryable`、`failedStage` 和旧 command checks，使后续正常 command checks
   重新建立事实。
6. repair 成功 metadata 必须包含 `reopenedFromStatus`、
   `reopenedToStatus`、`reopenedFromRecoveryDecision`、`repairReason`、
   `repairFailureText`、`repairedProjection`、`repairEvidenceLocator`、
   `reusedProducerRunIds`、`normalCommandChecksRequired=true`。
7. repair blocked 时 checkpoint 必须保持 `pending/continue_pending`，并记录
   blocked reason，不得在同一 runner invocation 内无限重复 repair。
8. event log 必须投影同一组 repair metadata，至少包含一个
   `item_local_artifact_gate_repair_reopened` 事件。
9. repair 后必须回到普通 item execution path；如果普通闭环失败，最终失败必须
   反映新的失败阶段，而不是伪造旧 query-ready repair 成功。
10. `--status-json` 只读路径不得写入 checkpoint、event log、producer manifest
    或其他恢复产物。
