**Result**

FAIL。

implementation-turn_017 agent-2/3 的前两项实现缺口已有实质修复：
`queryBookshelfGraph` 与 `queryLibraryGraph` 已禁止 `maxReports` 和
`maxInputTokens` 放宽 package-local manifest budget，并补充 fail-closed
测试；bookshelf scale 测试已通过 package-local manifest、quality gate、
`CURRENT.json`、`PUBLISH_READY.json`、validator 和正式 query API。

第三项 library CLI `--upper-deepening` 成功路径也已补齐并通过测试。但
library 10/100/1000 scale package-local 闭环测试当前单独运行仍在测试自身
120 秒超时内失败，不能作为 D02/D06/D10 的通过证据。因此本轮实施审计不能
判定为 PASS。

**Scope**

本报告审计当前工作区，不修改实现代码、测试代码或历史审计报告。唯一写入
文件为：

- `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_018/agent-3/report.md`

规范输入：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

重点复核 implementation-turn_017 agent-2/3 失败项：

1. upper exported query API 不能放宽 package-local fixed budget。
2. bookshelf/library 10/100/1000 scale 测试必须走正式 package-local
   query-ready 闭环。
3. library CLI `--upper-deepening` 必须有成功路径测试，并验证 bounded
   member book invocation。

**Evidence**

- `git status --short --branch` 显示当前分支为
  `main...origin/main [ahead 3]`，且存在未提交实现、测试、Type DD 和审计
  目录变更；本报告审计当前工作区状态。
- TypeScript 验证通过：
  `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`。
- YAML 验证通过：
  `node -e "const fs=require('fs'); const yaml=require('yaml'); for (const p of ['docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml','docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml']) yaml.parse(fs.readFileSync(p,'utf8')); console.log('yaml ok')"`。
- `src/graphrag/upper-index/bookshelf-query.ts` 的
  `resolveRequestedBudget` 对 invalid / over-package `maxReports` 和
  `maxInputTokens` 产生诊断，并以
  `budget_exceeded_narrow_scope_required` 抛出 `BookshelfQueryScopeError`。
- `src/graphrag/upper-index/library-query.ts` 使用同等
  `resolveRequestedBudget` 逻辑，并以
  `budget_exceeded_narrow_scope_required` 抛出 `LibraryQueryScopeError`。
- `test/graphrag-bookshelf-graph.test.ts` 覆盖：
  - 删除 catalog projection 后显式 `queryBookshelfGraph` 仍可查询。
  - `maxReports > manifest.fixedQueryBudget.maxSemanticUnits` fail-closed。
  - `maxInputTokens > manifest.fixedQueryBudget.maxInputTokens` fail-closed。
  - 10/100/1000 bookshelf scale 在 bridge build 后发布合成 package，运行
    `validateBookshelfGraph` 和 `queryBookshelfGraph`，并断言 validation ok、
    `reportCount <= 8`、`selectedReportCount === 3`。
- `test/graphrag-library-graph.test.ts` 覆盖：
  - 删除 catalog projection 后显式 `queryLibraryGraph` 仍可查询。
  - `maxReports > manifest.fixedQueryBudget.maxSemanticUnits` fail-closed。
  - `maxInputTokens > manifest.fixedQueryBudget.maxInputTokens` fail-closed。
  - 10/100/1000 library scale 测试写入合成 bookshelf member package，发布
    library package，运行 `validateLibraryGraph` 和 `queryLibraryGraph`。
- `test/cli-graphrag-route.test.ts` 已有
  `qmd query --library-id --upper-deepening calls bounded member books`，断言
  exit code 0、输出包含 controlled deepening 文本、evidence 含
  `upperDeepening: true`、fake bridge request 数为 1、`selectedBookIds` 长度
  为 1、`graphCapabilityIds` 长度为 1，且 JSON 输出不包含本地 graph vault
  绝对路径。
- `src/graphrag/upper-index/upper-package-paths.ts` 的 `readQueryReadyPackage`
  校验 package root、`CURRENT.json`、generation manifest、root manifest、
  quality gate、`PUBLISH_READY.json` 和 sidecar sha256；legacy catalog-only
  上层产物缺 package root 时返回 `upper_package_migration_required`。
