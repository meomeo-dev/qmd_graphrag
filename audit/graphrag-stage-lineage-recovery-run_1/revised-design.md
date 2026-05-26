# Revised Design: GraphRAG Stage Lineage Recovery

## Scope

This design only changes GraphRAG stage lineage recovery, artifact readiness,
manifest lineage preservation, and resume observability. It does not change qmd
search, GraphRAG query semantics, ranking, output rendering, or CLI output
formats.

## Invariants

1. A high-cost stage that has a usable succeeded checkpoint is ready even when
   its checkpoint artifact ids are stale, provided current artifacts for the
   same stage and producer run pass all readiness checks.
2. A newer failed, running, abandoned, interrupted, timed out, or otherwise
   non-succeeded attempt never shadows an older usable succeeded checkpoint.
3. A newer succeeded checkpoint supersedes an older succeeded checkpoint only
   after its current artifacts pass the same readiness checks.
4. Readiness validates required artifact kinds, book scope, producer run id,
   stage fingerprint, provider fingerprint, corpus content hash, and artifact
   file integrity. Missing, empty, corrupt, wrong-scope, wrong-producer,
   wrong-fingerprint, wrong-provider, wrong-corpus, and wrong-hash artifacts are
   not recoverable.
5. `qmd_output_manifest.json` preserves `stageProducerRunIds` per stage. Sync or
   repair may merge known lineage from the existing manifest and validated
   succeeded checkpoints, but must not collapse lineage into the last writer run
   id.
6. Query-ready is a conjunction gate: graph_extract, community_report, and embed
   must each have a usable succeeded checkpoint, producer run id, and validated
   required artifacts.
7. Resume planning exposes evidence. For every blocked stage it reports missing
   artifact kinds, missing artifact ids, and invalid artifact reasons. For every
   recovered stage it selects current artifact ids by producer lineage instead
   of mutating unrelated behavior.

## Stage Checkpoint Resolution

For each stage, the repository builds a candidate list from recorded
checkpoints. A checkpoint is usable when all conditions hold:

- status is `succeeded`;
- input fingerprint matches the current stage fingerprint;
- high-cost checkpoint metadata is not bootstrap-only;
- stage, provider, and corpus hashes match the registered book state;
- current artifacts for the checkpoint producer run satisfy stage readiness.

The resume planner chooses the newest usable succeeded checkpoint by checkpoint
finish/start timestamp. Non-succeeded checkpoints remain diagnostic records and
run records but do not shadow usable succeeded checkpoints. If no usable
succeeded checkpoint exists, the latest checkpoint state supplies blocked
status and evidence.

## Artifact Rebinding

When a succeeded checkpoint artifact id list is stale, stage readiness derives a
candidate artifact set from the current artifact manifest:

- same book id;
- same stage;
- same producerRunId as the checkpoint;
- required kind is present exactly enough for the stage gate;
- stage fingerprint, provider fingerprint, and corpus content hash match;
- file integrity validation passes.

The derived current artifact ids are used for readiness evidence. This does not
trust stale checkpoint artifact ids and does not mark invalid artifacts ready.

## Manifest Lineage Repair

When writing or repairing `qmd_output_manifest.json`, the implementation merges
lineage from:

- an existing matching manifest;
- usable succeeded checkpoints for graph_extract, community_report, embed, and
  query_ready;
- the stage currently being completed.

The output always stores `stageProducerRunIds[stage]` per completed stage. The
manifest-level `producerRunId` remains the last writer for compatibility but is
not used as the only producer identity for multi-stage recovery.

## Query-Ready Gate

Query-ready readiness requires all producer stages:

- graph_extract has all graph core artifacts;
- community_report has community reports parquet;
- embed has complete LanceDB index;
- all three producer run ids are available and artifacts validate against their
  own stage fingerprints and shared corpus/provider identity.

If any producer stage is missing or invalid, query-ready is blocked and the true
next stage is the first missing or invalid producer stage, usually embed after
reports are ready.

## Recovery From the Observed Batch State

If duplicate graph_extract has already partially overwritten outputs, readiness
must fail closed because old graph_extract artifact hashes no longer match the
current files. The current book must rebuild graph_extract and downstream
community_report/embed. The code fix prevents the same incorrect fallback for
later books and for future completed stages.
