# Dev Agent C Baseline

1. The design must reduce provider waste after first actionable partial-output
   evidence, not merely relabel the failure after the stage completes.
2. Partial-output early stop must be limited to GraphRAG index stages and must
   not affect `qmd search`, `qmd query`, GraphRAG query, DSPy, or Jina embedding.
3. Error classification must keep provider transient precedence and
   data-compatibility fail-closed behavior.
4. Log watcher polling must be bounded and must not spin or leak processes.
5. Child termination must be deterministic enough for tests and must include a
   graceful-then-forceful escalation or equivalent safe cleanup.
6. Evidence extraction must not leak secrets, absolute private paths, or full
   provider payloads.
7. Existing `concurrent_requests: 5` behavior must remain configurable and
   unchanged.
8. The solution must work whether the repo runs from source via `tsx` or from
   built `dist` code.
9. The design must identify residual risk if a provider error occurs without a
   recognizable log line.
10. Tests must include a fake long-running bridge process so early stop is
    verified without real provider calls.
