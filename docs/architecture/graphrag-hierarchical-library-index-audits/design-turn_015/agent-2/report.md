# design-turn_015 agent-2 report

结论：PASS

## D01_authority_boundaries

PASS。Type DD 继续保持单书包、bookshelf、library 三层权威根分离。书架与
library 的 `CURRENT`、manifest、`PUBLISH_READY`、quality gate 和 generation
仍限定在各自 package root 内。catalog projection 只作为派生发现与路由视图，
不参与 query-ready 判定；`--upper-deepening` 也没有改变该边界。

## D02_fixed_query_budget

PASS。本轮变更明确 `--upper-deepening` 默认关闭，必须显式启用；下钻目标只
来自 upper query 已选 evidence，并受 `maxBooksForDeepening`、
`maxBookshelvesForDeepening` 或 `--max-deepening-targets` 的固定上限约束。
`--max-deepening-targets` 只能收窄 package-local 预算，不能放宽预算。设计仍
禁止交互查询全量扫描所有单书 `community_reports`，超预算返回
`budget_exceeded_narrow_scope_required`。

## D03_graphrag_semantic_alignment

PASS。上层索引仍以 `community_reports`、`entities`、`relationships`、
`semantic_units`、`semantic_edges` 和 `evidence_map` 为核心输入与输出。显式
下钻调用既有单书 GraphRAG 能力，只作为已选上层证据的受控补充，没有退化
为普通摘要检索或全库拼接查询。

## D04_evidence_traceability

PASS。Type DD 要求 bookshelf/library 回答和可选下钻证据暴露 evidence
lineage，并通过 `evidence_map` 回链到 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report 或 text unit。`--upper-deepening` 被限定为
只读已选 upper evidence，避免生成无上层来源的游离证据。

## D05_state_recovery

PASS。设计继续覆盖 staging、quality gate、atomic publish、`CURRENT.json`、
`PUBLISH_READY.json`、stale detection、failed/running/pending 状态隔离。
受控下钻是查询期只读行为，不发布新 package 状态；当已选成员书不再
query-ready 时 fail closed 为 typed error，不把 stale 下层包当作 ready 输入。

## D06_quality_gates

PASS。bookshelf 与 library 均保留独立质量门，覆盖 schema、checksum、成员
一致性、evidence lineage、敏感信息扫描和 fixed-budget simulation。状态/list
查询被要求读取 package-local authority，并且不得把 catalog projection 当作
质量门或 publish marker。

## D07_incremental_scaling

PASS。设计仍记录成员 manifest sha256、generation、builder/config/evidence
schema 变化条件，并保留保守全量重建与可定位增量刷新边界。library 仍通过
书架层级控制规模；`--upper-deepening` 对固定数量已选目标下钻，不随成员书
总量线性增长。

## D08_security_privacy

PASS。Type DD 继续禁止 provider payload、raw prompt/completion、密钥、绝对
路径和 query log 进入可发布 manifest、索引、quality gate 或诊断。受控下钻
没有新增可发布语义产物写入路径，诊断仍要求 digest、bounded summary 和
脱敏 locator。

## D09_cli_operability

PASS。CLI 合同覆盖显式 book/bookshelf/library scope、missing、stale、
quality gate failed、legacy catalog-only、over budget 等 typed errors。
`--upper-deepening` 被定义为显式开关，默认 report-only 查询不变；timing
需要包含 retrieval、optional deepening、evidence merge 等层级阶段。

## D10_testability

PASS。Type DD 仍定义超过 8 个必测案例，覆盖不同规模 library 固定预算、
catalog projection 删除后显式 package 查询、legacy catalog-only fail closed、
stale、evidence lineage、安全扫描、单书 hotplug 非回归等。implementation
grounding 新增了 controlled deepening 相关测试说明，包括固定预算、去重、
超预算和缺失 capability fail-closed 覆盖。

## Required Fixes

无。

## Minor Notes

- `maxBookshelvesForDeepening` 与既有 `maxBookshelves` 命名应在后续实现文档中
  保持一致，避免 library 下钻预算字段出现解释歧义。
- 顶层 `testContracts.requiredCases` 已能满足 D10；后续可把
  `--upper-deepening` 的“显式启用、不能放宽预算、只读已选 evidence”加入正式
  required cases，而不只放在 implementation grounding validation 中。
- 审计以当前工作区 Type DD 内容为准；design-turn_015 报告目录持久化应由
  主控流程完成。

## Residual Risks

- 真实外部 provider 下的单书 `--graph-book-id` 与 `--upper-deepening` 成功路径
  仍是实现验证风险，不构成本轮 Type DD 设计阻断。
- LLM synthesis 仍标记为未来能力，当前 PASS 仅覆盖固定预算 report search 与
  显式受控下钻设计。
- membership 创建、自动 repair、增量 refresh 管理生命周期仍是后续实现风险，
  但 Type DD 已将其限定为 future/remaining capability。
