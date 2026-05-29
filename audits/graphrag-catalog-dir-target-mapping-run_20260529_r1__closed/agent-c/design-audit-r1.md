# Design Audit R1 - Agent C

## 结论

FAIL。

当前 Type DD 已规定 durable replace 必须执行文件 fsync 与父目录 fsync，并已
定义目录 fsync 不可用、不确定或失败时的 fail-closed 分类与观测字段。但它没有
明确说明 parent directory fsync 不是新的业务 durable target，也没有规定
`fsyncDirectory(dirname(path))` 应继承哪个 primary target 或 sidecar target 的
`targetMapping`。因此，真实 runner 报出
`durable target mapping missing: graph_vault/catalog` 时，不能仅判为实现缺口；
这是 Type DD 的可执行规则缺口。

## 审计发现

1. 目录 fsync 已被定义为 durable write 的一部分，但边界不完整。

   Type DD 的 `durableWriteContract.yamlOrJsonReplace` 要求 catalog、
   checkpoint、lock、manifest 等写入经过同目录 temp file、文件 fsync、
   atomic rename、父目录 fsync。`platformFsyncBoundary` 也要求生产终态写入在
   strict mode 下处理 file fsync 与 parent directory fsync。

   缺口在于：`targetMappingContract` 只说明每个 durable YAML/JSON/SQLite
   primary target 必须映射到 lane、owner、durableKind 等字段，并说明 checksum
   sidecar 继承 primary target 映射；它没有对 parent directory fsync locator
   作出同等继承规则。实现把 `graph_vault/catalog` 当作独立 target 查询 mapping
   时，设计没有明确禁止。

2. 目录 fsync 失败分类与观测投影基本存在。

   Type DD 已定义：

   - `durable_fsync_failed`
   - `durable_directory_fsync_unsupported`
   - `durable_directory_fsync_uncertain`
   - `recoveryDecision=stop_until_fixed`
   - `completedPublishRule=forbidden`

   事件 schema、durable failure evidence、status-json 与 recovery summary 字段中
   也包含 `fsyncTarget`、`fsyncErrno`、`targetLocator`、`operationId` 等诊断字段。
   这部分允许实现将目录 fsync 失败投影到 event、status-json 与 recovery summary。

   仍需补充的是：当失败是 mapping resolution 失败而不是系统调用 fsync 失败时，
   Type DD 没有指定应使用哪个 `localFailureClass`、`failedSyscall`、
   `fsyncTarget` 与 `targetLocator`。本次错误发生在目录 fsync evidence 构造阶段，
   不是平台不支持或 fsync errno 失败，现有分类不能无歧义覆盖。

3. `graph_vault/catalog` 目录 target mapping 缺失应判为设计缺口。

   若目录 fsync 是 durable write commit protocol 的组成步骤，则
   `graph_vault/catalog` 不应作为独立业务 target 加入 `targetMapping`，否则会引入
   无内容、无 owner 语义且可递归膨胀的目录 target。正确设计应是：目录 fsync
   evidence 使用被提交的 primary target 或 sidecar target 的 mapping；目录路径只
   作为 `fsyncTarget` 诊断字段。

   当前 Type DD 未写明该规则，导致实现可以合理地把目录路径传入
   `durableTargetMapping` 并 fail closed。因此该失败暴露的是 Type DD 缺口，而不是
   单纯实现偏差。

4. 需要补充 catalog checksum meta repair 的 acceptance/regression。

   现有 acceptance matrix 覆盖了 `status_json_catalog_missing_checksum_meta`，
   也覆盖了 checksum meta backfill rename ENOENT 与目录 fsync 不确定边界。但缺少
   一个直接用例：正常 repair writer 在读取 `catalog/books.yaml` 时发现
   `books.yaml.sha256.meta.json` 缺失，回填 checksum meta sidecar，随后对
   `graph_vault/catalog` 执行 parent directory fsync，并且该 fsync evidence 继承
   `graph_vault/catalog/books.yaml` 的 catalog writer mapping，而不是要求
   `graph_vault/catalog` 自身出现在 target mapping。

## 最小设计补平建议

1. 在 `targetMappingContract` 增加 `directoryFsyncMappingRule`：

   - parent directory fsync 是 durable replace 或 sidecar durable replace 的 commit
     step，不是独立业务 durable target。
   - `fsyncDirectory(dirname(target))` 必须使用正在提交的 primary target 或
     derived sidecar target 的 lane、owner、durableKind、operationId 与
     releaseOn。
   - directory path 只能作为 `fsyncTarget` 诊断字段；不得要求目录路径本身出现在
     `targetMapping`。
   - 若无法从 active commit target 解析 mapping，分类为
     `local_state_integrity`、`localFailureClass=durable_target_mapping_missing`、
     `retryable=false`、`recoveryDecision=stop_until_fixed`，并输出
     `targetLocator`、`fsyncTarget`、`operationId`、`sidecarKind`、`primaryTargetLocator`
     或 unavailable sentinel。

2. 在 `derivedSidecarRule` 补充 checksum meta sidecar 的目录 fsync继承：

   - `{target}.sha256.meta.json` 的 durable replace 继承 primary target mapping。
   - 其 parent directory fsync evidence 仍以 primary target mapping 为权威，
     `sidecarTargetLocator` 指向 meta sidecar，`fsyncTarget` 指向父目录。

3. 在 durable failure observability 中补充 mapping-resolution 失败投影：

   - `durable_replace_failed` 与 `item_failed` 必须保留
     `targetLocator`、`primaryTargetLocator`、`sidecarTargetLocator`、
     `sidecarKind`、`fsyncTarget`、`failedSyscall=fsyncDirectory`、
     `localFailureClass=durable_target_mapping_missing`。
   - status-json 与 recovery summary 必须投影同一分类，不能降级为 `unknown`。

4. 在 acceptance matrix 增加回归用例
   `catalog_books_checksum_meta_repair_parent_dir_fsync`：

   - 初始状态：`graph_vault/catalog/books.yaml` 与 `.sha256` 有效，
     `books.yaml.sha256.meta.json` 缺失。
   - repair writer 回填 checksum meta sidecar。
   - 回填提交执行 checksum meta 文件 fsync、rename 与
     `fsyncDirectory(graph_vault/catalog)`。
   - directory fsync evidence 继承 `graph_vault/catalog/books.yaml` 的
     `catalogWriterLane` 与 repository owner。
   - 不要求 `graph_vault/catalog` 作为 targetMapping 条目存在。
   - 注入 directory fsync 失败或 mapping-resolution 失败时，event、status-json 与
     recovery summary 均 fail closed，且 completed 不发布。

