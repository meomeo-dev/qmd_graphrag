# Design Audit R2 Agent B

## 结论

FAIL。

R2 已经修正 R1 中最直接的 `graph_vault/catalog` 目录误判风险：
`directoryFsyncRule` 要求目录 fsync 从 primary 或 sidecar target 派生映射，
`directoryFsyncScopes` 明确把 `graph_vault/catalog` 映射到
`catalogWriterLane` 与 `repository`，并新增 checksum meta backfill 后 fsync
`graph_vault/catalog` 的验收用例。因此，对 `books.yaml.sha256.meta.json`
这类 catalog sidecar 的父目录 fsync，不应再被判为
`durable_target_mapping_missing: graph_vault/catalog`。

但是，R1 要求的是目录级 durable operation 的完整映射闭包
（mapping closure）和跨观测面的证据闭包（evidence closure）。R2 仍有最小
剩余缺口，不能判定为 PASS。

## 复审结果

1. `catalogWriterLane` 目录 scope 尚不完整。

   `graph_vault/catalog` 已覆盖 catalog 根目录文件，但 catalog lane 仍有
   `graph_vault/catalog/provider-requests/*.json`，其父目录
   `graph_vault/catalog/provider-requests` 未在 `directoryFsyncScopes` 中声明。
   `graph_vault/settings.yaml` 的父目录 `graph_vault` 也未声明。若实现只拿到
   裸目录路径执行或报告 directory fsync，这些 target 仍可能进入 unmapped 或
   ambiguous 分支。

2. `manifestWriterLane` 与 `checkpointWriterLane` 对 `book-leases` 的归属不一致。

   `writerLanes.manifestWriterLane.protects` 仍列出
   `graph_vault/catalog/batch-runs/**/book-leases/*.json`，但
   `targetMapping` 与 `directoryFsyncScopes` 把
   `graph_vault/catalog/batch-runs/{runId}/book-leases` 归给
   `checkpointWriterLane`。该目录必须只有一个权威 lane；否则实现可从不同段落
   得到不同串行化规则。

3. `checkpointWriterLane` 的深层 output scope 需要显式递归语义。

   `graph_vault/books/{bookId}/output` 已声明，但
   `graph_vault/books/{bookId}/output/lancedb/*.lance/qmd_row_count.json` 的
   父目录是更深层的 `.lance` 目录。若 `output` 是递归 family scope，需要在
   scope 条目中明确。另一个 target
   `graph_vault/output/lancedb/*.lance/qmd_row_count.json` 仍缺少对应目录
   scope；若该共享 output target 已被排除，应从 production target mapping
   中移除或标为非 production durable target。

4. directory fsync evidence 字段尚未投影到所有观测面。

   R2 新增了 `directoryFsyncEvidence.requiredFields`，但旧的观测面字段集仍未
   同步：

   - `platformFsyncBoundary.requiredDiagnostics` 仍只要求
     `targetLocator`、`operationId`、`tempId`、`fsyncTarget`、
     `fsyncErrno`、`fsyncPlatform`、`durableMode` 与
     `completedPublishRule`。
   - `durableFailureEventEvidence.conditionalFields.fsyncBoundary` 仍只要求
     `fsyncTarget`、`fsyncErrno` 与 `completedPublishRule`。
   - `statusJsonDurableFailureEntryFields` 没有 directory fsync 专用字段集。
   - `recoverySummaryRequiredFields` 未要求 `directoryTargetLocator`、
     `primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind` 或
     `durableKind`。
   - `directory_fsync_boundary_uncertain` 验收用例仍只检查 `fsyncTarget` 与
     `fsyncErrno`。

   因此，目录 fsync 失败虽然在规则层可被分类，但事件、checkpoint、
   status-json 与 recovery summary 仍可能无法无损证明其 primary/sidecar
   来源、lane、owner 与 durable kind。

5. `durableKind` 语义存在轻微歧义。

   `directoryFsyncRule` 说目录 fsync 继承 primary 或 sidecar 的
   `durableKind`，而 `directoryFsyncScopes` 又把目录条目标为
   `durableKind: directory`。应区分 `directoryDurableKind: directory` 与
   `primaryDurableKind`，或明确 evidence 中的 `durableKind` 始终表示目录
   operation。

6. status-json read-only 与 repair writer 已基本共用同一规则。

   `directoryFsyncEvidence.readOnlyRule` 与
   `statusJsonReadOnlyContract.directoryFsyncProjection` 已规定 read-only
   不执行 fsync，并用同一 `directoryFsyncRule` 投影 lane、owner 与
   durable kind；repair writer 后续 backfill 使用同一规则执行真实 fsync。
   剩余问题不是规则分叉，而是这些字段尚未进入所有 status-json、event 与
   recovery schema 的必填闭包。

## 最小剩余设计修正

1. 补齐目录 scope。

   增加或明确以下目录 scope：

   - `graph_vault`，用于 `graph_vault/settings.yaml`。
   - `graph_vault/catalog/provider-requests`，用于
     `graph_vault/catalog/provider-requests/*.json`。
   - `graph_vault/books/{bookId}/output` 为递归 family scope，或显式列出
     `graph_vault/books/{bookId}/output/lancedb/*.lance`。
   - `graph_vault/output/lancedb/*.lance`，或删除/降级对应 production target。

2. 消除 `book-leases` lane 冲突。

   选择一个权威 lane。若沿用 R2 的 targetMapping，应把
   `book-leases/*.json` 从 `manifestWriterLane.protects` 移出，并保持
   `targetMapping` 与 `directoryFsyncScopes` 均为 `checkpointWriterLane`。

3. 统一 directory durable kind 字段。

   将目录 fsync evidence 明确为：

   - `directoryDurableKind: directory`
   - `primaryDurableKind: yaml | json | sqlite | jsonl`
   - `sidecarKind`，仅 sidecar commit 或 sidecar repair/quarantine 时必填

   或等价地声明 `durableKind` 只表示目录 operation，primary kind 使用独立字段。

4. 将 `directoryFsyncEvidence.requiredFields` 投影到所有观测面。

   至少同步到 `platformFsyncBoundary.requiredDiagnostics`、
   `durableFailureEventEvidence.conditionalFields.fsyncBoundary`、
   `commandCheckDurableEvidence`、item checkpoint local-state failure evidence、
   `statusJsonDurableFailureEntryFields` 与 `recoverySummaryRequiredFields`。
   必填字段应包括：

   - `directoryTargetLocator`
   - `primaryTargetLocator` 或 `sidecarTargetLocator`
   - `sidecarKind`，当 fsync 跟随 sidecar 写入时必填
   - `lane`
   - `targetMappingOwner`
   - `directoryDurableKind` 或无歧义的 `durableKind`
   - `operationId`
   - `fsyncTarget`
   - `fsyncPlatform`
   - `fsyncErrno`，当 fsync 失败时必填
   - `completedPublishRule`

5. 扩展验收矩阵。

   在现有 `catalog_checksum_meta_backfill_parent_directory_fsync` 基础上，增加或
   扩展用例，覆盖 provider-requests、settings.yaml、item checkpoint sidecar、
   book output/lancedb sidecar、repair writer directory fsync failure，以及
   status-json read-only 对缺失 directory evidence 的 fail-closed 投影。
