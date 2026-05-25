# Design Agent B Baseline: Query-Ready Recovery Reopen

Scope: audit the design for reopening a failed EPUB batch item after a
code-level fix repairs GraphRAG query-ready identity or graph capability
projection. The audit covers recovery semantics only; it must not redesign the
whole GraphRAG pipeline.

1. A `stop_until_fixed` item may be reopened only when the original failure is
   a local query-ready or graph-query readiness gate, not a provider/network
   failure or ambiguous data error.
2. Reopen logic must be evidence based. It must reclassify from persisted
   failure text and current artifacts, not from operator intent alone.
3. Query-ready identity failures, including missing QMD-to-GraphRAG document
   identity, must be repairable after a validated sidecar or validated
   book-scoped GraphRAG output is available.
4. Graph capability readiness failures, including unknown or not-ready
   `graphCapabilityId`, must be repairable only after catalog capabilities are
   reconstructed from validated `query_ready` lineage.
5. Reopen must not mark the item completed. It must reset the item to
   `pending` or `continue_pending` so the normal qmd and GraphRAG command
   checks execute.
6. Reopen must preserve operator observability: event log, item checkpoint,
   recovery summary, failed stage, and repair reason must show what changed.
7. Reopen must not rerun high-cost GraphRAG stages when their producer
   checkpoints and artifacts remain valid.
8. Reopen must fail closed for mixed-book output, stale sidecar identity,
   content-hash mismatch, missing producer lineage, or incomplete artifacts.
9. Tests must cover the real failure shapes:
   `GraphRAG document identity is missing for query_ready` and
   `capabilityScope references unknown or not-ready graphCapabilityId(s)`.
10. The implementation boundary must remain narrow: batch failure
    classification, batch checkpoint hydration, resume repair gates, and
    focused tests. Unrelated qmd search, CLI rendering, and GraphRAG execution
    behavior must stay unchanged.
