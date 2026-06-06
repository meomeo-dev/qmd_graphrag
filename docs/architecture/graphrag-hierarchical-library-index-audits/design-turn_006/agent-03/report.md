# design-turn_006 agent-03 设计复审报告

overallStatus: pass

## 审计范围

- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 主设计：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- Pipeline I/O 合同：
  `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`
- 最终摘要：
  `docs/architecture/graphrag-hierarchical-library-index-audits/reports/final-summary.md`

本轮按固定 D01-D10 逐项复审。重点采用反例确认：单书包复制、qmd index
缺失、GraphRAG 中断、LLM suggestion 未接受、超大分类拆分、虚拟父书架、
library direct book 超限、删除 catalog 上层索引、stale member manifest。

## 逐项结论

### D01_authority_boundaries

status: pass

依据：主设计将 `graph_vault/books/{bookId}/BOOK_MANIFEST.json` 和包内质量门
定义为单书包权威，书架与 library 均限定为 `graph_vault/catalog/**` 下的
可重建派生索引。Pipeline I/O 的 `package_first_authority`、
`catalog_is_derivative` 与 `book_mount_projection` 明确只读取已验证包产物，
且不改变单书包。删除 catalog 上层索引时，设计要求只影响上层查询并返回
`upper_index_missing`，单书 query-ready 状态不被降级。

### D02_fixed_query_budget

status: pass

依据：主设计在 `queryContract.interactiveBudget` 固定了 semantic units、
bookshelves、deepening books、LLM calls、input/output tokens 等预算，并禁止
查询时全量扫描所有单书 community reports。Pipeline I/O 的
`scoped_query_execution` 禁止 missing upper index auto-build、stale scope 和
exhaustive all-books scan，超预算返回
`budget_exceeded_narrow_scope_required`。虚拟父书架查询也只能路由到固定
top-K 子物化书架，过宽时要求收窄 scope。

### D03_graphrag_semantic_alignment

status: pass

依据：上层构建输入包含单书或书架的 `community_reports.parquet`、
`entities.parquet`、`relationships.parquet` 与 `semantic_edges.parquet`。
主设计定义 `semanticUnit`、`semanticEdge`、`community_reports` 与 map-reduce
或等价社区报告生成路径，保留 entity/relationship 证据引用。Pipeline I/O
禁止 runner ledger 作为语义输入，防止从 GraphRAG 语义链路退化为普通运行
日志摘要检索。

### D04_evidence_traceability

status: pass

依据：主设计定义 `evidence_map.parquet`，要求上层 semantic unit、semantic
edge、community 和 community report 至少有一条下层证据映射，字段覆盖
`bookId`、`sourceId`、`documentId`、`contentHash`、community report 和
text unit。Pipeline I/O 要求书架与 library 构建产出 `evidence_map.parquet`，
查询输出 evidence lineage，并且只引用已发布产物。反例中 GraphRAG 中断或
部分构建不会发布缺失 evidence lineage 的 query-ready 上层索引。

### D05_state_recovery

status: pass

依据：主设计有 `stateAndRecovery`、durable checkpoints/events/status、
staging 到 current 的 publish protocol，publish marker 最后写入。Pipeline I/O
要求每个阶段能从 authority root、manifest、quality gate、checksums、events
和 checkpoints 判断 ready、failed、stale、running 或 pending。GraphRAG 构建
中断时，failed staging generation 不提升为 current；成员 manifest digest
变化时返回 `stale_not_query_ready`，默认查询拒绝 stale 上层索引并提供修复
命令。

### D06_quality_gates

status: pass

依据：主设计分别定义 bookshelfGate 与 libraryGate，覆盖 schema、checksum、
成员 manifest 一致性、membership authority、LLM suggestion acceptance、
虚拟父书架、direct book limit、fixed budget simulation、敏感扫描和 stale
marker。Pipeline I/O 每个阶段均有 `qualityGate`、`failureOutputs` 与下游
handoff reject 条件。qmd index 缺失、GraphRAG gate 失败、direct book 超限、
未接受 LLM suggestion、超大分类未拆分等反例均会阻断 publish 或 handoff。

