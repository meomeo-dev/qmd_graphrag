# Design Audit R2

结论：PASS。

从验收矩阵角度，Type DD 已覆盖当前真实失败闭环。

## 已确认覆盖点

- `book_scoped_yaml_rename_enoent_resume_child` 覆盖 `job.yaml`、
  `checkpoints.yaml`、`artifacts.yaml` 在 `resume-book-*` 子进程内触发
  `rename ENOENT`。
- `subprocess_command_check_durable_schema` 覆盖子进程 typed envelope、父
  runner 优先解析、`commandCheck` 作为 first-hop durable evidence carrier。
- `commandCheckDurableEvidence` 明确禁止 durable failure 被投影为 `unknown`，
  并要求保留 `failedSyscall`、`errno`、`tempId`、`operationId`、
  `renameCause`、`completedPublishRule` 等字段。
- `statusJsonReadOnlyContract` 明确 `--status-json` 为只读 observer，禁止
  lock/temp/checksum/event/manifest/status/recovery-summary 等任何写入。
- 验收项要求 `completed is not published and batch stops until fixed`。
- `productionDryRun.realEpubRecoveryGate` 要求 stop 后必须 repair 或 explicit
  resume 才能继续同一 item，并要求最终 qmd command checks、GraphRAG
  producer lineage、query-ready evidence 完整闭环。
