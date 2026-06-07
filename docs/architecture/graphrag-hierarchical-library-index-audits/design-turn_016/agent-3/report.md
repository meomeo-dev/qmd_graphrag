# design-turn_016 agent-3 report

结论：PASS

## D01_authority_boundaries

PASS。Type DD 继续把单书包权威限定在 `graph_vault/books/{bookId}` 的
`BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd / GraphRAG 产物和质量门。
bookshelf 与 library 权威根分别限定为 `graph_vault/bookshelves/{bookshelfId}` 和
`graph_vault/library/{libraryId}`。catalog 仍仅为 projection / routing /
observability 派生视图，不证明 query-ready，也不拥有上层包闭包。

## D02_fixed_query_budget

PASS。上一轮 FAIL 指出的 `maxBookshelvesForDeepening` 未定义预算字段已从当前
合同中移除，只保留已定义的 `maxBookshelves` 与 `maxBooksForDeepening`。
`--upper-deepening` 默认关闭、必须显式启用，且只能从上层已选 evidence 中选择
固定数量目标；`--max-deepening-targets` 只能收窄 package-local budget，不能
放宽。查询合同继续禁止交互路径全量扫描所有单书 `community_reports`，超预算返回
`budget_exceeded_narrow_scope_required`。

## D03_graphrag_semantic_alignment

PASS。上层索引仍以 `community_reports`、`entities`、`relationships`、
`semantic_units`、`semantic_edges` 和 `evidence_map` 为核心输入输出。当前实现状态
被限定为固定预算 report search、证据回链和显式 controlled deepening，未把
GraphRAG 退化为普通摘要检索；LLM synthesis 仍标为 remaining capability。

## D04_evidence_traceability

PASS。Type DD 要求 bookshelf/library evidence map 回链到 `bookId`、`sourceId`、
`documentId`、`contentHash`、community report 或 text unit。controlled deepening
也被限制为从已选 upper evidence 下钻，避免生成无上层来源的游离证据。

## D05_state_recovery

PASS。当前文档状态闭环已修正：`status: design_audit_in_progress`，
`designAudit.currentRunDirectory` 指向 `design-turn_016`，
`finalAuditSummary.result` 为 `pending_after_design_turn_015_required_fixes`，
没有把 design-turn_016 写成通过。本地 `design-turn_015/agent-{1,2,3}/report.md`
已落盘，且保留 1 个 FAIL 历史。`implementation-turn_016` 也已改为
`pending`，未伪造 re-audited pass。构建恢复合同继续覆盖 staging、checkpoints、
quality gate、atomic publish、`CURRENT.json`、`PUBLISH_READY.json`、stale
detection、failed/running/pending fail-closed。

## D06_quality_gates

PASS。bookshelf 与 library 均保留独立 quality gate，覆盖 schema、checksum、成员
一致性、evidence lineage、embedding fingerprint、fixed query budget simulation、
敏感信息扫描和 stale marker。质量门失败时查询不可用，并映射到 typed error 与
诊断字段。

## D07_incremental_scaling

PASS。设计继续记录成员 manifest sha256 与 generation；成员变化会标记 stale 或
生成新 generation。增量刷新可在可证明局部影响时执行，无法定位时保守全量重建。
library 通过 bookshelf 分层、partition plan 和直接书本上限控制规模，不要求交互
查询随全库线性扩展。

## D08_security_privacy

PASS。forbidden inputs 与 redacted diagnostics policy 继续禁止 provider payload、
raw prompt、raw completion、credential、绝对路径和 query log content 进入可发布
manifest、索引、quality gate 或 diagnostics。诊断仅允许 digest、schema id、
check id、bounded summary 和 scope-relative redacted locator。

## D09_cli_operability

PASS。CLI 合同覆盖 no scope、ambiguous scope、explicit book/bookshelf/library
scope、legacy catalog-only、missing upper index、stale、quality gate failed、
over budget 和 runtime error。显式上层查询必须先校验 package-local `CURRENT`、
manifest、`PUBLISH_READY`、quality gate 和 checksum；catalog projection 缺失不得
阻断有效 package-root 查询。timing/cost 观测已要求拆分 route、retrieval、
budget、synthesis、optional deepening 和 evidence merge 等阶段。

## D10_testability

PASS。`testContracts.requiredCases` 明显超过 8 项，覆盖 copied package 查询、删除
catalog projection 后显式 package-root 查询、legacy catalog-only fail-closed、单书
hotplug 非回归、多规模 library 固定预算、stale 拒绝、缺索引不隐式构建、质量门
失败、evidence lineage、安全扫描、interrupted build 和 timing。controlled
deepening 的实现接地段还列出 fixed-budget、去重、budget-exceeded、missing
capability fail-closed 和默认 report-only regression 覆盖。

## Required Fixes

无。

## Minor Notes

- 当前文档可进入 design-turn_016 审计闭环；design-turn_016 报告目录尚需由主控
  流程按 agent 输出实际落盘。
- library controlled deepening 文字中“member books under maxBookshelves”仍略易
  误读；建议后续实现说明持续区分 bookshelf selection cap 与 single-book
  deepening cap。
- missing `graph_query` capability 当前可通过 fail-closed 表达；后续 CLI 矩阵可
  进一步明确其错误码归属，减少运维诊断歧义。
- `testContracts.requiredCases` 已满足 D10；后续可把 `--upper-deepening` 默认关闭、
  `--max-deepening-targets` 不得放宽预算、只读已选 evidence 写成正式必测项。

## Residual Risks

- LLM synthesis over selected upper semantic units 仍未实现。
- 真实外部 provider 的单书 `--graph-book-id` 与 `--upper-deepening` 成功路径仍未
  验证。
- membership 创建、自动 repair、增量 refresh 管理生命周期仍是后续能力。
- controlled deepening 依赖成员单书 package 的 `graph_query` capability 与 provider
  可用性；provider timeout 必须继续保持 typed runtime error，不得静默降级为缺证。