### D07_incremental_scaling

status: pass

依据：主设计要求记录 member manifest sha256、packageGeneration、builder
fingerprint 与 generation，成员变化触发新 generation 或 stale。书架与
library 均有 incrementalRefresh 规则，无法按 checksum 证明局部不变时保守
重建。超大分类必须拆分为虚拟父书架和多个物化子书架；library direct book
仅限小规模或过渡修复，超过限制需通过书架或分区组织，避免全库重建成为
默认路径。

### D08_security_privacy

status: pass

依据：主设计的 `no_sensitive_payload_export` 和
`diagnosticRedactionPolicy` 禁止 provider payload、raw prompt、raw
completion、credential、absolute local path 与 query log content 进入上层
manifest、索引、质量门和诊断。Pipeline I/O 的 `redacted_diagnostics_only`
与各阶段 `forbiddenInputs`、sensitive payload scan 形成同向约束。LLM
suggestion 的 rationale 仅允许 bounded redacted summary，未接受建议也不得
进入 query-ready 输入。

### D09_cli_operability

status: pass

依据：主设计定义 scope resolution order、typed query error schema、错误码、
exitCode、remediationCommand 和 CLI behavior matrix。Pipeline I/O 中
`scoped_query_execution.failureOutputs` 已与主 typed errors 对齐，覆盖
`missing_scope`、`ambiguous_scope`、`upper_index_missing`、
`upper_index_stale`、`upper_quality_gate_failed` 和
`budget_exceeded_narrow_scope_required`。无 scope、qmd index 缺失、删除上层
索引、stale manifest、超预算等场景均快速返回 typed error，不进入长时间
隐式全库扫描或查询时重建。

### D10_testability

status: pass

依据：主设计与 Pipeline I/O 均列出超过 8 个 required cases。测试合同覆盖
10/100/1000 书固定预算验证、单书 hotplug 非回归、catalog 上层索引删除不
影响单书查询、qmd index 缺失拒绝、GraphRAG/质量门失败闭环、stale manifest
拒绝、direct book limit、虚拟父书架、LLM suggestion gate、敏感扫描、
证据映射和中断恢复。测试面满足正确性、成本边界、恢复、证据、安全和热插
兼容要求。

## 反例确认

- 用户只复制单书包：缺少 `PUBLISH_READY` 或包内 gate 未通过时不进入书架
  projection；有效单书包仍可按自身 manifest 与 gate 直接查询。
- qmd index 缺失：`book_package_publish` 质量门要求 bundled index valid 或
  package-local rebuild completed；失败包不进入 bookshelf membership。
- GraphRAG 中断：staging generation 不提升为 current，恢复从 checkpoint
  继续，默认查询只消费已发布 query-ready scope。
- LLM suggestion 未接受：suggestion-only 不能成为 query-ready 输入，handoff
  明确 reject 未接受 suggestion。
- 超大分类拆分：超过 hardLimit 或语义预算时必须拆为虚拟父书架和物化子
  书架，未拆分阻断物化书架构建。
- 虚拟父书架：不拥有 `semantic_units` 或 `community_reports`，只能导航或
  路由到子物化书架；无 query-ready 子书架时不可作为查询输入。
- library direct book 超限：membership 阶段禁止超过 `directBookLimit`，
  并返回 `upper_quality_gate_failed` 诊断。
- 删除 catalog 上层索引：上层 scope 返回 `upper_index_missing`，不触发查询
  路径隐式重建，也不改变单书包 query-ready。
- stale member manifest：成员 digest 变化标记上层 stale，默认返回
  `upper_index_stale` 或 `stale_not_query_ready`，可通过 rebuild/status 恢复。

## 必须修订位置

无。
