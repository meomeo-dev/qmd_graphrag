# design-turn_011 agent-2 设计审计报告

overallStatus: DESIGN_REWORK_REQUIRED

## 审计范围

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计唯一规范设计：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

新增设计约束：

- 书架包根目录应为 `graph_vault/bookshelves/{bookshelfId}/`。
- library 包根目录应为 `graph_vault/library/{libraryId}/`。
- 两者应是可复制传播的上层 hotplug-like package。
- `graph_vault/catalog/**` 只保存 projection、索引目录和路由目录，不保存
  书架/library 的包权威闭包。

## 总体结论

当前 Type DD 需要重修，不能沿用 `design_audit_passed` 结论。现有设计把
`graph_vault/catalog/bookshelves/{bookshelfId}` 和
`graph_vault/catalog/library/{libraryId}` 定义为书架与 library 的
`authorityRoot`、质量门路径、运行状态路径和已实现 artifact 路径。该设计与最新
要求冲突：catalog 不应承载上层包闭包，只应投影和路由上层包。

可保留的设计内核包括固定查询预算、GraphRAG 语义结构、evidence lineage、敏感信息
扫描、typed error 和 staging 到 quality gate 再发布的状态语义。但这些合同必须迁移
到 `graph_vault/bookshelves/**` 与 `graph_vault/library/**` 包根下，并重新定义 catalog
projection 与 package authority 的关系。

本轮结论：D01、D05、D06、D09、D10 在新增目录权威约束下不通过；D02、D03、D04、
D07、D08 的核心原则可保留，但必须随路径、包闭包和 projection 边界同步修订。

## D01_authority_boundaries

status: FAIL

当前设计保持了单书包 `BOOK_MANIFEST.json` 的权威边界，也禁止书架/library 写回
单书包文件闭包。但它把书架与 library 的 `authorityRoot` 设为
`graph_vault/catalog/bookshelves/{bookshelfId}` 和
`graph_vault/catalog/library/{libraryId}`，并在 `scope.included`、`hierarchyModel`、
`qualityGates`、`stateAndRecovery` 与 `pipelineStages` 中重复该路径。

在新增约束下，书架和 library 不是 catalog 内部派生目录，而是可复制传播的上层包。
catalog 只能从这些包生成 projection、capability 和路由目录。现有设计把 catalog 同时
作为 projection 层和上层包权威层，破坏 catalog 的职责分离。

必须修订：

- `scope.included` 中的书架/library 根路径。
- `terms.bookshelf` 中“catalog 产物”的定义。
- `hardInvariants.derived_upper_indexes_only`，明确“可重建派生”不等于
  “位于 catalog”。
- `hierarchyModel.levels.bookshelf.authorityRoot` 与 `graphRoot`。
- `hierarchyModel.levels.library.authorityRoot` 与 `graphRoot`。
- `pipelineIoContract.hardInvariants.catalog_is_derivative`，改为 catalog 只投影
  book、bookshelf 和 library package。

结论：不满足 D01。

## D02_fixed_query_budget

status: PASS_WITH_REWORK

固定预算设计仍成立。`queryContract.interactiveBudget` 固定
`maxSemanticUnits`、`maxBookshelves`、`maxBooksForDeepening`、LLM 调用数和 token
上限；`routing.noImplicitFullVaultScan` 禁止查询路径全库扫描或隐式构建。

需要重修的是 scope 读取位置：查询应从
`graph_vault/bookshelves/{bookshelfId}/current` 或
`graph_vault/library/{libraryId}/current` 读取已发布包产物，catalog 只用于查找候选
scope、capability projection 或 default scope pointer。若 catalog projection 缺失但包
存在，设计应定义快速重建 projection、直接 package lookup，或 typed error 的优先级。

结论：预算原则满足 D02，但路径和 scope resolution 必须修订。

## D03_graphrag_semantic_alignment

status: PASS_WITH_REWORK

当前设计仍贴近 GraphRAG 结构：书架构建消费成员书的
`community_reports.parquet`、`entities.parquet`、`relationships.parquet` 和受界
`text_units.parquet`；上层产物包含 `semantic_units.parquet`、
`semantic_edges.parquet`、`community_reports.parquet` 与 `evidence_map.parquet`。
library 构建继续消费已发布书架的语义产物，而不是把所有单书临时拼接成一次查询。

