# Design Audit R3 Agent C

## 结论

FAIL。

当前 `docs/architecture/graphrag-parallel-runner.type-dd.yaml` 已闭合
`graph_vault/catalog` 被误当作独立 durable target 的核心缺口，但尚未闭合
R1/R2 要求的全观测面 directory fsync evidence contract。实现阶段仍会在
command check、status-json 与 recovery summary 字段选择上猜测或绕过
contract，因此不能判定为设计 PASS。

## 已闭合的关键事项

- `directoryFsyncRule` 已明确 parent directory fsync 是 primary 或 sidecar
  durable write 的派生提交步骤（derived commit step），不是独立业务 target。
- `graph_vault/catalog` 父目录 fsync 已被规定不得因缺少文件名触发
  `durable_target_mapping_missing`；`books.yaml` checksum meta backfill 场景
  可继承 `graph_vault/catalog/books.yaml` 的 `catalogWriterLane` 与
  `repository` owner。
- `directoryFsyncScopes` 已补齐 `graph_vault`、
  `graph_vault/catalog/provider-requests`、batch-run root、`items`、
  `provider-slots`、`subprocesses`、`book-leases`、book `runs`、`qmd`、
  `output`、book/shared LanceDB、`graph_vault/dspy` 与 `.qmd` 等主要目录。
- `book-leases` lane 已统一为 `checkpointWriterLane`，并与
  `targetMapping`、`directoryFsyncScopes` 保持一致。
- `directoryDurableKind: directory` 与 `primaryDurableKind` 已分离，
  消除了把目录 fsync kind 与 primary target kind 混用的主要歧义。
- `statusJsonReadOnlyContract` 仍禁止 `--status-json` 写入、回填、rename、
  quarantine、append event、写 status 或 recovery summary，并要求按同一
  `directoryFsyncRule` 投影 read-only 诊断。
- 验收矩阵已覆盖 catalog checksum meta backfill、非 catalog directory scopes、
  read-only fail-closed projection 与 directory fsync uncertain。
- 对真实失败链路
  `loadCatalogBySourceHash -> checksum meta backfill -> fsync graph_vault/catalog`，
  设计已给出可实施路径：repair writer 回填 checksum meta sidecar 后，将
  `graph_vault/catalog` 作为派生 directory fsync boundary，而不是独立 target。

## 阻塞项

### 1. Directory fsync evidence 未投影到全部观测面

涉及设计段落/关键词：

- `targetMappingContract.directoryFsyncEvidence.requiredFields`
- `durableWriteContract.platformFsyncBoundary.requiredDiagnostics`
- `observability.durableFailureEventEvidence.conditionalFields.fsyncBoundary`
- `observability.commandCheckDurableEvidence.requiredForSubprocessDurableFailures`
- `observability.statusJsonDurableFailureEntryFields`
- `observability.recoverySummaryRequiredFields`
- `observability.eventSchema.conditionalFields`

问题：

