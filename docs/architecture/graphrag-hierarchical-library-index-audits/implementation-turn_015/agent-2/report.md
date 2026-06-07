# implementation-turn_015 / agent-2 实施复审报告

## 结论

PASS_WITH_RISK

implementation-turn_014 / agent-2 发现的 required fix 已闭合。当前
`getUpperPackageStatus()` 在返回 `query_ready` 前，会先通过
`readQueryReadyPackage()` 校验 package-local `CURRENT.json`、manifest、
quality gate、`PUBLISH_READY.json` 与 checksum sidecar，再解析
`BookshelfGraphManifestSchema` / `LibraryGraphManifestSchema` 和
`BookshelfQualityGateSchema` / `LibraryQualityGateSchema`，并校验 scope id 与
generation。上轮可复现的 corrupt-but-checksummed manifest/gate fixture 现在
返回 `not_query_ready`，不再误报 `query_ready`。

本轮未发现新的阻断项。结论保留风险，是因为 LLM synthesis、controlled
deepening、membership 创建、自动 repair、增量 refresh 管理生命周期，以及真实
外部 provider 单书 `--graph-book-id` 成功回答仍未完成或未验证。

## Required Fixes

无。

## 已复核修复

1. `src/graphrag/upper-index/upper-management.ts` 新增
   `assertReadyPackageContent()`。
   该函数解析 graph manifest 与 graph quality gate schema；schema 本身固定
   `queryReady: true`、query-ready readyState 与 `status: "passed"`。函数还
   额外校验 manifest/gate 的 scope id 与 generation 等于当前 pointer。

2. `getUpperPackageStatus()` 只在 `readQueryReadyPackage()` 与
   `assertReadyPackageContent()` 均通过后返回 `query_ready`。任何 schema 损坏、
   quality gate 损坏、scope mismatch 或 generation mismatch 均落到
   `not_query_ready`，并输出 typed diagnostic。

3. `test/cli-graphrag-upper-management.test.ts` 新增 bookshelf 与 library 的
   corrupt-but-checksummed quality gate、corrupt-but-checksummed manifest 回归
   断言，并验证 `list` 中对应 scope 也不再是 `query_ready`。

## 逐项审计

1. 单书包复制传播不回归：PASS_WITH_RISK。
   管理命令新增逻辑仍只读上层包状态或调用既有上层 builder/validator；未发现
   新增写入 `graph_vault/books/**` 的路径。单书 hotplug catalog/qmd projection
   与目标 vsearch 回归通过。真实外部 provider 单书 `--graph-book-id` 成功回答
   未验证，保留风险。

2. 上层索引不污染单书包：PASS。
   `qmd bookshelf/library build/rebuild` 仍从 package-root membership 调用
   `buildBookshelfGraph()` / `buildLibraryGraph()`，发布到
   `graph_vault/bookshelves/**` 或 `graph_vault/library/**`，未新增单书包污染
   路径。

3. catalog 仅 projection/route/observability 且不能证明 query-ready：PASS。
   管理状态输出仍固定 `catalogProjectionIsAuthority: false`。ready 判定不读取
   catalog projection 作为证明，而是校验 package-root pointer、manifest、
   publish marker、quality gate 和 schema。

4. 删除 catalog projection 不影响显式查询：PASS。
   管理命令只报告 `catalogProjectionExists`，不要求 projection 存在。既有
   bookshelf/library graph 测试继续覆盖删除 projection 后显式上层查询仍成功。

5. runner ledger 不参与语义检索：PASS。
   审计范围内未发现 `upper-management.ts`、`graphrag-upper-management.ts` 或
   管理命令测试读取 `graph_vault/catalog/batch-runs/**`、runner ledger 或 events
   作为语义输入。

6. 固定查询预算不随规模线性增长：PASS。
   build/rebuild 仍只接受显式正整数预算参数，并传给既有上层 builder。status
   仅投影 manifest 中的 `fixedQueryBudget` 摘要。`test/graphrag-library-graph`
   继续通过 10、100、1000 book scale 固定预算覆盖。

7. evidence lineage：PASS。
   管理 build/rebuild 后仍运行 validator，并报告 `semanticUnitCount` 与
   `evidenceMapCount`。既有 bookshelf/library graph 测试继续覆盖 evidence 回链
   与 unknown lineage fail closed。

