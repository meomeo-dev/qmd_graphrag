# Development Audit Baseline A

## Scope

Audit the OpenAI retry-guidance classification patch for GraphRAG batch
recovery.

## Fixed Criteria

1. The classifier must mark the observed OpenAI retry-guidance text as
   `failureKind=transient` and `retryable=true`.
2. The match must require explicit retry guidance, not a generic OpenAI
   mention.
3. HTTP 4xx provider status codes must remain permanent before textual retry
   matching is considered.
4. Data compatibility failures must still classify as `data_compatibility`.
5. Local artifact gate failures must still classify as permanent unless a
   provider transient signal is present.
6. Query-ready capability and identity projection failures must still route
   through local artifact gate repair.
7. The change must not edit GraphRAG stage execution, artifact cleanup,
   query-ready projection, or qmd output rendering.
8. A regression test must cover the observed GraphRAG index workflow wrapper
   around the provider message.
9. Type checking must pass.
10. The fix must be safe for legacy status hydration because it uses the
    shared classifier.

