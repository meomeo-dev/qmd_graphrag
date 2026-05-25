# Query Ready Identity 设计复审报告

## 复审范围

本报告只按固定基准
`audit/graphrag-query-ready-identity-run_1/design-agent-a/baseline.md`
第 6 至 27 行的原 10 条标准复审，不新增或替换基准。

复审输入：

- `audit/graphrag-query-ready-identity-run_1/design-agent-a/baseline.md`
- `audit/graphrag-query-ready-identity-run_1/design-agent-a/report.md`
- `audit/graphrag-query-ready-identity-run_1/design-fix-summary.md`
- `docs/architecture/unified-retrieval-plane.md`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `catalog/data-bus.catalog.yaml`
- `audit/graphrag-query-ready-identity-run_1/status.yaml`

## 逐条复审

### 1. query_ready 必须同时要求 QMD corpus identity 与 GraphRAG document identity

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:341` 至 `:347` 定义
  `query_ready` 必须先验证 `graph_extract`、`community_report`、`embed`
  producer checkpoint 和 artifact 证据，并且只有
  `DocumentIdentityMap.graphDocumentId`、非空 `graphTextUnitIds` 与 qmd
  corpus registration 同时存在时才发布 graph capability。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1732` 至 `:1741`
  将 canonical readiness 定义为 validated checkpoint 加 validated manifest，
  并明确 qmd corpus registration gate 与 graph identity gate。
- `docs/operations/graphrag-epub-batch-runbook.md:118` 至 `:122` 将
  `DocumentIdentityMap.metadata.qmdCorpusRegistered=true`、`graphDocumentId`
  与非空 `graphTextUnitIds` 列为 `graphBuildStatus.status=succeeded`
  的必要条件。

剩余缺口：无。

### 2. GraphRAG document identity extraction 必须容忍 GraphRAG 内部 id 不同

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:353` 至 `:356` 将
  `graphDocumentId` 与 `graphTextUnitIds` 的事实源定义为已验证的
  book-scoped GraphRAG output，并将 `qmd_graph_text_unit_identity.json`
  定义为 repair evidence。
- `docs/architecture/unified-retrieval-plane.md:365` 至 `:370` 要求 sidecar
  repair 校验 `bookId/sourceId/sourceHash/documentId/contentHash` 与当前
  job/catalog 一致；sidecar 缺失时只允许直接匹配 GraphRAG document id
  或单 GraphRAG document fallback，多 document 无法唯一证明时 fail-closed。
- `catalog/data-bus.catalog.yaml:225` 至 `:236` 规定
  `graph_text_unit_identity_map` 绑定 qmd identity 到 GraphRAG
  `graphDocumentId` 和 `graphTextUnitIds`，且多 document output 无有效
  sidecar 或直接 document identity match 时不得按 title 或 first row 修复。

剩余缺口：无。

### 3. 设计必须定义关键字段的事实源

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:351` 至 `:356` 定义
  `documentId`、`sourceHash`、`contentHash`、`normalizedPath` 的事实源是
  book job 与 qmd corpus registration；`graphDocumentId` 与
  `graphTextUnitIds` 的事实源是已验证的 book-scoped GraphRAG output。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:226` 至 `:289`
  定义 source、document、content、chunk、GraphRAG text unit 和 GraphRAG
  document identity 的 producer、source table 与 invariant。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:481` 至 `:485`
  明确 sidecar 是 derived repair evidence，不是 query capability 的事实源。
- `catalog/data-bus.catalog.yaml:177` 至 `:201` 明确
  `document_identity_map` 的 producers、consumers、storage 以及 query_ready
  publication source 角色。

剩余缺口：无。

### 4. Identity map 写入必须幂等并更新既有 entry

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:357` 至 `:361` 规定重复注册同一
  `canonicalBookId/documentId/contentHash/sourceHash` 时必须非破坏性合并，
  保留 qmd metadata、`chunkIds`、`graphDocumentId` 与 `graphTextUnitIds`。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:458` 至 `:463`
  将同一 `canonicalBookId/sourceHash/documentId/contentHash` 的 upsert 定义为
  non-destructive merge，并限制清除 graph identity 的条件。
- `catalog/data-bus.catalog.yaml:197` 至 `:201` 同步规定 upsert 保留已验证
  graph identity fields，sidecar 只能修复 projection，不能替代 catalog gate。

剩余缺口：无。

### 5. stale 或 missing identity map entry 必须可由 validated 输出修复

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:362` 至 `:367` 要求 repair 先通过
  `qmd_output_manifest.json`、producer checkpoints、artifact manifests、
  fingerprints 与 `metadata.corpusContentHash` 校验，再校验 sidecar 与
  text units output。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1651` 至 `:1659`
  定义在 GraphRAG outputs、manifest、producer checkpoints、fingerprints 与
  qmd corpus registration 有效但 `DocumentIdentityMap` 缺 graph fields 时，
  resume 从 sidecar 或 validated parquet extraction 修复 catalog projection。
