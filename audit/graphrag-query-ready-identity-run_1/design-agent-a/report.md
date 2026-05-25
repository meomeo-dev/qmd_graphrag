# Query Ready Identity 设计审计报告

## 审计范围

本报告按固定基准
`audit/graphrag-query-ready-identity-run_1/design-agent-a/baseline.md`
的 10 条标准逐条审计，不新增或替换判定标准。

真实失败为：

- `bookId`: `book-9f587b71073a-ad95ce2f`
- `documentId`: `doc-fd8875181a17`
- 失败信息：
  `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`

## 基准逐条审计

### 1. `query_ready` 必须同时要求 QMD corpus identity 与 GraphRAG document identity

判定：PASS

证据：

- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.md:341`
  - `:347` 定义 `query_ready` 只引用已验证查询产物，并且只有
  `DocumentIdentityMap` 已写入 `graphDocumentId`、非空
  `graphTextUnitIds` 且存在 qmd corpus registration 时才发布 graph
  capability。
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2551`
  - `:2584` 按 `canonicalBookId`、`documentId`、`contentHash` 查找
  identity，并强制要求 `qmdCorpusRegistered`、`graphDocumentId`、
  `graphTextUnitIds`。
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:770`
  - `:817` 注册 qmd corpus 前校验 normalized content hash，并写入
  qmd corpus registration。

设计决策建议：继续实施。保留严格发布门禁（strict publication gate），不要
将 `query_ready` 降级为只看 GraphRAG artifact 是否存在。

### 2. GraphRAG document identity extraction 必须容忍 GraphRAG 内部 id 不同

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:638`
  - `:666` 只先按 QMD `documentId` 匹配 `documents.parquet.id`，失败后仅在
  `documents` 单行时 fallback。该逻辑能容忍单文档不同 id，但不能处理同一书
  产生多行 GraphRAG document 的真实输出。
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_graph_text_unit_identity.json:6`
  - `:10` 已记录 QMD `documentId` 与 GraphRAG `graphDocumentId` 的映射。
- 只读检查真实 `documents.parquet` 显示该输出有 2 行 GraphRAG document，而
  sidecar 中 `graphTextUnitIds` 为 70 个。当前 extraction 规则没有用
  book-scoped manifest、sidecar 或内容身份证明来消解该情形。

设计决策建议：修正完善设计。GraphRAG 内部 id 不同应通过
`qmd_output_manifest.json` 的 book/source/document/content/fingerprint 匹配、
`qmd_graph_text_unit_identity.json` 的同一身份字段匹配、以及 text unit 存在性
校验来允许；多 GraphRAG document 只能在 book scope 和内容身份均已验证时修复，
否则必须拒绝。

### 3. 设计必须定义关键字段的事实源

判定：UNCLEAR

证据：

- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.md:301`
  - `:312` 定义 `sourceId`、`documentId`、`bookId`、`contentHash`、
  `graphTextUnitId`、`graphDocumentId` 的语义。
- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:235`
  - `:289` 定义 `document_id`、`content_hash`、`graph_text_unit_id`、
  `graph_document_id` 的 producer 与 source table。
- `/Users/jin/projects/qmd_graphrag/src/contracts/corpus.ts:62`
  - `:88` 定义 `DocumentIdentityMap` 与 `GraphTextUnitIdentityMap` 字段。
- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.md:421`
  - `:425` 同时写明 Graph Bus 记录 GraphRAG artifacts 与 identity map，又说
  query-ready 判定以 validated checkpoint 和 manifest 为唯一事实源，未明确
  `qmd_graph_text_unit_identity.json`、parquet、manifest、catalog 的修复优先级。

设计决策建议：补充设计。应明确字段事实源：
`documentId/sourceHash/contentHash/normalizedPath` 来自 book job 与 qmd corpus
registration；`graphDocumentId/graphTextUnitIds` 来自 validated book-scoped
GraphRAG output，经 sidecar 或 parquet extraction 证明后写回
`DocumentIdentityMap`；发布时 catalog 是查询能力投影的读取源，sidecar 是可验证
修复证据，不是绕过门禁的权威源。

