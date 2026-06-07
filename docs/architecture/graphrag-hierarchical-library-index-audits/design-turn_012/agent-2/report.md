# design-turn_012 agent-2 设计审计报告

overallStatus: PASS

## 审计结论

修订后的 Type DD 满足固定 D01-D10 审计基准，并覆盖本轮重点边界：
bookshelf 与 library 已定义为 `graph_vault/bookshelves/{bookshelfId}` 与
`graph_vault/library/{libraryId}` 下的可复制传播上层包
(copyable upper package)。`graph_vault/catalog/**` 被限定为 projection、
capability、默认 scope、路由索引和观测状态，不再承担上层包权威。

显式 `--bookshelf-id` 与 `--library-id` 查询以 package-local manifest、
`CURRENT.json`、`PUBLISH_READY.json` 和 quality gate 为 ready 判定依据；
catalog projection 缺失或 stale 不阻断有效 package-root 查询。legacy
catalog-only 上层产物被定义为 fail closed，并返回
`upper_package_migration_required` typed error。package-local staging、
generations、state、runs、quality gate 与 publish marker 已形成闭环。

blockingFindings: []

mustModifyFilesOrSections: []

## D01_authority_boundaries

status: PASS

Type DD 明确保留单书包 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd、
GraphRAG output 和包内质量门作为单书权威；书架与 library 不写回单书包闭包。

关键合同已修正：

- `scope.included` 将 bookshelf 和 library 权威根定义为
  `graph_vault/bookshelves/{bookshelfId}` 与
  `graph_vault/library/{libraryId}`。
- `hardInvariants.upper_package_authority_roots` 要求 manifest、`PUBLISH_READY`、
  `CURRENT`、package-local gates、generations、staging 和 runs 位于各自上层包
  闭包内。
- `hardInvariants.catalog_projection_only` 与
  `pipelineIoContract.hardInvariants.catalog_is_derivative` 明确 catalog 只作
  projection，不拥有 query-ready authority。
- `queryContract.routing.catalogOptionalForExplicitScope` 规定 catalog projection
  缺失或 stale 不阻断显式 package-root 查询。

## D02_fixed_query_budget

status: PASS

