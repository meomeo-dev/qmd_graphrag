# Design Audit R2

结论：FAIL。

R2 已覆盖 envelope、命令身份、typed parse 优先级、legacy fallback、
fail-closed 与真实 EPUB gate 的主要设计方向，但仍有阻塞缺口。

## 阻塞缺口

- typed envelope 未被强制无损投影到所有观测面。事件与 durable failure event
  evidence 没有把 `failedSyscall`、`errno` 列为 rename ENOENT 事件必备字段。
- status-json 与 recovery summary 的 durable 诊断字段不足。逐条 durable
  failure entry 未强制保留 `failedSyscall`、`errno`、`renameCause`、
  `completedPublishRule` 等 envelope 字段。
- 缺证据 fail-closed 路径没有指定 fallback `localFailureClass`、
  `completedPublishRule`，也未说明缺字段时如何满足 checkpoint 必填 durable
  evidence。
- `book_scoped_yaml_rename_enoent_resume_child` 验收用例对
  `command_failed`、`item_failed`、status-json 与 recovery summary 的字段要求
  弱于目标行为。

## 必须修改的设计项

- 在 rename ENOENT 事件必备字段中加入 `failedSyscall`、`errno`、
  `renameCause`、`lane`、`targetMappingOwner`、`leaseGeneration` 与
  `completedPublishRule`。
- 定义 status-json durable failure entry 与 recovery summary failed item entry
  的 required fields。
- 指定缺 envelope 或缺字段时的 fallback `localFailureClass`、
  `completedPublishRule`、`redactedEvidenceLocator` 与 unavailable sentinel
  规则。
- 加强 book-scoped resume-child 验收，确保所有观测面都包含 ENOENT 根因字段。