### 4. Identity map 写入必须幂等并更新既有 entry

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1083`
  - `:1131` 的 `upsertDocumentIdentityMap` 按 `canonicalBookId` 删除旧 entry 后
  重建 identity。新对象没有保留既有 `graphDocumentId`、`graphTextUnitIds` 或
  graph metadata。
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1134`
  - `:1179` 的 `recordGraphTextUnitIdentity` 能更新既有 entry，但依赖前序 entry
  仍存在且匹配 source/document/content。
- `/Users/jin/projects/qmd_graphrag/graph_vault/catalog/document-identity-map.yaml:13366`
  - `:13524` 真实失败书籍的 catalog entry 保留了 qmd corpus registration，但缺少
  `graphDocumentId` 与 `graphTextUnitIds`。

设计决策建议：修正。`upsertDocumentIdentityMap` 必须对相同
`canonicalBookId/documentId/contentHash/sourceHash` 做非破坏性合并，保留已验证
graph identity 与 qmd metadata；只有内容身份变化时才清除不再适用的 graph 字段。

### 5. stale 或 missing identity map entry 必须可由 validated 输出修复

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_graph_text_unit_identity.json:1`
  - `:10` 已存在完整 GraphRAG text unit identity sidecar。
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_output_manifest.json:3`
  - `:23` 记录同一 `bookId/sourceHash/documentId/contentHash` 与 producer run id。
- `/Users/jin/projects/qmd_graphrag/graph_vault/catalog/document-identity-map.yaml:13366`
  - `:13524` catalog 对同一书只保留 qmd corpus registration，缺失 graph identity。
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:704`
  - `:737` 只尝试从 parquet 读取并写回，未读取已存在的
  `qmd_graph_text_unit_identity.json` 进行修复。

设计决策建议：补平。新增 repair path：当 query-ready artifacts 存在且 qmd corpus
registration 已验证时，优先读取 sidecar，校验其 book/source/document/content/
normalizedPath 与 manifest/job/catalog 一致，再幂等写回 catalog；sidecar 缺失时再
走 parquet extraction；两者都不能证明时保持失败。

### 6. repair path 不得削弱混书、歧义、缺 text units、hash mismatch 的拒绝

判定：UNCLEAR

证据：

- `/Users/jin/projects/qmd_graphrag/src/job-state/artifact-validation.ts:520`
  - `:555` 已对 book-scoped output、producer run id、stage fingerprint、
  provider fingerprint 与 `corpusContentHash` 做 fail-closed 校验。
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1047`
  - `:1068` `outputProducerMatches` 校验 manifest 的 book/source/document/
  content/provider/stage fingerprints。
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:687`
  - `:690` GraphRAG identity extraction 在 text unit id 为空时返回 null。
- 现有设计没有明确 sidecar repair 或多文档 repair 的拒绝规则，因此不能证明新增
  repair 不会绕过上述门禁。

设计决策建议：补充设计。repair 必须先通过 validated manifest 与 artifact gate，
再校验 sidecar 或 parquet 派生结果；多文档且无法唯一证明目标 graph document、
text unit 不存在、sidecar 与 job/catalog hash 不一致、或 output locator 不是
`books/<bookId>/output` 时全部拒绝。

### 7. 设计必须区分 runtime 变更与 docs-only 变更并识别最小模块

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/status.yaml:5`
  - `:12` 表明真实运行失败发生在 runtime query-ready identity 同步，不是文档
  描述问题。
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1551`
  - `:1565` runtime sync 在 query-ready artifacts 存在时执行 graph identity 记录。
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1083`
  - `:1179` runtime repository 负责 identity map upsert 与 graph identity 写回。
- 现有设计文档未列出该修复的 runtime/docs/test 最小变更边界。

设计决策建议：修正完善设计。最小 runtime 模块应限制在
`src/job-state/graphrag-book.ts` 与 `src/job-state/repository.ts`；测试补在
`test/graphrag-book-state.test.ts` 和 `test/book-job-state.test.ts`，必要时补一条
CLI resume 覆盖；文档仅补架构/记录说明，不得作为 docs-only 修复。

