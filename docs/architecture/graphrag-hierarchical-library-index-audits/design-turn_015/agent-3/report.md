# design-turn_015 agent-3 report

结论：PASS

## D01_authority_boundaries

PASS。Type DD 继续保持单书包权威边界。单书 query_ready 仅来自
`graph_vault/books/{bookId}` 包内 manifest、publish marker、qmd / GraphRAG
产物和质量门。书架与 library 的权威根分别限定为
`graph_vault/bookshelves/{bookshelfId}` 与 `graph_vault/library/{libraryId}`。
catalog 明确为 projection / routing / observability 派生视图，不作为
query-ready 权威。

## D02_fixed_query_budget

PASS。文档明确要求交互查询使用固定 top-K、固定候选语义单元、固定 token 与
固定 LLM 调用预算。`--upper-deepening` 被表述为显式可选，默认关闭，只能从
上层已选 evidence 中选择固定数量 member book，并且 `--max-deepening-targets`
只能收窄 package-local 预算，不能放宽预算。

## D03_graphrag_semantic_alignment

PASS。上层索引输入包含单书或书架的 `community_reports`、`entities`、
`relationships`、`text_units`，并生成 `semantic_units`、`semantic_edges`、
`community_reports` 与 `evidence_map`。文档没有把上层 GraphRAG 退化为普通
summary retrieval。

## D04_evidence_traceability

PASS。Type DD 定义并反复要求 `evidence_map`，证据需回链到 `bookId`、
`sourceId`、`documentId`、`contentHash`、community report 或 text_unit。显式
controlled deepening 也被限制为从已选上层 evidence 下钻，未改变 lineage
要求。

## D05_state_recovery

PASS。文档覆盖 staging、quality gate、atomic publish、generations、
`CURRENT.json`、`PUBLISH_READY.json`、runs、diagnostics、stale 检测与 failed /
partial publish fail-closed。membership-only manifest 被明确标为
`queryReady=false`，不能授权查询。

## D06_quality_gates

PASS。书架与 library 均有独立 quality gate，覆盖 schema、checksum、成员
一致性、evidence lineage、固定预算模拟、stale marker 和敏感信息扫描。
质量门失败时查询路径必须 typed error，不得继续消费上层索引。

## D07_incremental_scaling

PASS。文档记录成员 manifest sha256 与 generation，并允许保守 generation
rebuild。同时明确 richer incremental refresh / refresh planner 仍是未来能力，
未误写成已完成。大库通过书架分层、partition plan 和 direct book limit 限制
影响范围。

## D08_security_privacy

PASS。文档禁止 provider payload、raw prompt、raw completion、credential、
绝对路径和 query log 进入可发布 manifest、索引、quality gate 或 diagnostics。
诊断只允许 digest、schema id、check id、bounded summary 和 redacted locator。

## D09_cli_operability

PASS。Type DD 覆盖无 scope、显式 book / bookshelf / library scope、legacy
catalog-only artifact、missing index、stale、quality gate failed、over budget
等 CLI 行为。`--bookshelf-id` / `--library-id` 显式查询以 package-root
`CURRENT.json`、manifest、`PUBLISH_READY.json`、quality gate 和 checksum 为
query-ready 依据，不依赖 catalog projection。

## D10_testability

PASS。测试合同超过 8 项，并覆盖删除 catalog projection 后显式 package-root
查询、legacy catalog-only fail-closed、固定预算多规模 library、stale 拒绝、
单书 hotplug 非回归、evidence lineage、安全扫描、partial publish 与 query
timing。当前实现状态也将 LLM synthesis、真实外部 provider 单书成功验证、
membership creation / automatic repair / incremental refresh 管理生命周期列为
剩余风险或未来能力，未误判为完成。

## Required Fixes

无。

## Minor Notes

- Type DD 顶部声明 `design-turn_015` 已由 3 agents 通过；本次只审计当前
  Type DD 正文，不验证该审计目录是否已落盘。
- 历史 implementation turn 条目中保留了较早的 “controlled deepening remains
  future” 风险描述；后文 `postImplementationTurn016LocalAdditions` 和当前
  implementation status 已更新为显式 controlled deepening minimum completed。
  该历史顺序可读性略弱，但没有造成当前状态误判。
- `designAudit.currentRunDirectory` 已指向 `design-turn_015`，后续若继续修改
  Type DD，需要重新进入设计审计循环。

## Residual Risks

- LLM synthesis over selected upper semantic units 仍未实现。
- 真实外部 provider 的单书 `--graph-book-id` 成功验证仍未执行。
- `--upper-deepening` 当前状态表述为 fixture-tested / injectable provider paths，
  真实外部 provider 成功仍单独受阻。
- membership 创建、自动 repair、增量 refresh 管理生命周期仍是未来能力。
- 更丰富的上层聚类、摘要、LLM-authored community report synthesis 和增量
  refresh planner 仍未完成。
