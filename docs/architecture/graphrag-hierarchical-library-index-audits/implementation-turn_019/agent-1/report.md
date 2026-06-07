**Result**

PASS_WITH_RISK。

implementation-turn_018 agent-3 的阻断项已闭合：`test/graphrag-library-graph.test.ts`
中的 `keeps library query budget fixed at simulated 10, 100, and 1000 book scale`
在当前工作区单独运行通过，测试体耗时 35.644 秒，总耗时 38.79 秒，低于该测试
自身 120 秒 timeout，且不再接近 timeout。该测试仍通过 package-local manifest、
quality gate、`CURRENT.json`、`PUBLISH_READY.json`、validator 和
`queryLibraryGraph` 正式 API 验证 library 10/100/1000 represented book scale
下的 fixed query budget。

本轮未发现必须修复项。保留风险主要是：上层核心测试组合命令整体耗时仍高，在
360 秒外层命令限制内未完成；本 agent 尝试重跑 hotplug 聚焦回归时进程收到
`SIGTERM`，因此本报告不能新增 hotplug 通过证据；真实外部 provider smoke、
LLM synthesis、membership repair 和 incremental lifecycle 仍未闭合。

**Scope**

本报告只审计当前工作区，不修改实现文件、测试文件或历史审计报告。唯一写入目标：

- `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_019/agent-1/report.md`

规范输入：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

重点复核：

1. library 10/100/1000 scale package-local 测试是否在优化后闭合。
2. turn_017 三项原始失败是否仍闭合。
3. 固定实施审计维度（implementation audit dimensions）下是否存在阻断缺口。

**Evidence**

- `git status --short --branch` 显示当前分支为
  `main...origin/main [ahead 3]`，且存在未提交实现、测试、Type DD 和审计目录
  变更；本报告审计该当前工作区状态。
- TypeScript 验证通过：
  `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`。
- YAML 验证通过：
  `node -e "const fs=require('fs'); const yaml=require('yaml'); for (const p of ['docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml','docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml']) yaml.parse(fs.readFileSync(p,'utf8')); console.log('yaml ok')"`，
  输出 `yaml ok`。
- 阻断项聚焦验证通过：
  `TIMEFORMAT='elapsed=%R'; time node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/graphrag-library-graph.test.ts -t "keeps library query budget fixed at simulated 10, 100, and 1000 book scale"`。
  结果：1 passed；测试体耗时 35644ms；Vitest duration 38.79s；shell total
  39.389s。
- `test/graphrag-library-graph.test.ts:1207-1362` 当前 scale 测试使用固定
  4 个 synthetic bookshelf packages 表示 library 层级，分别汇总出
  representedBookCount 10、100、1000；每个 scale 都发布 synthetic member
  bookshelf package，构建 library parquet artifacts，发布 synthetic library
  package，并运行 `validateLibraryGraph` 与 `queryLibraryGraph`。
- `test/graphrag-library-graph.test.ts:1281-1296` 写入 library package-local
  manifest/gate/publish 闭包所需 artifact rows；`test/graphrag-library-graph.test.ts:1297-1301`
  调用 `validateLibraryGraph`；`test/graphrag-library-graph.test.ts:1302-1309`
  调用 `queryLibraryGraph` 正式 API。
- `test/graphrag-library-graph.test.ts:1344-1362` 断言 validation ok、
  diagnostics 为空、representedBookCount 等于 scale、semanticUnitCount 固定为
  8、selectedReportCount 固定为 3，并比较 budget fingerprint，确认
  reportCount、selectedReportCount、estimatedInputTokens、evidenceCount 不随
  represented book count 增长。
- `test/graphrag-library-graph.test.ts:509-833` 的
  `publishSyntheticLibraryPackage` 写入 `LIBRARY_MANIFEST.json`、
  `state/library-quality-gate.json`、`CURRENT.json` 和 `PUBLISH_READY.json`，
  并维护 manifest sha256 sidecar。
- `src/graphrag/upper-index/library-graph-validator.ts:173-251` 通过
  `validateLibraryGraphAtRoot` 检查 generation-local manifest/gate、manifest
  file closure、sidecar、parquet inspection、artifact row budget、evidence map
  row count，并经 `readQueryReadyPackage` 校验 member bookshelf package。
- `src/graphrag/upper-index/upper-package-paths.ts:275-381` 的
  `readQueryReadyPackage` 校验 package root、`CURRENT.json`、generation manifest、
  root manifest、quality gate、`PUBLISH_READY.json`、sha256 sidecar 和 scope
  一致性。缺 package root 但存在 legacy catalog-only artifacts 时返回
  `upper_package_migration_required:legacy_catalog_only`。
