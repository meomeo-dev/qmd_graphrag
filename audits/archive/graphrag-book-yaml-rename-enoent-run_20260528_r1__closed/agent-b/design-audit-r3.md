# Design Audit R3

结论：PASS。

R2 缺口已补平。Type DD 已要求 `resume-book-*` 子进程内
`DurableStateError` 通过 `QMD_GRAPHRAG_DURABLE_FAILURE` typed envelope
传递，父 runner 优先解析，并将 durable fields 无损投影到
`commandCheck`、item checkpoint、`command_failed`、`item_failed`、
status-json 与 recovery summary。

## 已确认覆盖点

- book-scoped YAML 目标已纳入 `targetMapping`。
- 子进程 envelope、required fields、父 runner 解析优先级、无损投影与
  fail-closed 规则已定义。
- 缺 envelope 或缺字段时固定为 `local_state_integrity`、`retryable: false`、
  `stop_until_fixed`，并使用 `durable_subprocess_evidence_incomplete`、
  `completedPublishRule: forbidden`、unavailable sentinel 与
  `evidenceIncomplete`。
- `command_failed` / `item_failed` 的 rename ENOENT 必填字段已补入
  `failedSyscall`、`errno`、`renameCause`、`lane`、`targetMappingOwner`、
  `leaseGeneration`、`completedPublishRule`。
- status-json durable failure entry 与 recovery summary 已要求保留 ENOENT
  根因字段。
- `book_scoped_yaml_rename_enoent_resume_child` 验收项已覆盖三类 book YAML
  target、resume child 内失败、commandCheck、checkpoint、events、
  status-json、recovery summary 与禁止 completed 发布。