需要重修的是 artifact 根路径和 package manifest 对语义产物的声明方式。语义结构可以
保留，但应归属于上层包闭包，而不是 catalog 闭包。

结论：语义对齐满足 D03，目录归属需要重修。

## D04_evidence_traceability

status: PASS_WITH_REWORK

`evidence_map.parquet` 的字段能回链到 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report 或 text unit。library 级 evidence 也包含
`targetBookshelfId`，可继续作为跨层证据。

新增包根要求下，设计还需要把 lineage 扩展到上层包版本：library 成员应记录成员
bookshelf package manifest digest、generation 和 publish marker digest；书架成员应记录
成员 book package manifest digest、generation 和 publish marker digest。catalog
projection digest 只能作为路由观测，不能替代包权威 digest。

结论：证据模型核心满足 D04，但 package-level lineage 字段必须补齐。

## D05_state_recovery

status: FAIL

当前状态闭环语义完整，但权威位置错误。`stateAndRecovery.ledgerRoots`、
`qualityGates.failureDiagnostics.pathPattern`、`pipelineStages.*.stateWrites` 和
`implementationGroundingReview.implementedArtifacts` 均将书架/library 的运行状态、
diagnostics、checkpoints、quality gate 和 current generation 写在
`graph_vault/catalog/**` 下。

新增要求下，状态恢复必须从上层包根判断 `ready`、`failed`、`running`、`pending`、
`stale` 或 `quarantined`。catalog projection 损坏、缺失或过期不应让一个可复制的
bookshelf/library package 失去自证状态。现有设计没有定义：

- 上层包根中的 `staging/{runId}`、`runs/{runId}`、`current` 与 publish marker。
- catalog projection 从上层包恢复或重建的规则。
- 旧 `catalog/bookshelves/**` 与 `catalog/library/**` 产物的隔离、迁移或拒读规则。
- 包复制后在新 vault 中如何用 package-local state 判断 query readiness。

必须修订：

- `stateAndRecovery.ledgerRoots`。
- `stateAndRecovery.publishProtocol` 的 root 语义。
- `pipelineIoContract.stageFieldContract.authorityRoot` 约束。
- `pipelineStages.bookshelf_membership_resolution.authorityRoot`。
- `pipelineStages.materialized_bookshelf_graph_build.authorityRoot`。
- `pipelineStages.library_membership_resolution.authorityRoot`。
- `pipelineStages.library_graph_build.authorityRoot`。
- `stateClosure.rule`，明确以包根而非 catalog root 判断状态。

结论：不满足 D05。

## D06_quality_gates

status: FAIL

质量门检查项本身较完整，覆盖 schema、checksum、成员一致性、evidence lineage、敏感
扫描、固定预算模拟和 stale marker。但质量门路径仍定义为：

- `graph_vault/catalog/bookshelves/{bookshelfId}/state/bookshelf-quality-gate.json`
- `graph_vault/catalog/library/{libraryId}/state/library-quality-gate.json`

这会让 catalog 成为 query-ready 判定的包权威位置。新增要求下，质量门必须位于
`graph_vault/bookshelves/{bookshelfId}/state/` 与
`graph_vault/library/{libraryId}/state/`，并由上层包 manifest 引用。catalog 中只能保存
质量门摘要、capability projection 或路由索引，不能保存唯一质量门权威。

必须修订：

- `qualityGates.bookshelfGate.path`。
- `qualityGates.libraryGate.path`。
- `qualityGates.failureDiagnostics.pathPattern`。
- `manifestSchemas.*.qualityGate` 对 package-local gate 的引用。
- CLI capability resolver 对 gate 的读取顺序。

结论：不满足 D06。

## D07_incremental_scaling

status: PASS_WITH_REWORK

当前设计记录成员 manifest sha256、generation、builder version、embedding model
fingerprint、clustering config、summary config 和 evidence schema，支持成员变化后标记
stale 或生成新 generation。书架分区、虚拟父书架、direct book limit 和 library
partition 也能限制重建影响范围。

需要重修的是增量刷新边界：catalog projection 的增量刷新不应等同于 package 的增量
重建。设计应区分：

