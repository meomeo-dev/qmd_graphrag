# Agent C Design Audit R2

## Verdict

PASS

## Scope

Fixed audit object:
`runner_start` handling of book-scoped durable checksum mismatch, covering
observability, audit state, and recovery verifiability.

This review checks only the latest Type DD text and current audit-run state.
No source code or docs were modified.

## Evidence

- Accurate counting is now required. `startupRecovery.targetCount` and
  `mutationCount` must come from the same preflight scan result. `targetCount`
  counts checked primary targets, `degradedTargetCount` counts abnormal targets,
  and `mutationCount` counts actual lock, temp, checksum, meta, backfill,
  quarantine, delete, or rename writes. Any durable quarantine, checksum
  backfill, checksum meta backfill, or temp reconciliation event must increment
  `mutationCount`.
- Normal `runner_start` has a closed book-scoped boundary. Existing
  book-scoped durable targets are read-only blocking diagnostics, and their
  normal runner-start mutation budget is fixed at `0`.
- Bounded repair is limited to explicit repair or migrate-only. That boundary
  must declare `repairScope`, `maxScannedTargets`, `maxReportedSamples`,
  `maxMutationCount`, `firstSample`, `lastSample`, `mutationCount`, `limitHit`,
  and `nextOperatorAction`.
- Manifest, status, and recovery-summary projection is now required for repair
  summaries and startup failure state. Recovery-summary must record the same
  first blocker and next action.
- Failure before item checkpoint creation is no longer allowed to leave an
  ambiguous running manifest. The Type DD requires failed status, `failedAt`,
  `recoveryDecision: stop_until_fixed`,
  `startupRecovery.decision: blocked_before_claim`,
  `startupRecovery.firstBlocker`, `startupRecovery.nextOperatorAction`, and
  zero active provider slots, subprocesses, and book leases.
- `nextOperatorAction` is now a fielded value, not a natural-language hint.
  The allowed values are `run_status_json`, `run_explicit_repair`,
  `run_migrate_only`, `start_new_run_after_repair`, and
  `inspect_manual_state`; blocked book-scoped durable mismatch defaults to
  `run_explicit_repair`.
- Book-scoped target-family rules now state that normal `runner_start` may only
  record a first-blocker summary and stop at `blocked_before_claim` for checksum
  mismatch, missing checksum, checksum meta conflict, invalid target, unknown
  temp, or unresolved lock. It must not mutate any existing book-scoped primary,
  checksum sidecar, meta sidecar, temp, owner, lock, or corrupt target.
- The audit directory state is not drifting: exactly one `__open` audit
  directory is present, namely
  `audits/graphrag-runner-start-book-state-repair-boundary-run_20260529_r1__open`.

## Residual Note

The initial startup recovery manifest field list still includes
`explicitRepairHint`, while the later normative rule requires the stronger
fielded `startupRecovery.nextOperatorAction`. This is not blocking for this
design audit because the later rule closes the verifiable operator-action
contract. Implementation should follow `nextOperatorAction` as the authoritative
field.

## Closure Criteria

The Type DD now closes the Agent C R1 gaps for the fixed audit object:

- exact count source and mutation-count semantics;
- bounded repair limits and limit-hit projection;
- manifest, status, and recovery-summary visibility;
- fail-closed startup state without ambiguous running;
- fielded operator action;
- single open audit continuity.

Design audit R2 passes.
