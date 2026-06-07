# design-turn_013 agent-1 设计审计报告

overallStatus: PASS

## auditedFiles

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

## baseline

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- baselineStatus: fixed_baseline
- baselineUsage: 已按固定 D01-D10 逐项审计，未修改基准。

## summary

Type DD 当前设计满足 package-root 上层包合同（upper package contract）：
bookshelf 权威根为 `graph_vault/bookshelves/{bookshelfId}`，library 权威根为
`graph_vault/library/{libraryId}`。`graph_vault/catalog/**` 被限定为
projection、capability、默认 scope、路由索引和 observability state，不拥有
bookshelf/library 包闭包，也不得证明上层 scope query-ready。

legacy catalog-only upper artifacts 的查询路径被设计为 fail closed，并返回
`upper_package_migration_required`。Type DD 同时把 catalog projection 生成、
LLM synthesis、bounded deepening 和 library 管理命令列为 remaining/future
capabilities，没有把未完成实施错误声明为已完成。因此本轮没有设计级阻断项。

## blockingFindings

无。

## D01-D10 分项

### D01_authority_boundaries: 权威边界与热插包隔离

- riskQuestion: 设计是否保持单书包 `BOOK_MANIFEST.json` 作为唯一包权威，
  并把书架与 library 索引限定为可重建派生物。
- status: PASS
- passCriteriaAssessment: 单书包 query-ready 不依赖 bookshelf/library；
  bookshelf/library 不写入单书包闭包；catalog 派生状态损坏不改变单书挂载。
- judgment: Type DD 明确单书包权威来自 `graph_vault/books/{bookId}` 的
  manifest、publish marker、包内 qmd/GraphRAG 产物和质量门。上层包权威根
  分别迁移到 `graph_vault/bookshelves/{bookshelfId}` 与
  `graph_vault/library/{libraryId}`，且 catalog 只保留派生视图。

### D02_fixed_query_budget: 固定查询预算

- riskQuestion: 设计是否保证交互查询的 LLM 调用数、token 输入、候选语义
  单元数和下钻书本数不随书籍数量线性增长。
- status: PASS
- passCriteriaAssessment: 查询阶段定义固定 top-K 和预算参数；禁止查询时
  全量扫描所有单书 `community_reports`；超预算返回 fail-closed typed error。
