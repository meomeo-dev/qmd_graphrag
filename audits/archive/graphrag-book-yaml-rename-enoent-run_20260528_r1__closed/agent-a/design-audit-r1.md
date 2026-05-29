# Design Audit R1

结论：FAIL。

本次真实失败链路是 book-scoped durable YAML `rename ENOENT`。期望分类为
`local_state_integrity`、`durable_temp_rename_enoent` 与
`stop_until_fixed`，但父 batch runner 在 `resume-book-2` 子进程边界观察到
`failureKind: unknown`。

## 已覆盖设计

- Type DD 已将 `graph_vault/books/{bookId}/job.yaml`、
  `artifacts.yaml`、`checkpoints.yaml` 与 `runs/{runId}.yaml` 注册为
  durable YAML target。
- Type DD 已规定 `rename ENOENT` 必须分类为 `local_state_integrity`、
  `durable_temp_rename_enoent`、`retryable: false` 与
  `stop_until_fixed`。
- Type DD 已禁止 `rename ENOENT` 降级为 `unknown`、provider transient 或
  普通业务失败。
- Type DD 已有通用 `rename_enoent` 验收矩阵。

## 阻塞缺口

- Type DD 未规定 `resume-book-workspace.mjs` 捕获 `DurableStateError` 时必须
  输出机器可解析的 structured failure envelope。
- `selfFailureProjection` 只覆盖 `--status-json` 自身失败，不能覆盖
  `resume-book-*` 普通子命令失败。
- 父 runner 当前主要从 stderr/stdout 文本做 `classifyFailure`，不能可靠保留
  子进程内部 `DurableStateError` 的 typed fields。
- durable error 类型本身已存在，缺口在 subprocess projection。

## 必须补充的设计约束

- 新增 `subprocessDurableFailureProjection`，至少覆盖
  `resume-book-workspace.mjs`。
- 子进程 durable failure envelope 必须包含 `schemaVersion`、`status`、
  `failureKind`、`localFailureClass`、`retryable`、`recoveryDecision`、
  `failedStage`、`targetLocator` 或 `redactedEvidenceLocator`、`tempId`、
  `operationId`、`failedSyscall`、`errno`、`renameCause`、`lane`、
  `targetMappingOwner`、`itemId`、`bookId`、`workerId`、`leaseGeneration` 与
  `completedPublishRule`。
- 父 runner 必须优先解析 typed failure envelope，再退回 legacy 文本分类。
- `commandChecks[]`、item checkpoint、event、status-json 与 recovery summary
  必须投影同一 durable classification。
- 增加 `resume_book_child_book_yaml_rename_enoent` 验收项，覆盖 `job.yaml`、
  `checkpoints.yaml` 与 `artifacts.yaml`。
