# Design Audit R4 Agent A

## 结论

FAIL。

`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 已闭合 R3 的主要
directory fsync 设计缺口，包括 item checkpoint、subprocess durable failure
projection、generic event schema、durable failure event evidence、command
check、status-json durable failure entry 与 recovery summary 的字段投影。
但 `status-json` 自身失败投影（self failure projection）仍未完整绑定同一套
fsync boundary 字段，因此 R4 不能判定为 PASS。

## 已核对闭包

- `targetMappingContract.directoryFsyncRule` 明确 parent directory fsync 是
  primary 或 sidecar durable write 的派生提交步骤（derived commit step），
  不是独立业务 target；目录路径不得因缺少文件名触发
  `durable_target_mapping_missing`。
- `directoryFsyncEvidence.requiredFields` 已要求 `directoryTargetLocator`、
  `primaryTargetLocator or sidecarTargetLocator`、`sidecarKind`、
  `lane`、`targetMappingOwner`、`directoryDurableKind`、
  `primaryDurableKind`、`operationId`、`fsyncTarget`、`fsyncPlatform`、
  `fsyncErrno when fsync fails` 与 `completedPublishRule`。
- `unavailableSentinelRule` 明确 directory fsync unsupported、uncertain 或
  平台 API 未返回 errno 时不得省略 `fsyncErrno`，必须写入 explicit sentinel，
  并在 `unavailableFieldSentinels` 中列出 `fsyncErrno`；event、checkpoint、
  command check、status-json 与 recovery summary 均必须保留该 sentinel。
- `terminalCommitProtocol.failed.itemCheckpointFailureEvidence.conditional`
  已增加 `fsyncBoundary`，覆盖 directory locator、primary/sidecar locator、
  `sidecarKind`、lane、owner、durable kind、`fsyncTarget`、
  `fsyncPlatform`、`fsyncErrno` 与 sentinel 字段；`completedPublishRule`
  已在 local state failure 必填字段中保留。
- `workerLifecycle.subprocessDurableFailureProjection.requiredFields` 已为
  `durable_directory_*` 增加 directory fsync boundary 字段，包括
  `fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、`completedPublishRule` 与
  `unavailableFieldSentinels`。
- `observability.eventSchema.conditionalFields` 已允许 directory/fsync 字段；
  `durableFailureEventEvidence.conditionalFields.fsyncBoundary` 已把同一字段组
  作为 durable failure event 条件证据。
- `commandCheckDurableEvidence.requiredForSubprocessDurableFailures` 已为
  `durable_directory_*` 增加 `fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、
  sentinel 与 completed publish 字段，闭合 first-hop carrier 缺口。
- `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 已新增，并覆盖
  directory locator、primary/sidecar locator、`sidecarKind`、lane、owner、
  durable kind、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、
  `completedPublishRule` 与 `unavailableFieldSentinels`。
- `recoverySummaryRequiredFields` 已为 `durable_directory_*` 增加
  `fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与 sentinel 字段。
- `graph_vault/dspy` directory fsync scope 已声明为 recursive family scope，
  覆盖所有承载已注册 DSPy YAML/JSON target 或 checksum sidecar 的后代目录。
- `catalog_checksum_meta_backfill_parent_directory_fsync` 验收项仍保留 R1/R2 的
  核心失败路径：`books.yaml.sha256.meta.json` 回填后 fsync
  `graph_vault/catalog`，作为 sidecar write 的派生 directory fsync boundary，
  映射到 `catalogWriterLane` 与 `repository`，且不得出现
  `durable_target_mapping_missing`。该路径未退化为宽松 fallback。

## 阻塞项

### 1. status-json self failure projection 未完整声明 fsync boundary 字段

涉及段落：

- `observability.statusJsonReadOnlyContract.selfFailureProjection`
- `observability.statusJsonReadOnlyContract.directoryFsyncProjection`
- `observability.statusJsonDurableFailureEntryFields.requiredForFsyncBoundary`

问题：

`statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 已完整声明
status-json durable failure entry 的 directory fsync 字段。但
`statusJsonReadOnlyContract.selfFailureProjection` 只要求 status-json 自身读取
durable target 失败时输出 `failureKind`、`localFailureClass`、
`recoveryDecision`、`failedStage`、`targetLocator`、`tempId`、
`operationId`、`failedSyscall`、`errno`、`renameCause`、
`directoryTargetLocator`、`primaryTargetLocator or sidecarTargetLocator`、
`fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与
`completedPublishRule`。

该字段清单缺少 R4 要求的以下 fsync boundary 字段：

- `sidecarKind when sentinel or sidecar evidence is present`
- `lane`
- `targetMappingOwner`
- `directoryDurableKind`
- `primaryDurableKind`
- `unavailableFieldSentinels when fsyncErrno is sentinel`

相邻的 `directoryFsyncProjection` 虽要求 read-only 诊断按
`directoryFsyncRule` 投影 `lane`、`targetMappingOwner`、
`directoryDurableKind` 与 `primaryDurableKind`，但它没有明确绑定
`selfFailureProjection` 的可解析 JSON 输出，也没有补齐 `sidecarKind` 与
`unavailableFieldSentinels`。实现阶段仍需猜测 status-json 自身失败输出是否应
复用 `requiredForFsyncBoundary`，以及 sentinel 字段是否必须进入该输出。

影响：

当 `--status-json` 在 read-only inspection 中自身遇到 fail-closed directory
fsync boundary、unsupported boundary 或 uncertain boundary 时，它可以按当前
文字输出可解析 JSON，但丢失 sidecar 类型、mapping owner、durable kind 或
sentinel 保留信息。这会破坏 R3 要求的跨观测面无损投影（lossless
projection），并迫使实现绕过或自行补充 contract。

最小修正建议：

在 `statusJsonReadOnlyContract.selfFailureProjection` 中显式要求：

- `sidecarKind when parent directory fsync follows sidecar write`
- `lane`
- `targetMappingOwner`
- `directoryDurableKind`
- `primaryDurableKind when primary or sidecar target is visible`
- `unavailableFieldSentinels when fsyncErrno is sentinel`

或将该段改为：status-json self failure JSON 对 directory fsync boundary 必须
复用 `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 的完整字段
集，并同时遵守 `targetMappingContract.directoryFsyncEvidence.unavailableSentinelRule`。
