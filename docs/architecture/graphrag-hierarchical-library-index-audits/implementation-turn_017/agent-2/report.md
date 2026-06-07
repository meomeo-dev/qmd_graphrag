**Result**

FAIL（implementation-readiness 未通过）。implementation-turn_016 agent-2
提出的四项 required fixes 已有实质性修复：upper scope capability 已改为
`graph_query`，query readiness validator 已重新检查实际 parquet row counts，
CLI 级 `--upper-deepening` 成功与错误路径测试已补齐，bookshelf/library
10/100/1000 scale 测试也已存在并通过定向运行。

但当前工作区仍存在固定预算（fixed budget）阻断项：upper query 内部 API 允许
调用方用 `maxReports` 和 `maxInputTokens` 放宽 package-local manifest 预算；同时
scale 测试直接调用 bridge，绕过 package-local validator，不能证明正式发布包在
10/100/1000 规模下仍 query-ready。按固定审计基准 D02/D06/D10，不能判定 PASS。

**Scope**

审计范围为当前工作区实现，不修改实现代码，不修改历史审计报告。重点文件：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `src/graphrag/upper-index/upper-query-capability.ts`
- `src/graphrag/upper-index/bookshelf-query.ts`
- `src/graphrag/upper-index/library-query.ts`
- `src/graphrag/upper-index/bookshelf-graph-validator.ts`
- `src/graphrag/upper-index/library-graph-validator.ts`
- `src/graphrag/upper-index/controlled-deepening.ts`
- `src/cli/qmd.ts`
- `test/graphrag-controlled-deepening.test.ts`
- `test/graphrag-bookshelf-graph.test.ts`
- `test/graphrag-library-graph.test.ts`
- `test/cli-graphrag-route.test.ts`

**Evidence**

- `git status --short --branch` 显示当前分支 `main...origin/main [ahead 3]`，
  且存在未提交实现、测试、Type DD 与审计目录变更；本报告审计的是当前工作区。
- Type DD `queryContract.interactiveBudget.rule` 规定预算只能向下配置：
  “may be configurable downward”，不能放宽 package active budget。
- Type DD `retrieval.firstStage.boundedBy` 绑定 `maxSemanticUnits`、
  `maxBookshelves` 与 `maxInputTokens`；`secondStage` 绑定
  `maxBooksForDeepening` 和 `maxMemberCommunityRefs`。
- `upper-query-capability.ts` 生成单个 scope-level `graph_query` capability，
  `capabilityId` 格式为 `<scopeKind>:<scopeId>:<generation>:<method>:graph_query`。
- `bookshelf-query.ts` 与 `library-query.ts` 的 evidence `graphCapabilityId`
  使用同一 `upperGraphQueryCapabilityId`。
- `bookshelf-graph-validator.ts` 与 `library-graph-validator.ts` 已检查
  `semantic_units.parquet`、`community_reports.parquet` 实际 row count，
  并在超出 `fixedQueryBudget.maxSemanticUnits` 时产生
  `budget_exceeded_narrow_scope_required:<artifact>:...` 诊断。
- `queryBookshelfGraph` 和 `queryLibraryGraph` 仍把
  `input.maxReports ?? scope.maxReports`、`input.maxInputTokens ?? scope.maxInputTokens`
  直接传给 query bridge；若内部调用方传入更大值，会放宽 package budget。
- `scripts/graphrag/bookshelf_graph_bridge_query.py` 只按 payload 的
  `maxReports` 与 `maxInputTokens` 选择 reports 和判定 token 预算，不知道
  package-local manifest 上限。
- `test/graphrag-bookshelf-graph.test.ts` 与
  `test/graphrag-library-graph.test.ts` 的 scale 测试直接调用
  `runBookshelfGraphParquetBridge` 与 `runBookshelfGraphQueryBridge`，
  没有发布 package，也没有运行 `validateBookshelfGraphAtRoot` /
  `validateLibraryGraphAtRoot`。测试还允许 `reportCount <= 9`，而 validator
  对 `maxSemanticUnits: 8` 要求 `community_reports.parquet` 不得超过 8。
