# GraphRAG Identity Projection Reaudit 1 - Agent B

## Conclusion

PASS

前次 FAIL 已修复。当前设计已将 `normalizedPath` 提升为 Type DD
一等 typed locator，并在 sidecar adoption 与 repair rejection 中强制校验。
`normalizedPath` 不参与 canonical identity，但作为 normalized input locator
参与 adoption gate，且 mismatch 必须 fail-closed。

## Reaudit Findings

- `normalizedPath` 已在统一身份模型中定义为 normalized input locator，并说明由
  EPUB 规范化结果和 qmd corpus registration 投影产生；它不参与 canonical
  identity，但参与 GraphRAG repair adoption 校验：
  `docs/architecture/unified-retrieval-plane.md:308`.
- Type DD 已新增 `identity_model.normalized_path`，列出 producer、catalog
  sources、`participates_in_canonical_identity: false` 和 adoption invariant：
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:258`.
- `graph_text_unit_identity_map.required_identity_fields` 已包含
  `normalizedPath`：
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:516`.
- sidecar adoption 已要求
  `bookId/sourceId/sourceHash/documentId/contentHash/normalizedPath` 均匹配当前
  `BookJob`、qmd corpus registration 和 `qmd_output_manifest.json`：
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:1756`.
- repair rejection 已明确对 `normalizedPath mismatch` fail-closed：
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:527`.

## Criterion Results

1. PASS - 设计已定义 `bookId`、`sourceId`、`sourceHash`、`documentId`、
   `contentHash`、`normalizedPath` 和 GraphRAG text unit id 的身份或 locator
   契约。核心定义见
   `docs/architecture/unified-retrieval-plane.md:301` 和
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:226`.

2. PASS - document identity sidecar 为 book-scoped repair evidence，路径位于
   `graph_vault/books/<book_id>/output/qmd_graph_text_unit_identity.json`，并且
   graph vault 使用 vault-relative locator，独立于 host absolute path：
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:522`.

3. PASS - sidecar adoption 已强制校验 `bookId/sourceId/sourceHash/documentId/
   contentHash/normalizedPath`，且要求 text unit ids 在 GraphRAG text units
   output 中存在：
   `docs/architecture/unified-retrieval-plane.md:369` 和
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1756`.

4. PASS - sidecar mismatch 不会静默覆盖有效 catalog state。`DocumentIdentityMap`
   upsert 为非破坏性合并，graph identity 只能在 content identity change 或
   validated repair evidence 证明旧投影 stale 时清除：
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:498`.

5. PASS - 缺失 `DocumentIdentityMap` graph projection 可从有效 sidecar 或
   validated parquet extraction 修复，然后重试 `query_ready`，且不得重跑
   `graph_extract`、`community_report` 或 `embed`：
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1747`.

6. PASS - graph capability 发布依赖 qmd corpus registration 和有效
   `query_ready` artifacts。canonical readiness 要求
   `DocumentIdentityMap.metadata.qmdCorpusRegistered=true`、graph identity 和
   validated checkpoint/manifest：
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1833`.

7. PASS - capability scope 只来自 selected ready `GraphCapability` records；
   `selectedSourceIds`、`selectedDocumentIds` 和 `selectedContentHashes` 均由
   selected `GraphCapability` 派生：
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1575`.

8. PASS - 设计防止 stale same-book 或 same-title artifacts 满足不同 content
   identity。GraphRAG document title 只作为 locator，不参与 readiness 或权限判断；
   query-ready 校验同时检查 artifact hash 与 `metadata.corpusContentHash`：
   `docs/architecture/unified-retrieval-plane.md:338` 和
   `docs/architecture/unified-retrieval-plane.md:779`.

9. PASS - graph capability 不可用时，query route refusal 保持 typed。显式
   `--graphrag` 不静默 fallback，并以 typed capability error 表达：
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1558`.

10. PASS - 测试要求覆盖 missing identity、sidecar mismatch、missing
    capability projection 和 stale producer lineage。focused regressions 与
    negative reopen tests 见
    `docs/architecture/unified-retrieval-plane.type-dd.yaml:2029` 和
    `docs/operations/graphrag-epub-batch-runbook.md:174`.

## Required Remediation

None.
