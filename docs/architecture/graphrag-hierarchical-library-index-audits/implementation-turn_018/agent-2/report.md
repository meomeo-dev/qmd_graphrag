**Result**

PASS_WITH_RISK.

implementation-turn_017 agent-2/3 的三项 FAIL required fixes 在当前工作区已闭合：
exported `queryBookshelfGraph` / `queryLibraryGraph` 禁止 `maxReports` 与
`maxInputTokens` 放宽 package-local fixed budget，并有 fail-closed 测试；
bookshelf/library 10/100/1000 scale 测试已经过 package-local manifest、quality
gate、`CURRENT.json`、`PUBLISH_READY.json`、validator 和正式 query API；
library CLI `--upper-deepening` 已有成功路径测试，并验证 bounded member book
invocation。

保留风险来自本轮边界之外：真实外部 provider smoke 未执行，LLM synthesis 仍为
future capability，membership creation/repair/incremental refresh lifecycle 仍未在
本轮完成。因此不判定为无风险 PASS。

**Scope**

本报告独立审计当前工作区，只写入本文件，未修改
`implementation-turn_016`、`implementation-turn_017` 或其他历史报告。审计输入：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 当前工作区实现与测试。

工作区状态：`main...origin/main [ahead 3]`，存在未提交实现、测试、Type DD 和审计
目录变更；本结论仅覆盖当前工作区快照。

**Evidence**

- TypeScript build check 通过：
  `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`。
- Type DD 与固定审计基准 YAML parse 通过。
- `src/graphrag/upper-index/bookshelf-query.ts:97` 与
  `src/graphrag/upper-index/library-query.ts:97` 的 `resolveRequestedBudget` 拒绝
  invalid 或大于 package scope budget 的 `maxReports` / `maxInputTokens`，并抛出
  `budget_exceeded_narrow_scope_required`。
- `test/graphrag-bookshelf-graph.test.ts:774` 和
  `test/graphrag-library-graph.test.ts:1052` 覆盖 exported query API 试图放宽
  `maxReports` 的 fail-closed。
- `test/graphrag-bookshelf-graph.test.ts:788` 和
  `test/graphrag-library-graph.test.ts:1066` 覆盖 exported query API 试图放宽
  `maxInputTokens` 的 fail-closed。
- `test/graphrag-bookshelf-graph.test.ts:908` 的 10/100/1000 scale 测试先写入
  synthetic book manifests，再发布 synthetic bookshelf package，运行
  `validateBookshelfGraph`，并通过 `queryBookshelfGraph` 验证 selected reports、
  token metadata 和 evidence 数量固定。
- `test/graphrag-library-graph.test.ts:1206` 的 10/100/1000 scale 测试先发布
  synthetic member bookshelf packages，再发布 synthetic library package，运行
  `validateLibraryGraph`，并通过 `queryLibraryGraph` 验证 fixed query budget。
- 聚焦 scale 验证通过：
  `vitest test/graphrag-bookshelf-graph.test.ts -t "keeps bookshelf query budget fixed|publishes a query-ready bookshelf graph"`
  为 2 passed；
  `vitest test/graphrag-library-graph.test.ts -t "keeps library query budget fixed|publishes a query-ready library graph"`
  为 2 passed。
- `scripts/graphrag/bookshelf_graph_bridge_build.py:198` 与
  `scripts/graphrag/library_graph_bridge_build.py:293` 的 community report build
  使用 `maxSemanticUnits` 约束 report 数量；validators 对
  `semantic_units.parquet` 和 `community_reports.parquet` row count 超预算返回
  `budget_exceeded_narrow_scope_required`。
- `test/cli-graphrag-route.test.ts:1435` 覆盖
  `qmd query --library-id --upper-deepening` 成功路径；
  `test/cli-graphrag-route.test.ts:1467` 断言 fake bridge request 数为 1，
  `:1473` 断言 `selectedBookIds` 长度为 1。
- CLI upper-deepening / failed CURRENT / staging CURRENT 聚焦验证通过：
  `vitest test/cli-graphrag-route.test.ts -t "upper-deepening|refuses failed upper CURRENT|refuses staging upper CURRENT"`
  为 8 passed。
- `src/graphrag/upper-index/upper-package-paths.ts:275` 的
  `readQueryReadyPackage` 读取 package root，校验 `CURRENT.json`、manifest sha256、
  root manifest、`PUBLISH_READY.json` 和 quality gate；legacy catalog-only 返回
  `upper_package_migration_required`。
- `src/graphrag/upper-index/bookshelf-query.ts:145` 与
  `src/graphrag/upper-index/library-query.ts:145` 在查询前调用
  `readQueryReadyPackage`，不以 catalog projection 作为 query-ready 权威。
