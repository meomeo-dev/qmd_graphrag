# design-turn_013 agent-2 设计审计报告

## overallStatus

PASS

## auditedFiles

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

## baseline

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- baseline status: `fixed_baseline`

## summary

本轮按固定 D01-D10 基准执行设计审计，未修改固定基准、Type DD 或其他
agent 报告。Type DD 已把 bookshelf 与 library 设计为可复制传播的上层包
（upper package），其权威根分别为
`graph_vault/bookshelves/{bookshelfId}` 与 `graph_vault/library/{libraryId}`。
`graph_vault/catalog/**` 被限定为 projection、capability、默认 scope、路由索引
和观测状态，不拥有上层包闭包，也不能证明 query-ready。

Type DD 明确要求显式 `--bookshelf-id` 与 `--library-id` 查询先校验
package-local `CURRENT.json`、manifest、`PUBLISH_READY.json`、quality gate 和
checksum sidecar；无 catalog projection 的显式上层包查询允许执行；只有 legacy
catalog-only 上层产物而缺失 package root 时必须 fail closed，并返回
`upper_package_migration_required`。该设计满足本轮 package-root 重点审计要求。

## blockingFindings

无。

## requiredDesignChanges

无。

## D01-D10 分项

### D01_authority_boundaries

- title: 权威边界与热插包隔离
- riskQuestion: 设计是否保持单书包 `BOOK_MANIFEST.json` 作为唯一包权威，并把
  书架与 library 索引限定为可重建派生物。
- passCriteria:
  - 单书包 query_ready 不依赖书架或 library 索引。
  - 书架/library 不写入单书包文件闭包。
  - catalog 派生索引损坏不会改变单书包挂载状态。
- result: PASS
- evidence: `hardInvariants.book_package_authority_preserved`、`derived_upper_indexes_only`
  和 `upper_package_authority_roots` 保持单书包权威独立，并要求 bookshelf 与
  library 包闭包位于各自 package root。`catalog_projection_only` 和
  `compatibilityWithHotplugPackages` 明确 catalog 可删除重建，且不会改变单书包
  query-ready 或挂载状态。

### D02_fixed_query_budget

- title: 固定查询预算
- riskQuestion: 设计是否保证交互查询的 LLM 调用数、token 输入、候选语义单元数和
  下钻书本数不随书籍数量线性增长。
- passCriteria:
  - 查询阶段使用固定 top-K 或明确预算参数。
  - 禁止查询时全量扫描所有单书 community_reports。
  - 超预算时有 fail-closed 或收窄 scope 机制。
- result: PASS
- evidence: `queryContract.interactiveBudget` 定义 `maxSemanticUnits`、
  `maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、固定 LLM
  调用数和 token 上限。`routing.noImplicitFullVaultScan` 与
  `scoped_query_execution.forbiddenInputs` 禁止交互路径全量扫描或隐式构建。
  超预算错误码为 `budget_exceeded_narrow_scope_required`。

### D03_graphrag_semantic_alignment

- title: GraphRAG 语义对齐
- riskQuestion: 设计是否贴近 GraphRAG 的 community report、entity、relationship
  和 map-reduce 查询原理，而不是退化为普通摘要检索。
- passCriteria:
  - 上层索引输入包含 community reports。
  - 设计保留 entity/relationship 或等价语义关系。
  - 上层综合回答基于预计算社区报告或语义单元。
- result: PASS
- evidence: `hierarchyModel` 和 `upperGraphArtifactSchemas` 要求 bookshelf/library
  读取下层 `community_reports`、`entities`、`relationships`，并输出
  `semantic_units`、`semantic_edges` 与 `community_reports`。
  `semanticEdges.allowedRelationTypes` 保留共享实体、源关系、主题共聚类和父子社区关系。
  `queryContract.retrieval` 要求查询基于上层预计算语义单元和社区报告。

### D04_evidence_traceability

- title: 证据可追溯
- riskQuestion: 设计是否能把书架/library 回答追溯到 `bookId`、`sourceId`、
  `documentId`、`contentHash`、community report 或 `text_unit`。
- passCriteria:
  - 定义 evidence_map 或等价结构。
  - 每个上层语义单元有下层证据引用。
  - 回答输出能暴露或摘要 evidence lineage。
- result: PASS
- evidence: `upperGraphArtifactSchemas.evidenceMap.requiredColumns` 覆盖
  `targetBookId`、`targetSourceId`、`targetDocumentId`、`targetContentHash`、
  `targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。
  bookshelf/library 质量门分别要求 evidence map 链接上层单元到成员证据或
  shelf/book 证据。`scoped_query_execution.emittedOutputs` 要求输出 evidence
  lineage。

### D05_state_recovery

- title: 状态闭环与恢复
- riskQuestion: 设计是否覆盖构建阶段中断、失败、恢复、stale 检测和 partial
  publish 防护。
- passCriteria:
  - 有 durable checkpoints/events/status。
  - partial build 不会发布 query-ready 上层索引。
  - 成员变更会标记 stale 或生成新 generation。
