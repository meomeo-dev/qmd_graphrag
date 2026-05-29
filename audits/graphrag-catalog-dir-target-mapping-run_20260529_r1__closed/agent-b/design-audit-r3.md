# Design Audit R3 Agent B

## 结论

FAIL。

R3 复核确认，R2 agent-b 指出的多数目录 fsync target mapping 缺口已经补平。
`graph_vault/catalog` 不再会仅因缺少文件名触发
`durable_target_mapping_missing`，`book-leases` lane 冲突也已消除。

但是，directory fsync evidence 的跨观测面投影仍未在字段契约层完全闭合。
实现阶段仍需要在 command check、status-json、recovery summary 与 item
checkpoint 字段之间猜测如何携带 `fsyncTarget`、`fsyncPlatform`、
`fsyncErrno` 等目录 fsync 关键字段。因此当前设计仍不能判定为 PASS。

## 已闭合项

- `directoryFsyncRule` 已明确 parent directory fsync 是 primary 或 sidecar
  durable write 的派生提交步骤（derived commit step），不是独立业务 target。
- `graph_vault/catalog` 已有 `directoryFsyncScopes` 映射，并且
  `catalog_checksum_meta_backfill_parent_directory_fsync` 验收用例要求
  `books.yaml.sha256.meta.json` backfill 后 fsync `graph_vault/catalog` 时解析到
  `catalogWriterLane` 与 `repository`，不得出现
  `durable_target_mapping_missing`。
- `graph_vault`、`graph_vault/catalog/provider-requests`、
  batch run `items`、`provider-slots`、`subprocesses`、`book-leases`、
  book `runs`、`qmd`、`output`、deep lancedb、`graph_vault/dspy` 与 `.qmd`
  的主要目录 scope 已在 `directoryFsyncScopes` 中列出。
- `book-leases` 已统一归属 `checkpointWriterLane`，并与 `targetMapping` 和
  directory scope 保持一致。
- `directoryDurableKind: directory` 与 `primaryDurableKind` 已分离，基本消除
  directory operation 与 primary/sidecar durable kind 的语义歧义。
- `statusJsonReadOnlyContract.directoryFsyncProjection` 已禁止 read-only
  status-json 写入或 fsync，并要求按同一 `directoryFsyncRule` 投影诊断。
- 验收矩阵已覆盖 catalog checksum meta backfill、非 catalog directory scope、
  read-only fail-closed projection 与 directory fsync uncertain。
- 对真实失败链路
  `loadCatalogBySourceHash -> checksum meta backfill -> fsync graph_vault/catalog`，
  设计已经给出可实施路径：repair writer 写入 checksum meta sidecar 后，将父目录
  fsync 作为 sidecar commit 的派生边界处理，继承 `books.yaml` 的 lane 与 owner。

## 阻塞项

### 1. directory fsync evidence 未完整投影到 command check、status-json 与 recovery summary

涉及段落/关键词：

- `directoryFsyncEvidence.requiredFields`
- `platformFsyncBoundary.requiredDiagnostics`
- `durableFailureEventEvidence.conditionalFields.fsyncBoundary`
- `commandCheckDurableEvidence.requiredForSubprocessDurableFailures`
- `statusJsonDurableFailureEntryFields`
- `recoverySummaryRequiredFields`
- `terminalCommitProtocol.failed.itemCheckpointFailureEvidence`
- `directory_fsync_boundary_uncertain`

`directoryFsyncEvidence.requiredFields` 和
`platformFsyncBoundary.requiredDiagnostics` 已要求目录 fsync evidence 包含
`directoryTargetLocator`、`primaryTargetLocator` 或 `sidecarTargetLocator`、
`lane`、`targetMappingOwner`、`directoryDurableKind`、`primaryDurableKind`、
`fsyncTarget`、`fsyncPlatform`、失败时 `fsyncErrno` 与
`completedPublishRule`。

`durableFailureEventEvidence.conditionalFields.fsyncBoundary` 已基本同步这些字段。
但以下观测面仍不完整：

- `commandCheckDurableEvidence.requiredForSubprocessDurableFailures` 缺少
  `fsyncTarget`、`fsyncPlatform` 与 `fsyncErrno`。
