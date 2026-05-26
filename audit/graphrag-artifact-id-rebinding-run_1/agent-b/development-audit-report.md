# GraphRAG Artifact Id Rebinding Development Audit Report

Verdict: pass

## Criteria Results

1. Pass. Current artifact selection filters by `producerRunId` and required
   kind before validation.
2. Pass. Candidate artifacts are validated against stage fingerprint, provider
   fingerprint, corpus content hash, content hash, and book-scoped path.
3. Pass. Duplicate valid artifacts use newest `createdAt`, then lowest
   `artifactId` as the deterministic tie-break.
4. Pass. Invalid candidate artifact ids remain visible through diagnostics.
5. Pass. Repository resume planning no longer returns `graph_extract` only
   because a checkpoint references an obsolete stats artifact id.
6. Pass. Capability publication uses current lineage artifact ids.
7. Pass. Batch `--status-json` uses the same current-manifest evidence
   semantics and no longer independently reports stale checkpoint artifact ids.
8. Pass. Existing invalid artifact and LanceDB sidecar regression tests remain
   covered.
9. Pass. Typecheck and batch script syntax verification pass.
10. Pass. Authentication failures remain stop-until-fixed and are not treated
    as artifact recovery events.

## Residual Risk

The implementation depends on consistent GraphRAG producer metadata. If future
stages add additional query-ready producers, the fixed criteria and required
kind maps must be extended before those stages can publish query capabilities.
