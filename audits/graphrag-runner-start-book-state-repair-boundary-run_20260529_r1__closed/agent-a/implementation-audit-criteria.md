# Implementation Audit Criteria Agent A

## Fixed Scope

Audit the implementation of normal `runner_start` handling for existing
book-scoped durable state under the fixed Type DD boundary.

## Fixed Criteria

1. Type DD alignment: implementation must match
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml` for normal
   `runner_start` book-scoped durable state.
2. Zero mutation: normal `runner_start` must not mutate existing book-scoped
   primary targets, checksum sidecars, checksum meta sidecars, temp files,
   locks, owner files, or corrupt targets.
3. Forbidden events: normal `runner_start` must not emit book-scoped
   quarantine, checksum backfill, checksum meta backfill, temp reconciliation,
   delete, or rename events.
4. Read-only blocker: book-scoped checksum mismatch, missing checksum, checksum
   meta conflict, invalid target, unknown temp, or unresolved lock must produce
   a read-only blocking diagnostic.
5. Fail fast: normal `runner_start` must stop after the first book-scoped
   blocker and must not continue scanning into additional book-scoped repair
   mutations.
6. Startup manifest failure: failure before item checkpoint creation must write
   `status: failed`, `failedAt`, zero active slots, zero active subprocesses,
   and zero active book leases.
7. Startup recovery fields: `startupRecovery` must include
   `blocked_before_claim`, `stop_until_fixed`, `firstBlocker`,
   `nextOperatorAction`, `targetCount`, `degradedTargetCount`, and
   `mutationCount`.
8. Recovery summary parity: `recovery-summary.json` and `batch-status.json`
   must preserve the same startup blocker, recovery decision, mutation count,
   and next operator action as the manifest.
9. Provider request boundary: provider-request startup diagnostics must remain
   read-only, capped, non-blocking unless catalog authority is broken, and must
   not be converted into book-scoped repair behavior.
10. Module boundary: new startup-preflight behavior must stay in
    `scripts/graphrag/runner-startup-preflight.mjs` or minimal runner wiring,
    with no additional large-file feature growth beyond the documented plan.
