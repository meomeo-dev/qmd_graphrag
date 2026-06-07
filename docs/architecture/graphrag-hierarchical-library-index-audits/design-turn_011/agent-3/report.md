# design-turn_011 / agent-3 反向边界设计审计报告

## 审计结论

结论：`DESIGN_REOPEN_REQUIRED`。

最新边界要求已经改变上层索引的权威模型：`bookshelf` 与 `library`
不应继续以 `graph_vault/catalog/bookshelves/**` 和
`graph_vault/catalog/library/**` 作为包权威根目录。它们应成为
`graph_vault/bookshelves/**` 与 `graph_vault/library/**` 下类似单书包的
可复制传播闭包 (copyable package closure)。`catalog` 只能保留 projection、
发现、默认 scope、能力索引和观测索引，不再拥有上层包 manifest、CURRENT、
publish marker、quality gate 或 query-ready 判定。

当前唯一 Type DD 仍在 scope、hierarchyModel、pipelineIoContract、
quality gate path、run path 和 implementationGroundingReview 中把
bookshelf/library 的 `authorityRoot` 与已实现产物绑定到
`graph_vault/catalog/**`。因此，当前设计在新的用户要求下不再成立，必须先
修订 Type DD，再继续按该 DD 推进实现或实施审计。

## 审计输入

