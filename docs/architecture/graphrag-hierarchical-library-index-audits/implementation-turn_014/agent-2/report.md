# implementation-turn_014 / agent-2 实施审计报告

## 结论

FAIL

本轮审计范围限定为 implementation-turn_013 后新增的 bookshelf/library
上层管理命令补强。管理命令整体保持了 package-root 入口、未发现写回单书包
或把 catalog projection 当作权威的实现路径；但 `status/list` 的
query-ready 判定存在可复现缺口：当 `CURRENT.json`、root/generation manifest、
root/generation quality gate 与 `PUBLISH_READY.json` 的 checksum/sidecar 自洽，
但 manifest 与 quality gate 内容不是有效上层 graph schema 时，`qmd bookshelf
status <id> --json` 仍会返回 `status: "query_ready"` 与 `queryReady: true`。

该问题使管理状态视图不能证明 package-root manifest/quality gate 状态闭环，
不满足本轮管理命令补强的 query-ready 状态可信度要求。该结论不表示显式
`--bookshelf-id` / `--library-id` 查询已经被证明同样误判；本次发现限定在
`src/graphrag/upper-index/upper-management.ts` 的 status/list 管理路径。

## Required Fixes

1. 修复 `getUpperPackageStatus()` 的 query-ready 判定。
   `readQueryReadyPackage()` 当前只校验 package root、`CURRENT.json`、manifest
   文件、quality gate 文件、`PUBLISH_READY.json` 与 sidecar/checksum 的闭环，
   不解析 graph manifest 或 quality gate schema。`getUpperPackageStatus()`
   必须在返回 `query_ready` 前解析对应的 `BookshelfGraphManifestSchema` /
   `LibraryGraphManifestSchema` 和 `BookshelfQualityGateSchema` /
   `LibraryQualityGateSchema`，并确认 scope id、readyState、`queryReady: true`
   以及 gate 通过状态。解析失败或 gate 未通过时应返回 `not_query_ready` 或
   `invalid`，并提供 typed diagnostic。

2. 为管理命令增加回归测试。
   `test/cli-graphrag-upper-management.test.ts` 应覆盖 checksum/marker 自洽但
   graph manifest schema 损坏、quality gate schema 损坏或 gate 未通过的
   bookshelf/library fixture，断言 `status/list` 不得返回 `query_ready`。

## 逐项审计

1. 单书包复制传播不回归：PASS_WITH_RISK。
   新增管理模块本身无文件写入 API。`status/list` 只读
   `graph_vault/bookshelves/**` 或 `graph_vault/library/**`，`build/rebuild`
   调用既有 upper builder。未发现新增管理命令向 `graph_vault/books/**`
   写入上层 manifest、parquet 或 projection。保留风险是真实外部 provider
   条件下单书 `--graph-book-id` 成功回答本轮仍未验证。

2. 上层索引不污染单书包：PASS。
   `src/cli/graphrag-upper-management.ts` 的 `build/rebuild` 只调用
   `buildBookshelfGraph()` / `buildLibraryGraph()` 与对应 validator；既有 builder
   发布到上层包根并生成允许的 catalog projection。本轮新增管理代码未新增
   单书包写入路径。

3. catalog 仅 projection/route/observability，且不能证明 query-ready：FAIL。
   管理命令没有把 catalog projection 标为权威，输出中
   `catalogProjectionIsAuthority` 固定为 `false`。但 status/list 会在 graph
   manifest 与 quality gate 内容无效时仍返回 `query_ready`，query-ready 证明
   未完整落到 package-local manifest 与 quality gate schema。

4. 删除 catalog projection 不影响显式查询：PASS。
   本轮新增管理命令只报告 `catalogProjectionExists`，不要求 projection 存在。
   既有 `test/graphrag-bookshelf-graph.test.ts` 与
   `test/graphrag-library-graph.test.ts` 在删除 projection 后显式查询仍通过。

5. runner ledger 不参与语义检索：PASS。
   审计范围内未发现 `upper-management.ts` 或
   `graphrag-upper-management.ts` 读取 `graph_vault/catalog/batch-runs/**`、
   runner ledger 或 events 作为语义输入。管理命令仅做状态读取、builder 调用
   和 validator 调用。

6. 固定查询预算不随规模线性增长：PASS。
   管理命令 build/rebuild 仅接受显式正整数预算参数，并将
   `maxSemanticUnits`、`maxEdges`、`maxReportsPerBook` 或
   `maxReportsPerShelf` 传给既有 builder；status summary 只投影 manifest 中的
   `fixedQueryBudget` 摘要。既有 library graph 测试覆盖 10、100、1000 book
   scale 的固定预算行为。

7. evidence lineage：PASS。
   管理 build/rebuild 在发布后运行 validator，并在 JSON 结果中报告
   `semanticUnitCount` 与 `evidenceMapCount`。既有 bookshelf/library graph 测试
   覆盖 evidence 回链到 book/source/document/content/text-unit 或 library scope
   metadata；unknown lineage fail closed 仍通过。