- `src/graphrag/upper-index/upper-catalog-projection.ts:189` 写入
  `readinessProof: package_local_current_publish_ready_quality_gate` 和
  `catalogIsAuthority: false`；graph builders 在发布上层包后重建 catalog
  projection。
- 单书 hotplug 回归通过：
  `test/graphrag-book-hotplug-creation-gate.test.ts`,
  `test/graphrag-book-hotplug-runtime-gate.test.ts`,
  `test/graphrag-capability-scope.test.ts` 为 13 passed；
  `test/graphrag-book-hotplug-catalog.test.ts`,
  `test/graphrag-book-hotplug-qmd-projection.test.ts` 为 13 passed。
- 单书 GraphRAG CLI 聚焦回归通过：
  `vitest test/cli-graphrag-route.test.ts -t "qmd query --graphrag uses the selected book scoped output"`
  为 1 passed。
- qmd vsearch 非回归通过：
  `vitest test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`
  为 1 passed；
  `vitest test/store.test.ts -t "vectorSearchQuery does not expand the query or call generation"`
  为 1 passed。
- `test/cli-graphrag-upper-index-failclosed.test.ts` 与 bookshelf/library graph tests
  覆盖 upper parquet 中含 provider/raw prompt/token 文本时 fail-closed。

**D01-D10 Table**

| ID | Result | Evidence / Rationale |
|---|---|---|
| D01_authority_boundaries | PASS | 单书包 query-ready 不依赖 upper index；upper query 以 package root、`CURRENT`、manifest、`PUBLISH_READY` 和 gate 为权威；hotplug 回归通过。 |
| D02_fixed_query_budget | PASS | exported query API 对放宽 `maxReports` / `maxInputTokens` fail-closed；controlled deepening 默认关闭且 target count 只能收窄；10/100/1000 scale 经正式 query API 验证预算固定。 |
| D03_graphrag_semantic_alignment | PASS | 上层构建与查询围绕 community reports、semantic units、semantic edges、communities 和 evidence map，不是普通摘要拼接。 |
| D04_evidence_traceability | PASS_WITH_RISK | evidence lineage 可追溯到 book/source/document/contentHash/community report/text unit；真实 LLM synthesis 仍未实现。 |
| D05_state_recovery | PASS | staging -> generation -> `CURRENT` -> root manifest/gate -> `PUBLISH_READY` 闭环存在；failed/staging CURRENT 的 CLI fail-closed 测试通过。 |
| D06_quality_gates | PASS | bookshelf/library validators 检查 schema、checksum、member consistency、row budget、sensitive payload 和 stale 成员；scale 测试已经过 validator。 |
| D07_incremental_scaling | PASS_WITH_RISK | 成员 manifest sha256 / generation 与 stale detection 存在；自动 repair 和增量 refresh lifecycle 仍是保留风险。 |
| D08_security_privacy | PASS | forbidden fields、敏感 payload 扫描、relative locator 和 hotplug provider payload 排除均有实现或测试覆盖。 |
| D09_cli_operability | PASS | CLI typed errors、exit codes、timing、scope ambiguity、legacy migration、upper deepening success/error 路径均有测试覆盖。 |
| D10_testability | PASS | 覆盖 package-local query-ready、catalog deletion、legacy migration、stale/failed/staging、sensitive scan、scale fixed budget、单书 hotplug 和 qmd vsearch 非回归。 |

**Findings by severity**

High: 无。

Medium: 无。

Low:

1. 真实外部 provider smoke 仍未执行。

   - Evidence: 本轮验证使用 fake bridge、fixture package 和 injectable runner 路径。
   - Impact: 不影响 package-local authority、fixed budget 或 CLI typed error 的闭环，
     但不能证明外部 provider 在真实环境下完成端到端回答。
   - Required fix: 无阻断修复；在外部 provider 可用时单独执行 smoke test。

2. LLM synthesis 仍为 future capability。

   - Evidence: Type DD `remainingCapabilities` 仍列出
     `LLM synthesis over selected upper semantic units`。
   - Impact: 当前实现是 fixed-budget report search 加显式 controlled deepening；
     不应宣称完整 synthesis 已完成。
   - Required fix: 无本轮阻断修复；后续阶段实现时需要独立合同和测试。

**Residual risks**

- 真实外部 provider 单书 GraphRAG 和 controlled deepening 成功路径未在本审计中运行。
- LLM synthesis over selected upper semantic units 尚未实现。
- Membership creation、automatic repair、incremental refresh management lifecycle
  仍为保留风险。
- Query bridge 会读取已发布且 validator 限定 row count 的 upper parquet 文件后排序；
  当前固定预算证明依赖 build-time row-bound、validator 和 query-time budget guard。

**Required fixes**

无阻断 required fixes。