- `workerLifecycle.subprocessDurableFailureProjection.requiredFields` 缺少
  directory fsync 专用字段，子进程 typed envelope 无法作为 command check 的
  完整 first-hop carrier。
- `statusJsonDurableFailureEntryFields.requiredForLocalStateFailures` 缺少
  `fsyncTarget`、`fsyncPlatform`、`fsyncErrno`，且 `lane`、
  `targetMappingOwner`、`directoryDurableKind`、`primaryDurableKind` 被放在
  `requiredForRenameEnoent` 下，不是 `durable_directory_*` 的独立必填条件。
- `recoverySummaryRequiredFields` 缺少 `fsyncTarget`、`fsyncPlatform` 与
  `fsyncErrno`。
- `terminalCommitProtocol.failed.itemCheckpointFailureEvidence` 没有
  `fsyncBoundary` 条件字段，不能保证 item checkpoint 保留目录 fsync 根因证据。

验收用例 `directory_fsync_boundary_uncertain` 已要求 status-json 与 recovery
summary 包含 `fsyncTarget`、`fsyncPlatform` 和 `fsyncErrno`，但上游字段契约没有
对应必填项。该不一致会导致实现阶段在 schema、projection 与 acceptance 之间
自行选择字段来源，仍属于 contract 缺口。

最小修正建议：

- 在 `commandCheckDurableEvidence.requiredForSubprocessDurableFailures` 中，为
  `localFailureClass is durable_directory_*` 增加 `fsyncTarget`、
  `fsyncPlatform` 与失败时 `fsyncErrno`。
- 在 `subprocessDurableFailureProjection.requiredFields` 中增加 directory fsync
  条件字段，或新增 `conditionalFields.fsyncBoundary`，确保 typed envelope 可无损
  投影到 command check。
- 在 `statusJsonDurableFailureEntryFields` 中新增
  `requiredForDirectoryFsyncBoundary`，包含 `directoryTargetLocator`、
  `primaryTargetLocator or sidecarTargetLocator`、`sidecarKind`、
  `lane`、`targetMappingOwner`、`directoryDurableKind`、
  `primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`、失败时
  `fsyncErrno` 与 `completedPublishRule`。
- 在 `recoverySummaryRequiredFields` 中补入 `fsyncTarget`、
  `fsyncPlatform` 与失败时 `fsyncErrno`。
- 在 `itemCheckpointFailureEvidence.conditional` 中新增 `fsyncBoundary`，
  至少保留 directory locator、primary/sidecar locator、lane、owner、
  durable kind、fsync platform/error 与 completed publish rule。

### 2. `graph_vault/dspy` 深层目录 scope 仍有递归语义风险

涉及段落/关键词：

- `directoryFsyncScopes`
- `targetMapping: graph_vault/dspy/**/*.yaml`
- `targetMapping: graph_vault/dspy/**/*.json`

`directoryFsyncScopes` 只列出 `graph_vault/dspy`，但 `targetMapping` 允许
`graph_vault/dspy/**/*.yaml` 与 `graph_vault/dspy/**/*.json`。若 DSPy policy
target 位于更深层目录，父目录 fsync 的 `directoryTargetLocator` 可能是
`graph_vault/dspy/{subdir}`，当前 scope 没有像
`graph_vault/books/{bookId}/output` 一样声明 recursive family scope。

最小修正建议：

- 将 `graph_vault/dspy` directory scope 明确标为 recursive family scope；或
- 显式增加 `graph_vault/dspy/**` / `graph_vault/dspy/**/*.yaml|json` 对应的
  directory fsync 派生规则，保证深层 DSPy target 的 parent directory fsync
  不需要实现自行解释前缀匹配。

## 残余非阻塞风险

- `catalogWriterLane.protects` 仍不是 `targetMapping` 的完整镜像。当前设计可由
  `targetMappingContract` 解释为 `targetMapping` 权威，但实现时应避免把
  `protects` 列表当成完整目标清单。
- `graph_vault/catalog` 同一父目录下存在多个 owner 的 primary target。正常写入
  应由 primary 或 sidecar locator 派生 owner；只有在只剩裸目录路径时才进入
  directory scope fallback。实现必须避免把 fallback owner 用于覆盖已知
  primary/sidecar owner。
