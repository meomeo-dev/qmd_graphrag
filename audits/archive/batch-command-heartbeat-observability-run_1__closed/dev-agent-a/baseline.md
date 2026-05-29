# Batch Command Heartbeat Observability Audit Baseline - Agent A

## Scope

Audit the batch runner command heartbeat change for runtime state correctness.
The reviewed change is limited to long-running batch command observability and
must not alter qmd indexing, GraphRAG stage semantics, or query behavior.

## Fixed Criteria

1. Long-running commands refresh `runnerHeartbeatAt` while the parent runner is
   blocked in `spawnSync`.
2. The heartbeat is written only for the owning runner session, host, and PID.
3. The heartbeat does not steal, overwrite, or reopen another runner's item.
4. `currentCommand` and `currentCommandStartedAt` identify the active command
   without changing command retry semantics.
5. Command completion clears active-command fields for the same owning session.
6. Failed commands still preserve existing failure classification and retry
   decision behavior.
7. The monitor exits when the parent runner dies, the stop file appears, or the
   checkpoint is no longer owned by the runner.
8. The monitor tolerates transient checkpoint read failures without corrupting
   state.
9. Heartbeat state is reflected in normal checkpoint files and recovery summary
   output.
10. The change avoids broad rewrites of batch execution, qmd, and GraphRAG
    stage gate logic.