- judgment: `queryContract.interactiveBudget` 规定 `maxSemanticUnits`、
  `maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、
  `maxLlmCalls` 和 token 上限；`budget_exceeded_narrow_scope_required`
  覆盖预算越界。

### D03_graphrag_semantic_alignment: GraphRAG 语义对齐

- riskQuestion: 设计是否贴近 GraphRAG 的 community report、entity、
  relationship 和 map-reduce 查询原理，而不是退化为普通摘要检索。
- status: PASS
- passCriteriaAssessment: 上层索引输入包含 community reports；保留
  entity/relationship 或等价语义关系；综合回答基于预计算社区报告或语义单元。
- judgment: bookshelf/library build 均消费下层 `community_reports`、
  `entities`、`relationships` 和 `semantic_edges`；上层产物包含
  `semantic_units`、`semantic_edges`、`communities` 与 `community_reports`。

### D04_evidence_traceability: 证据可追溯

- riskQuestion: 设计是否能把书架/library 回答追溯到 `bookId`、`sourceId`、
  `documentId`、`contentHash`、community report 或 `text_unit`。
- status: PASS
- passCriteriaAssessment: 定义 `evidence_map`；每个上层语义单元有下层证据；
  回答输出能暴露或摘要 evidence lineage。
- judgment: `upperGraphArtifactSchemas.evidenceMap` 要求记录 owner、target、
  `targetBookId`、`targetSourceId`、`targetDocumentId`、`targetContentHash`、
  `targetCommunityReportId`、`targetTextUnitId` 和 artifact digest。质量门要求
  evidence map 链接到 shelf 与 book 证据。

### D05_state_recovery: 状态闭环与恢复

- riskQuestion: 设计是否覆盖构建阶段中断、失败、恢复、stale 检测和
  partial publish 防护。
- status: PASS
- passCriteriaAssessment: 定义 durable checkpoints/events/status；partial
  build 不会发布 query-ready；成员变更会标记 stale 或生成新 generation。
- judgment: publish protocol 采用 package-local staging、quality gate、
  atomic promotion、`CURRENT.json`、`PUBLISH_READY.json` 顺序；staging、
  failed、running、pending 和 stale 产物不得作为 ready 输入。

### D06_quality_gates: 质量门

- riskQuestion: 设计是否为书架和 library 定义独立质量门，并覆盖 schema、
  checksum、成员一致性、敏感信息和固定预算模拟。
- status: PASS
- passCriteriaAssessment: bookshelf gate 与 library gate 均存在并包含
  requiredChecks；质量门失败时查询不可用且诊断可见。
- judgment: `qualityGates.bookshelfGate` 与 `qualityGates.libraryGate` 覆盖
  schema、checksum sidecar、成员 manifest sha256、一致性、evidence lineage、
  embedding fingerprint、固定预算模拟、敏感扫描和 stale marker。

### D07_incremental_scaling: 增量扩展

- riskQuestion: 设计是否允许构建成本随规模增长，同时支持增量刷新，避免
  每次变更都必须重建全库。
- status: PASS
- passCriteriaAssessment: 记录成员 manifest sha256 和 generation；定义增量
  刷新或保守全量重建条件；大库通过书架分层限制重建影响范围。
- judgment: bookshelf 与 library generation rule 均绑定成员 manifest sha256、
  package generation、builder/config/schema 指纹；当无法证明局部影响时允许
  保守新 generation 重建。library 通过 materialized shelves、virtual parents
  和 partition policy 控制影响范围。

### D08_security_privacy: 安全与隐私

- riskQuestion: 设计是否禁止 provider payload、密钥、原始 prompt/completion、
  绝对路径和 query.log 进入可发布上层 manifest 或索引。
- status: PASS
- passCriteriaAssessment: 定义 forbidden inputs 与 sensitivity/redaction
  policy；质量门包含敏感信息扫描；诊断和 manifest 使用脱敏摘要或 digest。
- judgment: Type DD 在 build inputs、pipeline forbidden inputs、diagnostic
  redaction policy 和 quality gates 中禁止 provider payload、raw prompt、
  raw completion、credential、absolute local path 与 query log content。

### D09_cli_operability: CLI 可操作性与降级

- riskQuestion: 设计是否说明无 scope、有 scope、stale、缺索引、超预算等
  场景的 CLI 行为，避免长时间无输出。
- status: PASS
- passCriteriaAssessment: 定义 scope resolution order；stale 或 ambiguity
  有快速 typed error；query timing/cost 可分解到层级阶段。
- judgment: `queryContract.routing` 给出 explicit book、bookshelf、library、
  default library、ambiguity error 的解析顺序。typed errors 覆盖 missing、
  ambiguous、missing upper index、migration required、stale、quality gate
  failed、over budget 和 runtime error。

### D10_testability: 可测试性

- riskQuestion: 设计是否提供足够测试合同，覆盖正确性、成本边界、恢复、
  证据、安全和热插兼容。
- status: PASS
- passCriteriaAssessment: 测试合同超过 8 个必测案例；包含不同规模 library 的
  固定预算验证；包含单书 hotplug 非回归。
- judgment: `testContracts.requiredCases` 覆盖 package-root copy/query、删除
  catalog projection 后显式上层查询、legacy catalog-only fail closed、单书查询
  非回归、成员权威、stale、预算越界、evidence map、安全扫描和中断恢复。

## residualNotes

- 若 design-turn_013 被采纳为最新设计审计轮次，主控汇总阶段应更新 Type DD
  的 `designAudit.currentRunDirectory` 与最终汇总报告。该事项属于审计记录
  管理，不构成当前 Type DD 设计合同失败。
- catalog projection generation、LLM synthesis、bounded deepening 与 library
  management commands 被 Type DD 正确标注为 remaining/future capabilities。
  本轮未将这些实施未完成项判为设计 FAIL。
- 本报告仅为设计审计，不评价当前代码实现是否完全覆盖 Type DD。
