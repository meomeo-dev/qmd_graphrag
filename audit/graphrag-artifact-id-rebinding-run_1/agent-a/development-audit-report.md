# GraphRAG Artifact Id Rebinding Development Audit Report

Verdict: fail

## Criteria Results

1. Pass. High-cost stage artifact gates now select candidates from the current
   manifest by `bookId`, `stage`, `producerRunId`, and required artifact kinds.
2. Pass. Duplicate valid candidates use deterministic selection based on newest
   `createdAt`, then lowest `artifactId`.
3. Pass. Missing and invalid artifacts still fail closed and expose observable
   `missingArtifactKinds`, `missingArtifactIds`, and `invalidArtifacts`.
4. Fail. Bootstrap high-cost checkpoints could still be used as
   `query_ready` producer evidence when current checkpoints were initialized
   into the effective state before usable-checkpoint filtering.
5. Fail. `query_ready` still validated producer artifacts, but the producer
   lineage could be derived from bootstrap checkpoints instead of real
   non-bootstrap GraphRAG producer runs.
6. Pass. Batch status uses current-manifest artifact evidence rather than stale
   checkpoint artifact ids.
7. Pass. JSON, Parquet, and LanceDB validators were not weakened.
8. Pass. Regression coverage includes refreshed `graphrag_stats_json`
   rebinding and missing or invalid stats rejection.
9. Pass. The diff does not change qmd query routing or OpenAI credential error
   classification.
10. Pass. Real batch status shows the local GraphRAG state repaired while
    preserving the external `INVALID_API_KEY` blocker.

## Finding

High severity. `query_ready` producer run id derivation rejected missing or
failed checkpoints, but did not reject high-cost checkpoints marked
`metadata.bootstrap: true`. That allowed bootstrap checkpoints to satisfy
producer lineage even though bootstrap output must force a real rebuild before
query readiness.

Affected area: `src/job-state/repository.ts`, `producerRunIdsForQueryReady`
and `validateQueryReadyProducerStages`.

## Required Fix

Use one shared real-producer predicate for `graph_extract`,
`community_report`, and `embed` query-ready lineage. The predicate must require
`status: succeeded`, a non-empty `runId`, and `metadata.bootstrap !== true`.
Add a regression test that constructs valid artifacts with only bootstrap
producer checkpoints and asserts `query_ready` is rejected and no graph
capability is published.
