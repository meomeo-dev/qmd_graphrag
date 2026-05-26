# Dev Agent A Baseline

1. Repair-only mode must never execute GraphRAG query calls or CLI command
   checks; it may only inspect and repair local GraphRAG state.
2. A local artifact gate that can be repaired from validated local evidence must
   reopen the item as `pending` with `continue_pending`.
3. A local artifact gate that needs real GraphRAG work must reopen the same
   item as `pending`, `transient`, `retry_same_run_id`, and preserve the stage
   that needs rebuilding.
4. A repair-only blocked result with `requiresRealRebuild: true` must not set
   `localArtifactGateRepairBlocked`.
5. A repair-only blocked result without `requiresRealRebuild: true` must remain
   a manual blocked state and must not spin in the same runner invocation.
6. Reopened real rebuilds must continue in the same batch run id and must not
   create a new batch or book identity.
7. Existing permanent data compatibility and provider-auth failures must not be
   reclassified as real-rebuild recoverable failures.
8. Repair metadata for successful projection repair must remain strict and
   include reason, projection, evidence locator, producer run ids, and command
   check requirement.
9. Events and checkpoints must expose enough information to distinguish
   `repaired`, `blocked`, and `requires_real_rebuild`.
10. The implementation must preserve GraphRAG book-scoped output isolation and
    typed checkpoint persistence invariants.
