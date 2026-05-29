# Design Audit R4

结论：FAIL。

## 阻塞缺口

- `eventSchema.conditionalFields` 未声明 `cleanupReason`，但异常
  `durable_temp_reconciled` 事件要求携带该字段。
- `eventSchema.conditionalFields` 未声明 `checksumRecoveryDecision`，但
  `durable_checksum_backfilled` 非 committed 场景要求携带该字段。
- `commandCheckDurableEvidence.requiredForSubprocessDurableFailures` 未显式要求
  `lane`、`targetMappingOwner`、`leaseGeneration`，但
  `book_scoped_yaml_rename_enoent_resume_child` 要求这些字段从子进程 durable
  failure 经 commandCheck 投影到 `command_failed` 与 `item_failed` 事件。
