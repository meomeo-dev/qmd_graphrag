# Agent C Baseline: Recovery, Observability, And Resume Semantics

Scope: audit recovery behavior for transient upstream failures, stale runners,
state persistence, and operator observability.

1. Transient upstream failures, including network instability and provider
   overload, must be classified separately from permanent schema or contract
   failures.
2. Retriable provider failures must persist enough checkpoint state to resume
   without losing book identity, stage identity, provider fingerprint, and
   attempt history.
3. Stale local or remote `running` checkpoints must be recoverable when their
   heartbeat exceeds the configured lease TTL.
4. Fresh remote `running` checkpoints must not be stolen by another runner
   before the lease TTL expires.
5. Recovered stale-runner checkpoints must not be reclassified as provider
   transient waits that block for the provider retry window.
6. Batch fail-fast behavior must leave an explicit incomplete manifest instead
   of silently appearing successful.
7. Recovery must never mark a book as graph-ready unless all stage gates and
   artifact validations pass after recovery.
8. Operator-visible logs or status records must indicate current book, stage,
   attempt, retryability, and next recovery action.
9. Resume semantics must be idempotent: rerunning the same batch should skip
   succeeded stages, reopen only recoverable stages, and preserve unrelated
   successful books.
10. Tests must cover stale remote runner recovery, fresh remote runner
    protection, orphaned local runner recovery, provider transient recovery,
    and non-transient schema failure behavior.
