# GraphRAG Artifact Id Rebinding Revised Design

## Problem

A real batch run for `book-356ff4920cdf-0bbd8bdb` generated and registered
`books/<bookId>/output/stats.json` as `graphrag_stats_json`, but the
`graph_extract` checkpoint still referenced an older stats artifact id. Batch
status then reported `stage_artifact_kind_missing:graphrag_stats_json` even
though the current artifact manifest contained a valid stats artifact for the
same `bookId`, `stage`, `producerRunId`, stage fingerprint, provider
fingerprint, and corpus content hash.

This is a local state reconciliation defect. It is separate from the later
`INVALID_API_KEY` failure raised by `qmd-query-json`.

## Revised Design

Use the current artifact manifest as the source of truth for gate validation
when the producer run id is known and the checkpoint is otherwise usable.
A checkpoint remains authoritative for stage status, run id, and timing, but
not for artifact id membership after artifact re-recording has refreshed ids
for the same output files.

For every GraphRAG stage gate:

1. Consider rebinding only for a non-bootstrap, non-legacy checkpoint that
   existing rules already treat as a usable `succeeded` checkpoint.
2. Select candidate artifacts by `bookId`, `stage`, `producerRunId`, and the
   required artifact kinds for the stage.
3. Validate the candidate set with existing artifact validators, including
   book-scoped output path, content hash, parquet structure, JSON object shape,
   LanceDB tables, stage fingerprint, provider fingerprint, and corpus content
   hash.
4. Group valid candidates by artifact kind. Each required kind must resolve
   deterministically to exactly one current artifact. If multiple valid
   candidates exist for one required kind, choose the artifact with the newest
   `createdAt`, then lowest `artifactId` as a stable tie-breaker. The selected
   set must still satisfy all required kinds. If a candidate lacks stable
   identity fields needed for deterministic ordering, fail closed as ambiguous.
5. Use the selected current artifact ids as the gate result.
6. If the candidate set does not satisfy validation, fail closed with existing
   missing or invalid artifact reasons.

For `query_ready`, retain producer lineage requirements. It must validate
current artifacts from `graph_extract`, `community_report`, and `embed`
producer run ids. It must not publish readiness from only checkpoint ids.

## Batch Status Consistency

Batch status reporting, batch recovery summaries, GraphRAG build status, and
GraphRAG query status must use the same evidence model as repository resume
and query_ready gates. A status path must not independently decide required
kinds from stale checkpoint artifact ids. If a status path cannot reuse the
same function directly, it must implement the same deterministic current
manifest rebinding and existing artifact validators.

## Implementation Scope

The change is limited to GraphRAG artifact readiness and batch status
reconciliation. It must not change qmd query routing, output rendering,
GraphRAG settings projection, source normalization, user-owned inputs, or
user-owned configuration files.

The implementation must reuse existing validators rather than introduce a
second validation model. Regression coverage must include a stale checkpoint
artifact id for `graphrag_stats_json` with a complete current artifact
manifest, a duplicate-current-artifact deterministic case, and a negative case
where stats is missing or invalid.

## Run Decision

After implementation, local GraphRAG state should no longer report stale solely
because checkpoint artifact ids are obsolete. Real batch execution may still
stop on `INVALID_API_KEY`; that condition is an external credential/proxy
failure and must remain stop-until-fixed.
