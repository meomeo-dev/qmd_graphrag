# Dev Agent B Baseline

1. `repair-local-artifact-gate-only` must not require a failed stage
   checkpoint when all producer stages and `query_ready` are already
   succeeded.
2. Repair-only projection recovery must re-use validated query-ready evidence
   and must not execute a real GraphRAG rebuild.
3. Repair-only projection recovery must publish or refresh `query_ready`
   capability projection through repository completion semantics.
4. Repair-only projection recovery must return `status: repaired`,
   `repairedLocalArtifactGate: true`, and `requiresRealRebuild: false` after
   successful projection repair.
5. Repair-only projection recovery must report fixed metadata:
   `repairReason`, `repairedProjection`, `repairEvidenceLocator`,
   `reusedProducerRunIds`, and `settingsProjectionRepair`.
6. If current stages are incomplete, repair-only must still return blocked
   with `requiresRealRebuild` tied to the actual next stage.
7. Repair-only projection recovery must not clear or rewrite unrelated batch
   state, command checks, or completed book checkpoints.
8. The same batch run id and same book id must be preserved during projection
   repair.
9. Failed projection repair must produce a blocked JSON response with a
   concrete reason and must not spin.
10. The implementation must preserve existing successful repair behavior for
    graph identity, producer-manifest, and settings projection failures.
