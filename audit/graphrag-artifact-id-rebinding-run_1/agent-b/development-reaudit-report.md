# GraphRAG Artifact Id Rebinding Development Reaudit Report

Verdict: pass

## Criteria Results

1. Pass. Current artifact selection filters by `producerRunId` and required
   kind before validation.
2. Pass. Validation still covers stage fingerprint, provider fingerprint,
   corpus content hash, content hash, and book-scoped path.
3. Pass. Duplicate valid artifacts use newest `createdAt`, then lowest
   `artifactId`.
4. Pass. Invalid candidate artifact ids remain visible in diagnostics.
5. Pass. Repository resume planning does not return `graph_extract` when
   current producer artifacts are complete.
6. Pass. Capability publication and projection use current lineage artifact
   ids, and capability projection now rejects bootstrap checkpoints.
7. Pass. Batch `--status-json` does not independently report stale from old
   checkpoint artifact ids.
8. Pass. Existing invalid artifact and LanceDB sidecar regression paths remain
   covered.
9. Pass. TypeScript typecheck and batch script syntax checks pass.
10. Pass. Runtime state remains stop-until-fixed on 401 authentication
    failures.

## Residual Risk

Batch status and capability projection still assemble lineage in separate
paths. Their behavior is now covered by focused tests, but future validator
changes should be synchronized or moved into a shared selector.
