# Implementation Audit Criteria R1

本文件固定本轮实施审计基准（implementation audit criteria）。后续重审
不得修改以下 10 条基准。

1. Type DD 可追溯性：实现必须对应
   `graphrag-parallel-runner.type-dd.yaml` 中 `directoryFsyncRule`、
   `directoryFsyncEvidence`、目录 scope、契约字段与 acceptance cases。
2. 派生目录 fsync：当 parent directory fsync 由 primary 或 sidecar durable
   write 触发时，evidence 必须继承该 operation 的 primary/sidecar locator、
   lane、owner、sidecar kind 与 primary durable kind。
3. 裸目录 fsync：无 operation 的 `fsyncDirectory` 必须只使用显式目录 scope；
   未映射生产目录必须 fail closed 为 `durable_target_mapping_missing`，不得
   静默 best effort。
4. Catalog checksum meta backfill：`graph_vault/catalog/books.yaml` 的
   checksum meta repair 写入后 fsync `graph_vault/catalog` 不得再触发
   missing target mapping。
5. Evidence 完整性：目录 fsync failure/diagnostic 必须投影
   `directoryTargetLocator`、`primaryTargetLocator` 或 `sidecarTargetLocator`、
   `sidecarKind`、`lane`、`targetMappingOwner`、`directoryDurableKind`、
   `primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与
   `completedPublishRule`。
6. Status-json read-only：`--status-json` 不得写入或修复 state，但必须按同一
   directory fsync mapping 投影缺失 checksum meta 的目录证据。
7. Contract schema closure：`src/contracts/batch-run.ts` 与 runner 内部 schema
   必须接收目录 fsync closure 字段，并覆盖 command check、checkpoint、
   event、status-json、manifest 与 recovery summary。
8. Shared durable store parity：`src/job-state/durable-state-store.ts` 的目录
   fsync evidence 必须与 batch runner 兼容，且 sidecar evidence 不得泄漏
   `"primary"` 或 `"json-sidecar"` 作为 `primaryDurableKind`。
9. Test hook 边界：目录 fsync 注入测试 hook 可匹配 directory、primary、
   sidecar、fsync locator，但不得改变生产 target mapping 与 fail-closed 语义。
10. 回归验证：实施必须有聚焦测试或命令覆盖 read-only 投影、repair writer
    parent fsync failure、catalog backfill、非 catalog scope、contract closure、
    durable preflight 与 CLI durable failure 语义。