- result: PASS
- evidence: `stateAndRecovery` 定义 package-local `runs/{runId}`、events、
  checkpoints、status 和 recovery summary。`publishProtocol` 使用 staging、
  quality gate、原子提升到 `generations/{generationId}`、更新 `CURRENT.json`、
  最后写入 `PUBLISH_READY.json`。`stateClosure` 和 handoff/reject 条款覆盖
  failed、running、pending、stale 和 partial publish 防护。

### D06_quality_gates

- title: 质量门
- riskQuestion: 设计是否为书架和 library 定义独立质量门，并覆盖 schema、
  checksum、成员一致性、敏感信息和固定预算模拟。
- passCriteria:
  - 书架质量门存在且有 requiredChecks。
  - library 质量门存在且有 requiredChecks。
  - 质量门失败时查询不可用且诊断可见。
- result: PASS
- evidence: `qualityGates.bookshelfGate` 与 `qualityGates.libraryGate` 均有
  package-root 路径、checkIds 和 requiredChecks，覆盖 manifest/checksum、成员
  sha256、一致性、语义 schema、evidence、固定预算模拟、敏感扫描和 stale marker。
  `qualityGates.failureDiagnostics` 与 typed error `upper_quality_gate_failed` 定义了
  查询失败和诊断输出。

### D07_incremental_scaling

- title: 增量扩展
- riskQuestion: 设计是否允许构建成本随规模增长，同时支持增量刷新，避免每次变更都
  必须重建全库。
- passCriteria:
  - 记录成员 manifest sha256 和 generation。
  - 定义增量刷新或保守全量重建条件。
  - 大库通过书架分层限制重建影响范围。
- result: PASS
- evidence: bookshelf 和 library 的 `generationRule` 都把成员集合、成员 manifest
  sha256、builder 版本和配置纳入 generation 变更条件。bookshelf 与 library
  `incrementalRefresh.rule` 均允许 checksum 可证明时局部重建，否则标记 stale 或
  全量生成新 generation。`libraryContract.scaleLimits` 和虚拟书架规则要求大库通过
  物化书架、虚拟父级或分区控制规模。

### D08_security_privacy

- title: 安全与隐私
- riskQuestion: 设计是否禁止 provider payload、密钥、原始 prompt/completion、绝对
  路径和 query.log 进入可发布上层 manifest 或索引。
- passCriteria:
  - 定义 forbiddenInputs 或 sensitivityPolicy。
  - 质量门包含敏感信息扫描。
  - 诊断和 manifest 使用脱敏摘要或 digest。
- result: PASS
- evidence: `hardInvariants.no_sensitive_payload_export`、各构建阶段
  `forbiddenInputs`、`stateAndRecovery.diagnosticRedactionPolicy` 和 manifest
  `sensitivityPolicy` 要求禁止 provider payload、raw prompt、raw completion、
  credential、绝对路径与 query log。bookshelf/library 质量门均包含
  `sensitive_payload_scan_passed`，诊断字段限定为 digest、schema id、bounded
  summary 和 redacted locator。

### D09_cli_operability

- title: CLI 可操作性与降级
- riskQuestion: 设计是否说明无 scope、有 scope、stale、缺索引、超预算等场景的
  CLI 行为，避免长时间无输出。
- passCriteria:
  - 定义 scope resolution order。
  - stale 或 ambiguity 有快速 typed error。
  - 查询 timing/cost 观测可分解到层级阶段。
- result: PASS
- evidence: `queryContract.routing.scopeResolutionOrder` 定义显式 book、
  bookshelf、library、默认 library 和快速 ambiguity error 的解析顺序。
  `typedErrors` 和 `cliBehaviorMatrix` 覆盖 `missing_scope`、`ambiguous_scope`、
  `upper_index_missing`、`upper_package_migration_required`、`upper_index_stale`、
  `upper_quality_gate_failed` 与超预算。各错误场景包含 timing fields，输出合同要求
  bounded timing breakdown。

### D10_testability

- title: 可测试性
- riskQuestion: 设计是否提供足够测试合同，覆盖正确性、成本边界、恢复、证据、
  安全和热插兼容。
- passCriteria:
  - 至少定义 8 个必测案例。
  - 测试包含不同规模库的固定预算验证。
  - 测试包含单书 hotplug 非回归。
- result: PASS
- evidence: 顶层 `testContracts.requiredCases` 和 `pipelineIoContract.testContracts`
  均定义超过 8 个必测案例，覆盖复制上层包、无 catalog projection 显式查询、
  legacy catalog-only fail closed、固定预算规模模拟、stale、missing、质量门、
  evidence lineage、敏感扫描、partial publish 恢复和单书查询非回归。

## residualNotes

- 本报告仅做设计审计，不评价实现是否完成或是否已通过真实外部 provider 端到端验证。
- Type DD 将 catalog projection generation、LLM synthesis、bounded deepening 和
  library 管理命令标记为 remaining/future 能力，没有把这些能力错误声明为全部完成。
- package-root 设计与本轮重点要求一致：上层包闭包不写入
  `graph_vault/catalog/**`，删除 catalog projection 不应影响显式上层包查询，
  legacy catalog-only 上层产物必须以 `upper_package_migration_required` fail closed。
