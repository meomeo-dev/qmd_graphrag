# design-turn_012 / agent-3 反向边界与可测试性审计报告

overallStatus: PASS

## 审计范围

- 规范设计：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 执行提示：
  `docs/task_kickoff_prompt/书架-Library层级索引改造_UNDO.prompt.md`
- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 参考报告：
  `docs/architecture/graphrag-hierarchical-library-index-audits/design-turn_011/agent-*/report.md`

## 总体结论

修订后的 Type DD 已消除 design-turn_011 的阻断问题。规范性段落已把
bookshelf 与 library 的权威根 (authority root) 固定到
`graph_vault/bookshelves/{bookshelfId}` 与
`graph_vault/library/{libraryId}`，并把 `graph_vault/catalog/**` 限定为
projection、capability、默认 scope、路由索引和观测状态。

本轮未发现仍把上层 `BOOKSHELF_MANIFEST`、`LIBRARY_MANIFEST`、
`PUBLISH_READY`、`CURRENT`、quality gate、generation、staging 或 runs 放在
catalog 中作为权威的规范性段落。旧 catalog 路径仅作为
legacy implementation gap 或迁移前实现证据出现，并被明确标记为不能授予
package-root query-ready。

阻断项 (blocking findings)：无。

## 重点边界核验

- 上层包权威：`scope`、`hardInvariants.upper_package_authority_roots`、
  `hierarchyModel`、`manifestSchemas` 与 `pipelineIoContract.pipelineStages`
  均指向 `graph_vault/bookshelves/{bookshelfId}` 或
  `graph_vault/library/{libraryId}`。
- catalog 职责：`catalog_projection_only` 与
  `pipelineIoContract.catalog_is_derivative` 明确 catalog 不拥有上层包闭包，
  不得改变任何 scope 的 `query_ready` 判定。
- 显式查询：`queryContract.routing.packageAuthorityValidation` 要求
  `--bookshelf-id` 与 `--library-id` 先解析 package root，再校验
  package-local `CURRENT`、manifest、`PUBLISH_READY` 与 quality gate。
- catalog 可删性：`queryContract.routing.catalogOptionalForExplicitScope`、
  `stateAndRecovery.recoveryRules` 和两处 `testContracts` 均要求删除或缺失
  catalog projection 不影响显式上层包查询。
- legacy 拒读：`legacyCatalogArtifactRule`、typed error
  `upper_package_migration_required`、CLI matrix 和测试合同均明确 legacy
  catalog-only artifact 不能作为 query-ready authority。

## D01_authority_boundaries

status: PASS

修订版保持单书包权威不依赖上层索引，并明确 bookshelf/library 包权威根只能
位于 `graph_vault/bookshelves/{bookshelfId}` 与
`graph_vault/library/{libraryId}`。`catalog_projection_only` 进一步声明 catalog
不得作为上层 manifest、quality gate 或 publish marker 的权威来源。

## D02_fixed_query_budget

status: PASS

交互预算定义了固定 `maxSemanticUnits`、`maxBookshelves`、
`maxBooksForDeepening`、LLM 调用上限和 token 上限。查询路径禁止隐式全库扫描，
超预算返回 `budget_exceeded_narrow_scope_required`。library 规模 10、100、
1000 本书的固定预算测试也已纳入测试合同。

## D03_graphrag_semantic_alignment

status: PASS

上层构建输入保留 member `community_reports`、`entities`、`relationships`
和受界 `text_units`，输出包含 `semantic_units`、`semantic_edges`、
`communities`、`community_reports` 和 `evidence_map`。该模型继续保持
GraphRAG community report、entity 与 relationship 语义，而非普通摘要检索。

## D04_evidence_traceability

status: PASS

`evidenceMap.requiredColumns` 覆盖 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report、text unit 和 artifact digest。查询合成要求输出
traceable evidence ids，pipeline handoff 与 quality gate 要求每个上层语义单元
回链到下层 evidence。

## D05_state_recovery

status: PASS

状态闭环已从 catalog 迁移到 package-local `staging/{runId}`、
`generations/{generationId}`、`CURRENT.json`、`PUBLISH_READY`、state gates 和
`runs/{runId}`。`catalogProjectionRoots` 仅作为可重建 routing view，不能保存
package authority、publish marker 或 query-ready gate。

## D06_quality_gates

status: PASS

bookshelf 与 library 的 quality gate 路径分别位于
`graph_vault/bookshelves/{bookshelfId}/state/bookshelf-quality-gate.json` 与
`graph_vault/library/{libraryId}/state/library-quality-gate.json`。检查项覆盖 schema、
checksum、成员一致性、evidence lineage、固定预算模拟、敏感信息扫描和 stale
marker。失败时返回 typed error 并记录脱敏诊断。

## D07_incremental_scaling

status: PASS

设计记录成员 manifest sha256、packageGeneration、builder/config fingerprint 和
generation。成员变化会生成新 generation 或标记 stale；library 以 bookshelf
package generation 和 manifest digest 为刷新边界。大规模 library 通过物化书架、
虚拟父书架和 direct book limit 控制重建影响范围。

## D08_security_privacy

status: PASS

设计禁止 provider payload、raw prompt、raw completion、credential、绝对路径和
query log 进入上层 manifest、索引、quality gate 或诊断。质量门包含
`sensitive_payload_scan_passed`，诊断只允许 digest、bounded summary 与 redacted
locator。

## D09_cli_operability

status: PASS

CLI scope resolution 已区分 explicit book、bookshelf、library 与 default scope。
显式 bookshelf/library 查询必须回读 package authority；catalog projection 只能辅助
discovery 和默认 scope routing。stale、missing、quality gate failed、over budget、
legacy catalog-only artifact 均有 typed error 和 bounded timing 字段。

## D10_testability

status: PASS

测试合同超过固定基准要求的 8 个案例，并覆盖正确性、固定预算、状态恢复、证据、
安全、单书 hotplug 非回归和上层包边界。关键反向测试包括：复制 bookshelf/library
package 后无 catalog projection 查询、删除 catalog projection 不影响显式上层查询、
legacy catalog-only artifact 返回 `upper_package_migration_required`、删除上层
catalog projection 不影响单书查询。

## 非阻断观察

- `designAudit.currentRunDirectory` 仍记录 `design-turn_011`。这属于审计元数据
  新鲜度问题，不影响 D01-D10 的设计边界判定。
- 上层 package mount 未单独定义命令名，但 Type DD 已通过“复制到权威根、
  package-local gate validation、catalog projection 可重建、显式 package query
  不依赖 projection”定义了可测试 mount 行为。该表达足以支撑本轮设计通过。
