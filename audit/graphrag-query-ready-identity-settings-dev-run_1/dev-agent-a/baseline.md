# GraphRAG Query-Ready Implementation Audit Baseline - Agent A

## Scope

Audit the implementation that recovers real GraphRAG query-ready projection
failures in batch EPUB runs. Focus on runtime state-machine behavior,
book-scoped artifact gates, and checkpoint transitions. Do not audit unrelated
CLI output rendering, DSPy behavior, or provider model selection.

## Fixed Criteria

1. Runtime code must keep `graph_extract`, `community_report`, `embed`, and
   `query_ready` stage ownership separate.
2. `query_ready` must not be marked complete unless producer-stage lineage and
   query artifacts are valid for the same book identity.
3. Repair-only logic must reopen affected items to pending work and must not
   mark them completed directly.
4. Repair must preserve valid high-cost producer run ids for existing
   `graph_extract`, `community_report`, and `embed` outputs.
5. Repair must refresh only local projections, such as document identity and
   graph capability metadata.
6. Runtime classification must treat missing capability or document identity
   projections as local artifact gates, not provider transients.
7. Runtime validation must fail closed on source hash, normalized content hash,
   document id, book id, normalized path, or producer lineage mismatch.
8. Completed batch items must require the normal CLI command-check set after
   repair.
9. Checkpoints and recovery summaries must expose repair reason, repaired
   projection, evidence locator, reused producer run ids, and active command.
10. Regression tests must cover the real observed query-ready failure texts.
