# implementation-turn_014 agent-3 审计报告

## 结论

结论：`PASS_WITH_RISK`。

本轮新增/变更的 bookshelf/library 上层管理命令补强满足当前最小目标：
`qmd bookshelf` 与 `qmd library` 已接入 `status`、`list`、`build`、
`rebuild`；状态读取以 package-root `CURRENT.json`、manifest、
`PUBLISH_READY.json`、quality gate 和 sidecar 为权威；catalog projection
只作为非权威派生视图和存在性信号。未发现必须修复项。

风险保留原因是：真实外部 provider 条件下的单书 `--graph-book-id` 成功回答
仍未验证；管理命令仍只是薄适配器，不包含 LLM synthesis、controlled
deepening、membership 创建、自动 repair、增量 refresh 管理生命周期；本地
`test/graphrag-library-graph.test.ts` 最大端到端发布用例在当前环境触发该用例
显式 60s 超时，未形成本轮绿色证据。

## Required Fixes

无。

## 审计输入

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-013-summary.md`
- `src/graphrag/upper-index/upper-management.ts`
- `src/cli/graphrag-upper-management.ts`
- `src/cli/qmd.ts`
- `test/cli-graphrag-upper-management.test.ts`
- 相关 bookshelf/library graph、query、membership、catalog projection 和 CLI
  route 测试。

## 逐项审计

1. 单书包复制传播不回归：`PASS_WITH_RISK`。
   管理命令不写入 `graph_vault/books/**`。上层 build/rebuild 读取既有成员
   package-root membership 和单书包 GraphRAG 产物，发布到
   `graph_vault/bookshelves/**` 或 `graph_vault/library/**`。单书 hotplug
   catalog/qmd projection 与 qmd vsearch 目标回归通过。保留风险是真实外部
   provider 单书 `--graph-book-id` 成功回答未执行。

2. 上层索引不污染单书包：`PASS`。
   `upper-management.ts` 只计算上层包相对路径和 catalog projection 相对路径。
   `buildBookshelfGraph()`、`buildLibraryGraph()` 在上层包 `staging/`、
   `generations/`、root manifest、root quality gate 和 `PUBLISH_READY.json`
   下发布，不向单书包闭包写入上层索引。

3. Catalog 仅 projection/route/observability 且不能证明 query-ready：
   `PASS`。`getUpperPackageStatus()` 通过 `readQueryReadyPackage()` 判定
   query-ready，并将 `catalogProjectionIsAuthority` 固定为 `false`。
   `upper-catalog-projection.ts` 先校验 package-local `CURRENT`、manifest、
   `PUBLISH_READY` 和 quality gate，再写 `projection.yaml`；projection
   schema 自身也声明 `catalogIsAuthority=false`。

4. 删除 catalog projection 不影响显式查询：`PASS_WITH_RISK`。
   query path 直接调用 `readQueryReadyPackage()`，不依赖
   `loadUpperCatalogProjection()`。bookshelf graph 测试完整验证删除 catalog
   projection 后显式查询仍成功。library graph 测试源码包含同等断言，但最大
   端到端用例在当前环境触发测试内 60s 超时，故本轮对 library 该断言只形成
   源码审计证据和既有 turn_013 证据，不形成新的绿色执行证据。

5. Runner ledger 不参与语义检索：`PASS`。
   `upper-management.ts`、`graphrag-upper-management.ts`、bookshelf/library
   query path 和 catalog projection path 未读取 `graph_vault/catalog/batch-runs/**`
   或 runner ledger 作为 semantic input。测试中出现 runner harness 仅用于临时
   项目目录，不作为检索输入。

6. 固定查询预算不随规模线性增长：`PASS`。
   build/rebuild CLI 只暴露固定预算参数
   `--max-semantic-units`、`--max-edges`、`--max-reports-per-book`、
   `--max-reports-per-shelf`。query bridge 使用固定 `maxReports` 和
   `maxInputTokens`。library 10、100、1000 book scale 固定预算测试通过。

7. Evidence lineage：`PASS`。
   bookshelf/library query response 将 evidence 映射到 `bookId`、`sourceId`、
   `documentId`、`contentHash`、`graphTextUnitId`、community report artifact 和
   package-relative locator。library 缺失下层 evidence 与 `unknown-*` lineage
   fail-closed 测试均通过。

8. failed/staging/pending/stale 不可 query-ready：`PASS`。
   `readQueryReadyPackage()` 要求 `CURRENT.queryReady=true` 且 `readyState`
   等于 scope 对应的 query-ready 状态，并校验 manifest、quality gate、
   publish marker 与 sidecar。CLI route 测试覆盖 bookshelf/library failed 与
   staging `CURRENT`；library pending/current-not-ready 与 stale member 测试通过。

9. Manifest/quality gate/publish marker 状态闭环：`PASS`。
   `readQueryReadyPackage()` 校验 generation/root manifest 一致性、root/generation
   quality gate 一致性、`PUBLISH_READY.json` scope/generation/path/checksum
   一致性和 sidecar。builder 在 staged validation 后提升 generation，写
   `CURRENT.json`、root manifest、root quality gate、diagnostics、
   `PUBLISH_READY.json`，之后才 rebuild catalog projection。

10. CLI typed error/timing：`PASS_WITH_RISK`。
    `qmd query --bookshelf-id/--library-id` 的 missing、legacy catalog-only、
    failed/staging、ambiguous scope、budget/runtime 等错误均映射为 typed error，
    且 `--timing` 元数据可见。管理命令自身的异常由 `qmd.ts` 包装成 typed
    `cli_error`，但没有专用 upper-management error code 或阶段 timing 输出；
    这不阻断当前 status/list/build/rebuild 薄适配器目标，但应作为后续
    operability 风险保留。

11. 敏感信息与绝对路径泄漏：`PASS_WITH_RISK`。
    管理命令 JSON 测试断言 build/status/list 输出不包含传入的绝对
    `graphVault`。status 对象只返回 package-relative locator；manifest 与
    quality gate 保持 forbidden field 扫描。风险是 Python bridge runtime
    failure path 仍可能把 stderr 拼入异常，当前仅依赖 CLI 通用
    `sanitizeDiagnosticMessage()`，缺少专门覆盖非 home/cwd 临时路径的管理命令
    失败测试。

12. 现有单书 GraphRAG 和 qmd vsearch 不回归：`PASS_WITH_RISK`。
    `cli-graphrag-route` 19 项通过，包含单书 scoped output 和 upper scope
    fail-closed；hotplug catalog/qmd projection 13 项通过；qmd vsearch 目标
    回归通过。保留风险仍是真实外部 provider 单书 `--graph-book-id` 成功回答
    未执行。

13. Type DD/报告更新：`PASS_WITH_RISK`。
    Type DD 已把 package-root `qmd bookshelf/library status/list/build/rebuild`
    登记为实现目标，并同时说明 status/list 只读 package-root authority、
    build/rebuild 只消费既有 package-root membership；也明确不包含 LLM
    synthesis、跨 scope 下钻、membership 创建、自动 repair 或增量 refresh。
    implementation-turn_013 汇总报告明确这些管理命令是 turn_013 后本地补强，
    尚需 implementation-turn_014 复审。文档未把本轮薄适配器夸大为完整管理
    生命周期。

## Risk Notes

- 真实外部 provider 下的单书 `qmd query --graphrag --graph-book-id <id>`
  成功回答未验证。本轮只验证本地 fixture、route 行为和非回归。
- `test/graphrag-library-graph.test.ts` 的
  `publishes a query-ready library graph from two published bookshelves` 在当前
  环境单独执行仍触发用例内 60s timeout。其他 library fixed budget、missing
  evidence、stale、sensitive payload、unknown lineage 和 current-not-ready
  用例均已拆分通过。
- 管理命令错误路径缺少专门的 path-redaction regression。正常 JSON 输出已验证
  不含绝对 `graphVault`，但 bridge stderr failure path 仍建议后续补测试。
- `build` 与 `rebuild` 是相同 builder/validator 的薄入口，尚未实现
  membership 创建、自动 repair、增量 refresh 或 repair lifecycle。
- 本轮未实现 LLM synthesis over upper semantic units，也未实现 controlled
  deepening into selected single-book GraphRAG。

## Evidence Commands

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/cli-graphrag-upper-management.test.ts -t "builds and rebuilds a bookshelf package from package-root membership"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/cli-graphrag-upper-management.test.ts -t "reports bookshelf package-root status without using catalog as authority"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/cli-graphrag-upper-management.test.ts -t "reports library package-root status without using catalog as authority"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/cli-graphrag-upper-management.test.ts -t "builds and rebuilds a library package from package-root membership"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli-graphrag-route.test.ts`
  通过，19 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli-graphrag-query-scope.test.ts`
  通过，8 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli-graphrag-upper-index-failclosed.test.ts`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-bookshelf-graph.test.ts`
  通过，5 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-book-hotplug-catalog.test.ts test/graphrag-book-hotplug-qmd-projection.test.ts`
  通过，13 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-bookshelf-membership.test.ts test/graphrag-library-membership.test.ts`
  通过，5 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/graphrag-library-graph.test.ts -t "keeps library query budget fixed at simulated 10, 100, and 1000 book scale"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/graphrag-library-graph.test.ts -t "fails library graph build when member report evidence is not traceable"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/graphrag-library-graph.test.ts -t "refuses query when library CURRENT pointer is not query-ready"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/graphrag-library-graph.test.ts -t "refuses library query when a member bookshelf manifest becomes stale"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/graphrag-library-graph.test.ts -t "refuses library query when upper parquet artifacts contain sensitive payload text"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/graphrag-library-graph.test.ts -t "refuses library query when evidence lineage contains unknown placeholders"`
  通过，1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/graphrag-library-graph.test.ts -t "publishes a query-ready library graph from two published bookshelves"`
  未通过，触发该用例显式 `Test timed out in 60000ms`。
