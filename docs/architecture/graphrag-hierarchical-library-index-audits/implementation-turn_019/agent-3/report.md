**Result**

PASS_WITH_RISK.

implementation-turn_018 agent-3 的阻断项已闭合：当前
`test/graphrag-library-graph.test.ts` 的
`keeps library query budget fixed at simulated 10, 100, and 1000 book scale`
仍表示 10/100/1000 总成员书数，但通过固定数量 synthetic bookshelf packages
承载书架层级，减少 1000 package root I/O。该测试单独运行通过，Vitest 报告
测试耗时 29882ms，命令墙钟 33.95s；同文件全量 8 个测试也通过，scale 用例在
全文件运行中耗时 34685ms，不再接近自身 120s timeout。

turn_017 的三项原始失败仍保持闭合：exported upper query API 禁止通过
`maxReports` / `maxInputTokens` 放宽 package-local fixed budget；
bookshelf/library scale 测试走 package-local ready 闭环；library CLI
`--upper-deepening` 成功路径验证 bounded member book invocation。

保留风险为非阻断项：真实外部 provider smoke 未执行，LLM synthesis 仍为
future capability，membership repair / incremental refresh lifecycle 仍未在本轮
完成。另有两条较大的组合验证命令曾因外层 360s 命令 timeout 或用户中断而未
作为通过证据计入。

**Scope**

本报告审计当前工作区快照，只写入本文件：

- `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_019/agent-3/report.md`

审计输入：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 当前工作区实现与测试。

工作区状态：`main...origin/main [ahead 3]`，存在未提交实现、测试、Type DD 和
审计目录变更。本报告不修改实现文件，不回滚或改写他人文件。

**Evidence**

- TypeScript build check 通过：
  `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`。
