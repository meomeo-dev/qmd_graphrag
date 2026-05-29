# GraphRAG Artifact Id Rebinding Design

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

## Design

Use the current artifact manifest as the source of truth for gate validation
when the producer run id is known. A checkpoint remains authoritative for stage
status, run id, and timing, but not for immutable artifact id membership after
artifact re-recording has refreshed ids for the same output files.

For every GraphRAG stage gate:

1. Select candidate artifacts by `bookId`, `stage`, `producerRunId`, and the
   required artifact kinds for the stage.
2. Validate the candidate set with existing artifact validators, including
   book-scoped output path, content hash, parquet structure, JSON object shape,
   LanceDB tables, stage fingerprint, provider fingerprint, and corpus content
   hash.
3. If the candidate set satisfies the required kinds, use those current
   artifact ids as the gate result.
4. If the candidate set does not satisfy validation, fail closed with existing
   missing or invalid artifact reasons.

For `query_ready`, retain producer lineage requirements. It must validate
current artifacts from `graph_extract`, `community_report`, and `embed`
producer run ids. It must not publish readiness from only the checkpoint ids.

## Implementation Scope

The change is limited to GraphRAG artifact readiness and batch status
reconciliation. It must not change qmd query routing, output rendering,
GraphRAG settings projection, or source normalization.

The implementation should reuse existing validators rather than introduce a
second validation model. Regression coverage must include a stale checkpoint
artifact id for `graphrag_stats_json` with a complete current artifact manifest,
and a negative case where stats is missing or invalid.

## Run Decision

After implementation, local GraphRAG state should no longer report stale solely
because checkpoint artifact ids are obsolete. Real batch execution may still
stop on `INVALID_API_KEY`; that condition is an external credential/proxy
failure and must remain stop-until-fixed.
