# GraphRAG Artifact Id Rebinding Development Audit Criteria

1. Current artifact selection must filter by producerRunId and required kind
   before validation.
2. Current artifact selection must validate stage fingerprint, provider
   fingerprint, corpus content hash, content hash, and book-scoped path.
3. Duplicate valid artifacts must choose newest `createdAt`, then lowest
   `artifactId`.
4. Invalid candidate artifact ids must remain visible in diagnostics.
5. Repository resume plan must not return `graph_extract` when current producer
   artifacts are complete.
6. Capability publication must use current lineage artifact ids.
7. Batch `--status-json` must not independently report stale from old checkpoint
   artifact ids.
8. Existing regression tests for invalid artifacts and LanceDB sidecars must
   continue to pass.
9. TypeScript typecheck and batch script syntax checks must pass.
10. Runtime state must remain stop-until-fixed on 401 authentication failures.
