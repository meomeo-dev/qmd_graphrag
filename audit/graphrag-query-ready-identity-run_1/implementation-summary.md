# Query Ready Identity 实施摘要

## 变更范围

运行代码：

- `src/job-state/repository.ts`
- `src/job-state/graphrag-book.ts`

测试：

- `test/book-job-state.test.ts`
- `test/graphrag-book-state.test.ts`

## 实施内容

- `upsertDocumentIdentityMap` 对同一
  `canonicalBookId/sourceHash/documentId/contentHash` 执行非破坏性合并，保留
  `chunkIds`、qmd corpus registration metadata、`graphDocumentId` 与
  `graphTextUnitIds`。
- 再次注册同一内容身份时，`qmdCorpusRegistered`、`qmdCollection`、
  `qmdRelativePath`、`qmdChunkCount`、`graphDocumentId` 和
  `graphTextUnitCount` 等 repository projection metadata 由既有 catalog 值保护，
  用户传入 metadata 不得覆盖这些状态字段。
- `syncGraphRagBookWorkspace` 在需要 query-ready identity 时优先读取已有
  `qmd_graph_text_unit_identity.json`，校验身份字段与 text unit 存在性后通过仓库
  写回 `DocumentIdentityMap`。
- mismatched 或 stale sidecar 直接 fail closed，不 fallback 到 parquet。
- sidecar 缺失时保留既有 parquet extraction 路径。
- 回归测试覆盖 sidecar 已存在但 catalog 缺 graph fields 的真实失败形态，以及
  stale sidecar 负例和 repository 非破坏性 upsert。

## 已运行验证

- `npm run test:types`
- `node ./node_modules/vitest/vitest.mjs run test/graphrag-book-state.test.ts test/book-job-state.test.ts --testTimeout 120000 --reporter=dot`
- `node ./node_modules/vitest/vitest.mjs run test/unified-query.test.ts test/cli-graphrag-route.test.ts test/integrations/graphrag-cost.test.ts --testTimeout 120000 --reporter=dot`
- `node ./node_modules/vitest/vitest.mjs run test/cli.test.ts --testTimeout 120000 --reporter=dot`
- `.venv-graphrag/bin/python test/python/test_graphrag_bridge_scope.py`

## 审计后修正

- Dev Agent A 初审指出再次 register 时 incoming metadata 可能覆盖已有 qmd corpus
  registration metadata。已修正为 protected projection metadata existing-wins，并在
  `test/book-job-state.test.ts` 增加冲突 metadata 回归。
- Dev Agent A 复审指出 legacy catalog remap 可能留下重复 canonical identity。已在
  `rewriteLegacyCatalogReferences` 后对 `DocumentIdentityMap` 按
  `canonicalBookId/sourceId/sourceHash/documentId/contentHash` 去重合并，并在
  `test/graphrag-book-state.test.ts` 增加 old/new identity 同时存在的回归。
- Dev Agent A 复审指出 metadata sanitizer 缺少 raw provider payload 结构性边界。
  已对 `raw*`、`payload`、`body`、`providerRequest`、`providerResponse`、
  `requestBody`、`responseBody` 等键执行 denylist，并在
  `test/book-job-state.test.ts` 增加 raw provider payload 不落盘断言。
- 修正后已重跑：
  - `npm run test:types`
  - `node ./node_modules/vitest/vitest.mjs run test/book-job-state.test.ts --testTimeout 120000 --reporter=dot`
  - `node ./node_modules/vitest/vitest.mjs run test/graphrag-book-state.test.ts --testTimeout 120000 --reporter=dot`

## 剩余风险

真实 EPUB resume 尚未在本实现修正后重跑。原因是当前流程仍处于开发审计循环；
按任务门禁，必须先通过开发审计复审，再回到真实 EPUB 闭环。未重跑前的剩余风险是：
真实运行环境的既有 failed checkpoint 重新打开路径可能仍暴露测试夹具未覆盖的
batch runner 状态问题。开发审计通过后，下一步验收必须以
`epub-batch-20260525-full-real` 的失败书或新的真实 run 恢复执行，并确认
`graph_extract`、`community_report`、`embed` producer run ids 不变，catalog graph
identity 被补齐，`query_ready` 与 27 个 command checks 通过。