- `docs/operations/graphrag-epub-batch-runbook.md:198` 至 `:201` 将该状态归类为
  `graph_identity_projection_missing`，并要求同一 runId resume 只补 catalog
  projection 后重试 `query_ready`。

剩余缺口：无。

### 6. repair path 不得削弱严格拒绝规则

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:368` 至 `:372` 规定 sidecar 缺失时
  只能做直接 GraphRAG document id 匹配或单 document fallback；多 document 无法
  证明、source/content hash mismatch、混书 output、空 text units、无效 output
  locator 或 producer lineage 不一致时必须拒绝。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:486` 至 `:491`
  将 mixed book output、sourceHash/documentId/contentHash mismatch、空
  `graphTextUnitIds`、text unit ids 不存在、无效 outputDir、producer lineage
  mismatch 与多 document 猜测列为 fail-closed repair rejection policy。
- `docs/operations/graphrag-epub-batch-runbook.md:202` 至 `:204` 同步要求
  identity repair 拒绝混书、source/content mismatch、空 text unit、text unit id
  不存在、无效 outputDir、producer lineage 不一致和缺少有效 sidecar 的多
  GraphRAG document 歧义。

剩余缺口：无。

### 7. 设计必须区分 runtime 变更与 docs-only 变更并识别最小模块

判定：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-fix-summary.md:5` 至 `:12`
  说明本轮只补充设计与验收，不修改运行代码，并列出已修改文档。
- `audit/graphrag-query-ready-identity-run_1/design-fix-summary.md:33` 至 `:42`
  将设计通过后的最小运行代码改动范围限定为
  `src/job-state/repository.ts`、`src/job-state/graphrag-book.ts` 和对应回归测试，
  并禁止通过重跑高成本 GraphRAG stage 或修改无关查询输出逻辑修复。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:444` 至 `:472`
  在 Type DD 中标出 `document_identity_map` 与
  `graph_text_unit_identity_map` 的 producers/consumers，限定 runtime 触点。

剩余缺口：无。

### 8. 测试必须包含真实失败形态

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:815` 至 `:818` 将真实失败
  `book-9f587b71073a-ad95ce2f` 纳入回归验收：sidecar 已存在但 catalog 缺
  graph fields 时，resume 必须补齐 `DocumentIdentityMap` 并完成
  `query_ready`，且 producer run ids 不变。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1928` 至 `:1932`
  要求真实回归测试从已有 `qmd_graph_text_unit_identity.json` 修复缺失的 catalog
  graph identity，并在不改变 `graph_extract`、`community_report` 或 `embed`
  producer run ids 的情况下完成 `query_ready`。
- `audit/graphrag-query-ready-identity-run_1/status.yaml:5` 至 `:12` 记录真实失败
  book、bookId、failedStage 和错误
  `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`。

剩余缺口：无。

### 9. 测试必须包含多文档歧义与 source/content mismatch 负例

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1933` 至 `:1936`
  要求 negative tests 拒绝无有效 sidecar 的多文档 ambiguous GraphRAG output、
  source/content mismatch、空 graph text unit ids，以及不存在于
  `text_units.parquet` 的 text unit ids。
- `docs/architecture/unified-retrieval-plane.md:368` 至 `:372` 定义多 document
  output 无法唯一证明、source/content hash mismatch、混书 output、空 text units
  等情形必须 fail-closed。
- `catalog/data-bus.catalog.yaml:232` 至 `:236` 在 catalog contract 中要求 repair
  对 mixed book output、source/content mismatch、空 `graphTextUnitIds`、缺失
  text unit ids、无效 outputDir、producer lineage mismatch 和无有效 sidecar 的
  multi-document output 拒绝。

剩余缺口：无。

### 10. 设计必须支持 safe resume

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1651` 至 `:1659`
  规定 `graph_identity_projection_missing` 通过 sidecar 或 validated parquet
  extraction 修复 catalog projection 后重试 `query_ready`，不得重跑
  `graph_extract`、`community_report` 或 `embed`。
- `docs/operations/graphrag-epub-batch-runbook.md:198` 至 `:201` 规定同一 runId
  resume 只补 catalog projection 并重试 `query_ready`，不重跑高成本 stage。
- `catalog/data-bus.catalog.yaml:1082` 至 `:1086` 将该状态定义为本地 projection
  repair reason，只 reopen catalog/query_ready projection work，禁止重跑
  `graph_extract`、`community_report` 或 `embed`。

剩余缺口：无。

## 总体结论

DESIGN PASS
