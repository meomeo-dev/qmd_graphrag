# Durable YAML Temp Collision 第三轮设计修正复审

## 结论

fail

## 阻塞项

### C09 event 层本地缺陷分类字段仍未完全满足

最新补丁已补齐 directory fsync 平台边界、fsync failure/unsupported 恢复动作、
残余风险诊断字段、不得发布 `completed` 规则；也已要求 item checkpoint 在
rename `ENOENT`、live temp deletion、checksum crash-window mismatch 与 lock
timeout 中持久写入 `localFailureClass`、redacted locator、`tempId` 与
`operationId`。

但固定基准 C09 要求 item checkpoint、event、status-json 与 recovery summary
均包含稳定 `failureKind`、`localFailureClass`、`recoveryDecision`、`failedStage`
与 redacted locator。当前 `eventSchema.conditionalFields` 仅列出
`targetLocator`、`tempId`、`operationId`、`localFailureClass`、`retryable` 与
`recoveryDecision` 等字段，未要求 durable state failure 事件或 `item_failed`
事件携带 `failureKind`、`failedStage` 与 `redactedEvidenceLocator`。因此仍不能
证明本次 durable YAML rename `ENOENT` 在事件流中稳定分类为可修复本地代码缺陷，
且不会被后续状态派生降级为 `unknown` 或 provider transient。

必须补充：对 `durable_replace_failed`、`durable_lock_timeout`、
`durable_temp_reconciled` 的异常清理事件以及对应 `item_failed` 事件，强制写入
`failureKind`、`localFailureClass`、`recoveryDecision`、`failedStage` 与
`redactedEvidenceLocator` 或等价 redacted locator，并在
`durableStateAcceptanceMatrix` 中验证事件层字段。