- 定向验证命令已运行并通过：
  - `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/graphrag-controlled-deepening.test.ts test/graphrag-bookshelf-graph.test.ts test/graphrag-library-graph.test.ts -t "controlled deepening|actual upper artifact rows|actual library artifact rows|keeps bookshelf query budget|keeps library query budget|publishes a query-ready bookshelf graph|publishes a query-ready library graph"`：11 passed。
  - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/cli-graphrag-route.test.ts -t "upper-deepening|upper deepening"`：4 passed。

**D01-D10 Table**

| ID | Result | Evidence / Rationale |
|---|---|---|
| D01 | PASS_WITH_RISK | 显式 upper query 先读 package root、`CURRENT`、manifest、`PUBLISH_READY` 和 gate；catalog projection 删除后查询仍可运行。工作区未见 upper query 写回单书包。 |
| D02 | FAIL | 正常 CLI 路径使用 package budget，controlled deepening 有界；但 exported query API 可通过 `maxReports` / `maxInputTokens` 放宽 manifest active budget，违反“只可向下配置”。 |
| D03 | PASS | 上层构建使用 community reports、semantic units、semantic edges、communities 和 evidence map；未退化为普通摘要拼接。 |
| D04 | PASS_WITH_RISK | evidence lineage 覆盖 book/source/document/contentHash/text unit/community report；upper graph capability id 已与 evidence 对齐。残余风险为 LLM synthesis future。 |
| D05 | PASS | package-local staging、generation、`CURRENT`、`PUBLISH_READY` 与 quality gate 校验路径存在；failed/staging/pending CURRENT 在测试中 fail-closed。 |
| D06 | FAIL | row-count validator 已补齐，但正式 scale 测试未通过 package-local validator；且查询 API 可放宽 active budget，质量门不能封住所有查询入口。 |
| D07 | PASS_WITH_RISK | 成员 manifest sha256 / generation 记录和 stale detection 存在；增量刷新 lifecycle 仍是 retained risk，不作为本轮阻断。 |
| D08 | PASS | manifest path normalization、sidecar checksum、sensitive payload scan 与 locator sanitization 覆盖主要发布面；未见 provider payload/raw prompt 写入上层发布索引。 |
| D09 | PASS_WITH_RISK | CLI typed errors、timing、scope ambiguity、legacy catalog-only migration 和 upper deepening success/error tests 已覆盖；library CLI deepening success 未单独覆盖。 |
| D10 | FAIL | implementation-turn_016 四项测试缺口大多补齐，但 scale 测试没有验证正式 package query-ready 闭环，且缺少“调用方试图放宽 upper query budget 必须 fail-closed 或 clamp”的测试。 |

**Findings by severity**

High: 无。

Medium:

1. Upper query API 允许调用方放宽 package-local fixed query budget。

   - Evidence: `queryBookshelfGraph` 使用 `input.maxReports ?? scope.maxReports`
     与 `input.maxInputTokens ?? scope.maxInputTokens`；`queryLibraryGraph` 使用
     同样模式。`scope.maxReports` 和 `scope.maxInputTokens` 来自 manifest，但
     显式 input 覆盖没有 clamp 或 fail-closed。
   - Evidence: Type DD 规定 runtime defaults “may be configurable downward”，
     且 selected evidence 不能 fit active budget 时必须 fail closed 或要求更窄
     scope。
   - Impact: 当前 CLI 未暴露 upper `maxReports` / `maxInputTokens` 查询参数，
     因此不是直接 CLI 漏洞；但这两个函数是 exported upper query API。后续 router、
     management command 或 tests 直接调用时可把 package budget 放大，破坏
     package-local fixed-budget authority。
   - Required fix: 对 `maxReports` 与 `maxInputTokens` 采用
     `Math.min(requested, packageBudget)`，或当 requested 大于 package budget 时
     fail-closed 为 `budget_exceeded_narrow_scope_required`。同时增加 bookshelf
     和 library 单元/合同测试，断言放宽请求不能增加 selected reports 或 token
     上限，且可观测地返回 typed error 或 clamp 结果。

2. Bookshelf/library scale tests 绕过 package-local validator，不能证明正式
   query-ready 包满足固定预算。

   - Evidence: scale 测试直接调用 `runBookshelfGraphParquetBridge(mode: "build")`
     / `runBookshelfGraphParquetBridge(mode: "build-library")` 和
     `runBookshelfGraphQueryBridge`，没有生成 `BOOKSHELF_MANIFEST.json` /
     `LIBRARY_MANIFEST.json`、`CURRENT.json`、`PUBLISH_READY.json`，也没有运行
     package-local validator。
   - Evidence: 测试在 `maxSemanticUnits: 8` 下允许 `reportCount <= 9`，而当前
     validator 已把 `community_reports.parquet` 实际 rows 超过
     `fixedQueryBudget.maxSemanticUnits` 视为
     `budget_exceeded_narrow_scope_required`。
   - Impact: 10/100/1000 scale bridge 测试可以通过，但同样 artifact 若进入正式
     package readiness validation 可能不 query-ready。该测试不能闭合
     implementation-turn_016 agent-2 要求的 bookshelf/library scale fixed-budget
     证明。
   - Required fix: 调整 builder 或 validator，使 `community_reports.parquet`
     row count 与 `maxSemanticUnits` 规则一致；然后把 scale 测试提升到
     package-local 闭环，至少运行 `validateBookshelfGraphAtRoot` /
     `validateLibraryGraphAtRoot`，并断言正式查询路径返回固定
     `selectedReportCount`、bounded timing 与 evidence lineage。

Low:

3. CLI controlled deepening 只覆盖 bookshelf scope，library scope 没有同等级 CLI
   成功路径测试。

   - Evidence: `test/cli-graphrag-route.test.ts` 覆盖 bookshelf 默认关闭、显式
     `--upper-deepening` 成功、预算超限、缺 member book capability。未见
     `qmd query --library-id --upper-deepening` 的 CLI success/error 对称测试。
   - Impact: library controlled deepening 函数级测试覆盖去重，query implementation
     静态可见；但 CLI wiring 对 library 分支仍缺少端到端防回归。
   - Required fix: 增加最小 library CLI controlled-deepening test，覆盖显式开启后
     只调用 `maxBookshelves` / requested narrower target 数量。

**Residual risks**

- 真实外部 provider 单书 deepening 成功路径未执行；当前验证仍依赖 fake bridge /
  injectable runner。
- LLM synthesis over selected upper semantic units 仍为 future capability；当前实现
  是 fixed-budget report search 加可选 controlled deepening。
- Membership creation、automatic repair、incremental refresh management lifecycle
  仍是 retained risk，不应宣称项目整体完成。
- Query bridge 仍会读取 bounded upper `community_reports.parquet` 全文件后排序；
  当前依赖 build-time row-bound 与 query-time validator 保证该文件有界。

**Required fixes**

1. 在 `queryBookshelfGraph` 与 `queryLibraryGraph` 中禁止放宽 package-local
   `maxReports` / `maxInputTokens`。请求值大于 manifest budget 时必须 clamp 或
   fail-closed，并增加对应测试。
2. 修正正式 builder/validator/test 的 scale budget 闭环：10/100/1000 scale 测试
   必须经过 package-local manifest、quality gate、`CURRENT`、`PUBLISH_READY` 和
   validator，而不是只测 bridge；`community_reports.parquet` row count 与
   `maxSemanticUnits` 规则必须一致。
3. 增加 library CLI `--upper-deepening` 最小成功路径测试，与 bookshelf CLI 测试
   对称覆盖 bounded member book invocation。
