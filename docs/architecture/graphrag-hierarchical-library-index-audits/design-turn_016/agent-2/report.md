# design-turn_016 agent-2 report

结论：PASS

## D01_authority_boundaries

PASS。Type DD 继续保持单书包、bookshelf package root、library package root 三层
权威边界。单书 `query_ready` 不依赖上层索引；bookshelf/library 权威来自各自
package-local `CURRENT.json`、manifest、`PUBLISH_READY.json`、quality gate 与
checksum；catalog projection 仅为派生发现与路由视图，不作为 query-ready 权威。

## D02_fixed_query_budget

PASS。controlled deepening 已定义为显式启用、默认关闭。`--upper-deepening` 只能
从上层查询已选 evidence 中选择固定数量目标；`--max-deepening-targets` 只能收窄
package-local 预算，不能放宽预算。前轮指出的未定义
`maxBookshelvesForDeepening` 已统一为已定义的 `maxBookshelves`，并与
`maxBooksForDeepening` 保持固定预算边界。

## D03_graphrag_semantic_alignment

PASS。上层索引仍围绕 `community_reports`、`entities`、`relationships`、
`semantic_units`、`semantic_edges` 与 `evidence_map`。controlled deepening 只是对
已选上层 evidence 的受控单书 GraphRAG 下钻，没有退化为全库摘要检索或普通拼接
查询。

## D04_evidence_traceability

PASS。设计要求 bookshelf/library 回答和下钻证据暴露 evidence lineage，并通过
`evidence_map` 回链到 `bookId`、`sourceId`、`documentId`、`contentHash`、
community report 或 text unit。controlled deepening 被限制为从已选 upper
evidence 下钻，不产生无上层来源的游离证据。

## D05_state_recovery

PASS。设计覆盖 package-local staging、quality gate、atomic publish、generations、
`CURRENT.json`、`PUBLISH_READY.json`、stale detection 以及 failed/running/pending
fail-closed。controlled deepening 是查询期只读行为，不发布新 package 状态；下层
成员书不再 query-ready 时必须 fail closed。

## D06_quality_gates

PASS。bookshelf 与 library 均定义独立 quality gate，覆盖 schema、checksum、成员
一致性、evidence lineage、敏感信息扫描和 fixed-budget simulation。质量门失败时
上层查询不可用，status/list 不得以 catalog projection 替代质量门或 publish
marker。

## D07_incremental_scaling

PASS。设计记录成员 manifest sha256 与 generation，允许可定位增量刷新；无法局部
化时保守生成新 generation。大库仍通过 bookshelf 分层、partition plan、direct
book limit 与固定下钻目标限制规模影响。

## D08_security_privacy

PASS。Type DD 明确禁止 provider payload、raw prompt、raw completion、credential、
绝对路径和 query log content 进入可发布 manifest、索引、quality gate 或
diagnostics。诊断仅允许 digest、schema id、check id、bounded summary 与
redacted locator。

## D09_cli_operability

PASS。CLI 合同覆盖显式 book/bookshelf/library scope、missing、stale、quality gate
failed、legacy catalog-only、over budget 与 runtime error。`--upper-deepening` 是
显式开关；timing 要覆盖 upper retrieval、optional deepening、evidence merge 等
层级阶段。catalog projection 缺失不得阻断有效 package-root 显式查询。

## D10_testability

PASS。测试合同超过 8 项，覆盖不同规模 library 固定预算、删除 catalog projection
后显式 package-root 查询、legacy catalog-only fail-closed、stale、evidence
lineage、安全扫描、partial publish、query timing 与单书 hotplug 非回归。
controlled deepening 的固定预算、去重、超预算和 missing capability fail-closed 已
纳入实现接地验证说明。

## Required Fixes

无。

## Minor Notes

- `maxBookshelves` 现在承担 library controlled deepening 的书架目标预算，应在后续
  实现说明中持续区分“书架目标 cap”与 `maxBooksForDeepening` 的“单书下钻 cap”，
  避免运维解释混淆。
- `synthesisLlMCallCap` 拼写与 `maxLlmCalls.synthesize` 字段命名不一致，建议后续
  统一为一个合同字段；当前不影响本轮 PASS，因为 LLM synthesis 明确仍是
  remaining capability。
- `designAudit.currentRunDirectory` 指向 `design-turn_016` 且状态为
  in progress/pending，符合当前复审状态；报告目录落盘应由主控流程完成。

## Residual Risks

- LLM synthesis over selected upper semantic units 仍未实现。
- 真实外部 provider 的单书 `--graph-book-id` 成功验证仍未执行。
- `--upper-deepening` 当前设计与实现状态仍依赖 fixture-tested / injectable provider
  paths，真实 provider 成功路径需要单独验证。
- membership 创建、自动 repair、增量 refresh 管理生命周期仍是未来能力。
- controlled deepening 依赖成员单书 package 的 `graph_query` capability 与 provider
  可用性；provider timeout 必须继续作为 typed runtime error，而不能静默降级。
