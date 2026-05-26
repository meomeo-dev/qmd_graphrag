# Dev Agent B Development Audit Baseline

## Scope

Audit the recovery, checkpoint, artifact isolation, and batch-resume behavior
around failed GraphRAG producer stages.

## Fixed Criteria

1. The recovery unit remains `book_id + processing_stage + command_check`; the
   early stop must not introduce a second state ledger or bypass normal
   checkpoint persistence.
2. Failed early-stop attempts do not publish producer manifests, artifact
   gates, `query_ready`, or `graph_query` capabilities.
3. Before retrying a GraphRAG producer stage, retryable failed checkpoints
   trigger cleanup or isolation of only that stage's owned residual outputs.
4. Cleanup must be stage-owned and white-listed: `community_report` may delete
   `community_reports.parquet`; `embed` may delete LanceDB stage output;
   `graph_extract` may delete graph extraction outputs.
5. Cleanup must not remove prior successful-stage artifacts, source input,
   normalized markdown, catalog files, batch manifests, command logs, other
   books, or unrelated output directories.
6. Cleanup decisions and deleted locators are persisted in stage metadata or
   command failure metadata using relative locators.
7. Retry classification maps early-stop failure text to transient provider
   recovery and `recoveryDecision=retry_same_run_id`.
8. Existing completed-item recovery, local artifact gate repair, provider wait,
   and stale-running-item recovery tests still pass.
9. The batch runner keeps heartbeat ownership intact while the bridge child is
   running; watcher logic must not replace or block heartbeat updates.
10. The implementation remains compatible with same `runId` resume semantics:
    previous successful stages are reused and only the failed current producer
    stage is retried.
