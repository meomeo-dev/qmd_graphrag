# Implementation Audit Criteria R3

本文件固定 implementation-r3 审计基准。基准派生自 Type DD design audit r5
验收项；implementation-r3 修复和重审期间不得修改。

1. `graph_vault/catalog/books.yaml` checksum meta backfill 的 parent directory
   fsync 必须映射到 `graph_vault/catalog`，不得再出现
   `durable_target_mapping_missing`。
2. 派生 parent directory fsync 必须保留 primary 或 sidecar write operation 的
   `primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind`、lane、owner
   与 `primaryDurableKind`。
3. checksum sidecar (`*.sha256`) 与 checksum meta sidecar
   (`*.sha256.meta.json`) 的 parent directory fsync 必须区分
   `sidecarKind: checksum` 与 `sidecarKind: checksum_meta`。
4. 裸 `fsyncDirectory` 必须只使用显式 directory scope；生产目录缺映射时
   必须 fail closed，不得静默 best effort。
5. 目录 fsync failure evidence 必须包含 `directoryTargetLocator`、
   `directoryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、
   `completedPublishRule`、lane 与 owner。
6. `fsyncErrno` 使用 sentinel 时，必须同时保留
   `unavailableFieldSentinels: ["fsyncErrno"]` 或等价字段集合。
7. `--status-json` 必须保持 read-only，不得写 lock、temp、checksum、checksum
   meta、event、manifest、status 或 recovery summary。
8. read-only durable diagnostics 必须按同一 directory fsync rule 投影
   directory locator、directory durable kind、primary durable kind、lane、
   owner、fsync sentinel 与 repair gate。
9. `src/contracts/batch-run.ts` 与 runner 内部 schema 必须接受并保留目录
   fsync closure 字段，覆盖 command check、checkpoint、event、manifest、
   status-json 与 recovery summary。
10. 回归测试必须覆盖 catalog parent fsync、read-only projection、checksum
    sidecar evidence、非 catalog directory scope、shared durable store parity
    与 contract closure。
