# implementation-turn_013 / agent-3 实施审计报告

## 结论

PASS_WITH_RISK

本轮 Type DD 与实现同步没有发现阻断性过度声明。`upper-catalog-projection.ts`
实现的是从 query-ready 上层包派生非权威 catalog projection，未把 catalog
提升为查询就绪权威。路径边界总体成立：`projectionPath()` 和
`loadUpperCatalogProjection()` 均经 `assertSafeUpperScopeId()` 约束 scope id 后再
拼接 catalog 路径。

## 逐项判定

1. 单书包复制传播不回归：PASS
   Type DD 仍限定单书包权威来自 `graph_vault/books/{bookId}` 下的 manifest、
   `PUBLISH_READY`、包内 qmd/GraphRAG 产物和质量门。上层 projection 模块只读取
   query-ready 上层包，不写单书包。

2. 上层索引不污染单书包：PASS
   书架 graph 测试断言成员 book 根下不存在 `BOOKSHELF_MANIFEST.json` 与
   `semantic_units.parquet`。library graph 测试继续通过书架包输入构建，不把
   library 产物写入单书包闭包。

3. 上层包闭包不写入 catalog 且 projection 删除不影响显式查询：PASS
   catalog 仅写 `projection.yaml`，durable mapping owner 为
   `upperCatalogProjection`。graph tests 断言 catalog projection 根下无
   `BOOKSHELF_MANIFEST.json` / `LIBRARY_MANIFEST.json`，并删除 catalog projection 后
   重新执行显式 `queryBookshelfGraph()` / `queryLibraryGraph()` 仍有 evidence。

4. runner ledger 不参与语义检索：PASS
   本轮 projection 由 `readQueryReadyPackage()`、manifest 与 quality gate 派生，
   未读取 `catalog/batch-runs/**`、events 或 recovery summary 作为语义输入。

5. 查询预算固定：PASS
   projection schema 只暴露 manifest 中的固定预算字段。bookshelf/library graph
   tests 仍断言 runtime LLM attempted request count 为 0，quality gate 的
   `fixedQueryBudgetSimulation.status` 为 `passed`。

6. evidence lineage：PASS
   graph tests 断言 bookshelf 查询 evidence 含 `bookId`、`sourceId`、
   `documentId`、`contentHash`、`graphTextUnitId` 和 scope-relative locator；
   library 查询 evidence 含 book 与 library scope metadata、locator。

7. 非 ready 状态不可被查询：PASS
   CLI 路由测试覆盖 missing upper index、legacy catalog-only、failed/staging
   `CURRENT`，均返回 typed error，不把非 ready 状态当作可查询索引。

8. manifest / quality gate / publish marker 闭环：PASS
   graph builders 在写入 package-local `CURRENT.json`、root manifest、root quality
   gate、`PUBLISH_READY.json` 后才调用 catalog projection rebuild。projection
   rebuild 先调用 `readQueryReadyPackage()`，该函数校验 package root、
   `CURRENT.json`、manifest sidecar、root manifest、quality gate、
   `PUBLISH_READY.json` 和 scope 一致性。

9. CLI typed error / timing：PASS
   CLI tests 继续断言 `upper_index_missing`、
   `upper_package_migration_required`、`upper_quality_gate_failed` 的 exit code、
   remediation command、scope id 和 `timingAvailable: true`。敏感 payload
   fail-closed 测试也断言 stderr 不泄露本地路径或 token。

10. 安全隐私与单书/qmd vsearch 非回归：PASS_WITH_RISK
    `ProjectionAuthoritySchema` 将 `catalogIsAuthority` 固定为 `false`，并将
    `readinessProof` 固定为 package-local proof。`projectionPath()` 对 `scopeId`
    做空值、空白、斜杠、反斜杠、`.`、`..`、NUL、Windows drive 和 URI scheme
    拒绝。风险是本 agent 未执行真实外部 provider 单书端到端命令；Type DD 也
    保留此风险。

## 必须修复项

无。

## 非阻断风险

- `loadUpperCatalogProjection()` 解析 projection YAML 时，schema 目前只要求
  `scopeId: z.string().min(1)`，没有交叉断言 YAML 内部 `scopeKind/scopeId` 与
  调用方请求完全一致。由于 projection 不参与 query-ready 权威判定，且读取路径已
  通过 `projectionPath()` 做 scope id 安全校验，此项不阻断；后续可加一致性校验作为
  硬化。
- Type DD 的历史 `postImplementationTurn011/012.retainedRisks` 仍保留
  “catalog projection generation remains future”。当前状态已在
  `currentImplementationStatus` 与 `postImplementationTurn013` 中更新为最小
  projection 已实现并通过复审；历史段落不构成过度声明。
- 真实外部 provider 单书 `--graph-book-id` 成功验证、LLM synthesis、
  controlled deepening、library 管理命令仍未完成。Type DD 已正确保留边界，不应在
  implementation-turn_013 后声明全部实现闭环。

## 证据和命令

关键证据：

- `upper-catalog-projection.ts`：`ProjectionAuthoritySchema` 固定
  `catalogIsAuthority: z.literal(false)`；`projectionPath()` 调用
  `assertSafeUpperScopeId()`；`loadUpperCatalogProjection()` 通过
  `projectionPath()` 读取。
- `upper-package-paths.ts`：`assertSafeUpperScopeId()` 拒绝路径穿越、URI scheme、
  Windows drive、NUL、斜杠和 `..`；`readQueryReadyPackage()` 校验
  package-local `CURRENT.json`、manifest、quality gate、`PUBLISH_READY.json` 与
  sidecar。
- `bookshelf-graph.ts` / `library-graph.ts`：projection rebuild 位于 package-root
  `PUBLISH_READY.json` 写入之后。
- `durable-state-store.ts`：仅映射
  `graph_vault/catalog/bookshelves/*/projection.yaml` 与
  `graph_vault/catalog/library/*/projection.yaml`，owner 为
  `upperCatalogProjection`。
- `test/graphrag-bookshelf-graph.test.ts`：断言 projection 存在、
  `catalogIsAuthority=false`、catalog 根无 `BOOKSHELF_MANIFEST.json`，并删除
  projection 后显式书架查询仍返回 evidence。
- `test/graphrag-library-graph.test.ts`：断言 projection 存在、
  `catalogIsAuthority=false`、catalog 根无 `LIBRARY_MANIFEST.json`，并删除
  projection 后显式 library 查询仍返回 evidence。
- `test/cli-graphrag-route.test.ts` 与相关 CLI tests：覆盖 missing、legacy
  catalog-only、failed/staging、typed error、timing 和敏感信息不泄露。