8. failed/staging/pending/stale 不可 query-ready：PASS_WITH_RISK。
   membership-only CURRENT、failed/staging 显式查询 fixture、corrupt manifest/gate
   均不被视为 query-ready。管理命令本轮重点覆盖了 corrupt-but-checksummed
   场景；pending/running/stale 的管理 status 组合仍可继续补专门测试，但未发现
   当前修复引入可利用误报。

9. manifest/quality gate/publish marker 状态闭环：PASS。
   上轮 required fix 已闭合。手工构造 checksum/marker 自洽但 manifest/gate 内容
   为 `{}` 的 bookshelf 与 library package，当前均返回 `not_query_ready`，
   diagnostics 分别为 `bookshelf_graph_manifest_invalid` 与
   `library_graph_manifest_invalid`。

10. CLI typed error/timing：PASS_WITH_RISK。
    管理命令参数错误仍通过顶层 CLI 输出结构化 `cli_error`；显式 query 路径的
    typed error 与 `timingAvailable` 回归通过。管理 status/list 本身仍是状态
    查询命令，不输出 query timing breakdown；这不应被表述为完整 query timing
    能力。

11. 敏感信息与绝对路径泄漏：PASS_WITH_RISK。
    管理命令测试继续断言 JSON 结果不包含临时 graphVault 绝对路径。当前新增
    diagnostic 只包含 schema/gate 错误码，不包含 provider payload、raw prompt、
    raw completion、密钥或 query log。无效 scope locator 回显的相对路径风险仍可
    后续收敛，但不构成本轮阻断。

12. 现有单书 GraphRAG 与 qmd vsearch 不回归：PASS_WITH_RISK。
    单书 hotplug catalog/qmd projection、route、query-scope、fail-closed 与目标
    vsearch 测试通过。真实外部 provider 单书 `--graph-book-id` 成功回答仍未执行。

## Risk Notes

- 管理命令仍是 package-root status/list/build/rebuild 薄适配器；不包含
  membership 创建、自动 repair 或增量 refresh lifecycle。
- LLM synthesis 与 controlled deepening 仍是后续能力，当前上层查询只覆盖固定预算
  community_reports report search、typed error、timing 与 evidence lineage。
- `test/graphrag-library-graph.test.ts` 将长端到端 per-test timeout 调整到 120s；
  本轮以相同 timeout 跑完全文件通过，未观察到隐藏失败。
- 本轮未验证真实外部 provider 条件下的单书 `--graph-book-id` 成功回答。

## Evidence Commands

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `npx vitest run test/cli-graphrag-upper-management.test.ts --reporter=dot`
  通过，4 tests passed。
- `npx vitest run test/cli-graphrag-query-scope.test.ts
  test/cli-graphrag-upper-index-failclosed.test.ts --reporter=dot`
  通过，9 tests passed。
- `npx vitest run test/cli/basic.test.ts -t
  "vsearch does not emit query expansion diagnostics" --reporter=dot`
  通过，1 test passed，51 skipped。
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts
  test/graphrag-book-hotplug-qmd-projection.test.ts --reporter=dot`
  通过，13 tests passed。
- `npx vitest run test/cli-graphrag-route.test.ts --reporter=dot`
  通过，19 tests passed。
- `npx vitest run test/graphrag-library-graph.test.ts --reporter=dot
  --testTimeout 120000`
  通过，7 tests passed。
- 手工 bookshelf corrupt-but-checksummed fixture：写入 checksum/sidecar 自洽的
  `CURRENT.json`、`PUBLISH_READY.json`、`BOOKSHELF_MANIFEST.json` 与
  `state/bookshelf-quality-gate.json`，manifest/gate 内容均为 `{}`；运行
  `qmd bookshelf status corrupt-ready --graph-vault <tmp>/graph_vault --json`
  返回 `status: "not_query_ready"`、`queryReady: false`，diagnostics 包含
  `bookshelf_graph_manifest_invalid`。
- 手工 library corrupt-but-checksummed fixture：同样构造
  `LIBRARY_MANIFEST.json` 与 `state/library-quality-gate.json` 为 `{}`；运行
  `qmd library status corrupt-library --graph-vault <tmp>/graph_vault --json`
  返回 `status: "not_query_ready"`、`queryReady: false`，diagnostics 包含
  `library_graph_manifest_invalid`。
- `node --input-type=module -e "import { readFileSync } from 'node:fs';
  import YAML from 'yaml';
  YAML.parse(readFileSync('docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml','utf8'));
  YAML.parse(readFileSync('docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml','utf8'));
  console.log('yaml-ok');"`
  输出 `yaml-ok`。

