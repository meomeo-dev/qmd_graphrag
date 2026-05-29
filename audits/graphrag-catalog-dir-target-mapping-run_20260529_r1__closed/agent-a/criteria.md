# Implementation Audit Criteria

本文定义本审计任务的固定实施审计基准（implementation audit criteria）。
后续重审不得改变本文件中的 10 条基准。

1. Durable atomic rename 的 `ENOENT` 必须被分类为
   `local_state_integrity`、`durable_temp_rename_enoent`、`retryable: false`
   与 `recoveryDecision: stop_until_fixed`，并保留 `failedSyscall: rename`、
   `errno: ENOENT`、`renameCause`、`tempId`、`operationId`、
   `targetLocator` 或 `redactedEvidenceLocator`、`lane`、
   `targetMappingOwner`、`leaseGeneration` 与
   `completedPublishRule: forbidden`。
2. `resume-book-workspace` 子进程捕获 `DurableStateError` 时，必须输出单行
   `QMD_GRAPHRAG_DURABLE_FAILURE` typed envelope。该 envelope 必须包含
   `schemaVersion`、`marker`、`status`、`failureKind`、
   `localFailureClass`、`retryable`、`recoveryDecision`、`failedStage`、
   target locator、`tempId`、`operationId`、`failedSyscall`、`errno`、
   `renameCause`、`lane`、`targetMappingOwner`、`itemId`、`bookId`、
   `workerId`、`leaseGeneration` 与 `completedPublishRule`。
3. 父 batch runner 必须先解析 typed envelope，再使用 legacy 文本分类
   （legacy text classifier）。envelope 可解析时，`BatchCommandCheck` 必须是
   子进程 durable failure 的 first-hop carrier，并保留父 runner 调度的
   command name，例如 `resume-book-1`。
4. `BatchCommandCheck`、item checkpoint、`command_failed`、`item_failed`、
   durable failure events、`status.json` 与 `recovery-summary.json` 必须无损
   投影 durable evidence，尤其是 `durable_temp_rename_enoent`、
   `failedSyscall: rename`、`errno: ENOENT`、`renameCause`、
   `completedPublishRule: forbidden`、`tempId` 与 `operationId`。
5. envelope 缺失、不可解析或 required fields 不完整，但父 runner 可确认失败
   发生在 durable subprocess boundary 时，必须 fail closed 为
   `local_state_integrity`、`durable_subprocess_evidence_incomplete`、
   `retryable: false` 与 `stop_until_fixed`，并写入 `evidenceIncomplete`、
   `evidenceIncompleteReason` 与 explicit unavailable sentinels。
6. `graph_vault/books/{bookId}/job.yaml`、`artifacts.yaml`、
   `checkpoints.yaml` 与 `runs/*.yaml` 必须使用 book-scoped durable YAML writer，
   target mapping 必须落在 `checkpointWriterLane` 与 `repository` owner。
   子进程内这些 book-scoped YAML target 的 rename `ENOENT` 不得被误投影为
   run-level item JSON、checksum sidecar 或 shared catalog failure。
7. `graph_vault/settings.yaml` 首次缺失时必须创建 managed projection，不得误判为
   user-owned settings。已存在且 valid 的 managed projection 不得重写；已存在但
   user-owned 或 invalid marker 的文件必须拒绝；invalid source config 必须与
   user-owned rejection 分开诊断。
8. durable preflight 与 `--status-json` 必须 fail closed 地报告 unresolved temp、
   live lock、checksum mismatch 或 partial checksum sidecar；`--status-json`
   不得写 checkpoint、event、manifest、`status.json` 或
   `recovery-summary.json`。
9. 测试必须真实覆盖 `resume-book-workspace.mjs` child process 中 book-scoped
   `checkpoints.yaml` durable YAML rename `ENOENT`。该测试不得用 fake resume
   runner 替代真实 child，不得只覆盖 run-level item JSON，也不得把 checksum
   sidecar rename 当作 primary YAML rename。
10. 测试必须覆盖 malformed、missing required fields 或 partial envelope 的
    fail-closed 行为，并覆盖 settings projection 首次缺失创建路径。类型检查、
    Type DD YAML parse、相关 `node --check` 与聚焦 Vitest 必须作为实施验证证据。