- Type DD 与固定审计基准 YAML parse 通过，输出 `yaml ok`。
- library scale 阻断项单独验证通过：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-library-graph.test.ts -t "keeps library query budget fixed at simulated 10, 100, and 1000 book scale"`
  结果为 1 passed，测试耗时 29882ms，命令墙钟 `real 33.95`。
- `test/graphrag-library-graph.test.ts` 全文件验证通过：8 passed，Duration
  237.14s；其中 scale 用例耗时 34685ms。
- `test/graphrag-library-graph.test.ts` 的 scale 用例在每个 scale 内：
  - 创建 4 个 published synthetic bookshelf packages。
  - 以 `memberCount` 汇总代表 10/100/1000 本书。
  - 发布 synthetic library package。
  - 写入 package-local `LIBRARY_MANIFEST.json`、`CURRENT.json`、
    `PUBLISH_READY.json`、`state/library-quality-gate.json` 和 sidecar。
  - 调用 `validateLibraryGraph` 与正式 `queryLibraryGraph`。
  - 断言 `representedBookCount` 等于 10/100/1000。
  - 断言 `semanticUnitCount === 8`、`selectedReportCount === 3`，
    并比较 budget fingerprint，确保 query budget 不随成员书数量增长。
- `src/graphrag/upper-index/library-query.ts` 与
  `src/graphrag/upper-index/bookshelf-query.ts` 的 `resolveRequestedBudget`
  拒绝 invalid 或大于 scope package budget 的 `maxReports` /
  `maxInputTokens`，错误码为 `budget_exceeded_narrow_scope_required`。
- `test/graphrag-library-graph.test.ts` 覆盖 exported `queryLibraryGraph`
  放宽 `maxReports` 和 `maxInputTokens` 的 fail-closed；同文件还覆盖实际
  upper artifact row 超过 fixed budget 时 validator/query fail-closed。
- `test/graphrag-bookshelf-graph.test.ts` 聚焦验证通过：3 passed，覆盖发布
  query-ready bookshelf、actual upper artifact row budget fail-closed、10/100/1000
  bookshelf fixed budget scale。
- `test/graphrag-controlled-deepening.test.ts` 通过：5 passed，覆盖默认不开启、
  bounded deepening、over-budget fail-closed、缺 selected member book capability
  fail-closed、library target 去重。
- library CLI controlled deepening 成功路径验证通过：
  `test/cli-graphrag-route.test.ts -t "qmd query --library-id --upper-deepening calls bounded member books"`
  结果为 1 passed；测试断言 fake bridge request 数为 1、
  `selectedBookIds` 长度为 1、`graphCapabilityIds` 长度为 1，输出 evidence 含
  `upperDeepening: true`，且不泄露本地 graph vault 绝对路径。
- CLI missing / legacy migration / single-book GraphRAG 聚焦验证通过：
  `test/cli-graphrag-route.test.ts -t "qmd query --graphrag uses the selected book scoped output|qmd query --bookshelf-id returns migration error for legacy catalog-only index|qmd query --library-id returns migration error for legacy catalog-only index|qmd query --bookshelf-id returns upper typed error for missing index|qmd query --library-id returns upper typed error for missing index"`
  结果为 5 passed。
- 单书 hotplug 回归通过：
  `test/graphrag-book-hotplug-creation-gate.test.ts`,
  `test/graphrag-book-hotplug-runtime-gate.test.ts`,
  `test/graphrag-capability-scope.test.ts`,
  `test/graphrag-book-hotplug-catalog.test.ts`,
  `test/graphrag-book-hotplug-qmd-projection.test.ts`
  结果为 26 passed。
- qmd vsearch 聚焦非回归通过：
  `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`
  结果为 1 passed；
  `test/store.test.ts -t "vectorSearchQuery does not expand the query or call generation"`
  结果为 1 passed。
- `src/graphrag/upper-index/upper-package-paths.ts` 的 `readQueryReadyPackage`
  读取 package root，校验 `CURRENT.json`、generation manifest、root manifest、
  quality gate、`PUBLISH_READY.json` 和 sidecar sha256；legacy catalog-only upper
  artifacts 缺 package root 时返回 `upper_package_migration_required`。
- `src/graphrag/upper-index/upper-catalog-projection.ts` projection schema 标记
  `readinessProof: package_local_current_publish_ready_quality_gate` 与
  `catalogIsAuthority: false`；显式 upper query 不以 catalog projection 作为
  query-ready 权威。
- `test/graphrag-library-graph.test.ts` 明确删除 library catalog projection 后
  再调用 `queryLibraryGraph`，仍能基于 package root 查询。
- `test/graphrag-bookshelf-graph.test.ts` 有对等删除 bookshelf catalog projection
  后显式 `queryBookshelfGraph` 仍可查询的覆盖。
- `test/cli-graphrag-upper-index-failclosed.test.ts`、bookshelf/library graph tests
  覆盖 upper parquet 含 provider payload、raw prompt 或敏感文本时 fail-closed。

**D01-D10 Table**

| ID | Result | Evidence / Rationale |
|---|---|---|
| D01_authority_boundaries | PASS | 单书包 query-ready 仍由 book package 权威闭环决定；upper package root 位于 `graph_vault/bookshelves/{id}` 与 `graph_vault/library/{id}`；upper query 先校验 package-local `CURRENT`、manifest、gate、`PUBLISH_READY`。 |
| D02_fixed_query_budget | PASS | exported query API 禁止放宽 `maxReports` / `maxInputTokens`；library scale 验证 10/100/1000 represented books 下 `semanticUnitCount`、`selectedReportCount` 和 budget fingerprint 固定；controlled deepening 有 target budget。 |
| D03_graphrag_semantic_alignment | PASS | 上层构建和查询使用 community reports、semantic units、semantic edges、communities 与 evidence map，未退化为普通摘要拼接或临时多书全量扫描。 |
| D04_evidence_traceability | PASS_WITH_RISK | query evidence 暴露 bookId、sourceId、documentId、contentHash、text unit、community report 与 upper locator；真实 LLM synthesis 尚未完成。 |
| D05_state_recovery | PASS | package-local generation、`CURRENT`、root manifest/gate、`PUBLISH_READY` 和 sidecar 闭环存在；failed/staging/pending/stale 不作为 ready 的路径有 CLI 或 graph tests 覆盖。 |
| D06_quality_gates | PASS | validators 覆盖 schema、checksum、member manifest sha256、actual row budget、sensitive payload 和 required checks；library scale 测试经 `validateLibraryGraph` 后再正式 query。 |
| D07_incremental_scaling | PASS_WITH_RISK | 成员 manifest sha256 / generation 与 stale detection 存在；automatic repair 与 incremental refresh lifecycle 仍为保留风险。 |
| D08_security_privacy | PASS | forbidden fields、provider payload、raw prompt/completion、绝对路径和 query-log 类文本有质量门或 fail-closed 测试；CLI 输出验证不泄露 graph vault 绝对路径。 |
| D09_cli_operability | PASS | CLI 覆盖 missing index、legacy catalog-only migration、failed/staging CURRENT、scope ambiguity、timing metadata 和 upper deepening success/error typed behavior。 |
| D10_testability | PASS | 当前测试覆盖 package-local ready 闭环、删除 catalog projection 后显式 query、fixed budget scale、row budget tamper、sensitive scan、stale member、single-book hotplug 与 qmd vsearch 非回归。 |

**Implementation Audit Coverage**

- 单书包复制传播完整性不回归：PASS。hotplug creation/runtime/catalog/qmd
  projection/capability 回归 26 passed。
- 书架/library 派生索引不污染单书包：PASS。upper tests 使用独立 package root；
  单书回归通过。
- 书架/library 上层包闭包不写入 `graph_vault/catalog/**`：PASS。catalog 仅
  projection，projection schema 标明 `catalogIsAuthority: false`。
- 删除 catalog projection 不影响显式 query：PASS。bookshelf/library graph tests
  均覆盖删除 projection 后显式 package query。
- runner ledger 不参与语义检索：PASS_WITH_RISK。upper query evidence 与 locators
  来自 package-local upper artifacts；本轮未发现 `catalog/batch-runs` 参与语义输入。
- 查询预算不随书籍数量线性增长：PASS。library 10/100/1000 represented book scale
  测试通过并验证 budget fingerprint 固定。
- evidence lineage 可追溯：PASS_WITH_RISK。静态代码与测试覆盖关键 lineage 字段；
  LLM synthesis 仍是 future capability。
- staging/failed/running/pending/stale 不被当作 ready：PASS。`CURRENT` 非
  query-ready 和 stale member 测试覆盖 fail-closed。
- manifest、quality gate、publish marker 状态闭环完整：PASS。`readQueryReadyPackage`
  与 validators 校验 package-local manifest/gate/marker/sidecar。
- CLI typed error 与 timing 可观测：PASS。missing、migration、failed/staging、
  over-budget 等 typed errors 有覆盖；timingAvailable 在 CLI tests 中断言。
- 敏感信息不进入可发布索引：PASS。forbidden text scan 和 polluted parquet
  fail-closed 有覆盖。
- 现有单书 GraphRAG 查询和 qmd vsearch 不回归：PASS。单书 GraphRAG scope 与
  vsearch 聚焦回归通过。

**Findings by severity**

High: 无。

Medium: 无。

Low:

1. 真实外部 provider smoke 未执行。

   - Evidence: 本轮验证使用 local tests、fake bridge 和 fixture packages。
   - Impact: 不影响 package-local authority、fixed budget 或 typed error 合同，
     但不能宣称真实 provider 端到端已完全闭环。
   - Required fix: 无阻断修复；provider 和网络可用时补充 smoke，并按真实状态
     记录 blocked / failed / recoverable / passed。

2. LLM synthesis 与 repair / incremental lifecycle 仍在本轮范围之外。

   - Evidence: 当前实现聚焦 fixed-budget upper report query、package-local
     closure 和 controlled deepening；Type DD 仍将 LLM synthesis、repair、
     incremental lifecycle 作为 remaining / future capability。
   - Impact: 不阻断 turn_017/018 required fixes，但不能宣称层级 GraphRAG 的
     所有远期能力完成。
   - Required fix: 无本轮阻断修复；后续阶段需独立合同、测试和审计。

3. 大型组合测试总耗时仍偏高。

   - Evidence: 一次并行组合运行因外层 360s command timeout 未形成干净通过证据，
     但对应关键拆分测试已分别通过，且 library scale 单测已从 120s timeout 风险
     降至约 30-35s。
   - Impact: 当前阻断项已闭合；CI 若继续把多个重 I/O upper graph suites 放在
     一个短外层 timeout 下，仍可能出现命令级 timeout。
   - Required fix: 无阻断修复；建议后续 CI 将 upper graph suites 分片或提高组合
     命令外层 timeout。

**Residual risks**

- 真实外部 provider 单书 GraphRAG 与 controlled deepening smoke 未执行。
- LLM synthesis over selected upper semantic units 尚未实现。
- Membership automatic repair 与 incremental refresh management lifecycle 尚未完成。
- Query bridge 仍依赖 build-time row-bound、validator row budget 和 query-time
  budget guard 共同证明固定预算。
- 当前工作区仍有未提交变更；本报告只覆盖当前快照。

**Required fixes**

无阻断 required fixes。
