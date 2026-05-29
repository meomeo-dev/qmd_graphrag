# Design Audit R4 Agent B

## 结论

FAIL。

R4 复核确认，R3 agent-b 的多数失败项已在
`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 中闭合：
`itemCheckpointFailureEvidence`、`subprocessDurableFailureProjection`、
generic `eventSchema`、`durableFailureEventEvidence`、`commandCheckDurableEvidence`、
`statusJsonDurableFailureEntryFields` 与 `recoverySummaryRequiredFields` 均已补入
directory fsync boundary 关键字段。

但 `statusJsonReadOnlyContract.selfFailureProjection` 仍未完整保留同一字段集。
该缺口会迫使实现阶段在 status-json 自失败（self failure）路径中猜测或丢失
directory fsync 根因证据，因此 R3 阻塞项尚未完全闭合。

## 已核对闭包

- `itemCheckpointFailureEvidence.conditional.fsyncBoundary` 已要求
  `directoryTargetLocator`、`primaryTargetLocator or sidecarTargetLocator`、
  `sidecarKind`、`lane`、`targetMappingOwner`、`directoryDurableKind`、
  `primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与
  `unavailableFieldSentinels`；`completedPublishRule` 由本地状态失败基础字段保留。
- `subprocessDurableFailureProjection.requiredFields` 已将 directory fsync 字段作为
  typed envelope 的 first-hop carrier，覆盖 `fsyncTarget`、`fsyncPlatform`、
  `fsyncErrno`、`completedPublishRule` 与 sentinel 保留。
- generic `eventSchema.conditionalFields` 与
  `durableFailureEventEvidence.conditionalFields.fsyncBoundary` 均已包含同一组
  directory fsync boundary 字段。
- `commandCheckDurableEvidence.requiredForSubprocessDurableFailures` 已补入
  `fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与
  `unavailableFieldSentinels`，可从子进程 envelope 无损投影。
- `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 已补入
  `directoryTargetLocator`、primary/sidecar locator、`sidecarKind`、lane/owner、
  durable kind、fsync 字段、`completedPublishRule` 与 sentinel 保留。
- `recoverySummaryRequiredFields` 已补入 directory fsync locator、lane/owner、
  durable kind、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与 sentinel 保留。
- `directoryFsyncEvidence.unavailableSentinelRule` 已规定 fsync unsupported、
  uncertain 或平台未返回 errno 时不得省略 `fsyncErrno`，必须写入显式 sentinel，
  并在 event、checkpoint、command check、status-json 与 recovery summary 中保留。
- `graph_vault/dspy` directory fsync scope 已标为 recursive family scope，覆盖持有
  DSPy YAML/JSON target 或 checksum sidecar 的所有 descendant directories。
- `catalog_checksum_meta_backfill_parent_directory_fsync` 仍可实施：checksum meta
  backfill 写入 sidecar 后，将 `graph_vault/catalog` parent directory fsync 作为
  sidecar commit 的派生边界处理，并解析到 `catalogWriterLane` 与 `repository`。
  该路径仍由 primary/sidecar locator 驱动，不是宽松 fallback。

## 阻塞项

### 1. status-json self failure projection 缺少完整 fsync boundary 字段

`statusJsonReadOnlyContract.selfFailureProjection` 仅要求输出
`directoryTargetLocator`、`primaryTargetLocator or sidecarTargetLocator`、
`fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与 `completedPublishRule`。

该段落未明确要求以下字段：

- `sidecarKind`
- `lane`
- `targetMappingOwner`
- `directoryDurableKind`
- `primaryDurableKind`
- `unavailableFieldSentinels when fsyncErrno is sentinel`

这使 status-json 自身读取 durable target 失败时，无法保证与 checkpoint、event、
command check、status-json durable failure entry 和 recovery summary 使用同一
directory fsync boundary contract。

最小修正建议：

- 将 `statusJsonReadOnlyContract.selfFailureProjection` 改为结构化 required fields，
  或在现有 prose 中补齐上述字段。
- 对 `localFailureClass is durable_directory_*` 明确要求
  `directoryTargetLocator`、`primaryTargetLocator or sidecarTargetLocator`、
  `sidecarKind when parent directory fsync follows sidecar write`、`lane`、
  `targetMappingOwner`、`directoryDurableKind`、`primaryDurableKind`、
  `fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、`completedPublishRule` 与
  `unavailableFieldSentinels when fsyncErrno is sentinel`。
- 声明该 self failure JSON 不得因不能写 checkpoint、event、status.json 或
  recovery summary 而降级或省略 sentinel 字段。
