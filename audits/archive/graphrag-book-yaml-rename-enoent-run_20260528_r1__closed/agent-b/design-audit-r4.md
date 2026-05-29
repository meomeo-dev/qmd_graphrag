# Design Audit R4

结论：FAIL。

## 阻塞缺口

- `eventSchema.conditionalFields` 未声明 `cleanupReason`、
  `checksumRecoveryDecision`、`evidenceIncomplete`、
  `evidenceIncompleteReason`、`unavailableFieldSentinels`、
  `primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind` 等字段，但这些
  字段在 durable failure event evidence、fail-closed projection、sidecar
  diagnostics 中被要求或验收使用。
- incomplete typed envelope 的事件投影不闭合。fail-closed rule 要求
  `command_failed`、`item_failed`、status-json 与 recovery summary 保留
  `evidenceIncomplete true`，但事件字段契约未覆盖相关字段。
- recovery summary 字段不足以无损投影 resume-book child durable envelope。
  缺少 `retryable`、`lane`、`targetMappingOwner`、`itemId`、`bookId`、
  `workerId`、`leaseGeneration`、`evidenceIncompleteReason` 与
  `unavailableFieldSentinels`。
- status-json durable failure entry 未 schema 化 `repairAllowed`，但验收要求
  `repairAllowed false`。
