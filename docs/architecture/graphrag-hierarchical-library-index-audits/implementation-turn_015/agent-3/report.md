# implementation-turn_015 agent-3 修复后复审报告

## 结论

结论：`PASS_WITH_RISK`。

implementation-turn_014 agent-2 的 required fix 已闭环。`getUpperPackageStatus()`
现在在返回 `query_ready` 前，先经 `readQueryReadyPackage()` 校验 package-local
`CURRENT.json`、manifest、quality gate、`PUBLISH_READY.json` 与 sidecar，再解析
对应的 graph manifest schema 和 quality gate schema，并校验 scope id 与
generation。checksum/marker 自洽但 manifest 或 gate 内容无效的上层包不再被
`status/list` 报为 query-ready。

本轮未发现新的必须修复项。保留 `PASS_WITH_RISK` 是因为真实外部 provider
条件下的单书 `--graph-book-id` 成功回答仍未验证；LLM synthesis、controlled
deepening、membership 创建、自动 repair 和增量 refresh 管理生命周期仍未完成。

## Required Fixes

无。

## 审计输入

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-013-summary.md`
- `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_014/agent-2/report.md`
- `src/graphrag/upper-index/upper-management.ts`
- `src/cli/graphrag-upper-management.ts`
- `src/cli/qmd.ts`
- `test/cli-graphrag-upper-management.test.ts`
- `test/graphrag-library-graph.test.ts`

## Required Fix 复审

agent-2 在 implementation-turn_014 发现的问题是：`status/list` 曾只依赖
`readQueryReadyPackage()` 的文件、checksum 和 publish marker 闭环；当 graph
manifest 与 quality gate 内容本身无效但 sidecar 自洽时，管理状态仍可能返回
`status: "query_ready"`。

当前修复点：

- `upper-management.ts` 已引入 `BookshelfQualityGateSchema` 与
  `LibraryQualityGateSchema`。
- 新增 `assertReadyPackageContent()`，在 ready 判定前读取
  `ready.manifestPath` 和 `ready.gatePath`。
- bookshelf 路径解析 `BookshelfGraphManifestSchema` 和
  `BookshelfQualityGateSchema`；library 路径解析 `LibraryGraphManifestSchema`
  和 `LibraryQualityGateSchema`。
- schema 自身约束 `readyState`、`queryReady`、`status` 为 query-ready/passed
  literal；修复代码额外校验 manifest/gate 的 scope id 与 current generation。
- `getUpperPackageStatus()` 捕获解析或 scope/generation 失败后返回
  `not_query_ready`、`queryReady: false` 和诊断，不返回 `query_ready`。
- `listUpperPackageStatuses()` 仍逐个调用 `getUpperPackageStatus()`，因此 list
  同步继承该修复。

新增回归覆盖：

- `test/cli-graphrag-upper-management.test.ts` 新增
  `corruptUpperQualityGate()` 与 `corruptUpperManifest()` fixture。
- bookshelf status 覆盖 checksum 自洽但 quality gate 无效，诊断为
  `bookshelf_quality_gate_invalid`。
- bookshelf status 覆盖 checksum 自洽但 graph manifest 无效，诊断为
  `bookshelf_graph_manifest_invalid`。
- bookshelf list 覆盖同一 scope 不得在列表中回到 `query_ready`。
- library status 覆盖 checksum 自洽但 quality gate 无效，诊断为
  `library_quality_gate_invalid`。
- library status 覆盖 checksum 自洽但 graph manifest 无效，诊断为
  `library_graph_manifest_invalid`。
- library list 覆盖同一 scope 不得在列表中回到 `query_ready`。

判定：`PASS`。agent-2 的两个 required fixes 均已实现并由测试覆盖。

## 固定维度复审

1. 单书包复制传播不回归：`PASS_WITH_RISK`。
   本轮修复只改管理状态读取和测试，不新增对 `graph_vault/books/**` 的写入。
   单书 fixture 路由用例通过。保留风险是真实外部 provider 单书
   `--graph-book-id` 成功回答仍未验证。

2. 上层索引不污染单书包：`PASS`。
   `status/list` 只读取上层 package root 和 catalog projection 存在性；
   `build/rebuild` 仍调用既有 bookshelf/library builder。未发现把上层索引写入
   单书包闭包的新增路径。

3. Catalog 仅 projection/route/observability 且不能证明 query-ready：`PASS`。
   管理状态输出仍固定 `catalogProjectionIsAuthority=false`。query-ready 判定
   已落到 package-local current、manifest、publish marker、quality gate、
   sidecar 与 schema 内容校验，catalog projection 不能自证 ready。

4. 删除 catalog projection 不影响显式查询：`PASS`。
   修复未改变 query path；显式 bookshelf/library 查询仍通过
   `readQueryReadyPackage()` 读取 package root。`test/graphrag-library-graph.test.ts`
   的长端到端用例在 per-test timeout 调整到 120s 后通过，继续覆盖删除 catalog
   projection 后显式 library 查询成功。

5. Runner ledger 不参与语义检索：`PASS`。
   审计范围内未发现 `upper-management.ts`、管理 CLI 或 qmd 接入读取 runner
   ledger、batch-runs、events 作为 semantic input。相关 runner harness 只用于
   临时目录。

6. 固定查询预算不随规模线性增长：`PASS`。
   本轮修复不改变 fixed-budget query 或 build 参数。管理 CLI 仍只透传固定
   `maxSemanticUnits`、`maxEdges`、`maxReportsPerBook`、`maxReportsPerShelf`
   到既有 builder。

7. Evidence lineage：`PASS`。
   本轮修复不改变 evidence map 或 query response。管理 build/rebuild 仍运行
   validator 并报告 `semanticUnitCount` 与 `evidenceMapCount`；既有上层 query
   evidence lineage 合同未回退。

8. failed/staging/pending/stale 不可 query-ready：`PASS`。
   `readQueryReadyPackage()` 仍拒绝非 query-ready `readyState`。本轮新增的
   corrupt-but-checksummed manifest/gate 回归进一步覆盖“文件闭环自洽但内容不
   query-ready”的管理状态误报。

9. Manifest/quality gate/publish marker 状态闭环：`PASS`。
   agent-2 指出的缺口已修复：status/list 不再只验证 checksum 与 publish
   marker，还解析 graph manifest 和 graph quality gate，并校验 scope/generation。
   gate schema 约束 `status: "passed"`、`queryReady: true` 与对应 readyState。

10. CLI typed error/timing：`PASS_WITH_RISK`。
    显式 upper query 的 typed error 与 timing helper 测试通过。管理
    `status/list` 仍以 exit code 0 表示命令成功执行，scope readiness 由
    `status` 和 `queryReady` 字段表达；管理命令仍没有专用 timing breakdown。
    这不阻断本轮修复，但仍是 operability 风险。

11. 敏感信息与绝对路径泄漏：`PASS_WITH_RISK`。
    管理测试继续断言 JSON 输出不包含传入的绝对 `graphVault`。status 对象使用
    package-relative locator。保留风险是 bridge/runtime failure stderr 的更广泛
    path-redaction 仍缺少专门管理命令回归。

12. 现有单书 GraphRAG 和 qmd vsearch 不回归：`PASS_WITH_RISK`。
    单书 `--graph-book-id` fixture 路由用例和 qmd vsearch 目标回归通过。真实
    外部 provider 单书成功回答仍未验证。

## Risk Notes

- 真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未执行。
- LLM synthesis、controlled deepening、membership 创建、自动 repair、增量
  refresh 管理生命周期仍未实现。
- `build` 与 `rebuild` 仍是相同既有 builder/validator 的薄入口；没有新增
  repair、create membership 或 incremental refresh 语义。
- 管理命令错误路径仍建议后续补充更强的 path-redaction 回归，尤其是 bridge
  stderr 可能包含非 cwd/home 的临时绝对路径时。

## Evidence Commands

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli-graphrag-query-scope.test.ts test/cli-graphrag-upper-index-failclosed.test.ts`
  通过，2 files passed，9 tests passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli-graphrag-upper-management.test.ts`
  通过，4 tests passed；覆盖 bookshelf/library corrupt-but-checksummed manifest
  与 quality gate 状态回归。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose test/graphrag-library-graph.test.ts -t "publishes a query-ready library graph from two published bookshelves"`
  通过，1 test passed，耗时约 68s；验证 per-test timeout 120s 调整后长端到端
  用例可完成。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli-graphrag-route.test.ts -t "qmd query --graphrag uses the selected book scoped output"`
  通过，1 test passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`
  通过，1 test passed。
