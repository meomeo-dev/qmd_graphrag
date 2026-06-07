# implementation-turn_015 agent-1 修复后复审报告

## 结论

结论：`PASS_WITH_RISK`。

implementation-turn_014 / agent-2 提出的 required fix 已关闭。修复后的
`getUpperPackageStatus()` 在返回 `query_ready` 前，先通过
`readQueryReadyPackage()` 校验 package-root `CURRENT.json`、manifest、
`PUBLISH_READY.json`、quality gate 和 checksum sidecar 闭环，再解析对应的
Bookshelf/Library graph manifest schema 与 quality gate schema，并校验
scopeId 与 generation。新增管理 CLI 回归覆盖 checksum/marker 自洽但
manifest 或 quality gate 内容损坏的 bookshelf/library 状态，均返回
`not_query_ready`。

本轮不应扩大为完整上层管理生命周期完成。LLM synthesis、controlled
deepening、membership 创建、自动 repair、增量 refresh、真实外部 provider
单书 `--graph-book-id` 成功回答仍未完成或未验证。

## Required Fixes

无。

## Required Fix 复核

### RF-014-A2-1：status/list query-ready 前解析 graph manifest 与 quality gate

状态：`PASS`。

证据：

- `src/graphrag/upper-index/upper-management.ts` 新增
  `assertReadyPackageContent()`。
- bookshelf 分支解析 `BookshelfGraphManifestSchema` 与
  `BookshelfQualityGateSchema`，失败时返回
  `bookshelf_graph_manifest_invalid` 或 `bookshelf_quality_gate_invalid`。
- library 分支解析 `LibraryGraphManifestSchema` 与
  `LibraryQualityGateSchema`，失败时返回
  `library_graph_manifest_invalid` 或 `library_quality_gate_invalid`。
- 两个分支均校验 manifest identity、gate `scopeId` 与
  `CURRENT.json` generation 一致；不一致时返回 ready scope mismatch
  diagnostic。
- graph manifest 与 quality gate schema 本身约束 `queryReady: true`、
  readyState literal 和 gate `status: "passed"`。

### RF-014-A2-2：新增 corrupt-but-checksummed 回归测试

状态：`PASS`。

证据：

- `test/cli-graphrag-upper-management.test.ts` 新增
  `corruptUpperQualityGate()` 与 `corruptUpperManifest()`，会同步更新内容与
  `.sha256` sidecar，使 checksum/marker 保持自洽。
- bookshelf status 测试断言损坏 gate 返回 `not_query_ready` 且 diagnostic
  包含 `bookshelf_quality_gate_invalid`，损坏 manifest 返回
  `bookshelf_graph_manifest_invalid`。
- library status 测试断言损坏 gate 返回 `library_quality_gate_invalid`，
  损坏 manifest 返回 `library_graph_manifest_invalid`。
- list 测试确认损坏后的 package 在列表中也不是 `query_ready`。

## 固定维度复审

1. 单书包复制传播不回归：`PASS_WITH_RISK`。
   本轮修复只增强上层管理状态读取，不新增单书包写入路径。检索未发现
   `upper-management.ts` 或 `graphrag-upper-management.ts` 写入
   `graph_vault/books/**`。保留风险仍是真实外部 provider 单书
   `--graph-book-id` 未执行。

2. 上层索引不污染单书包：`PASS`。
   build/rebuild 仍只调用既有 bookshelf/library builder 与 validator；状态
   修复只读 package-root manifest/gate。

3. catalog 仅 projection/route/observability，且不能证明 query-ready：`PASS`。
   status 输出仍固定 `catalogProjectionIsAuthority=false`；query-ready 现在必须
   同时通过 package-local publish marker/checksum 与 graph manifest/gate schema。

4. 删除 catalog projection 不影响显式查询：`PASS`。
   管理命令只报告 `catalogProjectionExists`。既有 bookshelf/library graph 测试
   覆盖删除 catalog projection 后显式 package-root 查询仍成功。

5. runner ledger 不参与语义检索：`PASS`。
   审计范围内未发现 `catalog/batch-runs` 或 runner ledger 作为管理命令、
   builder 或查询语义输入。

6. 固定查询预算不随规模线性增长：`PASS`。
   build/rebuild 仍只暴露固定预算参数，并传递给既有 builder。library graph
   固定预算测试仍覆盖 10、100、1000 book scale。

7. evidence lineage：`PASS`。
   修复没有改变 evidence_map 生成或查询证据回链；上层 graph validator 与
   fail-closed 测试仍覆盖 evidence lineage 与污染 parquet。

