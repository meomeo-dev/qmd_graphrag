# GraphRAG Artifact Id Rebinding Final Report

## Verdict

Development audit passed.

## Scope

This case fixes GraphRAG artifact readiness when checkpoint artifact ids become
stale after the current artifact manifest is refreshed. It also closes the
related `query_ready` producer lineage gaps so bootstrap high-cost checkpoints
cannot be treated as real query-ready producer evidence.

## Implemented Controls

1. Current artifact manifests are used as the source of truth for high-cost
   stage gates when the checkpoint run id is known.
2. Candidate artifacts are selected by `bookId`, `stage`, `producerRunId`, and
   required kind before validation.
3. Valid candidates are selected deterministically by newest `createdAt`, then
   lowest `artifactId`.
4. Existing validators remain authoritative for content hash, Parquet, JSON,
   LanceDB, stage fingerprint, provider fingerprint, corpus content hash, and
   book-scoped output path.
5. `query_ready` producer lineage requires real non-bootstrap
   `graph_extract`, `community_report`, and `embed` checkpoints.
6. Capability projection rejects bootstrap checkpoints even when legacy state
   already contains a `query_ready` success checkpoint.
7. Batch status uses current-manifest GraphRAG evidence instead of stale
   checkpoint artifact ids.

## Verification

- `npm run test:node -- test/book-job-state.test.ts`
- `npm run test:node -- test/graphrag-book-state.test.ts`
- `npm run test:node -- test/unified-query.test.ts`
- `npm run typecheck`
- `node -c scripts/graphrag/batch-epub-workflow.mjs`
- `git diff --check`

## Real Run Status

The repaired local GraphRAG status path no longer reports the previously stale
`graphrag_stats_json` artifact id as missing for the sampled Accelerate item.
The remaining blocker is the external OpenAI `INVALID_API_KEY` failure from
`qmd-query-json`; it remains stop-until-fixed and is not treated as a local
GraphRAG artifact gate defect.

## Residual Risk

Batch status and capability projection still contain equivalent lineage
selection logic outside the repository class. Focused tests now cover the
known drift points, but future validator changes should either share the same
selector or update all paths together.
