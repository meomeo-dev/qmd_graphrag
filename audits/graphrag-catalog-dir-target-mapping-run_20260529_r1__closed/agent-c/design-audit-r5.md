# Design Audit R5 Agent C

结论：PASS

## 审计范围

仅审计 `docs/architecture/graphrag-parallel-runner.type-dd.yaml` 中
R4 唯一阻塞项与 R1-R4 目录 fsync 设计闭包（design closure）。未审计源码，
未运行真实 EPUB runner，未读取或输出 `.env`。

## 关键核对结果

1. `statusJsonReadOnlyContract.selfFailureProjection` 已闭合 R4 阻塞项。
   该条款明确要求 status-json 自身 fail-closed durable failure 尽量输出
   可解析 JSON，并在 directory fsync boundary 上复用
   `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 的完整字段集。

2. self failure JSON 字段要求完整。条款已显式列出
   `sidecarKind`、`lane`、`targetMappingOwner`、`directoryDurableKind`、
   `primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、
   `completedPublishRule`，以及
   `unavailableFieldSentinels when fsyncErrno is sentinel`。同时明确不得因为
   不能写 checkpoint、event、`status.json` 或 `recovery-summary.json` 而降级
   或省略 sentinel 字段。

3. R1-R4 多观测面字段闭包未回退。item checkpoint、subprocess typed failure
   envelope、event schema、durable failure event、command check、status-json
   durable failure entry 与 recovery summary 均保留 directory fsync boundary
   所需字段：`directoryTargetLocator`、`primaryTargetLocator` 或
   `sidecarTargetLocator`、`sidecarKind`、`lane`、`targetMappingOwner`、
   `directoryDurableKind`、`primaryDurableKind`、`fsyncTarget`、
   `fsyncPlatform`、`fsyncErrno`、`completedPublishRule` 与 sentinel 投影。

4. directory fsync 映射闭包未回退。`directoryFsyncRule` 仍规定 parent
   directory fsync 是 primary 或 sidecar durable write 的派生提交步骤，并必须
   从 primary 或 sidecar target mapping 继承 lane、owner、durable kind 与
   preflight scope；仅有目录路径时也必须按唯一 directory scope 映射，不能回退
   为 `durable_target_mapping_missing`。

5. `graph_vault/dspy` recursive scope 仍闭合。目录 scope 覆盖
   `graph_vault/dspy` 的全部后代目录，target mapping 同时覆盖
   `graph_vault/dspy/**/*.yaml` 与 `graph_vault/dspy/**/*.json`，能为 DSPy
   YAML/JSON target 及其 checksum sidecar 派生 parent fsync 证据。

6. `graph_vault/catalog` checksum meta backfill parent fsync 路径仍闭合。
   catalog scope 映射到 `catalogWriterLane` 与 `repository`；测试矩阵仍要求
   `books.yaml.sha256.meta.json` backfill 后对 `graph_vault/catalog` 执行派生
   directory fsync，并记录 primary、sidecar、`sidecarKind checksum_meta`、
   `directoryDurableKind directory` 与 `primaryDurableKind yaml`。

## 非阻塞风险

1. fsync boundary 字段集在多个段落重复声明，后续修改存在漂移风险。建议实现阶段
   以 `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 作为中心
   schema（central schema）生成或校验各观测面字段。

2. 部分观测面使用条件措辞，例如
   `directoryDurableKind when fsyncTarget is parent_directory`。当前设计语义仍闭合，
   因为本轮审计对象是 parent directory fsync boundary；实现阶段应避免把该条件
   误解为可省略 directory fsync evidence。

3. 设计已规定 status-json read-only 不得执行 repair 或 fsync。实现阶段仍需测试
   status-json self failure JSON 在无法写任何 durable surface 时是否仍能输出完整
   sentinel 字段，避免 CLI 错误处理路径绕过 contract。
