**Result**

PASS_WITH_RISK。

implementation-turn_017 agent-2/3 的三项阻断已在当前工作区闭合：

- `queryBookshelfGraph` 与 `queryLibraryGraph` 的 exported API 已禁止
  `maxReports` / `maxInputTokens` 放宽 package-local manifest budget，并以
  `budget_exceeded_narrow_scope_required` fail closed。
- bookshelf/library 10/100/1000 scale 测试已发布 synthetic package-local
  closure，经过 manifest、quality gate、`CURRENT.json`、`PUBLISH_READY.json`、
  validator 和正式 `query*Graph` API。
- library CLI `--upper-deepening` 已有成功路径测试，且验证 bounded member
  book invocation。

本轮未发现阻断性 required fixes。保留风险为真实外部 provider smoke 未执行、
LLM synthesis 仍为 future capability、membership repair / incremental refresh
lifecycle 仍未闭环，以及 library scale 测试运行时间贴近单测 timeout。

**Scope**

审计对象为 `/Users/jin/projects/qmd_graphrag` 当前工作区。规范入口：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

历史 `implementation-turn_016` 与 `implementation-turn_017` 报告未修改。本报告
只写入：

- `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_018/agent-1/report.md`

**Evidence**

- 工作区状态：`git status --short --branch` 显示
  `main...origin/main [ahead 3]`，并存在未提交实现、测试、Type DD 与审计目录
  变更；本报告审计当前未提交工作区。
- Type DD 状态：`designAudit.currentRunDirectory` 指向
  `design-turn_016`，设计状态为 `design_audit_passed`。本轮未发现需要重新进入
  设计审计循环的规范冲突。
- YAML parse 通过：
  `node -e "... yaml.parse(...)"` 输出 `yaml ok`。
- TypeScript 通过：
  `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`。
- Exported upper query budget 修复证据：
  - `src/graphrag/upper-index/bookshelf-query.ts:97` 定义
    `resolveRequestedBudget`；当 requested `maxReports` 或 `maxInputTokens`
    大于 scope budget 时抛出 `budget_exceeded_narrow_scope_required`。
  - `src/graphrag/upper-index/bookshelf-query.ts:290` 在调用 parquet bridge 前解析
    budget，并在 payload 中只传入解析后的 `budget.maxReports` 与
    `budget.maxInputTokens`。
  - `src/graphrag/upper-index/library-query.ts:97` 与
    `src/graphrag/upper-index/library-query.ts:286` 对 library scope 使用相同
    fail-closed 规则。
  - `test/graphrag-bookshelf-graph.test.ts:774` 与 `:788` 测试 bookshelf
    `maxReports` / `maxInputTokens` 放宽请求会 fail closed。
  - `test/graphrag-library-graph.test.ts:1052` 与 `:1066` 测试 library
    `maxReports` / `maxInputTokens` 放宽请求会 fail closed。
- Package-local ready 闭环证据：
  - `src/graphrag/upper-index/upper-package-paths.ts:275` 的
    `readQueryReadyPackage` 校验 package root、`CURRENT.json`、generation manifest、
    root manifest、quality gate、`PUBLISH_READY.json` 与 sha256 sidecars。
  - `src/graphrag/upper-index/bookshelf-graph-validator.ts:78` 校验
    `BOOKSHELF_MANIFEST.json`、package-local gate、manifest files、sidecars、
    artifact row counts 与 member book manifest sha256。
  - `src/graphrag/upper-index/library-graph-validator.ts:173` 校验
    `LIBRARY_MANIFEST.json`、package-local gate、manifest files、sidecars、
    artifact row counts 与 member bookshelf query-ready package。
  - `test/graphrag-bookshelf-graph.test.ts:908` 的 scale 测试为 10/100/1000
    members 写入 synthetic book manifests，发布 bookshelf package，运行
    `validateBookshelfGraph`，再调用正式 `queryBookshelfGraph`。
  - `test/graphrag-library-graph.test.ts:1206` 的 scale 测试为 10/100/1000
    members 写入 synthetic member bookshelf packages，发布 library package，运行
    `validateLibraryGraph`，再调用正式 `queryLibraryGraph`。
- Catalog projection 非权威证据：
  - `src/graphrag/upper-index/upper-catalog-projection.ts:26` 将 projection source
    固定为 `upper_package_manifest`。
  - `src/graphrag/upper-index/upper-catalog-projection.ts:35` 和 `:36` 将
    readiness proof 固定为 package-local current/publish-ready/quality-gate，
    且 `catalogIsAuthority: false`。
  - `test/graphrag-bookshelf-graph.test.ts:766` 和
    `test/graphrag-library-graph.test.ts:1044` 删除 catalog projection 后显式
    package query 仍返回 evidence。
- Controlled deepening 证据：
  - `src/graphrag/upper-index/controlled-deepening.ts:101` 按 fixed limit 从 upper
    evidence 选择下钻目标；library scope 以 `targetBookshelfId` 去重。
  - `src/graphrag/upper-index/library-query.ts:428` 将 library 下钻预算绑定到
    manifest `fixedQueryBudget.maxBookshelves`。
  - `test/cli-graphrag-route.test.ts:1435` 覆盖
    `qmd query --library-id --upper-deepening` 成功路径，并断言 fake bridge
    request 数为 1、`selectedBookIds` 长度为 1、输出不包含绝对 graph vault path。
