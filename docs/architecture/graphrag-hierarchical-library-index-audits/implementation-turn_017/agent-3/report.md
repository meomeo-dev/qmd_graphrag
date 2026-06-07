**Result**

FAIL。

当前实现已明显推进 implementation-turn_016 的主要缺口：CLI typed error、
single-book hotplug 回归、上层 package-local authority、legacy catalog-only
migration error、显式上层 package query 无 catalog projection 依赖、controlled
deepening 默认关闭与固定目标数约束均有实现和测试证据。

但 implementation-turn_017 不能判定闭环（closed loop）：`queryBookshelfGraph`
与 `queryLibraryGraph` 的导出 API 仍允许调用方通过 `maxReports` 和
`maxInputTokens` 放宽 package-local manifest 的固定预算（fixed budget）。此外，
bookshelf/library scale 测试仍直接调用 parquet bridge，未完整经过正式
package-local manifest、quality gate、`CURRENT.json`、`PUBLISH_READY.json` 和
validator 闭环。按 D02、D06、D10，当前轮次仍需修复。

**Scope**

本报告独立审计当前工作区实现，不修改实现代码，不修改
`implementation-turn_016` 或 `design-turn_*` 历史报告。重点覆盖：

- CLI/query/runtime observability。
- 单书 hotplug 非回归。
- 安全与隐私发布面。
- 书架与 library 上层包权威闭包。
- `controlled deepening` 默认关闭、显式开启、预算限制和 stale fail-closed。
- catalog projection 只作为 package-root 派生视图。

规范输入：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

**Evidence**

- 工作区状态：`git status --short --branch` 显示 `main...origin/main [ahead 3]`，
  当前有未提交实现、测试和审计目录变更；本报告审计当前工作区。
- TypeScript 验证通过：
  `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`。
- YAML 验证通过：Type DD 与固定审计基准均可由 `yaml.parse` 解析。
- 上层查询权威校验：
  - `src/graphrag/upper-index/upper-package-paths.ts` 的
    `readQueryReadyPackage` 先检查 package root，再校验 `CURRENT.json`、
    generation-local manifest、root manifest、quality gate、`PUBLISH_READY.json`
    及 sidecar sha256；仅 legacy catalog artifact 且无 package root 时返回
    `upper_package_migration_required`。
  - `src/graphrag/upper-index/bookshelf-query.ts` 和 `library-query.ts` 的
    `readPublishedScope` 使用 `readQueryReadyPackage` 和 package-local validator，
    不使用 catalog projection 作为 query-ready 证明。
- catalog projection 派生性：
  - `src/graphrag/upper-index/upper-catalog-projection.ts` 在 projection 中写入
    `projectionSource: upper_package_manifest`、`readinessProof:
    package_local_current_publish_ready_quality_gate`、`catalogIsAuthority: false`。
  - `buildBookshelfGraph` 和 `buildLibraryGraph` 先发布上层包 root，再调用
    `rebuildBookshelfCatalogProjection` / `rebuildLibraryCatalogProjection`。
- CLI/query/runtime observability：
  - `src/cli/qmd.ts` 互斥 `--graph-book-id`、`--bookshelf-id`、`--library-id`。
  - `--max-deepening-targets` 缺少 `--upper-deepening` 时直接报错。
  - bookshelf/library 查询使用 `cli.query_bookshelf_upper_index` 和
    `cli.query_library_upper_index` timing stage；controlled deepening 使用
    `cli.resolve_deepening_book_graphrag_data_dir` 和
    `cli.invoke_deepening_graphrag_runtime`。
- controlled deepening：
  - `src/graphrag/upper-index/controlled-deepening.ts` 在 `enabled !== true` 时返回
    upper response，不调用单书 runtime。
  - requested target count 大于 package budget 时返回
    `budget_exceeded_narrow_scope_required`。
  - 被选 book 缺少 `graph_query` capability 时返回 `upper_index_stale`。
  - runtime/provider 失败被映射为 `upper_index_runtime_error`。
- upper scope capability：
  - `src/graphrag/upper-index/upper-query-capability.ts` 生成 scope-level
    `graph_query` capability；bookshelf/library query evidence 使用同一
    `upperGraphQueryCapabilityId`。
