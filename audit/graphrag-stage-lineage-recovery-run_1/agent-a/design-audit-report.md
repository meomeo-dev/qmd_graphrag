# Design Audit Report

Result: failed

## Summary

The initial design covers the core stale artifact id recovery problem, but it
misses checkpoint selection semantics, per-stage manifest lineage retention,
query-ready three-stage gating, and observable resume evidence.

## Failed Criteria

- Criterion 4: define checkpoint selection so newer failed or running attempts
  do not hide a usable older succeeded checkpoint.
- Criterion 5: preserve per-stage `stageProducerRunIds`; do not collapse lineage
  into the last writer run id.
- Criterion 6: query-ready must require validated graph_extract,
  community_report, and embed producers.
- Criterion 9: resumePlan must expose true next stage and missing or invalid
  evidence.

## Required Changes

- Add latest usable succeeded checkpoint resolution by stage.
- Validate current artifacts by producerRunId, stage, kind, book scope,
  fingerprints, corpus content hash, and file integrity.
- Repair manifest lineage from validated succeeded checkpoints and artifacts.
- Keep query-ready fail-closed across graph_extract, community_report, and embed.
