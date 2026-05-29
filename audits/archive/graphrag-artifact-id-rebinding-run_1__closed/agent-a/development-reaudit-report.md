# GraphRAG Artifact Id Rebinding Development Reaudit Report

Verdict: pass

## Criteria Results

1. Pass. Stale checkpoint artifact ids are rebound to current valid artifacts
   for the same book id, stage, producer run id, and required kinds.
2. Pass. Duplicate current artifacts are selected deterministically by newest
   `createdAt`, then lowest `artifactId`.
3. Pass. Missing or invalid required artifacts still fail closed with
   observable missing and invalid evidence.
4. Pass. Bootstrap high-cost checkpoints are no longer promoted to real
   successful producer evidence.
5. Pass. `query_ready` still validates `graph_extract`, `community_report`,
   and `embed` producer artifacts.
6. Pass. Batch status uses the same current-manifest evidence semantics needed
   by repository resume planning for this case.
7. Pass. JSON, Parquet, and LanceDB validators were not weakened.
8. Pass. Tests cover refreshed stats artifact id rebinding, missing or invalid
   stats rejection, and bootstrap producer rejection.
9. Pass. qmd query routing and OpenAI credential error classification are not
   changed by this diff.
10. Pass. Real batch status repair preserves the external `INVALID_API_KEY`
    blocker as stop-until-fixed.

## Closed Findings

The previous bootstrap producer finding is closed. `repository.ts` now uses a
shared real-producer predicate that rejects `metadata.bootstrap === true`, and
`validateQueryReadyProducerStages` uses the same predicate.

The follow-up capability projection finding is also closed.
`src/graphrag/capability-catalog.ts` carries checkpoint metadata into
projection candidates and rejects `metadata.bootstrap === true` in
`checkpointMatchesBook`. The regression test manually writes a legacy
`query_ready` checkpoint after repository rejection and verifies
`loadGraphQueryCapabilities` still returns no capability.

## Residual Risk

This reaudit was read-only. It reviewed current source, tests, and recorded
verification results but did not independently rerun the full suite.