- query-time row budget validation：
  - `bookshelf-graph-validator.ts` 与 `library-graph-validator.ts` inspect 实际
    `semantic_units.parquet` 和 `community_reports.parquet` row counts，并在实际
    row count 超出 `fixedQueryBudget.maxSemanticUnits` 时产生
    `budget_exceeded_narrow_scope_required:<artifact>:...` 诊断。
- 安全隐私：
  - validators 拒绝绝对路径、`../`、URI-like manifest file paths。
  - bookshelf/library graph tests 覆盖敏感 payload text 进入 upper parquet 后查询
    fail-closed；controlled deepening evidence locator 经过 portable path 清洗。
  - single-book hotplug tests 覆盖 runtime reports、provider payload、undeclared
    payload 不进入可发布 book package closure。
- 通过的验证命令：
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/graphrag-controlled-deepening.test.ts`
    ：5 passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/graphrag-bookshelf-graph.test.ts`
    ：7 passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/graphrag-library-graph.test.ts`
    ：8 passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/cli-graphrag-route.test.ts`
    ：23 passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/cli-graphrag-query-scope.test.ts`
    ：8 passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/cli-graphrag-upper-index-failclosed.test.ts`
    ：1 passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/graphrag-book-hotplug-catalog.test.ts test/graphrag-book-hotplug-backfill.test.ts`
    ：20 passed。
- 不计为通过证据的命令：一次并行组合 vitest 因 300 秒外部 timeout 截断；随后已按
  文件拆分重跑并全部取得退出码 0。
- 阻断证据：
  - Type DD `queryContract.interactiveBudget.rule` 规定预算默认值只能向下配置；
    evidence fit 不进 active budget 时必须 fail closed 或要求 narrow scope。
  - `queryBookshelfGraph` 使用 `input.maxReports ?? scope.maxReports` 和
    `input.maxInputTokens ?? scope.maxInputTokens`。
  - `queryLibraryGraph` 使用同样模式。
  - `scripts/graphrag/bookshelf_graph_bridge_query.py` 只按 payload 中的
    `maxReports` 与 `maxInputTokens` 截取和判定预算，不知道 package-local manifest
    上限。
  - scale tests 直接调用 `runBookshelfGraphParquetBridge` 和
    `runBookshelfGraphQueryBridge`；未发布正式 upper package，也未运行
    `readQueryReadyPackage`、`validateBookshelfGraphAtRoot` 或
    `validateLibraryGraphAtRoot` 闭环。

**D01-D10 Table**

| ID | Result | Evidence / Rationale |
|---|---|---|
| D01_authority_boundaries | PASS | 显式 upper query 以 package root、`CURRENT`、manifest、`PUBLISH_READY` 和 gate 为权威；catalog projection 标记 `catalogIsAuthority: false`。单书 hotplug 回归测试通过，未见 upper 写回单书包。 |
| D02_fixed_query_budget | FAIL | CLI 与 controlled deepening 正常路径有界，但 exported upper query API 可通过 `maxReports` / `maxInputTokens` 放宽 package budget；bridge 只信任 payload。 |
| D03_graphrag_semantic_alignment | PASS | 上层输入和产物覆盖 community reports、semantic units、semantic edges、communities 与 evidence map，未退化为普通摘要拼接。 |
| D04_evidence_traceability | PASS_WITH_RISK | evidence lineage 覆盖 bookId、sourceId、documentId、contentHash、community report/text unit；真实 LLM synthesis future 仍未验证。 |
| D05_state_recovery | PASS | staging -> generation -> `CURRENT` -> root manifest/gate -> `PUBLISH_READY` 发布语义存在；failed/staging CURRENT 在 CLI tests 中 fail-closed。 |
| D06_quality_gates | FAIL | package-local gates 和 row-count validator 已补齐；但导出查询 API 可以放宽 active budget，且 scale 测试未经过正式 validator/package-ready 闭环。 |
| D07_incremental_scaling | PASS_WITH_RISK | 成员 manifest sha256 / generation 与 stale detection 存在；自动 repair 与增量 lifecycle 仍是保留风险。 |
| D08_security_privacy | PASS | 敏感 payload、绝对路径、provider payload、runtime reports 和 raw package pollution 均有实现或测试覆盖；发布面使用 digest/relative locator。 |
| D09_cli_operability | PASS_WITH_RISK | CLI typed errors、exit codes、scope ambiguity、timing stage、legacy migration 和 controlled deepening 路径均有测试；真实外部 provider smoke 未执行。 |
| D10_testability | FAIL | 聚焦测试大多通过；仍缺“调用方试图放宽 upper package budget 必须 fail-closed 或 clamp”的测试，scale 测试也未闭合正式 package-local query-ready 路径。 |

**Findings by severity**

High:

1. Upper query API 可放宽 package-local fixed query budget。

   - Evidence: `queryBookshelfGraph` 和 `queryLibraryGraph` 使用调用方传入的
     `maxReports` / `maxInputTokens` 覆盖 manifest budget。
   - Evidence: query bridge 只按 payload 执行，不校验 package manifest 上限。
   - Impact: CLI 当前未直接暴露这两个 upper query 参数，因此不是当前 CLI flag 的
     直接漏洞；但这两个函数是上层 query 导出入口。后续 router、management
     command 或测试调用可绕过 package-local fixed budget authority，违反
     D02 与 Type DD “may be configurable downward”。
   - Required fix: 对 requested `maxReports` / `maxInputTokens` 做
     `Math.min(requested, packageBudget)`，或当 requested 大于 package budget 时以
     `budget_exceeded_narrow_scope_required` fail-closed。补充 bookshelf 和 library
     测试，断言放宽请求不能增加 selected reports 或 token budget。

Medium:

2. Bookshelf/library scale tests 未证明正式 package-local query-ready 闭环。

   - Evidence: scale tests 直接调用 parquet bridge build/query；未生成 root
     manifest、quality gate、`CURRENT.json`、`PUBLISH_READY.json`，也未运行正式
     validator。
   - Evidence: tests 断言 fixed selected report count，但不验证正式 query path 在
     10/100/1000 规模下仍通过 package-local gates 与 manifest sha256。
   - Impact: 可以证明 bridge-level selected report count 固定，但不能证明 upper
     package 可复制、可发布、query-ready 的固定预算闭环。
   - Required fix: 把 scale test 提升到正式 package-local 闭环，至少运行
     `validateBookshelfGraphAtRoot` / `validateLibraryGraphAtRoot`，并通过
     `queryBookshelfGraph` / `queryLibraryGraph` 验证 selected report count、timing
     和 evidence lineage 不随规模线性增长。

Low:

3. Library CLI controlled deepening 缺少与 bookshelf 对称的端到端成功测试。

   - Evidence: CLI route tests 覆盖 bookshelf `--upper-deepening` 默认关闭、成功、
     预算超限和 stale book capability；library 分支主要由 implementation 静态路径和
     function-level dedupe test 间接覆盖。
   - Impact: 当前实现可见地支持 library 分支，但 CLI wiring 对称性仍有回归风险。
   - Required fix: 增加最小 `qmd query --library-id --upper-deepening` 成功路径测试，
     验证 bounded member book invocation 和 deepening evidence metadata。

**Residual risks**

- 真实外部 provider 单书 deepening smoke test 未在本审计中运行；当前通过的是 fake
  bridge / injectable runner 路径。
- LLM synthesis 仍为 future capability；当前实现是 fixed-budget upper report
  search 加可选 controlled deepening。
- Membership repair、自动迁移、增量 refresh lifecycle 仍是保留风险，不应宣称项目整体
  完成。
- Query bridge 会读取 bounded upper `community_reports.parquet` 文件后排序；当前依赖
  build-time/validator row-bound 保证该文件自身有界。

**Required fixes**

1. 修复 `queryBookshelfGraph` 与 `queryLibraryGraph` 的 budget override：请求预算只能
   收窄，不能放宽 package-local manifest budget；增加对应 bookshelf/library 测试。
2. 将 bookshelf/library 10/100/1000 scale fixed-budget 测试提升到正式
   package-local gates、`CURRENT.json`、`PUBLISH_READY.json`、manifest sha256 和
   validator 闭环，不只测试 parquet bridge。
3. 增加 library CLI `--upper-deepening` 成功路径最小回归测试，覆盖 bounded runtime
   invocation、timing 和 evidence metadata。
