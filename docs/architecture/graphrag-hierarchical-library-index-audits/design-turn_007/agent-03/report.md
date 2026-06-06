# design-turn_007 agent-03 设计接地性复审报告

overallStatus: pass

## 审计范围

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计设计集：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-grounding-review.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/final-summary.md`

本轮按固定 D01-D10 维度复审，重点检查三类风险反例：

- 实现者误以为 bookshelf/library 已实现。
- `catalog/batch-runs`、`runs`、`events.jsonl` 被误用为语义输入
  (semantic input)。
- 用户复制单书包后尚无上层索引时，单书仍可查，上层查询 fail closed。

## 总体结论

设计集通过本轮接地性复审。四份文档共同形成了明确边界：当前已接地能力
限于单书 hotplug package、包内 qmd/GraphRAG 产物、catalog projection 和
单书 `--graph-book-id` 查询；bookshelf/library 的 manifest、builder、上层
semantic artifacts、质量门、CLI scope 和 typed errors 均被标为新能力
(new capability)，不得视为已实现。

未发现 fail 项。必须修订位置：无。

## 风险反例复审

### R01 bookshelf/library 已实现误读

status: pass

依据：

- 主设计 `implementationGrounding` 明确把现有基础限定为单书包发布、包内
  qmd index、包内 GraphRAG output、catalog 投影和单书 GraphRAG 查询。
- 同一节 `newCapabilities` 明确列出 `BOOKSHELF_MANIFEST`、
  `LIBRARY_MANIFEST`、bookshelf/library semantic artifacts、质量门、
  `--bookshelf-id`、`--library-id`、`qmd library` 命令和 `upper_index_*`
  typed errors 仍需新增实现。
- pipeline I/O 的 `currentImplementationStatus` 将 `alreadySupported` 限定为
  book package、book mount projection 和单书 scoped query，将
  materialized bookshelf build、library membership、library graph build 和
  bookshelf/library scoped query 标为 `newCapabilities`。
- 接地性审计文档的 `summary.highestRisk` 和 `groundingMatrix` 直接声明当前
  代码没有 `BOOKSHELF_MANIFEST`、`LIBRARY_MANIFEST`、upper semantic unit
  index 或 bookshelf/library CLI scope。
- final summary 已记录主设计和 pipeline I/O 对 implementation grounding 的
  补强，要求后续实现从独立 upper-index 模块开始。

结论：文档足以阻断“书架/library 已经实现”的误读。

### R02 catalog/batch-runs 被误用为语义输入

status: pass

依据：

- pipeline I/O `hardInvariants.no_runner_ledger_as_semantic_input` 明确禁止
  `graph_vault/catalog/batch-runs/**`、`runs/**`、`events.jsonl` 和 recovery
  summaries 作为语义检索、成员推断或 GraphRAG 社区生成的内容输入。
- `book_mount_projection` 禁止将 batch-runs ledger 当作 package readiness
  proof。
- `bookshelf_membership_resolution` 禁止将 runner ledger events 当作
  classification evidence。
- `library_graph_build` 禁止将 batch-runs ledger 作为 semantic input。
- 主设计 `implementationRule` 重申不得把 runner ledger 当作语义输入。
- 接地性审计文档将 `risk_catalog_ledger_confusion` 列为风险，并要求 upper
  builder tests 覆盖 batch-runs 污染反例。

结论：设计已明确禁止 catalog/batch-runs 作为语义输入，并在阶段合同与测试
方向中保留阻断点。

### R03 单书包已复制但尚无上层索引

status: pass

依据：

- 主设计 `book_package_authority_preserved` 和 `derived_upper_indexes_only`
  要求单书 query_ready 不受书架/library 缺失、损坏或过期影响。
- pipeline I/O `package_first_authority` 与 `catalog_is_derivative` 明确
  catalog 派生状态不得改变单书身份、文件闭包或直接单书查询的
  query_ready 判定。
- `compatibilityWithHotplugPackages` 规定安装或删除单书包不会自动改写 ready
  bookshelf/library generation，直接单书查询仍由 book package gate 管辖。
- `queryContract.typedErrors` 与 `cliBehaviorMatrix` 要求上层索引缺失时返回
  `upper_index_missing`，并禁止查询路径隐式 rebuild。
- pipeline I/O `scoped_query_execution` 禁止 missing upper index auto-build、
  stale scope 和 interactive exhaustive all-books scan。
- 主设计和 pipeline I/O 测试合同均包含删除 catalog 上层索引后单书查询不
  回归、缺失上层索引返回 typed error 且不重建的案例。

结论：单书可查性与上层 fail closed 行为均被设计约束和测试合同覆盖。

## D01_authority_boundaries

status: pass

依据：

- 单书权威被固定在 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内
  qmd/GraphRAG/state 产物和包内质量门。
- 书架与 library 权威根均位于 `graph_vault/catalog/**`，并被定义为可重建
  派生物。
- 主设计和 pipeline I/O 均排除将书架/library 索引写回单书可复制包闭包。
- catalog 派生状态损坏、缺失或 stale 时，只影响上层查询，不改变单书
  `query_ready`。

判定：满足单书包 query_ready 不依赖上层索引、上层索引不写入单书闭包、
catalog 损坏不改变单书挂载状态的基准。

## D02_fixed_query_budget

status: pass

依据：

- `fixedQueryBudget` 定义最大 LLM 调用数、最大 token、最大候选语义单元、
  最大下钻书本数和最大执行时间。
- `queryContract.interactiveBudget` 给出默认上限，包括 `maxSemanticUnits: 32`、
  `maxBookshelves: 4`、`maxBooksForDeepening: 3` 和固定 LLM call cap。
- 查询合同禁止交互路径全量扫描所有单书或书架，要求先从上层预计算
  semantic units 召回固定数量候选。
- 超预算时返回 `budget_exceeded_narrow_scope_required` 或要求收窄 scope。

判定：查询阶段预算不随书籍数量线性增长，并具备 fail-closed 预算错误。

## D03_graphrag_semantic_alignment

status: pass

依据：

- bookshelf build 输入包含成员书 `community_reports.parquet`、entities、
  relationships 和 text_units 的受限使用。
- library build 输入包含 bookshelf semantic units、semantic edges、
  community reports 和 evidence map。
- `semanticEdges` schema 保留 relation type、方向、权重、entity title、
  relationship id 和 evidence map 引用。
- build algorithm 明确从 community reports 提取 semantic units、派生
  semantic edges、聚类并生成上层 community reports。

判定：设计保留 GraphRAG community report、entity、relationship 和
map-reduce 或等价综合结构，未退化为普通摘要检索。

## D04_evidence_traceability

status: pass

依据：

- `upperGraphArtifactSchemas.evidenceMap` 定义 `evidence_map.parquet`，字段
  覆盖 bookId、sourceId、documentId、contentHash、community report 和
  text_unit。
- evidence map 规则要求每个上层 semantic unit、semantic edge、community
  和 community report 至少有下层证据引用，纯 membership marker 除外。
- 查询输出要求包含 evidence lineage，并只引用已发布产物。
- quality gates 要求 evidence map links every upper unit to member evidence。

判定：上层回答可追溯到单书和下层 GraphRAG/qmd 证据。

## D05_state_recovery

status: pass

依据：

- `stateAndRecovery` 定义 runs、events、checkpoints、status 和
  recovery-summary 等 durable state。
- publish protocol 要求先写 staging，完成校验、checksum、质量门和诊断后
  原子提升 current generation，publish marker 最后写入。
- pipeline I/O 每个阶段定义 `stateWrites`、`failureOutputs` 和
  `handoffMatrix`，阻断 running、failed、stale 和 staging 产物进入下游。
- 成员 manifest digest 变化会标记 stale 或生成新 generation。

判定：中断、失败、恢复、stale 检测和 partial publish 防护均有闭环。

## D06_quality_gates

status: pass

依据：

- 主设计定义独立 `bookshelfGate` 与 `libraryGate`，均包含 schema、checksum、
  成员 digest、成员 gate、semantic artifacts、evidence map、embedding 元数据、
  固定预算模拟、敏感扫描和 stale marker 检查。
- membership checks 定义稳定 check id，覆盖用户 lock、authority order、LLM
  suggestion 不可 query-ready、接受记录、超大类拆分和虚拟父书架不直接索引。
- pipeline I/O 各阶段质量门定义 ready state、required checks 和失败产物。
- 质量门失败时通过 `upper_quality_gate_failed` 和 bounded diagnostics 暴露。

判定：书架和 library 均有独立质量门，失败时查询不可用且诊断可见。

## D07_incremental_scaling

status: pass

依据：

- bookshelf 和 library generation 规则记录成员 manifest sha256、
  packageGeneration、builder version、embedding model fingerprint、聚类配置、
  summary 配置和 evidence schema。
- bookshelf incremental refresh 允许在 checksum 证明未变时只重建受影响的
  semantic units 和 derived communities，否则重建 shelf generation。
- library incremental refresh 允许按 shelf manifest sha256 定位受影响单元；
  无法局部化 graph connectivity 变化时标记 stale 并创建 full generation。
- 大库通过 materialized shelves、virtual parents、directBookLimit 和 partition
  policy 限制单次重建影响范围。

判定：构建成本可随规模增长，但支持增量刷新和保守全量重建条件。

## D08_security_privacy

status: pass

依据：

- 主设计 `no_sensitive_payload_export` 和 pipeline I/O `redacted_diagnostics_only`
  禁止 provider payload、raw prompt、raw completion、credential、绝对路径和
  query log 进入 manifest、索引、质量门或诊断。
- build forbidden inputs 明确排除 provider request/response payloads、query
  logs、local absolute paths 和未验证损坏包。
- 质量门包含 sensitive payload scan。
- diagnostics 和 manifest 只能记录 digest、schema id、bounded summary、check
  id 和 redacted locator。

判定：敏感输入、诊断和 manifest 脱敏边界明确。

## D09_cli_operability

status: pass

依据：

- `queryContract.routing.scopeResolutionOrder` 定义 explicit bookId、
  explicit bookshelfId、explicit libraryId、configured default library 和快速
  ambiguity error 的解析顺序。
- `typedErrors` 定义 `missing_scope`、`ambiguous_scope`、`upper_index_missing`、
  `upper_index_stale`、`upper_quality_gate_failed`、
  `budget_exceeded_narrow_scope_required` 和 `upper_index_runtime_error`。
- `cliBehaviorMatrix` 覆盖无 scope、scope ambiguous、缺索引、stale、质量门
  失败和超预算，并定义 fallback 与 timing fields。
- 查询 timing/cost 可分解为 scope resolution、upper index validation、
  retrieval、budget、synthesis、optional deepening 和 evidence merge。

判定：CLI 行为可操作，异常快速 typed error，不依赖长时间无输出的全库扫描。

## D10_testability

status: pass

依据：

- 主设计 `testContracts.requiredCases` 超过 8 项，覆盖单书 hotplug 非回归、
  固定预算、stale、缺索引、证据、敏感扫描、恢复、虚拟书架和 exhaustive
  report 分离。
- pipeline I/O `testContracts.requiredCases` 覆盖未发布包、缺 qmd index、
  membership lock、LLM suggestion、超大类拆分、virtual parent、上层缺失、
  typed error 对齐和删除 catalog 上层索引不破坏单书查询。
- final summary 记录第六轮已确认多类故障反例 fail closed。
- 接地性审计文档要求实现前增加 schema validators、fixtures、typed error
  mapping 和单书查询 survives deleted upper catalog 的测试。

判定：测试合同覆盖正确性、成本边界、恢复、证据、安全和热插兼容。

## 复审结果

overallStatus: pass

D01-D10 全项通过。未发现必须修订项。
