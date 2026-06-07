# design-turn_013 agent-3 设计审计报告

## overallStatus

PASS

## auditedFiles

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

## baseline

- baseline:
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- schemaVersion: `1.0.0`
- status: `fixed_baseline`
- dimensions: D01-D10
- baselinePolicy: 本轮审计未修改、未重排、未扩展固定基准。

## summary

本轮仅执行设计审计，不评估实现完成度。Type DD 已把 bookshelf 与
library 明确定义为可复制传播的上层包，权威根分别为
`graph_vault/bookshelves/{bookshelfId}` 与
`graph_vault/library/{libraryId}`。`graph_vault/catalog/**` 被限定为
projection、capability、默认 scope、路由索引和观测状态，不拥有上层包
闭包，也不能证明 query-ready。

设计保留单书包权威边界，要求显式 `--bookshelf-id` 与 `--library-id`
查询先校验 package-local `CURRENT.json`、manifest、`PUBLISH_READY.json`、
quality gate 和 checksum sidecar。仅存在 legacy catalog-only upper
artifacts 且缺少 package root 时，查询必须 fail closed，并返回
`upper_package_migration_required`。

Type DD 将 catalog projection 生成、LLM synthesis、controlled deepening
和 library 管理命令列为 remaining/future 能力，没有把这些未完成能力错误
声明为设计已完成的 query-ready 条件。因此未发现阻断 D01-D10 的设计缺陷。

## blockingFindings

无。

## requiredDesignChanges

无。

## D01-D10 分项

### D01_authority_boundaries - 权威边界与热插包隔离

- result: PASS
- riskQuestion: 设计是否保持单书包 BOOK_MANIFEST.json 作为唯一包权威，并把
  书架与 library 索引限定为可重建派生物。
- assessment: Type DD 明确单书包权威只能来自
  `graph_vault/books/{bookId}` 内的 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
  包内 qmd/GraphRAG/state 产物和质量门。bookshelf/library 上层包使用独立
  package root，不写回单书包文件闭包。catalog projection 损坏或删除不得改变
  单书包挂载与 query-ready 判定。
- passCriteria:
  - 单书包 query_ready 不依赖书架或 library 索引：满足。
  - 书架/library 不写入单书包文件闭包：满足。
  - catalog 派生索引损坏不会改变单书包挂载状态：满足。

### D02_fixed_query_budget - 固定查询预算

- result: PASS
- riskQuestion: 设计是否保证交互查询的 LLM 调用数、token 输入、候选语义
  单元数和下钻书本数不随书籍数量线性增长。
- assessment: `queryContract.interactiveBudget` 定义固定
  `maxSemanticUnits`、`maxBookshelves`、`maxBooksForDeepening`、
  `maxMemberCommunityRefs`、LLM call cap 和 token 上限。交互查询禁止全量扫描
  所有单书 community reports，超预算返回
  `budget_exceeded_narrow_scope_required` 或要求收窄 scope。
- passCriteria:
  - 查询阶段使用固定 top-K 或明确预算参数：满足。
  - 禁止查询时全量扫描所有单书 community_reports：满足。
  - 超预算时有 fail-closed 或收窄 scope 机制：满足。

### D03_graphrag_semantic_alignment - GraphRAG 语义对齐

- result: PASS
- riskQuestion: 设计是否贴近 GraphRAG 的 community report、entity、
  relationship 和 map-reduce 查询原理，而不是退化为普通摘要检索。
- assessment: 上层构建输入包含成员书或成员书架的 community reports、
  entities、relationships 和 text_units 的受限使用。设计定义
  `semantic_units.parquet`、`semantic_edges.parquet`、`community_reports.parquet`
  和 `evidence_map.parquet`，并要求保留 relationType、entity/relationship
  evidence 和 generation 信息。上层回答基于预计算 community reports 或语义
  单元。
- passCriteria:
  - 上层索引输入包含 community reports：满足。
  - 设计保留 entity/relationship 或等价语义关系：满足。
  - 上层综合回答基于预计算社区报告或语义单元：满足。

### D04_evidence_traceability - 证据可追溯

- result: PASS
- riskQuestion: 设计是否能把书架/library 回答追溯到 bookId、sourceId、
  documentId、contentHash、community report 或 text_unit。
- assessment: `upperGraphArtifactSchemas.evidenceMap` 定义
  `targetBookId`、`targetBookshelfId`、`targetSourceId`、`targetDocumentId`、
  `targetContentHash`、`targetCommunityReportId`、`targetTextUnitId` 和
  `targetArtifactDigest`。查询输出要求返回 evidence lineage，质量门要求每个
  上层 answerable artifact 有下层证据引用。
- passCriteria:
  - 定义 evidence_map 或等价结构：满足。
  - 每个上层语义单元有下层证据引用：满足。
  - 回答输出能暴露或摘要 evidence lineage：满足。

### D05_state_recovery - 状态闭环与恢复

- result: PASS
- riskQuestion: 设计是否覆盖构建阶段中断、失败、恢复、stale 检测和
  partial publish 防护。
- assessment: Type DD 定义 package-local `runs/{runId}`、events、
  checkpoints、recovery-summary、staging、generations、`CURRENT.json` 和
  `PUBLISH_READY.json`。发布协议要求 staging 通过 schema、checksum、质量门
  后才原子提升。running、pending、failed、stale 产物不得被下游当作 ready。
  成员 manifest sha256 或 generation 变化会标记 stale 或生成新 generation。