8. failed/staging/pending/stale 不可 query-ready：`PASS_WITH_RISK`。
   failed/staging explicit query 目标用例通过；membership-only status 返回
   `not_query_ready`。本轮新增 corrupt-but-checksummed manifest/gate 覆盖了
   agent-2 发现的 query-ready 误报。pending/stale 的管理 status 组合仍建议
   后续补专门测试。

9. manifest/quality gate/publish marker 状态闭环：`PASS`。
   这是本轮 required fix 的核心。status/list 已从 checksum/marker 自洽提升为
   checksum/marker/schema/scope/generation 全部一致后才返回 `query_ready`。

10. CLI typed error/timing：`PASS_WITH_RISK`。
    查询路径 typed error 与 `timingAvailable` 回归通过。管理 status/list 的
    corrupt package 以 JSON 状态返回，不把命令执行成功误解为 query-ready。
    管理命令仍无独立 timing breakdown；build/rebuild 参数错误仍由通用
    `cli_error` 包装。

11. 敏感信息与绝对路径泄漏：`PASS_WITH_RISK`。
    管理测试继续断言 JSON 输出不包含临时 `graphVault` 绝对路径；builder
    forbidden field scan 未被削弱。未对所有损坏文件解析异常做 fuzz 覆盖。

12. 现有单书 GraphRAG 和 qmd vsearch 不回归：`PASS_WITH_RISK`。
    query-scope、route fail-closed、upper-index fail-closed 与 vsearch 目标回归
    通过。真实外部 provider 单书 `--graph-book-id` 成功回答仍未验证。

## Risk Notes

- 管理 status/list 现在能拒绝 checksum/marker 自洽但 schema 无效的 manifest
  或 quality gate；但如果 manifest 文件本身不是可解析 YAML/JSON，
  `attachSummary()` 仍可能在 query-ready 判断前抛出通用 CLI error，而不是返回
  `invalid` 或 `not_query_ready` status。该路径不是 agent-2 复现条件，但建议
  后续硬化。
- 新增测试覆盖损坏 graph manifest/gate schema；scope/generation mismatch 的
  逻辑存在于实现中，但本轮未看到专门 CLI 回归。
- `build` 与 `rebuild` 仍是从既有 membership 触发保守重建，不是自动 repair、
  membership 创建或增量 refresh。
- `test/graphrag-library-graph.test.ts` 已把长端到端用例 per-test timeout 调整到
  120s；本地目标用例在默认命令下通过。并行 agent 运行中的其他 vitest 进程
  未被本报告纳入失败证据。

## Evidence Commands

已读取：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-013-summary.md`
- `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_014/agent-2/report.md`
- `src/graphrag/upper-index/upper-management.ts`
- `src/cli/graphrag-upper-management.ts`
- `src/cli/qmd.ts`
- `test/cli-graphrag-upper-management.test.ts`
- `test/graphrag-library-graph.test.ts`
- 相关 bookshelf/library graph contract、query 与 validator 源码。

本地验证命令：

```bash
node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false
npx vitest run test/cli-graphrag-upper-management.test.ts --reporter verbose
npx vitest run test/graphrag-library-graph.test.ts -t "publishes a query-ready library graph" --reporter verbose
npx vitest run test/cli-graphrag-query-scope.test.ts --reporter verbose
npx vitest run test/cli-graphrag-route.test.ts -t "refuses .* upper CURRENT|legacy catalog" --reporter verbose
npx vitest run test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics" --reporter verbose
npx vitest run test/cli-graphrag-upper-index-failclosed.test.ts --reporter verbose
rg -n "batch-runs|runner ledger|ledger" src/graphrag/upper-index/upper-management.ts src/cli/graphrag-upper-management.ts src/cli/qmd.ts src/graphrag/upper-index/bookshelf-graph.ts src/graphrag/upper-index/library-graph.ts
rg -n "join\\([^\\n]*\\\"books\\\"|graph_vault/books|books/\\$|books/\\{" src/graphrag/upper-index/upper-management.ts src/cli/graphrag-upper-management.ts src/cli/qmd.ts
```

结果摘要：

- TypeScript build check 通过。
- `test/cli-graphrag-upper-management.test.ts`：4 个测试通过，覆盖
  bookshelf/library status/list/build/rebuild 以及 corrupt-but-checksummed
  manifest/gate 回归。
- `test/graphrag-library-graph.test.ts` 目标长端到端用例通过，耗时约 65s，
  受 120s per-test timeout 覆盖。
- `test/cli-graphrag-query-scope.test.ts`：8 个测试通过。
- `test/cli-graphrag-route.test.ts` 目标用例：6 个测试通过，13 个跳过。
- `test/cli/basic.test.ts` 的 vsearch 目标用例通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 个测试通过。
- runner ledger 与单书包写入路径检索未在审计范围文件中命中。
