# Development Reaudit: PASS

## 逐条结论

| # | 结论 | 复审结论 |
|---|---|---|
| 1 | PASS | `qmd_graph_text_unit_identity.json` 仍作为派生投影缓存（derived projection cache）处理；`contentHash` 与 `normalizedPath` 从当前 query-ready identity 重建。 |
| 2 | PASS | stale sidecar `contentHash` 与 `normalizedPath` 会被重写，且重写前通过 `documents.parquet` 与 `text_units.parquet` 的一致关系验证 graph document 与 text-unit evidence。 |
| 3 | PASS | `bookId`、`sourceId`、`sourceHash` 或 `documentId` 不匹配时，sidecar 不被信任；当前路径会回退到独立 parquet 证据，而不是沿用错误 sidecar。 |
| 4 | PASS | sidecar 引用缺失 text units 时，验证返回无效并阻断发布，不会用该 sidecar 写入 graph identity。 |
| 5 | PASS | sidecar 不可用时允许回退到 parquet，但 parquet fallback 复用同一 evidence validator，要求有效 text-unit identity 后才可进入 `query_ready`。 |
| 6 | PASS | 修复后的 mapping 通过 `recordGraphTextUnitIdentity` 更新 `document-identity-map.yaml`，并写回 sidecar，持久化映射与 repaired sidecar 一致。 |
| 7 | PASS | 多文档 GraphRAG 输出会按当前 normalized title 限定 graph document；wrong graphDocumentId 或绑定另一文档会被拒绝。 |
| 8 | PASS | repair path 不再掩盖 documents/text_units 关系损坏；artifact validation 仍校验 parquet、LanceDB、producer run、stage/provider/corpus fingerprint。 |
| 9 | PASS | `query_ready` 仍要求 producer manifest、producer stage checkpoints、book-scoped artifacts、qmd corpus registration 和 graph document identity。 |
| 10 | PASS | 测试已覆盖 stale content/path repair 与 invalid evidence rejection 的区分，包括 missing graphDocumentId、wrong multi-document binding、missing text units、mismatched sidecar fallback、corrupt documents/text_units relation。 |

## 阻断问题

无阻断问题。

## 复核重点

1. stale content/path repair：
   `src/job-state/graphrag-book.ts:629` 到 `src/job-state/graphrag-book.ts:661`
   将 sidecar 的 `contentHash` 与 `normalizedPath` 替换为当前 expected identity，
   同时仍要求 `bookId`、`sourceId`、`sourceHash`、`documentId` 匹配。

2. sidecar/parquet 证据验证：
   `src/job-state/graphrag-book.ts:691` 到 `src/job-state/graphrag-book.ts:798`
   新增统一 validator，同时读取 `documents.parquet` 与 `text_units.parquet`，
   要求 documents row 的 `text_unit_ids` 与同一 `graphDocumentId` 下 scoped
   text_units 完全一致。

3. sidecar invalid rejection：
   `src/job-state/graphrag-book.ts:800` 到 `src/job-state/graphrag-book.ts:826`
   对 sidecar 的 `graphDocumentId` 与 `graphTextUnitIds` 调用统一 validator；
   missing graph document、wrong binding 或 missing text units 均抛出
   `GraphRAG document identity sidecar evidence is invalid for query_ready`。

4. query_ready 发布门控：
   `src/job-state/repository.ts:1771` 到 `src/job-state/repository.ts:1826`
   要求 graph_extract、community_report、embed producer checkpoints 与有效
   artifacts；`src/job-state/repository.ts:2472` 到
   `src/job-state/repository.ts:2503` 在完成 `query_ready` 前再次校验 query
   artifacts 与 graph identity。

## 验证命令

1. `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-book-state.test.ts`
   结果：PASS，1 个 test file，35 个 tests 全部通过。

2. `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "repair-only blocked can reopen a real GraphRAG rebuild"`
   结果：PASS，1 个定向测试通过，185 个未匹配测试跳过。