- passCriteria:
  - 有 durable checkpoints/events/status：满足。
  - partial build 不会发布 query-ready 上层索引：满足。
  - 成员变更会标记 stale 或生成新 generation：满足。

### D06_quality_gates - 质量门

- result: PASS
- riskQuestion: 设计是否为书架和 library 定义独立质量门，并覆盖 schema、
  checksum、成员一致性、敏感信息和固定预算模拟。
- assessment: `qualityGates.bookshelfGate` 与 `qualityGates.libraryGate`
  均定义 package-local 路径、checkIds 和 requiredChecks。检查项覆盖 manifest
  schema、checksum sidecar、成员 manifest sha256、一致性、semantic schema、
  evidence lineage、embedding fingerprint、fixed budget simulation、敏感扫描和
  stale marker。质量门失败映射到 `upper_quality_gate_failed`，诊断为
  machine-readable 且 bounded。
- passCriteria:
  - 书架质量门存在且有 requiredChecks：满足。
  - library 质量门存在且有 requiredChecks：满足。
  - 质量门失败时查询不可用且诊断可见：满足。

### D07_incremental_scaling - 增量扩展

- result: PASS
- riskQuestion: 设计是否允许构建成本随规模增长，同时支持增量刷新，避免每次
  变更都必须重建全库。
- assessment: bookshelf 与 library generationRule 均包含成员集合、成员
  manifest sha256、builder version、模型 fingerprint、聚类配置、摘要配置和
  evidence schema。设计允许在 checksum 可证明不变时局部刷新，无法定位影响时
  保守重建当前 generation。大库通过 materialized shelves、virtual parents、
  partition plan 和 scale limits 限制重建范围。
- passCriteria:
  - 记录成员 manifest sha256 和 generation：满足。
  - 定义增量刷新或保守全量重建条件：满足。
  - 大库通过书架分层限制重建影响范围：满足。

### D08_security_privacy - 安全与隐私

- result: PASS
- riskQuestion: 设计是否禁止 provider payload、密钥、原始 prompt/completion、
  绝对路径和 query.log 进入可发布上层 manifest 或索引。
- assessment: bookshelf build inputs、pipeline hard invariants、
  diagnosticRedactionPolicy 和 sensitivityPolicy 均禁止 provider payload、raw
  prompt、raw completion、credentials、absolute local paths 和 query logs 进入
  可发布上层产物。质量门包含 `sensitive_payload_scan_passed`，诊断只允许
  digest、check id、bounded summary 和 redacted locator。
- passCriteria:
  - 定义 forbiddenInputs 或 sensitivityPolicy：满足。
  - 质量门包含敏感信息扫描：满足。
  - 诊断和 manifest 使用脱敏摘要或 digest：满足。

### D09_cli_operability - CLI 可操作性与降级

- result: PASS
- riskQuestion: 设计是否说明无 scope、有 scope、stale、缺索引、超预算等
  场景的 CLI 行为，避免长时间无输出。
- assessment: `queryContract.routing.scopeResolutionOrder` 覆盖 explicit
  book、bookshelf、library、default library 和 ambiguity error。typedErrors
  定义 `missing_scope`、`ambiguous_scope`、`upper_index_missing`、
  `upper_package_migration_required`、`upper_index_stale`、
  `upper_quality_gate_failed` 和预算错误。cliBehaviorMatrix 定义每类场景的
  outcome、fallbackAllowed 和 timingFields；显式上层 scope 必须先读
  package root，catalog projection 只能辅助发现。
- passCriteria:
  - 定义 scope resolution order：满足。
  - stale 或 ambiguity 有快速 typed error：满足。
  - 查询 timing/cost 观测可分解到层级阶段：满足。

### D10_testability - 可测试性

- result: PASS
- riskQuestion: 设计是否提供足够测试合同，覆盖正确性、成本边界、恢复、证据、
  安全和热插兼容。
- assessment: Type DD 在主 `testContracts` 与 `pipelineIoContract.testContracts`
  中列出超过 8 个必测案例，覆盖复制传播、无 catalog projection 显式查询、
  legacy catalog-only fail closed、单书 hotplug 非回归、成员权威、虚拟书架、
  不同规模 library 固定预算、stale、missing index、证据回链、安全扫描、
  interrupted build 和 timing。
- passCriteria:
  - 至少定义 8 个必测案例：满足。
  - 测试包含不同规模库的固定预算验证：满足。
  - 测试包含单书 hotplug 非回归：满足。

## residualNotes

- Type DD 当前状态为 `design_audit_passed`，并记录 design-turn_012 三代理通过。
  本轮 agent-3 复审未发现需要回退该状态的设计问题。
- 实现侧仍可存在 `PASS_WITH_RISK` 或 future capability 风险，但本轮审计边界
  是设计合同。Type DD 已把 catalog projection generation、LLM synthesis、
  controlled deepening、library management commands 和真实外部 provider 验证
  标为 remaining/future 或实现风险，未把它们误写成完整设计通过条件。
- package-root 设计满足本轮重点：bookshelf 包根为
  `graph_vault/bookshelves/{bookshelfId}/`，library 包根为
  `graph_vault/library/{libraryId}/`，catalog 仅为 projection/routing/
  observability，legacy catalog-only upper artifacts 必须以
  `upper_package_migration_required` fail closed。
