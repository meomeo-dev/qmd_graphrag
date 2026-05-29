# Design Audit R4 Agent C

## 结论

FAIL。

`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 已闭合 R3 大部分
阻塞项：item checkpoint、subprocess typed envelope、generic event schema、
durable failure event、command check、status-json durable failure entry 与
recovery summary 均已补入 directory fsync boundary 字段。`graph_vault/dspy`
也已声明 recursive family scope。

但 `status-json` 自身读取 durable target 失败时的 self failure projection
仍未列齐同一组 fsync boundary 字段。该观测面是 R4 明确要求核对的闭包面；
当前字段不一致会迫使实现阶段在自失败 JSON 输出中猜测是否保留 lane、owner、
durable kind、sidecar kind 与 sentinel evidence。

## 已核对闭包

- `directoryFsyncRule` 仍明确 parent directory fsync 是 primary 或 sidecar
  durable write 的派生提交步骤（derived commit step），不是独立业务 target。
- `directoryFsyncEvidence.requiredFields` 已包含 `directoryTargetLocator`、
  `primaryTargetLocator or sidecarTargetLocator`、`sidecarKind`、`lane`、
  `targetMappingOwner`、`directoryDurableKind`、`primaryDurableKind`、
  `fsyncTarget`、`fsyncPlatform`、失败时 `fsyncErrno` 与
  `completedPublishRule`。
- `unavailableSentinelRule` 已要求 directory fsync unsupported、uncertain 或
  平台未返回 errno 时保留显式 sentinel，并在 `unavailableFieldSentinels`
  中标记 `fsyncErrno`。
- `itemCheckpointFailureEvidence.conditional.fsyncBoundary` 已包含目录 locator、
  primary/sidecar locator、sidecar kind、lane、owner、durable kind、fsync
  target/platform/errno 与 sentinel 条件字段；`completedPublishRule` 位于
  local state failure 基础字段中。
- `subprocessDurableFailureProjection.requiredFields` 已为
  `durable_directory_*` 补入目录 locator、primary/sidecar locator、
  sidecar kind、lane、owner、directory/primary durable kind、`fsyncTarget`、
  `fsyncPlatform`、`fsyncErrno`、sentinel 与 `completedPublishRule`。
- `eventSchema.conditionalFields` 已允许 directory fsync evidence 的全部核心
  字段，`durableFailureEventEvidence.conditionalFields.fsyncBoundary` 也已同步
  要求这些字段。
- `commandCheckDurableEvidence.requiredForSubprocessDurableFailures` 已补入
  `fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与 sentinel 条件字段。
- `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 已列出目录
  locator、primary/sidecar locator、sidecar kind、lane、owner、durable kind、
  fsync target/platform/errno、`completedPublishRule` 与 sentinel 条件字段。
- `recoverySummaryRequiredFields` 已补入目录 locator、primary/sidecar locator、
  sidecar kind、lane、owner、durable kind、fsync target/platform/errno、
  `completedPublishRule` 与 sentinel 条件字段。
- `graph_vault/dspy` 的 directory fsync scope 已声明为 recursive family
  scope，覆盖承载已注册 DSPy YAML/JSON target 及其 checksum sidecar 的后代
  目录。
- `catalog_checksum_meta_backfill_parent_directory_fsync` 验收项仍保留核心失败
  链路：`books.yaml.sha256.meta.json` 回填后 fsync `graph_vault/catalog`，
  并要求继承 `graph_vault/catalog/books.yaml` 的 `catalogWriterLane` 与
  `repository` owner，不得触发 `durable_target_mapping_missing`。

## 阻塞项

### 1. status-json self failure projection 缺少完整 fsync boundary 字段

涉及段落：

- `statusJsonReadOnlyContract.selfFailureProjection`
- `statusJsonReadOnlyContract.directoryFsyncProjection`
- `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary`

问题：

`statusJsonReadOnlyContract.selfFailureProjection` 目前要求自失败 JSON 包含
`failureKind`、`localFailureClass`、`recoveryDecision`、`failedStage`、
`targetLocator`、`tempId`、`operationId`、`failedSyscall`、`errno`、
`renameCause`、`directoryTargetLocator`、`primaryTargetLocator or
sidecarTargetLocator`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与
`completedPublishRule`。

该字段集缺少 R4 要求在所有观测面一致保留的以下字段：

- `sidecarKind when parent directory fsync follows sidecar write`
- `lane`
- `targetMappingOwner`
- `directoryDurableKind`
- `primaryDurableKind`
- `unavailableFieldSentinels when fsyncErrno is sentinel`

相邻的 `directoryFsyncProjection` 只要求 read-only 诊断投影
`directoryTargetLocator`、`lane`、`targetMappingOwner`、`directoryDurableKind`
与 `primaryDurableKind`，但没有明确扩展 `selfFailureProjection`，也没有覆盖
`sidecarKind`、`fsyncErrno` sentinel 保留规则。因此实现者仍可能让
`status-json` 自身失败输出少于普通 status-json durable failure entry。

影响：

当 `--status-json` 自身读取 durable target 时遇到 fail-closed directory fsync
相关故障，输出 JSON 可能无法无损表达 sidecar 边界、lane/owner 归属、目录
durable kind、primary durable kind 与 errno sentinel。该缺口会破坏 R4 要求的
跨观测面一致性，并迫使实现阶段在自失败输出和普通 status-json entry 之间自行
选择字段契约。

最小修正建议：

- 在 `statusJsonReadOnlyContract.selfFailureProjection` 中显式引用
  `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary`，或直接补入同一
  字段集。
- 最小字段集应包含：
  `directoryTargetLocator`、`primaryTargetLocator or sidecarTargetLocator`、
  `sidecarKind when parent directory fsync follows sidecar write`、`lane`、
  `targetMappingOwner`、`directoryDurableKind`、`primaryDurableKind`、
  `fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、`completedPublishRule`、
  `unavailableFieldSentinels when fsyncErrno is sentinel`。
- 明确该 self failure JSON 输出仍不得写 checkpoint、event、`status.json` 或
  `recovery-summary.json`，但必须保留与普通 durable failure entry 等价的
  directory fsync evidence。

## 非阻塞风险

- `graph_vault/catalog` 裸目录 fallback 仍应只在无法看到 primary 或 sidecar
  locator 时使用；已知 primary/sidecar 的 fsync evidence 必须优先从对应 target
  mapping 派生 lane 与 owner，避免把 catalog 父目录解释成宽松 owner fallback。
- `catalogWriterLane.protects` 不是 `targetMapping` 的完整镜像。当前 contract
  已以 `targetMapping` 为权威，不构成本轮阻塞，但实现时不应把 protects 列表
  当作完整 durable target 清单。
