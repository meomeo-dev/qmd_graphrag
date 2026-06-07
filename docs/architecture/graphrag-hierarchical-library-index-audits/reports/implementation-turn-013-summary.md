# implementation-turn_013 汇总报告

## 结论

总体结论：`PASS_WITH_RISK`。

三名实施审计代理均依据固定实施审计维度完成复审，结论分别为：

- agent-1：`PASS_WITH_RISK`
- agent-2：`PASS_WITH_RISK`
- agent-3：`PASS_WITH_RISK`

本轮无必须修复项。query-ready bookshelf/library package 发布后生成非权威
catalog projection 的最小实现已通过三代理复审。该能力不改变显式上层查询的
package-local authority，也不把 `graph_vault/catalog/**` 提升为上层包闭包。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 最新设计复审：`design-turn_014`
- 审计轮次：`implementation-turn_013`
- agent 报告：
  - `implementation-turn_013/agent-1/report.md`
  - `implementation-turn_013/agent-2/report.md`
  - `implementation-turn_013/agent-3/report.md`

## 本轮确认闭环

### query-ready 上层包 catalog projection

状态：闭环。

证据：

- `src/graphrag/upper-index/upper-catalog-projection.ts` 新增 bookshelf/library
  projection schema 和 rebuild/load helper。
- rebuild helper 先调用 `readQueryReadyPackage()`，再读取 package-local manifest 与
  quality gate；catalog projection 不能自证 query-ready。
- projection 仅写入：
  - `graph_vault/catalog/bookshelves/{bookshelfId}/projection.yaml`
  - `graph_vault/catalog/library/{libraryId}/projection.yaml`
- projection authority 字段固定 `catalogIsAuthority=false`，readiness proof 固定为
  package-local `CURRENT` / manifest / `PUBLISH_READY` / quality gate。
- bookshelf/library graph builder 在写入 package-root `PUBLISH_READY.json` 之后才
  rebuild catalog projection。
- durable writer 将两个 projection path 映射到 `catalogWriterLane`，owner 为
  `upperCatalogProjection`。

## 验证证据

主控送审前和审计期间验证：

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `test/graphrag-bookshelf-graph.test.ts`：4 个测试通过。
- `test/graphrag-library-graph.test.ts`：7 个测试通过。
- `test/cli-graphrag-route.test.ts`：19 个测试通过。
- `test/cli-graphrag-query-scope.test.ts`：8 个测试通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 个测试通过。
- `test/graphrag-bookshelf-membership.test.ts` 与
  `test/graphrag-library-membership.test.ts`：5 个测试通过。
- `test/graphrag-book-hotplug-catalog.test.ts` 与
  `test/graphrag-book-hotplug-qmd-projection.test.ts`：13 个测试通过。
- `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`：
  1 个目标测试通过。

审计后硬化验证：

- `loadUpperCatalogProjection()` 已补充 `scopeKind/scopeId` 交叉校验，防止
  catalog projection 文件内容与调用方 scope 不一致时被读取为有效投影。
- `test/graphrag-bookshelf-graph.test.ts` 已新增
  `catalog_projection_scope_mismatch` 回归用例。
- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `test/graphrag-bookshelf-graph.test.ts`：5 个测试通过。
- `test/graphrag-library-graph.test.ts`：7 个测试通过。
- `test/cli-graphrag-route.test.ts`：19 个测试通过。
- `test/cli-graphrag-query-scope.test.ts`：8 个测试通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 个测试通过。

## 逐项汇总

1. 单书包复制传播完整性不回归：`PASS_WITH_RISK`。
   本轮实现不写 `graph_vault/books/**`；单书 hotplug catalog/qmd projection 与
   vsearch 目标回归通过。保留风险是真实外部 provider 条件下的单书
   `--graph-book-id` 成功回答仍未执行。

2. 书架/library 派生索引不污染单书包：`PASS`。
   bookshelf/library builder 和 projection rebuild 均写入上层包根或允许的 catalog
   projection 文件，未写回单书包闭包。

3. 上层包闭包不写入 catalog，删除 projection 不影响显式查询：`PASS`。
   catalog 仅保存 `projection.yaml`；测试断言 catalog 根下没有
   `BOOKSHELF_MANIFEST.json` 或 `LIBRARY_MANIFEST.json`，删除 projection 后显式
   package-root 查询仍成功。

4. runner ledger 不参与语义检索：`PASS`。
   projection rebuild 和 query path 均不读取 `graph_vault/catalog/batch-runs/**`
   作为语义输入。

5. 查询预算不随书籍数量线性增长：`PASS`。
   projection 只投影 manifest 中的 fixed budget 字段；library 测试覆盖
   10、100、1000 book scale 固定预算模拟。

6. evidence lineage 可追溯：`PASS`。
   projection 保留 evidence map locator；上层 query 与 validator 继续要求
   book/shelf/library evidence lineage，缺失或 `unknown-*` lineage fail closed。

7. staging/failed/running/pending/stale 不可被当 ready：`PASS`。
   projection rebuild 先走 package-local `readQueryReadyPackage()`；CLI tests 覆盖
   failed/staging CURRENT fail closed。

8. manifest、quality gate、publish marker 状态闭环：`PASS`。
   builder 写入 `CURRENT.json`、root manifest、root quality gate 和
   `PUBLISH_READY.json` 后才 rebuild projection；projection 不复制 authority 文件内容。

9. CLI typed error 与 timing 可观测：`PASS`。
   missing、legacy catalog-only、failed/staging、scope ambiguity、sensitive payload
   fail-closed 等 CLI 测试继续通过，typed error 和 timing 字段可观测。

10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归：`PASS_WITH_RISK`。
    projection 不存 provider payload、raw prompt/completion、绝对路径或 query log。
    qmd vsearch 目标回归通过。保留风险是真实外部 provider 单书
    `--graph-book-id` 成功回答未执行。

## 保留风险

- 真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未验证。
- 审计时 LLM synthesis、controlled deepening 和 library 管理命令仍属后续能力。
- projection rebuild 若在 `PUBLISH_READY.json` 写入后失败，应视为可重建
  projection refresh 风险，不应降级 package-root query-ready authority。

## turn_013 后本地补强

implementation-turn_013 审计后，已新增 `qmd bookshelf/library`
`status/list/build/rebuild` package-root 管理命令薄适配器。

本地验证已通过：

- TypeScript build check。
- `test/cli-graphrag-upper-management.test.ts`：4 个测试通过，覆盖
  status/list 与 build/rebuild smoke。
- `test/cli-graphrag-route.test.ts`、`test/cli-graphrag-query-scope.test.ts`
  和 `test/cli-graphrag-upper-index-failclosed.test.ts` 通过。

该补强在 implementation-turn_014 中被审出 status/list query-ready 误报问题：
checksum/marker 自洽但 graph manifest 或 quality gate schema 无效的上层包可能被
报为 `query_ready`。主控随后补充管理状态 schema 校验和
corrupt-but-checksummed 回归；implementation-turn_015 三代理复审结论为
`PASS_WITH_RISK`，无必须修复项。

该补强仍不得并入 implementation-turn_013 的已审计结论；当前有效复审状态以
`implementation-turn-015-summary.md` 为准。membership 创建、自动 repair、增量
refresh 管理生命周期、LLM synthesis 和 controlled deepening 仍属后续能力。