- 设计文档：`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 审计轮次：`design-turn_011`
- 审计身份：`agent-3`
- 审计类型：反向/边界设计审计 (reverse and boundary design audit)
- 用户新增边界：bookshelf/library 是 `graph_vault/bookshelves/**` 与
  `graph_vault/library/**` 下的可复制传播包；catalog 只做 projection。

## 关键证据

- Type DD 的 scope 仍声明：
  `graph_vault/catalog/bookshelves/{bookshelfId}` 是书架层级派生索引根，
  `graph_vault/catalog/library/{libraryId}` 是 library 层级派生索引根。
- hierarchyModel 仍把 bookshelf `authorityRoot` / `graphRoot` 指向
  `graph_vault/catalog/bookshelves/{bookshelfId}`，把 library 指向
  `graph_vault/catalog/library/{libraryId}`。
- pipelineIoContract 中 `bookshelf_membership_resolution`、
  `materialized_bookshelf_graph_build`、`library_membership_resolution` 和
  `library_graph_build` 的 `authorityRoot` 仍指向 catalog。
- quality gate、diagnostics、runs、implementedArtifacts 路径仍集中在
  `graph_vault/catalog/bookshelves/**` 与 `graph_vault/catalog/library/**`。
- `catalog_is_derivative` 不变量把 catalog 下的书架、library、qmd projection
  和 runner ledger 统称为派生状态。这与“bookshelf/library 包自身可复制传播”
  的新要求冲突。

## D01-D10 固定维度判定

### D01_authority_boundaries

判定：`FAIL`。

当前设计保持了单书包权威不被上层写回，但没有满足新的上层包权威边界。
bookshelf/library 的 authoritative manifest、quality gate、membership 与 current
generation 仍被定义在 catalog 下。这样会让 catalog 同时承担 projection 和包权威，
破坏 catalog 的职责分离。

必须重定义：

- `graph_vault/bookshelves/{bookshelfId}` 为 bookshelf package authority root。
- `graph_vault/library/{libraryId}` 为 library package authority root。
- `graph_vault/catalog/**` 只保存从这些包读取后生成的 projection 与索引摘要。
- 删除“catalog bookshelf/library artifacts 损坏不影响上层包可挂载状态”这一隐含缺口，
  改成“catalog projection 损坏不影响已发布 bookshelf/library 包的挂载与直接查询”。

### D02_fixed_query_budget

判定：`PASS_WITH_REQUIRED_PATH_REDESIGN`。

固定 top-K、固定 token、固定候选语义单元、禁止全量扫描的设计目标仍然成立。
但查询预算检查的权威输入必须从上层包 current manifest 和 quality gate 读取，
不能从 catalog projection 读取。

必须重定义：

- `--bookshelf-id` 读取 `graph_vault/bookshelves/{bookshelfId}/CURRENT` 指向的
  published generation。
- `--library-id` 读取 `graph_vault/library/{libraryId}/CURRENT` 指向的
  published generation。
- catalog projection 可用于 scope discovery，但不得作为预算模拟通过的证明。

### D03_graphrag_semantic_alignment

判定：`PASS_WITH_PACKAGE_LAYOUT_UPDATE`。

community reports、semantic units、semantic edges、evidence map 的语义结构仍
符合 GraphRAG 上层索引方向。失效点不在语义模型，而在包权威位置。

必须重定义：

- bookshelf 包内保留 `graphrag/output` 或等价 `index/` 目录，承载上层
  `community_reports.parquet`、`semantic_units.parquet`、`semantic_edges.parquet`
  和 `evidence_map.parquet`。
- library 包内保留同构目录，输入来源为已发布 bookshelf 包，而不是 catalog
  bookshelf 产物。

### D04_evidence_traceability

判定：`PASS_WITH_LINEAGE_ROOT_CHANGE`。

evidence lineage 的字段要求仍然充分。但 lineage 的上层包引用应从 catalog
路径改成 package-root-relative locator，避免复制传播后失效。

必须重定义：

- evidence map 使用 `packageKind`、`packageId`、`packageGeneration`、
  `manifestSha256` 和包内相对 locator。
- 书本证据继续追溯到 `bookId`、`sourceId`、`documentId`、`contentHash`、
  community report 或 text_unit。
- 禁止把本机绝对路径或 catalog projection path 作为 evidence authority。

### D05_state_recovery

判定：`FAIL`。

当前设计的 staging、runs、quality gate、CURRENT/current generation 均位于 catalog
路径。若上层包要可复制传播，状态闭环必须在包闭包内自洽；catalog projection
损坏或未复制时，包仍应能被验证、挂载和查询。

必须重定义：

- 包内生成目录：`generations/{generationId}/...`。
- 包内 publish pointer：`CURRENT` 或 `CURRENT.json`，指向当前已发布 generation。
- 包内 run 状态：`state/runs/{runId}/...` 或 `runs/{runId}/...`，但不得进入语义检索。
- 包内 stale marker：`state/stale.json` 或 generation state，查询默认 fail closed。
- catalog projection 只缓存 current generation digest，不参与恢复判定。

### D06_quality_gates

判定：`FAIL`。

质量门内容本身较完整，但质量门路径和 authority 归属错误。若 gate 位于 catalog，
复制一个 bookshelf/library 包时无法携带 query-ready 闭环，也无法像单书包一样做
离线验证。

必须重定义：

- bookshelf 包内：
  `state/bookshelf-quality-gate.json`、
  `state/membership-quality-gate.json`、
  对应 `.sha256` sidecar。
- library 包内：
  `state/library-quality-gate.json`、
  `state/library-membership-gate.json`、
  对应 `.sha256` sidecar。
- publish marker 必须引用 manifest sha256、gate sha256、generationId 和
  queryReady 状态。
- catalog 中最多投影 gate status、digest、lastProjectedAt 和诊断摘要。

### D07_incremental_scaling

判定：`PASS_WITH_MANIFEST_REDEFINITION`。

成员 manifest sha256、generation 和保守重建条件的思路仍可用。需要把“成员变化
标记 stale 或生成新 generation”的判定从 catalog manifest 改为上层包 manifest。

必须重定义：

- bookshelf manifest 记录每个成员 book 的 `BOOK_MANIFEST.json` sha256、
  packageGeneration、PUBLISH_READY digest 和 gate digest。
- library manifest 记录每个成员 bookshelf 的 manifest sha256、packageGeneration、
  CURRENT generation 与 quality gate digest。
- library 增量刷新以 bookshelf 包 generation 为影响边界，而不是 catalog
  bookshelf current 目录。

### D08_security_privacy

判定：`PASS_WITH_PACKAGE_CLOSURE_SCAN_UPDATE`。

敏感信息禁止项仍成立。新的风险是：包可复制传播后，任何包内 manifest、gate、
diagnostics、projection snapshot 或 migration record 都可能成为发布内容。

必须重定义：

- 敏感扫描覆盖 entire upper package closure，而不仅是 catalog 上层 parquet 产物。
- 迁移兼容记录不得写入绝对路径、provider payload、raw prompt/completion 或
  query.log。
- catalog projection 诊断只保存脱敏 digest 与 package-relative locator。

### D09_cli_operability

判定：`FAIL`。

CLI 行为目前以 catalog current 路径为上层索引 ready 判定基础。新边界下，这会把
projection 当成包权威，造成 stale、missing 或迁移中状态误判。

必须重定义：

- scope resolution order：
  explicit `--graph-book-id` -> `graph_vault/books/{bookId}`；
  explicit `--bookshelf-id` -> `graph_vault/bookshelves/{bookshelfId}`；
  explicit `--library-id` -> `graph_vault/library/{libraryId}`；
  default scope 可来自 catalog projection，但必须回读包权威验证。
- 若只存在旧 catalog 上层产物而不存在新包，返回
  `upper_package_migration_required` 或等价 typed error，不得当成 ready。
- 若包存在但 catalog projection 缺失，显式 scope 查询仍可在包 gate 通过时执行。
- timing 必须区分 `scope_projection_lookup` 与 `package_authority_validation`。

### D10_testability

判定：`FAIL`。

现有测试合同覆盖了固定预算、安全、stale 和单书非回归，但测试对象仍是 catalog
上层目录。新要求下，必须增加上层包复制传播、catalog 删除、旧路径迁移和 projection
重建测试，否则无法证明职责边界已修复。

必须新增测试合同：

- 复制 `graph_vault/bookshelves/{bookshelfId}` 到新 vault 后，显式
  `--bookshelf-id` 可仅凭包闭包查询。
- 复制 `graph_vault/library/{libraryId}` 到新 vault 后，显式 `--library-id`
  可仅凭包闭包查询。
- 删除 `graph_vault/catalog/bookshelves/**` 与 `graph_vault/catalog/library/**`
  后，上层包直接查询不回归，catalog discovery 可重建。
- 旧 catalog 上层产物存在但新包缺失时，CLI fail closed 并提示迁移。
- catalog projection stale 时，显式包查询以包 manifest/gate 为准；默认 scope
  discovery fail closed。
- 上层包内敏感扫描覆盖 manifest、state、parquet、diagnostics 与 migration record。
- 单书包复制传播、单书 `--graph-book-id` 和 qmd vsearch 非回归继续保留。
- 不同规模 library 的固定预算验证改为基于 `graph_vault/library/**` 包。

## 必须重定义的包布局

### Bookshelf 包

建议权威根目录：

```text
graph_vault/bookshelves/{bookshelfId}/
  BOOKSHELF_MANIFEST.json
  BOOKSHELF_MANIFEST.json.sha256
  PUBLISH_READY.json
  PUBLISH_READY.json.sha256
  CURRENT
  generations/{generationId}/
    membership/BOOKSHELF_MEMBERSHIP_MANIFEST.json
    membership/bookshelf_members.json
    membership/membership_decisions.jsonl
    membership/bookshelf_split_plan.json
    graphrag/output/semantic_units.parquet
    graphrag/output/semantic_edges.parquet
    graphrag/output/communities.parquet
    graphrag/output/community_reports.parquet
    graphrag/output/evidence_map.parquet
    graphrag/output/semantic_unit_embeddings.lance/
  state/membership-quality-gate.json
  state/bookshelf-quality-gate.json
  state/diagnostics.json
  runs/{runId}/status.json
  runs/{runId}/events.jsonl
```

`BOOKSHELF_MANIFEST.json` 是 bookshelf 包权威。`PUBLISH_READY.json` 是该包可复制、
可挂载、可查询的发布 marker。`CURRENT` 只能指向已通过质量门并由 publish marker
确认的 generation。

### Library 包

建议权威根目录：

```text
graph_vault/library/{libraryId}/
  LIBRARY_MANIFEST.json
  LIBRARY_MANIFEST.json.sha256
  PUBLISH_READY.json
  PUBLISH_READY.json.sha256
  CURRENT
  generations/{generationId}/
    membership/LIBRARY_MEMBERSHIP_MANIFEST.json
    membership/library_members.json
    membership/library_partition_plan.json
    graphrag/output/semantic_units.parquet
    graphrag/output/semantic_edges.parquet
    graphrag/output/communities.parquet
    graphrag/output/community_reports.parquet
    graphrag/output/evidence_map.parquet
    graphrag/output/semantic_unit_embeddings.lance/
  state/library-membership-gate.json
  state/library-quality-gate.json
  state/diagnostics.json
  runs/{runId}/status.json
  runs/{runId}/events.jsonl
```

`LIBRARY_MANIFEST.json` 是 library 包权威。library 包只能以已发布 bookshelf 包为
主要输入；direct book 输入仍应受 directBookLimit 约束。

## Catalog projection 的新职责

`graph_vault/catalog/**` 应降级为 projection 与 discovery 层：

- `catalog/bookshelves.yaml`：投影已挂载 bookshelf 包的 id、title、manifestSha256、
  generation、queryReady、lastProjectedAt。
- `catalog/library.yaml`：投影已挂载 library 包的 id、manifestSha256、generation、
  queryReady、lastProjectedAt。
- `catalog/capabilities.yaml`：投影 book/bookshelf/library query capabilities。
- `catalog/qmd-*`：继续服务单书 qmd projection。
- `catalog/batch-runs/**`：仍只能是 runner ledger/observability state。

catalog 不得保存上层包的 authoritative manifest、CURRENT、quality gate、publish marker
或可发布语义索引。catalog projection 可删除、可重建、可 stale；显式查询必须回读
包权威。

## 迁移兼容要求

Type DD 应定义从旧 catalog 上层产物到新包闭包的迁移策略：

- 发现旧路径：
  `graph_vault/catalog/bookshelves/{bookshelfId}/current/**` 与
  `graph_vault/catalog/library/{libraryId}/current/**`。
- 对旧产物执行完整 schema、checksum、evidence、敏感扫描和固定预算质量门复验。
- 复验通过后写入新包 staging generation，再写 package manifest、quality gate、
  `CURRENT` 和 `PUBLISH_READY.json`。
- 旧 catalog 目录只能保留 migration pointer 或 projection，不再作为 query-ready
  authority。
- 复验失败时不得迁移为 ready 包；CLI 返回 typed error，并保留脱敏 diagnostics。
- 支持只读兼容窗口：旧路径可以被 migration command 读取，但 scoped query 不得直接
  把旧路径当作 ready。

## 必须更新的 Type DD 区域

- `scope.included`：改为 `graph_vault/bookshelves/{bookshelfId}` 与
  `graph_vault/library/{libraryId}`。
- `terms.bookshelf` 与 `terms.library`：把可复制传播包闭包写成一等语义。
- `hardInvariants.derived_upper_indexes_only`：区分“上层包是派生但权威闭包”和
  “catalog projection 是可重建派生投影”。
- `hierarchyModel.levels.bookshelf/library`：重写 `authorityRoot`、`graphRoot`、
  sourceInputs、outputs。
- `pipelineIoContract.hardInvariants.catalog_is_derivative`：删除 catalog 作为
  bookshelf/library 索引根的表述。
- `pipelineStages.*.authorityRoot`：全部改到上层包根。
- `qualityGateCatalog`、`runLedger`、`stateClosure`：改成包内闭环，catalog 只投影。
- `handoffMatrix`：library 从 bookshelf package manifest/gate handoff。
- `scoped_query_execution`：回读包权威并定义旧 catalog 产物 fail-closed 行为。
- `implementationGroundingReview`：把当前 catalog 实现标记为 legacy/current
  implementation gap，而不是继续宣称为最终接地路径。
- `testContracts`：新增复制传播、catalog 删除、迁移、projection stale 反例。

## 阻塞项

在 Type DD 完成上述修订前，不应继续把当前 catalog 上层路径实现判定为设计通过。
任何实施审计若仍以 `graph_vault/catalog/bookshelves/**` 或
`graph_vault/catalog/library/**` 作为 bookshelf/library 包权威，应判定为与最新
用户边界不一致。

## 最小通过条件

下一轮设计审计可通过的最低条件：

- Type DD 明确 bookshelf/library package authority root 位于
  `graph_vault/bookshelves/**` 与 `graph_vault/library/**`。
- `PUBLISH_READY.json`、`CURRENT`、manifest、quality gate、membership 和 semantic
  artifacts 均属于上层包闭包。
- catalog projection 明确可删除、可重建、不可作为 query-ready authority。
- scoped query 明确从包权威 fail-closed 验证，不从旧 catalog current 直接查询。
- 迁移兼容对旧 catalog 上层产物采用复验后迁移，未迁移不得当成 ready。
- 固定 D01-D10 中 D01、D05、D06、D09、D10 的失败点被设计修复。