- package generation refresh：重建 bookshelf/library 包内 current generation。
- catalog projection refresh：从已发布上层包重建路由和 capability projection。
- stale propagation：book 包变化标记 bookshelf 包 stale；bookshelf 包变化标记
  library 包 stale；catalog 只投影 stale 状态。

结论：扩展原则满足 D07，但增量刷新层次必须重写。

## D08_security_privacy

status: PASS_WITH_REWORK

当前设计禁止 provider payload、原始 prompt/completion、密钥、绝对路径和 query.log
进入上层 manifest、索引、质量门和诊断；`diagnosticRedactionPolicy` 也要求 digest 和
scope-relative locator。该原则仍适用于上层 hotplug-like package。

新增包根要求提高了敏感扫描范围：扫描对象不应只覆盖 catalog 内 artifacts，而应覆盖
可复制传播的 bookshelf/library package closure。catalog projection 也需要单独的红线：
projection 不得复制 package 中被禁止的敏感字段，不得把本机绝对路径、provider
payload 或 query log 内容写入路由目录。

必须修订：

- `no_sensitive_payload_export` 的 package closure 表述。
- `buildInputs.forbiddenInputs` 与 `diagnosticRedactionPolicy` 的适用根。
- `qualityGates.*.requiredChecks` 中 sensitive scan 的扫描闭包。
- `compatibilityWithHotplugPackages.exportBehavior`，改为上层包复制闭包规则。

结论：安全原则满足 D08，但必须迁移到上层包闭包。

## D09_cli_operability

status: FAIL

当前 CLI 行为定义了 `--graph-book-id`、`--bookshelf-id`、`--library-id`、typed error、
timing 和 remediation command。但它没有区分上层 package root 与 catalog projection：
`upper_index_missing`、`upper_index_stale` 和 `upper_quality_gate_failed` 的判定根仍隐含
`catalog/bookshelves` 或 `catalog/library`。

新增要求下，CLI 必须定义新的 resolution order：

- 显式 `--graph-book-id` 读取 `graph_vault/books/{bookId}` 包权威。
- 显式 `--bookshelf-id` 读取 `graph_vault/bookshelves/{bookshelfId}` 包权威。
- 显式 `--library-id` 读取 `graph_vault/library/{libraryId}` 包权威。
- catalog projection 可用于候选发现和默认 scope，但不能替代 package manifest、
  publish marker 或 package-local quality gate。

还必须定义以下 typed error 场景：

- package 存在但 catalog projection 缺失。
- catalog projection 存在但 package 缺失。
- package manifest/gate stale，但 projection 未更新。
- 旧 catalog 上层产物存在但新 package root 不存在。
- 上层包复制后成员 book/shelf package 未挂载，是否允许 upper-only answer，是否禁止
  deepening。

结论：不满足 D09。

## D10_testability

status: FAIL

当前测试合同覆盖固定预算、stale、missing、evidence、sensitive scan、单书 hotplug
非回归等场景。但测试目标仍围绕 `catalog/bookshelves/**` 与 `catalog/library/**`。
新增目录权威要求后，缺少关键测试：

- bookshelf package 可复制到新 vault 后，catalog projection 可重建，`--bookshelf-id`
  可读取包内 manifest/gate。
- library package 可复制到新 vault 后，catalog projection 可重建，`--library-id`
  可读取包内 manifest/gate。
- 删除 `graph_vault/catalog/**` 不破坏已发布 bookshelf/library package 的自证状态。
- 删除 `graph_vault/bookshelves/**` 或 `graph_vault/library/**` 时，catalog projection
  不能被查询误用为 ready。
- 旧 `catalog/bookshelves/**` 与 `catalog/library/**` 产物不能被新查询路径当作 ready。
- package-local sensitive scan 覆盖全部可复制闭包。
- package root 与 catalog projection 不一致时返回 typed error。
- 单书包复制传播非回归与上层包复制传播同时覆盖。

结论：不满足 D10。

## 必须修订的设计字段和路径

路径迁移目标：

- `graph_vault/catalog/bookshelves/{bookshelfId}` ->
  `graph_vault/bookshelves/{bookshelfId}`
- `graph_vault/catalog/library/{libraryId}` ->
  `graph_vault/library/{libraryId}`