查询预算 (fixed query budget) 以固定 `maxSemanticUnits`、`maxBookshelves`、
`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用数和 token 上限定义。
交互路径禁止全库扫描或隐式构建。

关键合同包括：

- `queryContract.interactiveBudget` 固定默认预算。
- `queryContract.routing.noImplicitFullVaultScan` 禁止查询路径重建全部 book、
  shelf 或 library index。
- `queryContract.retrieval.firstStage` 与 `secondStage` 均受 top-K、token 和
  deepening cap 约束。
- 超预算时返回 `budget_exceeded_narrow_scope_required`，符合 fail closed 要求。

## D03_graphrag_semantic_alignment

status: PASS

上层索引仍以 GraphRAG 语义结构为核心，而不是普通摘要检索。bookshelf 构建读取
成员书的 `community_reports.parquet`、`entities.parquet`、`relationships.parquet`
和受界 `text_units.parquet`；library 构建读取已发布 bookshelf 包的
`semantic_units.parquet`、`semantic_edges.parquet`、`community_reports.parquet`
和 `evidence_map.parquet`。

`upperGraphArtifactSchemas` 定义了 `semantic_units`、`semantic_edges` 和
`evidence_map`。`semantic_edges.allowedRelationTypes` 保留 shared entity、
source relationship、topic clustering、parent-child community、bookshelf
membership 与 library membership 等图关系，满足 GraphRAG 语义对齐。

## D04_evidence_traceability

status: PASS

证据追溯合同覆盖 book、bookshelf 与 library 层级。`evidenceMap.requiredColumns`
包含 `targetBookId`、`targetBookshelfId`、`targetSourceId`、
`targetDocumentId`、`targetContentHash`、`targetCommunityReportId`、
`targetTextUnitId` 与 `targetArtifactDigest`。

质量门要求 bookshelf 的每个 upper semantic unit 追溯到 member evidence，
library 的每个 unit 追溯到 shelf 和 book evidence。查询输出必须包含
published artifacts 的 evidence lineage。因此 catalog projection 被删除时，显式上层包
仍能从 package-local artifacts 追溯证据。

## D05_state_recovery

status: PASS

状态闭环已经迁移到上层包闭包内。`stateAndRecovery.ledgerRoots` 指向
`graph_vault/bookshelves/{bookshelfId}/runs/{runId}` 与
`graph_vault/library/{libraryId}/runs/{runId}`；`packageStateRoots` 指向上层包根。

`publishProtocol` 规定 package-local `staging/{runId}`、校验 staged artifacts、
写入 quality gate、提升到 `generations/{generationId}`、更新 `CURRENT.json`、
最后写 package-root manifest 与 `PUBLISH_READY`。`recoveryRules` 明确 partial
build 不发布 ready index，stale member manifests 会在查询前标记 stale，legacy
catalog-only upper artifacts 在迁移前 not query-ready。

## D06_quality_gates

status: PASS

bookshelf 与 library 均有独立 quality gate，且路径位于 package-local state：

- `graph_vault/bookshelves/{bookshelfId}/state/bookshelf-quality-gate.json`
- `graph_vault/library/{libraryId}/state/library-quality-gate.json`

required checks 覆盖 schema、checksum sidecars、成员 manifest sha256、一致性、
evidence lineage、embedding fingerprint、固定预算模拟、敏感信息扫描和 stale
marker absent。失败诊断位于上层包 `state/diagnostics.json`，并通过 typed error
暴露机器可读诊断。

## D07_incremental_scaling

status: PASS

设计记录成员 manifest sha256、packageGeneration、构建配置、embedding model
fingerprint、summary config 和 evidence schema。成员变化会生成新 generation 或标记
stale。

增量边界清晰：

- bookshelf generation 随成员书 manifest sha256 或配置变化而变化。
- library generation 随成员 shelf manifest sha256 或配置变化而变化。
- library 主要以已发布 bookshelf 包为输入，大规模 library 通过书架分层限制重建
  影响范围。
- catalog projection 可删除并从 package-local authority 重建，不参与 package
  generation 判定。

## D08_security_privacy

status: PASS

`no_sensitive_payload_export`、`buildInputs.forbiddenInputs` 和
`diagnosticRedactionPolicy` 禁止 provider payload、raw prompt、raw completion、
credential、绝对路径和 query log content 进入 manifest、索引、质量门或诊断。

bookshelf 与 library quality gates 均包含 `sensitive_payload_scan_passed`。
诊断只能记录 digest、schema id、check id、bounded summary 和 scope-relative
locator。上层包可复制传播闭包和 catalog projection 均被纳入敏感信息边界。

## D09_cli_operability

status: PASS

CLI 行为覆盖无 scope、歧义、缺索引、legacy catalog-only、stale、quality gate
failed 和 over budget。`queryContract.routing.packageAuthorityValidation` 要求显式
`--bookshelf-id`、`--library-id` 先解析 package root，再验证 package-local
`CURRENT`、manifest、`PUBLISH_READY` 和 quality gate。

关键 typed error 已定义：

- `missing_scope`
- `ambiguous_scope`
- `upper_index_missing`
- `upper_package_migration_required`
- `upper_index_stale`
- `upper_quality_gate_failed`
- `budget_exceeded_narrow_scope_required`

`cliBehaviorMatrix` 同时定义 timing fields，使 scope resolution、package authority
validation、quality gate read、retrieval 和 budget application 可分解观测。

## D10_testability

status: PASS

测试合同数量超过固定基准要求，覆盖正确性、成本边界、恢复、证据、安全和 hotplug
兼容。特别是本轮重点场景已纳入：

- 复制 `graph_vault/bookshelves/{bookshelfId}` 后在 fresh vault 中通过显式
  `--bookshelf-id` 查询。
- 复制 `graph_vault/library/{libraryId}` 后在 fresh vault 中通过显式
  `--library-id` 查询。
- 删除 catalog bookshelf/library projection 后，显式 package-root 上层查询不回归。
- legacy catalog upper artifacts 缺少 package roots 时返回
  `upper_package_migration_required`。
- 不同规模 library 在 10、100、1000 本模拟下验证固定 top-K。
- 单书查询在 catalog upper indexes 删除后仍成功。
- package-local sensitive scan、stale 拒绝、partial publish 防护和 typed error
  合同均有测试条目。

## 非阻塞观察

`designAudit.currentRunDirectory` 仍指向 `design-turn_011`。该元数据不影响 D01-D10
合同判定，也不改变本文档的 package-root、catalog projection、query、state、
quality gate 或测试合同。后续合并审计结果时可更新为当前轮次目录。
