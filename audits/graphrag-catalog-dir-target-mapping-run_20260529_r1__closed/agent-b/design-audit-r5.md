# Design Audit R5 Agent B

结论：PASS

审计对象：`docs/architecture/graphrag-parallel-runner.type-dd.yaml`

审计范围：

- 复核 R4 agent-b 唯一阻塞项是否闭合。
- 复核 R1-R4 目录 fsync 设计闭包（directory fsync design closure）
  是否发生回退。
- 未审计实现代码，未运行真实 EPUB runner。

## 关键核对结果

1. R4 唯一阻塞项已闭合。
   `statusJsonReadOnlyContract.selfFailureProjection` 明确规定，directory
   fsync boundary 的 self failure JSON 必须复用
   `statusJsonDurableFailureEntryFields.requiredForFsyncBoundary` 的完整字段集。
   该要求不是示例字段，而是硬性投影契约（projection contract）。

2. self failure JSON 字段闭包满足要求。
   self failure JSON 明确包含或继承以下 fsync boundary 字段：
   `directoryTargetLocator`、`primaryTargetLocator` 或
   `sidecarTargetLocator`、`sidecarKind`、`lane`、
   `targetMappingOwner`、`directoryDurableKind`、
   `primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`、
   `fsyncErrno`、`completedPublishRule`，以及 sentinel 场景下的
   `unavailableFieldSentinels`。契约同时明确规定，不得因为不能写
   checkpoint、event、status.json 或 recovery-summary.json 而降级，
   也不得省略 sentinel 字段。

3. 各观测面（observation surfaces）未丢失完整 fsync boundary 字段。
   item checkpoint、subprocess durable failure envelope、event schema、
   durable failure event、command check、status-json durable failure entry
   和 recovery summary 均保留目录 fsync 所需字段，包括
   `sidecarKind`、`lane`、`targetMappingOwner`、`directoryDurableKind`、
   `primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、
   `completedPublishRule` 与 sentinel 字段。

4. R1-R4 目录映射闭包未回退。
   `directoryFsyncRule` 仍将 parent directory fsync 定义为 primary 或
   sidecar durable write 的派生提交步骤，并要求由 primary/sidecar target
   继承 lane、owner 与 durable kind。目录路径不得因缺少文件名而触发
   `durable_target_mapping_missing`；无法唯一映射时仍 fail closed 为
   `stop_until_fixed`。

5. `graph_vault/dspy` recursive scope 保持闭合。
   `graph_vault/dspy` 在 directory fsync scope 中仍声明 recursive family
   scope，覆盖持有 registered DSPy YAML/JSON targets 或 checksum sidecars
   的所有 descendant directories。对应 target mapping 仍覆盖
   `graph_vault/dspy/**/*.yaml` 与 `graph_vault/dspy/**/*.json`。

6. `graph_vault/catalog` checksum meta backfill parent fsync 路径保持闭合。
   checksum meta backfill 仍要求 sidecar 写入后 fsync
   `graph_vault/catalog`，并保留 `primaryTargetLocator`、
   `sidecarTargetLocator`、`sidecarKind: checksum_meta`、
   `directoryDurableKind: directory`、`primaryDurableKind: yaml` 与
   `completedPublishRule: forbidden`。映射仍解析到
   `catalogWriterLane` 与 `repository`，且不允许退回
   `durable_target_mapping_missing`。

## 非阻塞风险

- `selfFailureProjection` 中存在“尽量输出可解析 JSON”的可用性表述
  （best-effort wording）。由于同段对 directory fsync boundary 使用“必须复用
  完整字段集”和“不得降级或省略 sentinel 字段”的硬约束，该表述不构成阻塞。
  实现阶段应通过契约测试固定该优先级，避免把 best-effort 误解为可省略字段。

- 多处字段列表以条件字段表达，例如 `sidecarKind when parent directory fsync
  follows sidecar write` 与 `primaryDurableKind when primary or sidecar target
  is visible`。当前契约已通过 `requiredForFsyncBoundary` 与
  `directoryFsyncRule` 闭合；实现阶段仍应集中复用同一字段集合，避免各观测面
  手写条件判断造成漂移。

## 最终判断

R4 agent-b 的失败项已闭合。未发现会导致实现阶段必须猜测或绕过 contract 的
阻塞性设计缺口。R1-R4 的目录 fsync 设计闭包未发生回退。