- `src/graphrag/upper-index/library-query.ts:97-143` 与
  `src/graphrag/upper-index/bookshelf-query.ts:97-143` 的
  `resolveRequestedBudget` 对 invalid / over-package `maxReports`、`maxInputTokens`
  fail-closed，并抛出 `budget_exceeded_narrow_scope_required`。正式 query API 在
  读取 package-local scope 后使用该预算解析逻辑。
- `test/graphrag-library-graph.test.ts:1053-1080` 覆盖 library exported query API
  不能通过 `maxReports` 或 `maxInputTokens` 放宽 package-local budget。
- `test/graphrag-bookshelf-graph.test.ts:774-801` 覆盖 bookshelf exported query API
  不能通过 `maxReports` 或 `maxInputTokens` 放宽 package-local budget。
- `test/graphrag-library-graph.test.ts:1036-1051` 删除 catalog projection 后仍可
  显式 `queryLibraryGraph`；`test/graphrag-bookshelf-graph.test.ts:757-772`
  删除 catalog projection 后仍可显式 `queryBookshelfGraph`。
- `src/graphrag/upper-index/upper-catalog-projection.ts:26-37` 将 projection source
  固定为 `upper_package_manifest`，readiness proof 固定为
  `package_local_current_publish_ready_quality_gate`，且 `catalogIsAuthority:
  false`。
- CLI upper 测试通过：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/cli-graphrag-query-scope.test.ts test/cli-graphrag-route.test.ts test/cli-graphrag-upper-index-failclosed.test.ts`。
  结果：3 files passed，33 tests passed；duration 220.62s。
- `test/cli-graphrag-route.test.ts:1435-1480` 覆盖
  `qmd query --library-id --upper-deepening calls bounded member books`，断言
  exit code 0、输出包含 controlled deepening 文本、evidence 含
  `upperDeepening: true`、fake bridge request 数为 1、`selectedBookIds` 长度为
  1、`graphCapabilityIds` 长度为 1，且输出 JSON 不包含本地 graph vault 绝对路径。
- qmd vsearch 聚焦非回归通过：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`。
  结果：1 passed；测试体耗时 7666ms。
- store vector search 聚焦非回归通过：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/store.test.ts -t "vectorSearchQuery does not expand the query or call generation"`。
  结果：1 passed；测试体耗时 551ms。
- 上层核心组合命令：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/graphrag-controlled-deepening.test.ts test/graphrag-bookshelf-graph.test.ts test/graphrag-library-graph.test.ts`
  在 360 秒外层命令限制内未完成，退出码 124。已完成部分均为通过，包括
  bookshelf scale 108500ms 和 library publish test 53274ms。该结果不推翻
  library scale 聚焦测试闭合，但说明组合套件仍需拆分或提高 runner budget。
- 本 agent 尝试重跑 hotplug 聚焦回归：
  `test/graphrag-book-hotplug-creation-gate.test.ts test/graphrag-book-hotplug-runtime-gate.test.ts test/graphrag-capability-scope.test.ts`
  以及
  `test/graphrag-book-hotplug-catalog.test.ts test/graphrag-book-hotplug-qmd-projection.test.ts`，
  两条命令均收到 `SIGTERM`，退出码 143。本报告不将其计为通过证据。

**Turn 017 Fix Closure**

1. Upper exported query API 预算放宽问题：已闭合。
   `queryBookshelfGraph` 与 `queryLibraryGraph` 均禁止请求超过 package-local
   fixed budget 的 `maxReports` / `maxInputTokens`，并有 fail-closed 测试。
2. Bookshelf/library scale 绕过 package-local 闭环问题：已闭合。
   library scale 测试当前经 manifest、quality gate、`CURRENT.json`、
   `PUBLISH_READY.json`、validator 和正式 query API；bookshelf scale 同类路径已在
   graph tests 中覆盖。
3. Library CLI controlled deepening 成功路径缺口：已闭合。
   `qmd query --library-id --upper-deepening` 测试验证 bounded member book
   invocation，只产生 1 次 fake bridge member book request。

**D01-D10 Table**

