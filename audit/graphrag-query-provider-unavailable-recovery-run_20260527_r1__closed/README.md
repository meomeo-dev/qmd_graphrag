# GraphRAG Query Provider Unavailable Recovery Audit

## Status

open

## Run

- Audit case: graphrag-query-provider-unavailable-recovery
- Run: 20260527_r1
- Real batch run id: epub-batch-20260527-real-resume-1

## Trigger

During the real EPUB batch, `Building Microservices (Sam Newman).epub`
completed QMD build and GraphRAG build, then failed at
`qmd-query-graphrag-json` with a structured GraphRAG provider error:

```json
{
  "schemaVersion": "1.0.0",
  "route": "graphrag",
  "stage": "graphrag_query",
  "provider": "graphrag",
  "capability": "graph_query",
  "code": "provider_unavailable",
  "retryable": false,
  "redactedMessage": "GraphRAG query provider failed before returning a response."
}
```

The batch status classified the item as non-retryable
`recoveryDecision=stop_until_fixed`, while the writer continued into the next
book before manual stop. This case audits the intended recovery semantics for
GraphRAG query provider failures and batch stop behavior.

## Fixed Audit Principles

Each agent must use the same ten audit principles in its report:

1. Retryability preserves structured provider error semantics.
2. Transient upstream/provider failures do not become permanent without proof.
3. Batch stage gates require book-scoped QMD build, command, GraphRAG build,
   and GraphRAG query evidence before completion.
4. Failed required evidence must prevent completion and expose the exact failed
   stage.
5. A stop-until-fixed decision must stop scheduling further books in the same
   writer process.
6. Orphaned runner recovery must preserve checkpoint identity and not corrupt
   adjacent book state.
7. Provider recovery must be observable in status JSON with retry timing and
   reason.
8. Retrying a failed query must not rebuild unrelated successful artifacts
   unless lineage is stale.
9. Docs and runbooks must describe the operator action for provider query
   outages.
10. Tests must pin retry classification and batch stop behavior for this case.