### 8. 测试必须包含真实失败形态

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/test/graphrag-book-state.test.ts:1445`
  - `:1515` 覆盖了 query-ready artifacts 存在但缺 qmd corpus registration 的拒绝，
  未覆盖 sidecar 已存在但 catalog 缺 graph identity 的修复。
- `/Users/jin/projects/qmd_graphrag/test/book-job-state.test.ts:301`
  - `:318` 测试通过手动 `recordGraphTextUnitIdentity` 后再注册 qmd corpus，未模拟
  真实的 stale catalog。
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_graph_text_unit_identity.json:1`
  - `:10` 真实失败形态中 sidecar 已存在。
- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/status.yaml:11`
  - `:12` 真实失败仍报缺失 graph identity。

设计决策建议：补平。新增回归测试：构造 book-scoped GraphRAG outputs、
`qmd_output_manifest.json`、`qmd_graph_text_unit_identity.json` 和 qmd corpus
registration；故意让 `document-identity-map.yaml` 缺少 graph fields；再次 sync
应修复 catalog 并允许 query-ready completion。

### 9. 测试必须包含多文档歧义与 source/content mismatch 负例

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/test/graphrag-book-state.test.ts:39`
  - `:45` 现有 GraphRAG output fixture 是单 GraphRAG document，不能覆盖多文档
  ambiguous output。
- `/Users/jin/projects/qmd_graphrag/test/cli.test.ts:5614`
  - `:5650` 仅覆盖 artifact 文件 hash mismatch 后 status-json 变 stale，不是
  graph identity sidecar/source/content mismatch。
- `/Users/jin/projects/qmd_graphrag/test/unified-query.test.ts:1356`
  - `:1446` 覆盖 query routing 的 ambiguous content hash，不是 query-ready
  identity repair 的多文档 ambiguous output。

设计决策建议：补平。新增负例：两个 GraphRAG document 且 sidecar 缺失或无法唯一
绑定时拒绝；sidecar 的 `sourceHash`、`documentId`、`contentHash`、`bookId` 任一与
job/manifest/catalog 不一致时拒绝；text unit id 不存在于 `text_units.parquet` 时拒绝。

### 10. 设计必须支持 safe resume，避免重跑高成本 GraphRAG stages

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1526`
  - `:1548` sync 已能在 manifest 匹配时收集既有 output artifacts。
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:671`
  - `:727` `query_ready` 分支只写 manifest、校验 producer artifacts 并 complete
  checkpoint，不调用 GraphRAG high-cost index workflow。
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_output_manifest.json:16`
  - `:23` 真实输出已有 book-scoped output locator 与 producer run ids。
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/checkpoints.yaml:37`
  - `:50` 真实运行仍在已有 output 后因 identity 缺失失败，说明 safe resume 被
  identity repair 缺口阻断。

设计决策建议：补平。safe resume 应在 query-ready 前执行 identity repair，并仅在
validated outputs 无法证明身份时要求重跑；对已验证 outputs，重跑同一本书应只补
catalog/checkpoint/capability 投影，不重新执行 `graph_extract`、`community_report`
或 `embed`。

## 总体设计建议

最小可行设计（minimum viable design）应包含以下决策：

- 保留 `query_ready` 严格门禁：qmd corpus registration、graph identity、validated
  producer artifacts 三者缺一不可。
- 将 `qmd_graph_text_unit_identity.json` 定义为可验证 repair evidence；它必须与
  job、manifest、catalog 的 `bookId/sourceHash/documentId/contentHash/normalizedPath`
  完全一致。
- 将 `DocumentIdentityMap` 写入改为非破坏性合并，避免重复 sync 清除已验证 graph
  identity。
- repair 先验证 output manifest 和 artifact gate，再校验 sidecar/text units，最后
  写回 catalog；任何 mixed-book、ambiguous、missing text units、hash mismatch 都
  fail closed。
- 测试补齐真实失败形态与负例后再继续实施 query-ready completion。

## 总体结论

DESIGN FAIL