- `graph_vault/catalog/**` 保留为 projection、capability、route index、scan state 和
  runner observability，不保存上层包权威闭包。

Type DD 必须修订的字段：

- `status` 与 `designAudit.currentRunDirectory`，标记第 11 轮重修状态。
- `scope.included`。
- `terms.bookshelf` 与 `terms.library`。
- `hardInvariants.derived_upper_indexes_only`。
- `hierarchyModel.levels.bookshelf`。
- `hierarchyModel.levels.library`。
- `qualityGates.bookshelfGate.path`。
- `qualityGates.libraryGate.path`。
- `qualityGates.failureDiagnostics.pathPattern`。
- `stateAndRecovery.ledgerRoots`。
- `manifestSchemas.bookshelfManifest`。
- `manifestSchemas.bookshelfMembershipManifest`。
- `manifestSchemas.libraryManifest`。
- `manifestSchemas.libraryMembershipManifest`。
- `compatibilityWithHotplugPackages.exportBehavior`。
- `pipelineIoContract.hardInvariants.catalog_is_derivative`。
- `pipelineIoContract.pipelineStages` 中四个上层阶段的 `authorityRoot`、`emittedOutputs`、
  `stateWrites`、`failureOutputs` 和 `nextStageInputs`。
- `pipelineIoContract.handoffMatrix` 中 bookshelf -> library 与 library -> query 的
  artifact 路径。
- `pipelineIoContract.stateClosure.rule`。
- `implementationGrounding.implementedCapabilities` 与
  `implementationGroundingReview.implementedArtifacts`。
- `testContracts.requiredCases`。

需要新增或明确的设计字段：

- bookshelf package publish marker 或等价 package-local ready marker。
- library package publish marker 或等价 package-local ready marker。
- package-local current generation 指针和 stale marker。
- catalog projection rebuild rule from upper packages。
- catalog projection 与 package authority 冲突时的 typed error。
- legacy catalog upper artifact quarantine 或 migration rule。
- upper package copy/export closure 与 sensitive scan closure。

## 实现迁移影响

实现需要从“catalog 内上层索引”迁移为“上层包 + catalog projection”。

受影响的实现面：

- `src/graphrag/upper-index/*` 的 root resolver、builder、validator、query reader。
- `scripts/graphrag/build-bookshelf-membership.mjs`。
- `scripts/graphrag/build-bookshelf-graph.mjs`。
- `scripts/graphrag/build-library-membership.mjs`。
- `scripts/graphrag/build-library-graph.mjs`。
- CLI `--bookshelf-id` 与 `--library-id` 的 capability resolution。
- catalog/capability projection 模块。
- membership 与 graph 测试中的 `catalog/bookshelves`、`catalog/library` fixture 路径。
- sensitive scan 测试和 package copy smoke test。

迁移顺序建议：

- 先修改 Type DD，明确上层包目录、包闭包、catalog projection 和 legacy 拒读规则。
- 再改 root resolver，使新构建默认写入 `graph_vault/bookshelves/**` 和
  `graph_vault/library/**`。
- 增加 catalog projection 从上层包重建的最小实现。
- 最后迁移 CLI 和测试，确保旧 catalog 上层产物不会被误判为 ready。

## 残余风险

- 旧 `graph_vault/catalog/bookshelves/**` 与 `graph_vault/catalog/library/**` 产物如果不
  隔离，查询路径可能把旧布局误判为 ready。
- library 包可复制后，如果成员 bookshelf/book 包未同时挂载，upper-only answer 与
  routed deepening 的可用性边界需要明确。
- catalog projection 若继续保存过多 manifest 细节，可能重新承担包权威或泄露本地
  路径。
- sensitive scan 若只扫描 manifest 和 parquet，不扫描上层包完整闭包，复制传播风险
  仍未闭合。
- 当前实现和测试已有较多 `catalog/bookshelves`、`catalog/library` 路径耦合；迁移期间
  需要 fail-closed 测试防止新旧路径同时可查询。

## 最终判定

第 11 轮 agent-2 判定当前设计必须重修。设计应先完成上层 hotplug-like package 的目录
权威、状态闭环、质量门路径、catalog projection 边界、CLI typed error 和测试合同
修订，再继续实现迁移或实施审计。
