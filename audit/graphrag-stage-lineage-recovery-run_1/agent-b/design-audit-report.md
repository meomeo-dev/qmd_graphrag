# Design Audit Report

Result: failed

## Summary

The proposed design should prevent artifact id refresh from causing high-cost
stage reruns, but it is incomplete without explicit checkpoint resolution,
manifest lineage preservation, and query-ready conjunction gating.

## Failed Criteria

- Criterion 4: newer failed or running checkpoints must not shadow older usable
  succeeded checkpoints.
- Criterion 5: manifest repair must preserve per-stage lineage.
- Criterion 6: query-ready must remain a conjunction of graph_extract,
  community_report, and embed readiness.

## Required Changes

- Resolve stage readiness from candidates, not only the latest checkpoint row.
- Rebuild or preserve `stageProducerRunIds` for every completed stage.
- Add query-ready validation that checks all producer stages and artifacts.
