# design-turn_016 agent-1 report

结论：PASS

## D01_authority_boundaries

PASS。Type DD 继续保持单书、bookshelf、library 三层权威根分离。单书包仍以
`graph_vault/books/{bookId}` 下的 manifest、publish marker、包内 qmd /
GraphRAG 产物与质量门为权威；bookshelf 与 library 分别限定在
`graph_vault/bookshelves/{bookshelfId}` 与 `graph_vault/library/{libraryId}`。
catalog 仍仅为 projection / routing / observability 派生视图，不能证明
query-ready。

## D02_fixed_query_budget

PASS。design-turn_015 的预算字段问题已闭合。当前文档不再使用未定义的
`maxBookshelvesForDeepening` 作为有效预算字段，仅在历史问题说明中引用该
名称。`queryContract.interactiveBudget.default` 定义了 `maxBookshelves` 与
`maxBooksForDeepening`，`implementationRule` 明确 `--upper-deepening` 只能从
已选 upper evidence 中按 `maxBooksForDeepening` 或 `maxBookshelves` 选择固定
目标。`--max-deepening-targets` 被限定为只能收窄 package-local 固定预算，不能
放宽。

## D03_graphrag_semantic_alignment

PASS。上层索引仍基于 `community_reports`、`entities`、`relationships`、
`semantic_units`、`semantic_edges` 与 `evidence_map`。受控下钻只是在已选上层
evidence 上调用既有单书 GraphRAG，不构成全库拼接查询，也没有退化为普通
摘要检索。

## D04_evidence_traceability

PASS。Type DD 持续要求 bookshelf/library evidence 通过 `evidence_map` 回链到
`bookId`、`sourceId`、`documentId`、`contentHash`、community report 或 text
unit。`--upper-deepening` 被限制为从已选 upper evidence 下钻，避免生成无上层
来源的游离证据。

## D05_state_recovery

PASS。设计覆盖 package-local staging、quality gate、atomic publish、
generations、`CURRENT.json`、`PUBLISH_READY.json`、stale detection、
failed/running/pending fail-closed。受控下钻为查询期只读行为，不发布新的上层
package 状态。

## D06_quality_gates

PASS。bookshelf 与 library 均有独立质量门，覆盖 schema、checksum、成员一致性、
evidence lineage、敏感信息扫描和 fixed-budget simulation。质量门失败时查询路径
必须返回 typed error，不得继续消费上层索引。

## D07_incremental_scaling

PASS。设计记录成员 manifest sha256 与 generation，并定义可定位刷新或保守 full
generation rebuild 条件。library 仍通过 materialized bookshelf 分层控制规模；
受控下钻只面向固定数量已选目标，不随总书籍数量线性增长。

## D08_security_privacy

PASS。Type DD 禁止 provider payload、raw prompt/completion、credential、绝对路径
和 query log content 进入可发布 manifest、索引、quality gate 或 diagnostics。
诊断信息仍限定为 digest、schema id、check id、bounded summary 和 redacted
locator。

## D09_cli_operability

PASS。CLI 合同覆盖显式 book/bookshelf/library scope、missing、stale、quality gate
failed、legacy catalog-only、over budget 等 typed errors。`--upper-deepening` 为
显式开关，默认 report-only 查询不变；timing 需要暴露 upper retrieval、
optional deepening 与 evidence merge 等阶段。

## D10_testability

PASS。测试合同超过 8 项，并覆盖固定预算、多规模 library、catalog projection
删除后显式 package 查询、legacy catalog-only fail-closed、stale、evidence
lineage、安全扫描、partial publish、query timing 与单书 hotplug 非回归。
controlled deepening 的固定预算、去重、超预算和缺失 capability fail-closed 也已
进入实现接地说明。

## Required Fixes

无。

## Minor Notes

- `designAudit.status` 与 `finalAuditSummary.result` 当前为
  `design_audit_in_progress` / `pending_after_design_turn_015_required_fixes`，
  未提前宣称 design-turn_016 已通过，状态闭环正确。
- `implementationTurn016.result` 当前为 `pending`，没有伪造
  implementation-turn_016 通过；引用 summary 路径作为待产出报告是可接受的
  pending 状态。
- phase3 中 “member books under maxBookshelves” 表述略紧，建议后续实现说明中
  明确：library 先受 `maxBookshelves` 限制选中书架，再由已选 evidence 导出的
  单书下钻受 `maxBooksForDeepening` 与 `--max-deepening-targets` 的较小值限制。

## Residual Risks

- LLM synthesis over selected upper semantic units 仍未实现。
- 真实外部 provider 下的单书 `--graph-book-id` 与 `--upper-deepening` 成功路径仍未
  验证。
- membership 创建、自动 repair、增量 refresh 管理生命周期仍为后续能力。
- controlled deepening 依赖成员单书 package 的 `graph_query` capability 与 provider
  可用性；provider timeout 仍应保持 typed runtime error，不能静默降级。