- `src/graphrag/upper-index/upper-catalog-projection.ts` projection schema 固定
  `projectionSource: upper_package_manifest`、`readinessProof:
  package_local_current_publish_ready_quality_gate` 和
  `catalogIsAuthority: false`。
- `src/graphrag/upper-index/controlled-deepening.ts` 在 `enabled !== true` 时
  直接返回 upper response；requested target 超过 package budget 时
  fail-closed；缺 member book `graph_query` capability 时返回
  `upper_index_stale`。
- `scripts/graphrag/bookshelf_graph_bridge_build.py` 与
  `scripts/graphrag/library_graph_bridge_build.py` 已按 `maxSemanticUnits` 限制
  upper reports；validators 也检查 `community_reports.parquet` 实际 row count。
- CLI upper 测试通过：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/cli-graphrag-query-scope.test.ts test/cli-graphrag-route.test.ts test/cli-graphrag-upper-index-failclosed.test.ts`
  ：33 passed。
- 单书 hotplug creation/runtime/capability 回归通过：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/graphrag-book-hotplug-creation-gate.test.ts test/graphrag-book-hotplug-runtime-gate.test.ts test/graphrag-capability-scope.test.ts`
  ：13 passed。
- 单书 catalog/qmd projection 回归通过：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/graphrag-book-hotplug-catalog.test.ts test/graphrag-book-hotplug-qmd-projection.test.ts`
  ：13 passed。
- qmd vsearch 聚焦非回归通过：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`
  ：1 passed。
- store vector search 聚焦非回归通过：
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/store.test.ts -t "vectorSearchQuery does not expand the query or call generation"`
  ：1 passed。
- 阻断验证：组合运行
  `test/graphrag-controlled-deepening.test.ts test/graphrag-bookshelf-graph.test.ts test/graphrag-library-graph.test.ts`
  时，`test/graphrag-library-graph.test.ts` 的
  `keeps library query budget fixed at simulated 10, 100, and 1000 book scale`
  超时失败。
- 阻断验证：单独运行
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/graphrag-library-graph.test.ts -t "keeps library query budget fixed at simulated 10, 100, and 1000 book scale"`
  仍在 120000ms 测试自身 timeout 内失败，退出码 1。

**D01-D10 Table**

| ID | Result | Evidence / Rationale |
|---|---|---|
| D01_authority_boundaries | PASS | 显式 upper query 读取 package root、`CURRENT`、manifest、quality gate 和 `PUBLISH_READY`；catalog projection 标记 `catalogIsAuthority: false`。单书 hotplug 回归通过，未见 upper 写回单书包闭包。 |
| D02_fixed_query_budget | FAIL | exported query API 放宽问题已修复并测试；bookshelf scale package-local fixed budget 通过。但 library 10/100/1000 scale package-local 测试单独运行仍 timeout，无法证明 library 固定预算在目标规模下可运行闭环。 |
| D03_graphrag_semantic_alignment | PASS | 上层构建和查询围绕 community reports、semantic units、semantic edges、communities 与 evidence map；未退化为普通摘要拼接。 |
| D04_evidence_traceability | PASS_WITH_RISK | bookshelf/library query evidence 含 book/source/document/contentHash/text unit/community report lineage；controlled deepening evidence 经过 portable locator 清洗。真实 LLM synthesis 仍未完成。 |
| D05_state_recovery | PASS | package-local staging -> generation -> `CURRENT` -> root manifest/gate -> `PUBLISH_READY` 语义存在；failed/staging/pending CURRENT 在 CLI 或 graph tests 中 fail-closed。 |
| D06_quality_gates | FAIL | quality gate、sidecar、row-count validator 与 sensitive scan 有实现和测试；但 library scale ready 闭环测试当前超时失败，不能证明 10/100/1000 规模下 gate + validator + query API 可稳定完成。 |
| D07_incremental_scaling | PASS_WITH_RISK | 成员 manifest sha256 / generation 与 stale detection 存在；automatic repair 与 incremental refresh lifecycle 仍是保留风险。 |
| D08_security_privacy | PASS | validators / tests 覆盖绝对路径、provider payload、query.log 样式敏感内容和 portable locator；发布面使用 digest/relative locator。 |
| D09_cli_operability | PASS_WITH_RISK | CLI typed error、timing、scope ambiguity、legacy migration、bookshelf/library `--upper-deepening` 成功和错误路径均有测试；真实外部 provider smoke 未执行。 |
| D10_testability | FAIL | 大多数合同测试通过；关键 library 10/100/1000 package-local scale 测试在自身 timeout 内失败，导致固定预算规模证明不可用。 |

