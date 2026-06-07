# implementation-turn_013 / agent-1 实施审计报告

## 结论

PASS_WITH_RISK

## 逐项判定

1. 单书包复制传播不回归：PASS
   本轮 projection 代码只读上层包和单书包 manifest，不写
   `graph_vault/books/**`。CLI 回归测试中 `--graph-book-id` 相关 fixture
   路由仍通过。

2. 书架/library 派生索引不污染单书包：PASS
   `buildBookshelfGraph()` 与 `buildLibraryGraph()` 仅在上层包发布后调用
   projection rebuild；未发现写回单书包闭包。

3. 上层包闭包不写入 catalog，且删除 catalog projection 不影响显式查询：PASS
   durable writer 只允许
   `graph_vault/catalog/bookshelves/{id}/projection.yaml` 与
   `graph_vault/catalog/library/{id}/projection.yaml`。测试确认 catalog 下没有
   `BOOKSHELF_MANIFEST.json` / `LIBRARY_MANIFEST.json`，并确认删除 projection
   root 后显式 package-root 查询仍成功。

4. runner ledger 不参与语义检索：PASS
   本轮 `upper-catalog-projection.ts` 从 `readQueryReadyPackage()` 读取
   package-local ready 状态，再读 manifest/gate；未读取
   `catalog/batch-runs/**` 或 runner ledger。

5. 查询预算不随书籍数量线性增长：PASS
   projection 只投影 manifest 中的 fixed budget 字段；library 测试覆盖
   10、100、1000 book scale 的固定预算模拟并通过。

6. evidence lineage 可追溯：PASS
   projection 保留 `evidenceMap` artifact locator；现有 library graph 测试覆盖
   不可追溯 evidence 与 `unknown-*` lineage fail closed。

7. staging/failed/running/pending/stale 不可被当 ready：PASS
   `rebuildBookshelfCatalogProjection()` / `rebuildLibraryCatalogProjection()`
   均先调用 `readQueryReadyPackage()`；该函数校验 `CURRENT.json`、
   `queryReady=true`、readyState、manifest/gate/publish marker 和 sidecar。
   CLI 测试覆盖 failed/staging/pending/current 非 ready 阻断。

8. manifest/quality gate/publish marker 状态闭环：PASS
   builder 在写入 package-local `CURRENT.json`、root manifest、root quality
   gate、`PUBLISH_READY.json` 后才 rebuild projection。projection 内只保存
   locator、sha、checkIds 和 `catalogIsAuthority=false`，不复制
   manifest/gate/publish marker 内容到 catalog。

9. CLI typed error 与 timing 可观测：PASS
   CLI route 和 helper 测试通过，覆盖 `upper_package_migration_required`、
   `upper_quality_gate_failed`、missing upper index、scope ambiguity 与
   `timingAvailable` 字段。

10. 敏感信息与单书 GraphRAG/qmd vsearch 不回归：PASS_WITH_RISK
    上层 graph 测试覆盖 sensitive payload fail closed；CLI 单书 GraphRAG
    fixture 路由通过。未执行真实外部 provider 的单书 `--graph-book-id` E2E；
    本 agent 未运行 qmd vsearch 测试，保留为非阻断风险。

## 必须修复项

无。

## 非阻断风险

- 本轮验证证明 catalog projection 最小实现符合合同，但真实外部 provider
  单书 `--graph-book-id` 成功路径仍未执行。
- 本 agent 未覆盖真实 qmd vsearch 命令，只通过代码范围和既有测试定位确认没有
  直接触碰 vsearch 路径。主控补充运行了 qmd vsearch 目标回归。
- Type DD 中历史 `postImplementationTurn011/012.retainedRisks` 仍保留
  “catalog projection generation remains future”；当前
  `postImplementationTurn013` 已更新为最小 projection 已实现并通过复审，
  最终汇总时应避免误读历史风险为当前缺口。

## 检查证据

- `src/graphrag/upper-index/upper-catalog-projection.ts`
- `src/graphrag/upper-index/upper-package-paths.ts`
- `src/graphrag/upper-index/bookshelf-graph.ts`
- `src/graphrag/upper-index/library-graph.ts`
- `src/job-state/durable-state-store.ts`
- `test/graphrag-bookshelf-graph.test.ts`
- `test/graphrag-library-graph.test.ts`

已运行验证：

- `tsc -p tsconfig.build.json --noEmit --pretty false`：通过。
- `test/graphrag-bookshelf-graph.test.ts`：4 passed。
- `test/graphrag-library-graph.test.ts`：7 passed。
- `test/cli-graphrag-route.test.ts`：19 passed。
- `test/cli-graphrag-query-scope.test.ts`：8 passed。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 passed。
