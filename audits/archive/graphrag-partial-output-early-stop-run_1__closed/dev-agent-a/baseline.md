# Dev Agent A Baseline

1. Early stop must watch only the current GraphRAG stage report log from the
   captured start offset, never old log history.
2. Early stop must detect `Community Report Extraction Error`,
   `error generating community report`, and `No report found for community`.
3. Detection must terminate only the current Python GraphRAG index bridge
   process and must not kill unrelated batch, qmd, or GraphRAG work.
4. The terminated bridge call must reject as a failed command; it must not
   parse partial stdout or produce a successful `GraphRagIndexResponse`.
5. Failure text must be classified as retryable provider/partial-output
   recovery with `recoveryDecision=retry_same_run_id`.
6. Failed attempts must not publish producer manifests, `query_ready`, or
   `graph_query` capabilities.
7. Stage-end health checking must remain as a correctness fallback if early
   stop misses a signal.
8. Other books and completed stages must remain untouched.
9. Evidence must be sanitized and include stage, log locator, and bounded
   evidence lines.
10. Tests must cover current-offset behavior, process termination semantics,
    retry classification, and non-regression for healthy logs.
