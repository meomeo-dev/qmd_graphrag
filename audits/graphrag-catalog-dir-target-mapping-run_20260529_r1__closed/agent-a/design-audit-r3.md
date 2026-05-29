# Design Audit R3 Agent A

## 结论

FAIL。

`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 已闭合 R1/R2 中最
核心的 catalog 目录 fsync target mapping 缺口：parent directory fsync
被定义为 primary 或 sidecar durable write 的派生提交步骤（derived commit
step），不是独立业务 target；`graph_vault/catalog` 也不应再因缺少文件名触发
`durable_target_mapping_missing`。

但是，R3 仍发现一项阻塞缺口：directory fsync evidence 的跨观测面字段闭包
不一致。实现阶段仍必须猜测 `BatchCommandCheck`、status-json durable failure
entry 与 recovery summary 是否需要携带 `fsyncTarget`、`fsyncPlatform` 与
`fsyncErrno` 等字段。这会使目录 fsync 失败无法按同一 contract 无损投影。

## 已核对的关键闭包

1. `directoryFsyncRule` 明确 parent directory fsync 是 primary/sidecar
   durable write 的派生提交步骤，不是独立业务 target。证据生成必须先解析
   `primaryTargetLocator` 或 `sidecarTargetLocator`，并继承其 lane、owner、
   timeout、release 与 preflight scope。

2. `directoryFsyncRule` 明确目录路径不得因缺少文件名触发
   `durable_target_mapping_missing`。只有在只能看到目录路径且目录 scope 无法
   唯一映射时，才 fail closed 到 `stop_until_fixed`。

3. `directoryFsyncScopes` 已覆盖本轮要求的主要目录：
   `graph_vault`、`graph_vault/catalog`、
   `graph_vault/catalog/provider-requests`、batch-runs 根目录、items、
   provider-slots、subprocesses、book-leases、book 根目录、book runs、
   book qmd、book output 递归 family scope、deep lancedb、
   `graph_vault/dspy` 与 `.qmd`。

4. `book-leases` lane 归属已经统一。`writerLanes.checkpointWriterLane`、
   `directoryFsyncScopes` 与 `targetMapping` 均把
   `graph_vault/catalog/batch-runs/{runId}/book-leases/*.json` 归于
   `checkpointWriterLane`。

5. `directoryDurableKind: directory` 与 `primaryDurableKind` 已分离，消除了
   R2 中 `durableKind` 同时指向目录操作和 primary target 的歧义。

6. `statusJsonReadOnlyContract` 仍保持 read-only：不得创建 lock、temp、
   checksum、checksum meta、event、manifest、status 或 recovery summary。
   对 primary、checksum sidecar、checksum meta sidecar 问题，要求按同一
   `directoryFsyncRule` 投影 directory locator、lane、owner 与 durable kind。

7. 验收矩阵已覆盖 catalog checksum meta backfill、非 catalog directory
   scopes、read-only fail-closed projection 与 directory fsync uncertain。
   `catalog_checksum_meta_backfill_parent_directory_fsync` 直接覆盖真实失败链路：
   `books.yaml.sha256.meta.json` 回填后 fsync `graph_vault/catalog`，映射到
   `catalogWriterLane` 与 repository，且不得出现
   `durable_target_mapping_missing`。

## 阻塞项

### 1. Directory fsync evidence 未无损投影到所有观测面

涉及设计段落/关键词：

- `targetMappingContract.directoryFsyncEvidence.requiredFields`
- `durableWriteContract.platformFsyncBoundary.requiredDiagnostics`
- `durableFailureEventEvidence.conditionalFields.fsyncBoundary`
- `commandCheckDurableEvidence.requiredForSubprocessDurableFailures`
- `statusJsonDurableFailureEntryFields.requiredForLocalStateFailures`
- `recoverySummaryRequiredFields`
- `durableStateAcceptanceMatrix.directory_fsync_boundary_uncertain`

问题：

`directoryFsyncEvidence.requiredFields` 要求目录 fsync evidence 包含
`directoryTargetLocator`、`primaryTargetLocator` 或 `sidecarTargetLocator`、
`lane`、`targetMappingOwner`、`directoryDurableKind`、`primaryDurableKind`、
`operationId`、`fsyncTarget`、`fsyncPlatform`、失败时 `fsyncErrno` 与
`completedPublishRule`。`platformFsyncBoundary.requiredDiagnostics` 与
`durableFailureEventEvidence.conditionalFields.fsyncBoundary` 基本同步了这些
字段。

但 `commandCheckDurableEvidence.requiredForSubprocessDurableFailures` 只在
`localFailureClass is durable_directory_*` 时要求 directory locator、primary/
sidecar locator、lane、owner 与 durable kind，没有要求 `fsyncTarget`、
`fsyncPlatform`，也没有把 `fsyncErrno` 作为 directory fsync 失败证据字段。

`statusJsonDurableFailureEntryFields` 也没有 directory fsync 专用字段集。
其 `requiredForLocalStateFailures` 缺少 `lane`、`targetMappingOwner`、
`directoryDurableKind`、`primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`
与 `fsyncErrno`；这些字段只部分出现在 `requiredForRenameEnoent`，导致目录
fsync 失败不会按同一规则进入 status-json schema。

`recoverySummaryRequiredFields` 要求 directory locator、primary/sidecar
locator、lane、owner 与 durable kind，但缺少 `fsyncTarget`、`fsyncPlatform`
与 `fsyncErrno`。这与验收矩阵中
`directory_fsync_boundary_uncertain` 要求 status-json 和 recovery summary
包含 `fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 不一致。

影响：

实现者无法仅凭 Type DD 判断目录 fsync 失败在 command check、status-json 与
recovery summary 中的必填字段。真实的 parent directory fsync 失败或不确定
边界可能在事件中保留完整字段，但在 status-json 或 recovery summary 中丢失
平台边界证据，违反“同一 durable failure evidence 在四个观测面一致投影”的
contract。

最小修正建议：

1. 在 `commandCheckDurableEvidence.requiredForSubprocessDurableFailures` 中为
   `localFailureClass is durable_directory_*` 增加 `fsyncTarget`、
   `fsyncPlatform`、`fsyncErrno when fsync fails`。

2. 在 `statusJsonDurableFailureEntryFields` 增加 directory fsync 条件字段集，
   或把 `lane`、`targetMappingOwner`、`directoryDurableKind`、
   `primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno when
   fsync fails` 移入适用于 durable directory failure 的必填规则。

3. 在 `recoverySummaryRequiredFields` 增加 `fsyncTarget`、`fsyncPlatform` 与
   `fsyncErrno when fsync fails`，使其与
   `directory_fsync_boundary_uncertain` 验收项一致。

4. 明确 `fsyncErrno` 在 unsupported/uncertain 且无 errno 的场景使用 explicit
   unavailable sentinel，避免实现省略字段或自行发明格式。

## 残余非阻塞风险

1. `graph_vault/dspy/**/*.yaml` 与 `graph_vault/dspy/**/*.json` 是深层通配
   target，`directoryFsyncScopes` 只声明 `graph_vault/dspy`。当前可按目录
   scope family 理解为覆盖 DSPy 子树，但建议在后续 implementation contract
   中确认该 scope 是否递归，避免实现维护独立手写目录清单。

2. `directoryFsyncRule` 对“只能看到目录路径”的场景要求映射到唯一 durable
   target family。`graph_vault/catalog` 下同时存在 catalog YAML、events、
   cost-accounting 与 provider request family。真实 checksum meta backfill 路径
   已通过 primary/sidecar locator 闭合；裸目录观测路径仍应优先 fail closed，
   不应用宽泛 repository owner 掩盖歧义。

## 生产安全路径判断

对真实失败栈 `loadCatalogBySourceHash -> checksum meta backfill -> fsync
graph_vault/catalog`，设计已给出可实施路径：`books.yaml.sha256.meta.json`
作为 `graph_vault/catalog/books.yaml` 的 checksum meta sidecar，继承
`catalogWriterLane` 与 repository owner；parent directory fsync 只作为派生
commit boundary 记录 `directoryTargetLocator=graph_vault/catalog`，
`primaryTargetLocator=graph_vault/catalog/books.yaml` 与
`sidecarTargetLocator=graph_vault/catalog/books.yaml.sha256.meta.json`。该路径
不会要求 `graph_vault/catalog` 作为独立 business target。

R3 的 FAIL 不否定该核心修复路径；失败原因是观测面 schema 仍未完全闭合，
会在 directory fsync failure、unsupported 或 uncertain 场景中迫使实现猜测。
