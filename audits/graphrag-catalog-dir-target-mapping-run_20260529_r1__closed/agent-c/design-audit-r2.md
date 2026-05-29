# Design Audit R2 - Agent C

## 结论

PASS。

当前 `docs/architecture/graphrag-parallel-runner.type-dd.yaml` 已足以闭合 R1
指出的设计缺口。parent directory fsync evidence 已被定义为 primary 或 sidecar
durable write 的派生提交步骤（derived commit step），不是独立业务 target。
当前设计可以进入 implementation 阶段；无需在实现前继续修改 Type DD。

## 复审判断

`directoryFsyncRule` 已明确规定 parent directory fsync 必须先解析触发该
fsync 的 `primaryTargetLocator` 或 `sidecarTargetLocator`，并继承其 `lane`、
`owner`、`durableKind`、`laneTimeoutMs`、`releaseOn` 与 preflight scope。该规则
同时禁止仅因目录路径缺少文件名而触发
`durable_target_mapping_missing`，直接覆盖本轮
`graph_vault/catalog` 被误当作独立 target 的设计缺口。

`directoryFsyncEvidence` 已要求目录 fsync 证据保留 `directoryTargetLocator`、
`primaryTargetLocator` 或 `sidecarTargetLocator`、`lane`、
`targetMappingOwner`、`durableKind`、`operationId`、`fsyncTarget`、
`fsyncPlatform` 与失败时的 `fsyncErrno`。这些字段足以证明目录 fsync 归属于
哪个 primary/sidecar mapping，并能被 event、status-json 与 recovery summary
一致投影。

`directoryFsyncScopes` 已为 catalog、batch run、book-scoped、DSPy、output 与
QMD index 等父目录提供目录 scope 解析边界。该 scope 是目录 fsync 的派生解析
辅助，不把目录提升为独立业务 durable target；当只有目录路径可见时，也要求
映射到唯一 durable target family，无法唯一映射则 `stop_until_fixed`。

`temporaryFileLifecycle.commit` 已补充父目录 fsync 必须按
`directoryFsyncRule` 继承刚完成的 primary 或 sidecar target mapping，不能使用
裸目录路径绕过或触发 target mapping 缺失。该约束把 durable replace、checksum
backfill 与 checksum meta sidecar backfill 统一到同一提交协议内。

`statusJsonReadOnlyContract.directoryFsyncProjection` 已明确 `--status-json`
不得执行 `fsyncDirectory`，但报告 primary、checksum sidecar 或 checksum meta
sidecar 问题时，必须按同一 `directoryFsyncRule` 投影目录 locator、lane、
owner 与 durable kind。repair writer 后续执行 checksum meta backfill 时也必须
使用同一规则完成 parent directory fsync。因此 read-only 观测路径与可写修复路径
不会产生两套目录映射语义。

新增 acceptance case
`catalog_checksum_meta_backfill_parent_directory_fsync` 已覆盖本轮核心场景：
`books.yaml` checksum meta backfill 写入 sidecar 后，对
`graph_vault/catalog` 执行派生 directory fsync；证据包含
`directoryTargetLocator=graph_vault/catalog` 与
`primaryTargetLocator=graph_vault/catalog/books.yaml`，并解析为
`catalogWriterLane` 与 `repository`，不得出现
`durable_target_mapping_missing`。该验收项足以指导实现阶段回归真实失败链路。

## 剩余设计缺口

无阻塞性设计缺口。

实现阶段应验证 `fsyncDirectory`、`durableOperationEvidence`、
`writeJsonAtomicSidecar`、`writeCommittedChecksumMeta` 与 catalog reconcile 链路
均传递 active primary/sidecar locator，而不是对
`graph_vault/catalog` 执行裸目录 target lookup。
