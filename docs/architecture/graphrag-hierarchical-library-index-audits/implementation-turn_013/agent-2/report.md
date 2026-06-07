# implementation-turn_013 / agent-2 实施审计报告

## 结论

PASS_WITH_RISK

## 逐项判定

1. 单书包复制传播不回归：PASS
   `buildBookshelfGraph()` 和 `buildLibraryGraph()` 均只读取单书包或下层书架包
   作为输入，测试断言未向 `graph_vault/books/{bookId}` 写入
   `BOOKSHELF_MANIFEST.json` 或上层 parquet 产物。单书 CLI 回归仍由既有
   `cli-graphrag-route` 覆盖，但本 agent 未重新执行真实 provider 单书
   `--graph-book-id`。

2. 书架/library 派生索引不污染单书包：PASS
   上层 graph publish 写入 `graph_vault/bookshelves/{id}`、
   `graph_vault/library/{id}` 和允许的 catalog projection；未发现写回单书包闭包。

3. 上层包闭包不写入 catalog 且删除 projection 不影响显式查询：PASS
   `upper-catalog-projection.ts` 只写
   `catalog/bookshelves/{id}/projection.yaml` 与
   `catalog/library/{id}/projection.yaml`，projection 内
   `authority.catalogIsAuthority === false`。测试断言 catalog 下没有上层
   manifest，并在删除 catalog projection root 后，显式 `queryBookshelfGraph()`
   / `queryLibraryGraph()` 仍返回 evidence。

4. runner ledger 不参与语义检索：PASS
   本轮 projection 模块没有读取 `graph_vault/catalog/batch-runs/**`。查询路径
   通过 `readQueryReadyPackage()` 进入 package-local generation，再调用 parquet
   query bridge，未发现 runner ledger 被作为语义输入。

5. 查询预算固定：PASS
   bookshelf/library query 使用 manifest 内 `fixedQueryBudget` 作为默认
   `maxReports` / `maxInputTokens`。library 测试覆盖 10、100、1000 book scale
   下固定 `reportCount`、`selectedReportCount`、token 估算和 evidence 指纹。

6. evidence lineage：PASS
   query 测试断言 evidence 包含 `bookId`、`sourceId`、`documentId`、
   `contentHash`、`graphTextUnitId` 或 library scope metadata。validator 和
   fail-closed 测试覆盖缺失、未知或不可追踪 evidence 被拒绝。

7. 非 ready 状态 fail closed：PASS
   `readQueryReadyPackage()` 要求 package root、`CURRENT.json` sidecar、
   generation manifest、root manifest、quality gate、`PUBLISH_READY.json` 与
   sha256 全部一致。CLI 测试覆盖 bookshelf/library 的 `failed` 与 `staging`
   CURRENT 均返回 `upper_quality_gate_failed`，而不是 query-ready。

8. manifest / quality gate / publish marker 闭环：PASS
   bookshelf 和 library publish 顺序为 staging 验证通过后 rename 到
   `generations/{generation}`，写 `CURRENT.json`、root manifest、root quality
   gate、diagnostics、`PUBLISH_READY.json`，随后才调用 projection rebuild。
   projection rebuild 再次调用 `readQueryReadyPackage()`，因此 catalog 不能自证
   ready。

9. CLI typed error / timing：PASS
   CLI route 测试覆盖 missing upper index、legacy catalog-only、failed/staging
   CURRENT、scope ambiguity，并断言 JSON typed error 包含 `code`、`exitCode`、
   `scopeKind`、`scopeId`、`retryable`、`remediationCommand`、
   `timingAvailable`。

10. 敏感信息与单书/qmd vsearch 非回归：PASS_WITH_RISK
    本轮新增 projection 只存 package-relative locator、manifest sha、budget 和
    quality gate 摘要，不复制 provider payload。CLI fail-closed 测试污染
    parquet 后确认 stderr 不泄露绝对路径和 token。风险是本 agent 未重新执行
    qmd vsearch 和真实外部 provider 单书 GraphRAG 成功查询。

## 必须修复项

无。

## 非阻断风险

- 本 agent 未执行测试命令，判定基于代码、测试断言和前序验证结果。
- `implementation-turn_013` 当前只证明最小上层 catalog projection 已接入
  publish 后重建；LLM synthesis、controlled deepening、library 管理命令仍是
  后续能力。
- 若 projection rebuild 在 `PUBLISH_READY.json` 写入后失败，package-root
  query-ready 仍成立但 catalog projection 可能缺失。这符合 projection
  非权威、可重建合同，但运维摘要应将其视为 projection refresh 风险，而不是
  package publish 失败。

## 证据和命令

关键证据：

- `src/graphrag/upper-index/upper-catalog-projection.ts`：bookshelf/library
  projection 先读 `readQueryReadyPackage()`，再写非权威 `projection.yaml`。
- `src/job-state/durable-state-store.ts`：durable writer 将上层 projection 映射到
  `catalogWriterLane`，owner 为 `upperCatalogProjection`。
- `src/graphrag/upper-index/bookshelf-graph.ts`：bookshelf `PUBLISH_READY.json`
  写完后才 rebuild catalog projection。
- `src/graphrag/upper-index/library-graph.ts`：library `PUBLISH_READY.json`
  写完后才 rebuild catalog projection。
- `src/graphrag/upper-index/upper-package-paths.ts`：query-ready 校验覆盖
  package root、CURRENT、manifest、quality gate、PUBLISH_READY 和 sidecar。
- `test/graphrag-bookshelf-graph.test.ts`：projection 存在、非权威、无 catalog
  manifest，删除 projection 后显式 bookshelf 查询仍成功。
- `test/graphrag-library-graph.test.ts`：library 同等覆盖。
- `test/cli-graphrag-route.test.ts`：legacy catalog-only bookshelf/library 返回
  `upper_package_migration_required`；failed/staging CURRENT 不可 query-ready。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：敏感 payload 污染后 CLI
  fail closed，typed error 不泄露路径或 token。