| ID | Result | Evidence / Rationale |
|---|---|---|
| D01_authority_boundaries | PASS | 显式 upper query 经 `readQueryReadyPackage` 读取 package root、`CURRENT`、manifest、quality gate 与 `PUBLISH_READY`。catalog projection 标记 `catalogIsAuthority: false`。未见 upper 写回单书包闭包。 |
| D02_fixed_query_budget | PASS | library 10/100/1000 represented book scale 聚焦测试通过，且 budget fingerprint 固定。exported query API 禁止放宽 `maxReports` / `maxInputTokens`。 |
| D03_graphrag_semantic_alignment | PASS | 上层构建与查询围绕 semantic units、semantic edges、communities、community reports 与 evidence map；未把多本书临时拼接成超大交互查询。 |
| D04_evidence_traceability | PASS_WITH_RISK | evidence lineage 覆盖 book/source/document/contentHash/text unit/community report 字段，controlled deepening evidence 经过 portable locator 清洗。真实 LLM synthesis 仍未完成。 |
| D05_state_recovery | PASS | `CURRENT` 非 query-ready、failed/staging/pending 状态通过 query path fail-closed；package root publish marker 和 sidecar 被读取校验。 |
| D06_quality_gates | PASS | validators 检查 manifest schema、quality gate checks、file closure、checksum sidecar、artifact row budget、member manifest stale 和 evidence map row count。 |
| D07_incremental_scaling | PASS_WITH_RISK | member manifest sha256 与 generation stale detection 存在；membership repair、automatic migration、incremental refresh lifecycle 仍是 retained risk。 |
| D08_security_privacy | PASS | sensitivity policy、validator/test 覆盖 provider payload、raw prompt/completion、absolute path 与 query-log 样式敏感内容；CLI upper 输出不包含 graph vault 绝对路径。 |
| D09_cli_operability | PASS | CLI upper typed error、timing availability、legacy catalog-only migration error、scope ambiguity、bookshelf/library controlled deepening 成功与错误路径均有测试。 |
| D10_testability | PASS_WITH_RISK | 阻断的 library scale package-local 测试已在 38.79s 内通过；CLI upper 与 vsearch 聚焦回归通过。上层核心组合命令仍因整体耗时在 360s 外层限制内未完成，hotplug 本 agent 重跑被 `SIGTERM` 终止。 |

**Findings by Severity**

High:

无阻断发现。

Medium:

1. 上层核心组合测试仍存在整体耗时风险。

   - Evidence:
     组合运行 `test/graphrag-controlled-deepening.test.ts`
     `test/graphrag-bookshelf-graph.test.ts`
     `test/graphrag-library-graph.test.ts` 在 360 秒外层命令限制内未完成。
   - Impact:
     library scale 阻断测试本身已降至 35.644 秒并通过；组合命令超时反映的是
     suite aggregate cost，不是当前阻断项未闭合。但若 CI 使用同一外层限制，
     仍可能出现不稳定或长时间排队。
   - Recommendation:
     将 upper graph scale/contract tests 分组运行，或为该组合配置更高外层
     runner timeout。提交前宜补一轮拆分后的 upper graph 全量测试。

Low:

1. 本 agent 未新增 hotplug 通过证据。

   - Evidence:
     本 agent 尝试运行 hotplug creation/runtime/capability 与 catalog/qmd
     projection 聚焦回归，两条命令均收到 `SIGTERM`，退出码 143。
   - Impact:
     当前改动主要集中在 upper-index、CLI upper query 与测试；既有 turn_018
     审计报告记录过 hotplug 通过，但本报告不能把这次中断重跑计为通过。
   - Recommendation:
     提交前再次顺序重跑 hotplug 聚焦回归，避免并行 runner 或外层中断影响。

2. 真实外部 provider smoke 未执行。

   - Evidence:
     当前通过证据依赖 fake bridge / test fixtures；未执行真实 provider 的
     single-book GraphRAG 或 controlled deepening smoke。
   - Impact:
     不阻断 package-local contract 和 fixed-budget 修复判断，但不能宣称完整
     production provider path 已验证。
   - Recommendation:
     provider、网络和凭据可用时补充一次真实 smoke；不可用时标记 blocked /
     recoverable，不使用 fixture-only 结果替代。

**Residual Risks**

- Full upper graph test suite aggregate runtime 仍高，需要拆分运行或提高外层
  runner timeout。
- 本 agent 的 hotplug 聚焦重跑被 `SIGTERM` 终止；提交前仍建议补跑并记录通过
  结果。
- LLM synthesis over selected upper semantic units 仍是 future capability；当前实现
  是 fixed-budget upper report search 加可选 controlled deepening。
- Membership repair、automatic migration、incremental refresh lifecycle 仍未作为
  本轮完成能力闭合。
- 真实外部 provider smoke 未执行。
- 当前工作区仍有未提交实现、测试、Type DD 和审计变更；历史
  implementation-turn_016 / implementation-turn_017 / implementation-turn_018 报告
  应保持原样。

**Required Fixes**

无阻断性 required fixes。

提交前建议补充但不改变本轮结论的验证：

1. 顺序重跑 hotplug 聚焦回归：
   `test/graphrag-book-hotplug-creation-gate.test.ts`
   `test/graphrag-book-hotplug-runtime-gate.test.ts`
   `test/graphrag-capability-scope.test.ts`
   `test/graphrag-book-hotplug-catalog.test.ts`
   `test/graphrag-book-hotplug-qmd-projection.test.ts`。
2. 将 upper graph full suite 拆分为较小命令，或提高外层 timeout 后重跑完整
   upper graph 测试组。
3. provider 可用时补充真实 GraphRAG smoke，并按 blocked / failed /
   recoverable / passed 明确记录。
