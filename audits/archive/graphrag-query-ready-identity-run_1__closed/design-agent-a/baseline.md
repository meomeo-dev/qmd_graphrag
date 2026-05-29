# Design Agent A Baseline: Query Ready Identity Contract

Scope: audit the design needed to fix `query_ready` failure when GraphRAG
outputs exist but the document identity map is not available or not consistent.

1. `query_ready` must require a QMD corpus identity and a GraphRAG document
   identity for the same canonical book before publishing a graph capability.
2. GraphRAG document identity extraction must tolerate GraphRAG assigning a
   different internal document id than QMD, but only when the book scope is
   unambiguous and content identity is preserved.
3. The design must define the source of truth for `documentId`, `sourceHash`,
   `contentHash`, `normalizedPath`, `graphDocumentId`, and `graphTextUnitIds`.
4. Identity map writes must be idempotent and must update existing entries
   without creating duplicate canonical identities for the same book.
5. A stale or missing identity map entry must be repairable from validated
   book-scoped GraphRAG outputs and QMD corpus registration.
6. The repair path must not weaken strict refusal for mixed-book outputs,
   ambiguous GraphRAG documents, missing text units, or mismatched content hash.
7. The design must distinguish runtime implementation changes from docs-only
   changes and identify the minimum affected modules.
8. Tests must include the real failure shape: GraphRAG outputs and
   `qmd_graph_text_unit_identity.json` exist, but query-ready sync still fails.
9. Tests must include negative cases for multi-document ambiguous output and
   mismatched source/content identity.
10. The design must support safe resume: rerunning the same book after the fix
    should not require redoing high-cost GraphRAG stages when valid outputs
    already exist.
