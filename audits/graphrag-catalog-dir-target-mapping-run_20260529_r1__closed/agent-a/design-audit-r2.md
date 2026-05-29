# Design Audit R2 - agent-a

## 结论

PASS。

`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 现已足以指导实现修复
真实失败 `durable target mapping missing: graph_vault/catalog`。

R2 已把 parent directory fsync 明确定义为 primary 或 sidecar durable write 的
派生提交步骤（derived commit step），而不是独立业务 target。实现生成
directory fsync evidence 时，必须先解析触发该 fsync 的
`primaryTargetLocator` 或 `sidecarTargetLocator`，并继承其 `lane`、`owner`、
`durableKind`、`laneTimeoutMs`、`releaseOn` 与 preflight scope。该规则直接禁止
以裸目录路径 `graph_vault/catalog` 触发 `durable_target_mapping_missing`。

对本次真实失败路径，`books.yaml.sha256.meta.json` 回填属于
`graph_vault/catalog/books.yaml` 的 checksum meta sidecar commit。R2 设计要求该
commit 后的父目录 fsync 记录 `directoryTargetLocator=graph_vault/catalog`，
同时保留 `primaryTargetLocator=graph_vault/catalog/books.yaml`，并解析到
`catalogWriterLane` 与 `repository` owner。因此实现可从 Type DD 推导出稳定
修复：`fsyncDirectory(graph_vault/catalog)` 不再作为未映射 primary target 查询，
而是作为 `books.yaml` sidecar commit 的目录同步边界（directory fsync
boundary）投影。

R2 还补足了只读与修复路径的分工。`--status-json` 必须保持 read-only，不执行
目录 fsync 或 checksum meta backfill；但它报告 checksum meta 缺失时，必须按同一
`directoryFsyncRule` 投影 `directoryTargetLocator`、`lane`、
`targetMappingOwner` 与 `durableKind`。normal resume、migrate-only 或 explicit
repair writer 后续执行真实 checksum meta backfill 时，使用相同映射完成 parent
directory fsync。

验收矩阵已新增
`catalog_checksum_meta_backfill_parent_directory_fsync`，覆盖 `books.yaml`
checksum meta backfill 写入 sidecar 后 fsync `graph_vault/catalog`，并明确要求
映射解析为 `catalogWriterLane` 与 `repository`，不得产生
`durable_target_mapping_missing`。该用例覆盖本轮 runner_start/discoverItems
真实失败的关键复现条件。

## 剩余设计缺口

无。