**Findings by severity**

High:

1. Library 10/100/1000 package-local fixed-budget scale test 当前不可通过。

   - Evidence:
     `test/graphrag-library-graph.test.ts:1206` 的
     `keeps library query budget fixed at simulated 10, 100, and 1000 book scale`
     单独运行时仍 `Test timed out in 120000ms`，退出码 1。
   - Evidence:
     命令为
     `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/graphrag-library-graph.test.ts -t "keeps library query budget fixed at simulated 10, 100, and 1000 book scale"`。
   - Impact:
     该测试正是 turn_017 agent-2/3 要求的 package-local scale 闭环证据。
     当前实现/测试虽然结构上已经纳入 manifest、quality gate、`CURRENT`、
     `PUBLISH_READY`、validator 和正式 query API，但测试无法在声明预算内完成，
     因此不能作为 D02/D06/D10 的 passing evidence。
   - Required fix:
     优化或拆分该测试，使 10/100/1000 library package-local scale 验证在 CI
     可接受时间内稳定通过。可行方向包括减少每个 scale 的重复 member package
     写入成本、复用最小 query-ready bookshelf member fixture、拆分 10/100/1000
     用例并给出合理 per-test timeout，或增加更轻量的 validator-only synthetic
     fixture；修复后必须重跑该测试和上层核心测试组。

Medium:

1. Library scale 测试每轮构造大量 synthetic bookshelf package，存在性能退化风险。

   - Evidence:
     `test/graphrag-library-graph.test.ts:1216-1252` 在每个 scale 内循环发布
     `scale` 个 synthetic bookshelf member package；1000 scale 会创建 1000 个
     package root、manifest、gate、publish marker 和 sidecar。
   - Impact:
     该做法符合 package-local 闭环意图，但当前成本过高，已经导致测试超时。
     若不优化，后续 CI 容易出现不稳定或长时间阻塞。
   - Required fix:
     保留 package-local authority 检查，但把 fixture 设计成最小化文件 I/O；
     必要时用共享 synthetic member artifact 与独立 manifest sha256 记录分离，
     或将 1000-scale 测试聚焦于 validator/query budget 不随成员数量增长的必要
     文件集合。

Low:

1. 实施仍缺真实外部 provider smoke 证据。

   - Evidence:
     当前通过测试依赖 fake bridge / injectable runner；未运行真实 provider
     的单书 controlled deepening smoke。
   - Impact:
     不阻断当前 package-local contract 修复判断，但不能宣称完整生产运行闭环。
   - Required fix:
     在 provider 和网络可用时补充一次真实 provider smoke，并把失败状态记为
     blocked / failed / recoverable，不用 mock-only 结果替代。

**Residual risks**

- LLM synthesis over selected upper semantic units 仍是 future capability；当前实现
  是 fixed-budget upper report search 加可选 controlled deepening。
- Membership repair、自动迁移、incremental refresh lifecycle 仍为 retained risk。
- Query bridge 仍读取 bounded upper parquet 文件后排序；当前依赖 build-time 和
  validator row-bound 保证发布文件自身有界。
- 当前工作区仍有未提交实现和审计变更；历史 implementation-turn_016 和
  implementation-turn_017 报告需保持原样。

**Required fixes**

1. 修复 `test/graphrag-library-graph.test.ts` 的
   `keeps library query budget fixed at simulated 10, 100, and 1000 book scale`
   超时问题，使其在 package-local manifest、quality gate、`CURRENT.json`、
   `PUBLISH_READY.json`、validator 和 `queryLibraryGraph` 正式 API 路径下稳定
   通过。
2. 修复后重跑：
   - `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
   - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 300000 test/graphrag-controlled-deepening.test.ts test/graphrag-bookshelf-graph.test.ts test/graphrag-library-graph.test.ts`
   - `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 240000 test/cli-graphrag-query-scope.test.ts test/cli-graphrag-route.test.ts test/cli-graphrag-upper-index-failclosed.test.ts`
   - 单书 hotplug 与 qmd vsearch 聚焦回归。
3. 在下一轮 implementation-turn_019 审计中重点复核 library scale 测试运行时间、
   package-local closure 证据和 fixed budget 指标。