- 验证命令：
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/graphrag-controlled-deepening.test.ts test/graphrag-bookshelf-graph.test.ts`
    ：2 files / 12 tests passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/graphrag-library-graph.test.ts`
    ：1 file / 8 tests passed。library 10/100/1000 scale test 用时约
    117.942s。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/cli-graphrag-query-scope.test.ts test/cli-graphrag-route.test.ts test/cli-graphrag-upper-index-failclosed.test.ts`
    ：3 files / 33 tests passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/graphrag-book-hotplug-creation-gate.test.ts test/graphrag-book-hotplug-runtime-gate.test.ts test/graphrag-capability-scope.test.ts`
    ：3 files / 13 tests passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`
    ：1 focused test passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/store.test.ts -t "vectorSearchQuery does not expand the query or call generation"`
    ：1 focused test passed。
- 非阻断观察：一次将 controlled-deepening、bookshelf graph、library graph 三个
  long-running files 合并运行的命令在外层 420s timeout 截断；其中 library scale
  测试在并发负载下触发 per-test 120s timeout。随后按文件拆分重跑均退出码 0。

**D01-D10 Table**

| ID | Result | Evidence / Rationale |
|---|---|---|
| D01_authority_boundaries | PASS | 单书 hotplug creation/runtime/capability 回归通过。upper query 读取 package root、`CURRENT`、manifest、gate、`PUBLISH_READY`，未见书架/library 写回单书包闭包。 |
| D02_fixed_query_budget | PASS | `maxReports` / `maxInputTokens` 只能收窄，放宽请求 fail closed。bookshelf/library scale 测试在 10/100/1000 下验证 selected report count、tokens 与 evidence count 不随规模线性增长。 |
| D03_graphrag_semantic_alignment | PASS | 上层 artifacts 包含 semantic units、semantic edges、communities、community reports、evidence map；输入仍基于下层 community reports。 |
| D04_evidence_traceability | PASS | bookshelf/library query evidence 暴露 bookId、sourceId、documentId、contentHash、text unit、community report 和 package-relative locator。 |
| D05_state_recovery | PASS | `readQueryReadyPackage` 校验 CURRENT ready state、manifest sha256、root/generation copies、gate sidecars 与 publish marker；failed/staging CURRENT CLI tests fail closed。 |
| D06_quality_gates | PASS | bookshelf/library validators 校验 required checks、file closure、row count、member sha/generation stale、artifact budget 与 sidecars。 |
| D07_incremental_scaling | PASS_WITH_RISK | manifest 记录 member manifest sha256 / generation，library validator 可检测 member bookshelf stale。自动 repair 与 incremental refresh lifecycle 仍属 retained risk。 |
| D08_security_privacy | PASS | validators 拒绝绝对路径/URI-like file paths；测试覆盖 sensitive payload parquet pollution fail closed；deepening locator 经过 portable path 清洗。 |
| D09_cli_operability | PASS | CLI typed errors、scope ambiguity、legacy catalog-only migration、timing availability、bookshelf/library upper deepening success/error paths均有测试覆盖。 |
| D10_testability | PASS_WITH_RISK | required regression suites 均通过，且新增 scale/package-local/预算放宽/library deepening 测试闭合 turn_017 failures。风险是部分 long-running tests 贴近 timeout，组合并发运行不稳定。 |

**Findings by severity**

High: 无。

Medium: 无。

Low:

1. Library 10/100/1000 scale test 运行时间贴近单测 timeout。

   Evidence: `test/graphrag-library-graph.test.ts` 全文件重跑通过，但
   `keeps library query budget fixed at simulated 10, 100, and 1000 book scale`
   用时约 117.942s，接近该 test 显式 120s timeout。合并运行 upper graph 三个
   long-running files 时，该测试曾在外层负载下触发 per-test timeout。

   Impact: 不是实现合同阻断；拆分运行和单文件运行均通过。但 CI 并发负载较高时
   可能产生 flaky failure。

   Recommendation: 后续将 scale test timeout 提高到 180s，或把 10/100/1000
   case 拆成独立 tests，保留 package-local validator 与正式 query API 路径。

**Residual risks**

- 真实外部 provider 单书 deepening smoke 未执行；本轮通过 fake bridge /
  injectable runner 路径验证 CLI wiring 与 bounded invocation。
- LLM synthesis over selected upper semantic units 仍是 future capability；当前实现是
  fixed-budget upper report search 加 optional controlled deepening。
- Membership creation、automatic repair、incremental refresh management lifecycle
  仍是 retained risk，不应宣称整体项目完全完成。
- Query bridge 会读取已发布上层 `community_reports.parquet` 后排序；当前依赖
  build-time row-bound、validator 和 query-time ready checks 保证该文件本身有界。

**Required fixes**

无。