8. failed/staging/pending/stale 不可 query-ready：PASS_WITH_RISK。
   membership-only CURRENT 在管理测试中返回 `not_query_ready`；failed/staging
   显式查询 fixture 仍 fail closed。风险是本轮管理测试尚未直接覆盖 stale、
   pending、running CURRENT 组合。更严重的问题已在第 3、9 项列为 required
   fix：schema 损坏但 marker/checksum 自洽时 status 误报 query-ready。

9. manifest/quality gate/publish marker 状态闭环：FAIL。
   `readQueryReadyPackage()` 覆盖 `CURRENT.json`、manifest checksum、root
   manifest、root quality gate、`PUBLISH_READY.json` 和 sidecar 一致性，但
   `getUpperPackageStatus()` 返回 ready 前未强制解析 graph manifest 与 quality
   gate schema。临时 fixture 证明 `{}` manifest/gate 加自洽 sidecar 可被
   status 视为 `query_ready`。

10. CLI typed error/timing：PASS_WITH_RISK。
    顶层 `qmd` 能把管理命令构建参数错误包装为结构化 `cli_error`。既有显式
    upper query 路径的 typed error 与 `timingAvailable` 测试通过。管理
    `status/list` 本身未输出 timing breakdown；这对只读状态命令可接受，但
    不应被表述为完整 query timing 能力。

11. 敏感信息与绝对路径泄漏：PASS_WITH_RISK。
    管理命令 JSON 输出使用 scope-relative package locator，管理测试断言
    build/status/list 结果不包含临时 graphVault 绝对路径。无效 scope status
    会回显用户输入组成的相对 locator，例如 `bookshelves/../bad`；这不泄露
    绝对路径，但建议后续将 invalid 状态的 locator 也规范化为安全占位。

12. 现有单书 GraphRAG 和 qmd vsearch 不回归：PASS_WITH_RISK。
    `cli-graphrag-route`、`cli-graphrag-query-scope`、
    `cli-graphrag-upper-index-failclosed`、单书 hotplug catalog/qmd projection
    与目标 vsearch 测试通过。真实外部 provider 单书 `--graph-book-id` 成功
    回答仍未执行。

## Risk Notes

- 管理命令补强仍是薄适配器，不包含 LLM synthesis、controlled deepening、
  membership 创建、自动 repair 或增量 refresh 管理生命周期。
- build/rebuild 依赖既有 package-root membership；本轮未证明从空状态创建
  membership 或自动修复损坏包。
- status/list 当前返回 exit code 0 表示命令成功执行，不表示 scope query-ready。
  调用方必须读取 `status` 与 `queryReady` 字段。
- 初次并行运行部分长测试时出现超时；增加 Vitest 单测 timeout 后通过。

## Evidence Commands

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `npx vitest run test/cli-graphrag-upper-management.test.ts --reporter=dot`
  通过，4 tests passed。
- `npx vitest run test/cli-graphrag-route.test.ts --reporter=dot`
  通过，19 tests passed。
- `npx vitest run test/cli-graphrag-query-scope.test.ts --reporter=dot`
  通过，8 tests passed。
- `npx vitest run test/cli-graphrag-upper-index-failclosed.test.ts --reporter=dot`
  通过，1 test passed。
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts
  test/graphrag-book-hotplug-qmd-projection.test.ts --reporter=dot`
  通过，13 tests passed。
- `npx vitest run test/cli/basic.test.ts -t
  "vsearch does not emit query expansion diagnostics" --reporter=dot`
  通过，1 test passed，51 skipped。
- `npx vitest run test/graphrag-bookshelf-graph.test.ts --reporter=dot
  --testTimeout 120000`
  通过，5 tests passed。
- `npx vitest run test/graphrag-library-graph.test.ts --reporter=dot
  --testTimeout 120000`
  通过，7 tests passed。
- `node --input-type=module -e "import { readFileSync } from 'node:fs';
  import YAML from 'yaml';
  YAML.parse(readFileSync('docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml','utf8'));
  YAML.parse(readFileSync('docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml','utf8'));
  console.log('yaml-ok');"`
  输出 `yaml-ok`。
- 临时 fixture 复现 required fix：构造
  `graph_vault/bookshelves/corrupt-ready`，写入 checksum/sidecar 自洽的
  `CURRENT.json`、`PUBLISH_READY.json`、`BOOKSHELF_MANIFEST.json` 和
  `state/bookshelf-quality-gate.json`，其中 manifest/gate 内容均为 `{}`。
  运行 `qmd bookshelf status corrupt-ready --graph-vault <tmp>/graph_vault
  --json` 返回 `status: "query_ready"`、`queryReady: true`。
- 管理 CLI 错误路径验证：
  `qmd bookshelf build bad-id --graph-vault <tmp>/graph_vault
  --max-semantic-units 0 --json` 返回结构化 `cli_error`，redactedMessage 为
  `max-semantic-units must be a positive integer`。

