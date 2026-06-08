# implementation-turn_020 agent-3 实施审计报告

## 审计结论

最终 verdict: PASS

本轮审计未发现阻断问题。Type DD 已把 query-time
`--upper-synthesis`、`refresh-membership`、`repair` 写为当前实现，
并继续把 build-time LLM-authored community report synthesis、自动调度
repair、增量 rebuild planner 留作未来能力。实现证据、真实 package-root
smoke、真实 provider synthesis smoke、固定预算、证据回链、单书热插回归和
YAML parse 证据满足本轮端到端可运行目标。

## 审计依据

- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 关键实现：
  `src/graphrag/upper-index/upper-synthesis.ts`,
  `src/graphrag/upper-index/bookshelf-query.ts`,
  `src/graphrag/upper-index/library-query.ts`,
  `src/cli/qmd.ts`,
  `src/cli/graphrag-upper-management.ts`
- 真实包证据：
  `graph_vault/bookshelves/audit-shelf-a`,
  `graph_vault/bookshelves/audit-shelf-b`,
  `graph_vault/library/audit-library`
- 主线程已执行证据：
  真实 graph_vault smoke、真实 provider smoke、单书 query/gate、
  聚焦测试矩阵和 YAML parse 均通过。

## 端到端证据核对

- `audit-shelf-a` 与 `audit-shelf-b` 均位于
  `graph_vault/bookshelves/**`，各自 membership 为 3 本已发布单书，
  membership generation 为 `queryReady=false`，图索引 generation 为
  `queryReady=true`。
- 两个书架的 `CURRENT.json`、`BOOKSHELF_MANIFEST.json`、
  `PUBLISH_READY.json`、package-local quality gate 均显示
  `bookshelf_query_ready`，质量门通过 13 项检查，membership gate 通过 7
  项检查。
- `audit-library` 位于 `graph_vault/library/**`，由 2 个已发布 bookshelf
  package 组成，direct book 数为 0，`CURRENT.json`、`LIBRARY_MANIFEST.json`、
  `PUBLISH_READY.json`、package-local quality gate 均显示
  `library_query_ready`。
- library graph quality gate 通过 13 项检查，library membership gate 通过
  10 项检查；`semantic_units.parquet`、`semantic_edges.parquet`、
  `community_reports.parquet`、`evidence_map.parquet` 的 checksum sidecar
  均存在。
- 书架固定预算为 `maxSemanticUnits=12`、`maxBooksForDeepening=3`、
  `maxMemberCommunityRefs=24`、`maxInputTokens=64000`，simulationStatus 为
  `passed`。
- library 固定预算为 `maxSemanticUnits=10`、`maxBookshelves=4`、
  `maxShelfCommunityRefs=24`、`maxInputTokens=64000`，simulationStatus 为
  `passed`。
- Type DD 记录显式删除 catalog projection 后，`--bookshelf-id` 与
  `--library-id` 查询仍成功，证明显式查询不依赖 catalog projection 作为
  query-ready 权威。
- Type DD 记录真实 provider `--upper-synthesis` smoke 已对
  `audit-library` 成功，输出包含 timing 与 `upper.llm_synthesis`；同时
  `--max-synthesis-output-tokens 200` 触发
  `budget_exceeded_narrow_scope_required`，证明收窄预算被强制执行。
- 单书热插回归证据覆盖 hotplug creation/runtime/catalog/qmd projection、
  capability scope、单书 `--graph-book-id` 聚焦查询和 qmd vsearch。

## D01-D10 逐项结论

| 维度 | 结论 | 核对结果 |
| --- | --- | --- |
| D01_authority_boundaries | PASS | 单书包权威仍为 `graph_vault/books/**` 下的 manifest、publish marker 和质量门；书架/library 写入各自 package root；catalog 仅为 projection。 |
| D02_fixed_query_budget | PASS | 书架与 library manifest 均记录固定 top-K、输入 token 和下钻预算；query-time synthesis 仅一轮 LLM 调用，超预算 fail-closed。 |
| D03_graphrag_semantic_alignment | PASS | 上层索引包含 `community_reports`、`semantic_units`、`semantic_edges` 和 `evidence_map`，查询基于已发布上层 semantic evidence。 |
| D04_evidence_traceability | PASS | evidence lineage 保留到 `bookId`、`sourceId`、`documentId`、`contentHash`、community report 或 text unit；synthesis 只重用已选 evidence。 |
| D05_state_recovery | PASS | membership generation、graph generation、`CURRENT.json`、`PUBLISH_READY.json`、quality gates 和 checksum sidecar 形成状态闭环；membership-only publish 不授权 query-ready。 |
| D06_quality_gates | PASS | 书架和 library 均有 package-local graph quality gate 与 membership gate；失败或 stale 状态不会被查询路径视为 ready。 |
| D07_incremental_scaling | PASS | 当前实现记录成员 manifest sha256/generation，并通过书架分层限制 library 查询与重建影响范围；自动调度 repair 和增量 planner 正确保留为未来能力。 |
| D08_security_privacy | PASS | query-time synthesis sanitizes answer/evidence metadata，不暴露 raw prompt、raw completion 或 provider payload；质量门包含敏感信息扫描合同。 |
| D09_cli_operability | PASS | CLI 提供 `--bookshelf-id`、`--library-id`、`--upper-synthesis`、预算收窄参数，以及 `status/list/build/rebuild/refresh-membership/repair`；typed error 与 timing 可观测。 |
| D10_testability | PASS | 主线程已通过 types、YAML parse、upper synthesis、management CLI、bookshelf/library graph、query scope、hotplug、single-book query 和 vsearch 聚焦测试矩阵。 |

## 文档与实现一致性

Type DD 当前实现状态与代码边界一致：

- query-time `--upper-synthesis` 为显式、默认关闭、一次受限 LLM 调用；
  `--max-synthesis-input-tokens` 与 `--max-synthesis-output-tokens` 只能收窄
  package-local 固定预算。
- `refresh-membership` 只发布 `queryReady=false` 的 package-root membership
  generation。
- `repair` 读取当前 package-root membership，重新解析成员并重建
  query-ready 上层包，不以 catalog projection 为权威。
- build-time LLM-authored community report synthesis、自动调度 repair 和增量
  rebuild planner 未被误写为已完成能力。

## 最终判定

PASS