`platformFsyncBoundary.requiredDiagnostics` 与
`durableFailureEventEvidence.conditionalFields.fsyncBoundary` 已要求
`directoryTargetLocator`、`primaryTargetLocator` 或 `sidecarTargetLocator`、
`sidecarKind`、`lane`、`targetMappingOwner`、`directoryDurableKind`、
`primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与
`completedPublishRule`。但后续观测面没有同步闭合：

- `commandCheckDurableEvidence.requiredForSubprocessDurableFailures` 缺少
  `fsyncTarget`、`fsyncPlatform` 与 `fsyncErrno`。
- `statusJsonDurableFailureEntryFields` 没有独立的 `fsyncBoundary` 条件字段组；
  对非 rename 的 directory fsync failure，未要求 `lane`、
  `targetMappingOwner`、`directoryDurableKind`、`primaryDurableKind`、
  `fsyncTarget`、`fsyncPlatform` 与 `fsyncErrno`。
- `recoverySummaryRequiredFields` 已包含 locator、lane 与 durable kind 字段，
  但缺少 `fsyncTarget`、`fsyncPlatform` 与 `fsyncErrno`。
- `eventSchema.conditionalFields` 未列出 `directoryTargetLocator`、
  `directoryDurableKind`、`primaryDurableKind` 与 `fsyncPlatform`；虽然
  durable failure event 子契约要求这些字段，但通用 event schema 是否允许
  这些字段仍不够明确。

影响：

实现者可以从 acceptance case 推断 status-json 与 recovery summary 应包含
fsync 字段，也可以从 schema 字段清单推断这些字段不是必填。该冲突会导致
directory fsync failure 在 command check、status-json 或 recovery summary 中
丢失平台 fsync 证据，无法满足 R2 的 evidence closure 要求。

最小修正建议：

- 在 `commandCheckDurableEvidence` 增加 directory/fsync boundary 条件字段：
  `directoryTargetLocator`、`primaryTargetLocator or sidecarTargetLocator`、
  `sidecarKind`、`lane`、`targetMappingOwner`、`directoryDurableKind`、
  `primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`、`fsyncErrno`、
  `operationId`、`tempId when available` 与 `completedPublishRule`。
- 在 `statusJsonDurableFailureEntryFields` 增加 `requiredForFsyncBoundary`
  或等价字段组，并覆盖同一字段集合。
- 在 `recoverySummaryRequiredFields` 增加 `fsyncTarget`、`fsyncPlatform` 与
  `fsyncErrno`。
- 在 `eventSchema.conditionalFields` 增加缺失的 directory/fsync 字段，或明确
  `durableFailureEventEvidence.conditionalFields.fsyncBoundary` 扩展通用
  event schema。

### 2. `graph_vault/dspy` 深层目录 scope 仍需显式递归语义

涉及设计段落/关键词：

- `targetMappingContract.preflightScopeRule`
- `directoryFsyncScopes: graph_vault/dspy`
- `targetMapping: graph_vault/dspy/**/*.yaml`
- `targetMapping: graph_vault/dspy/**/*.json`

问题：

`targetMapping` 对 DSPy policy store 使用 `graph_vault/dspy/**/*.yaml` 与
`graph_vault/dspy/**/*.json` 深层通配 target。`preflightScopeRule` 要求含通配
或深层 pattern 的条目声明 recursive scope。当前 `directoryFsyncScopes` 只列出
`graph_vault/dspy`，未像 book output scope 一样声明递归 family scope。

影响：

当 implementation 只持有裸目录路径，例如
`graph_vault/dspy/{policyFamily}` 或更深层 parent directory 时，设计没有明确该
路径是否按 `graph_vault/dspy` 前缀递归归属到 `catalogWriterLane` 与
`dspyPolicyStore`。这会留下 directory scope 解析缺口。

最小修正建议：

- 将 `graph_vault/dspy` 的 `directoryFsyncScopes` 条目标记为 recursive family
  scope，覆盖所有承载已注册 DSPy JSON/YAML target 与 sidecar 的后代目录。
- 或显式增加 `graph_vault/dspy/**` 等价 scope，并规定其 lane、owner 与
  `directoryDurableKind` 继承 `catalogWriterLane`、`dspyPolicyStore` 与
  `directory`。

## 残余非阻塞风险

- `graph_vault/catalog/batch-runs/{runId}` 目录 scope 归属
  `manifestWriterLane`。该目录下还有 `events.jsonl`，但 JSONL append 设计未要求
  parent directory fsync；若未来 event file 创建也被纳入 directory fsync，
  需要重新声明该父目录的唯一 family 归属。
- `catalogWriterLane.protects` 列表未显式列出所有 catalog-owned target，例如
  `sources.yaml`、`provider-requests` 与 `settings.yaml`。`targetMapping` 已给出
  权威 lane，因此当前不构成本轮 directory fsync mapping 阻塞，但后续可整理以
  降低读者误解。
