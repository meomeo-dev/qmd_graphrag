# Design Audit R1

结论：FAIL。

durable-state-store 与 batch runner 的跨进程 failure contract 不完整。
Type DD 已规定 `rename ENOENT` 的最终分类和观测面投影，但未规定
`resume-book` 子进程如何把 `DurableStateError` 作为机器可读 evidence 传给
父 runner，也未定义解析优先级与 fail-closed 规则。

## 已覆盖设计

- `rename ENOENT` 必须分类为 `local_state_integrity`，不得降级为
  `unknown`。
- failed terminal commit 必须写入 `localFailureClass`、`targetLocator` 或
  `redactedEvidenceLocator`、`tempId`、`operationId` 等 durable evidence。
- durable failure event 必须保证 checkpoint、event、status-json 与
  recovery summary 四个观测面一致。
- status-json 与 recovery summary 必须承载逐 item durable diagnostics。
- `rename_enoent` 验收矩阵要求 item checkpoint、durable event、
  `item_failed` event、status-json 与 recovery summary 包含关键字段。

## 阻塞缺口

- 缺少子进程 first-hop contract。
- 缺少父 runner 对 typed durable evidence 的解析优先级。
- Type DD 未把 `BatchCommandCheck` 绑定为跨进程 durable evidence carrier。
- 缺少 evidence 缺失、不可解析或字段不足时的 fail-closed 投影规则。

## 必须补充的设计约束

- 新增 `crossProcessDurableFailureContract`。
- `command_failed` 与 `BatchCommandCheck` 必须纳入
  `durableFailureEventEvidence` 的适用面。
- `commandCheck` 是子进程 durable failure 的第一权威载体。
- 从 stderr/raw error message 推断 durable failureKind 只能作为 legacy
  compatibility fallback。
- 增加 `resume_book_child_rename_enoent` 或等价验收项。

## 固定验收项

- 注入 `writeYamlFileUnlocked -> withDurableYamlFileLock ->
  upsertBookJob/writeStageCheckpoint` 的 rename ENOENT 时，`resume-book-2`
  子进程必须输出机器可读 durable failure evidence。
- failed `commandCheck` 必须包含 `failureKind: local_state_integrity`、
  `localFailureClass: durable_temp_rename_enoent`、`retryable: false`、
  `recoveryDecision: stop_until_fixed`、`failedStage: resume-book-2`、
  `targetLocator` 或 `redactedEvidenceLocator`、`tempId`、`operationId`、
  `failedSyscall: rename`、`errno: ENOENT` 与 `renameCause`。
- item checkpoint、`command_failed`、`item_failed`、manifest、status-json 与
  recovery summary 必须保持同一 durable classification。
- status-json 必须继续保持 read-only observer。
