# Implementation Audit R1 Agent B

## Result

FAIL

## Fixed Baseline

- Criteria source:
  `audits/graphrag-runner-start-book-state-repair-boundary-run_20260529_r1__open/agent-b/implementation-audit-criteria.md`
- Criteria count: 10
- Criteria changes: none
- Audit scope: current implementation, Type DD, plan, contract schema, and focused
  tests.

## Blocking Issues

### B1. Criterion 5 FAIL: first blocker does not preserve durable mode

The read-only book-scoped diagnostic is built with
`durableMode: "read_only_blocking_diagnostic"`, but the runner wraps the first
blocker into a `DurableStateError` and overwrites that value with
`durableMode: "strict"`. The failed manifest and recovery summary then project
the overwritten evidence, so the first blocker no longer preserves the durable
mode required by the fixed criterion and Type DD.

Evidence:

- `scripts/graphrag/runner-startup-preflight.mjs:152` starts the read-only
  diagnostic builder.
- `scripts/graphrag/runner-startup-preflight.mjs:249` builds the diagnostic
  base from the durable mapping.
- `scripts/graphrag/runner-startup-preflight.mjs:273` records
  `normalRunnerAction: "no_book_scoped_mutation"`.
- `scripts/graphrag/runner-startup-preflight.mjs:274` records
  `durableMode: mode`, where `mode` is read-only blocking diagnostic.
- `scripts/graphrag/batch-epub-workflow.mjs:6001` spreads the first blocker
  into durable error evidence.
- `scripts/graphrag/batch-epub-workflow.mjs:6003` overwrites
  `durableMode` with `"strict"`.
- `scripts/graphrag/runner-startup-preflight.mjs:97` builds the failed startup
  manifest from durable error evidence.
- `scripts/graphrag/runner-startup-preflight.mjs:126` stores the projected
  blocker as `startupRecovery.firstBlocker`.
- `scripts/graphrag/batch-epub-workflow.mjs:7466` persists the startup
  preflight failure.
- `scripts/graphrag/batch-epub-workflow.mjs:7479` writes the recovery summary
  from the failed manifest.
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1276` requires
  book-scoped targets in normal `runner_start` to use read-only blocking
  diagnostic.
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1308` requires the
  startup failure manifest and recovery summary to carry the blocker evidence.

Required correction:

- Preserve the original blocker durable mode when wrapping the first blocker,
  or write any runner wrapper mode under a separate field that does not replace
  the read-only diagnostic mode.

### B2. Criterion 3 FAIL: mutation accounting misses durable delete events

Startup preflight mutation accounting is implemented as an event-name filter.
The filter covers quarantine, checksum backfill, checksum meta backfill, temp
reconciliation, checksum meta sidecar quarantine, and checksum meta commit
events. It does not cover durable delete events such as
`durable_lock_recovered`. During startup preflight, the event log write path can
encounter and recover a stale JSON lock, delete that lock, emit
`durable_lock_recovered`, and still leave `mutationCount` unchanged.

Evidence:

- `scripts/graphrag/runner-startup-preflight.mjs:76` defines
  `isStartupPreflightMutationEvent`.
- `scripts/graphrag/runner-startup-preflight.mjs:77` only matches
  `target_quarantined`, `checksum_backfilled`, and `temp_reconciled`.
- `scripts/graphrag/runner-startup-preflight.mjs:79` covers
  `durable_checksum_meta_backfilled`.
- `scripts/graphrag/runner-startup-preflight.mjs:80` covers checksum meta
  sidecar quarantine.
- `scripts/graphrag/runner-startup-preflight.mjs:81` covers checksum meta
  commit suffixes.
- `scripts/graphrag/batch-epub-workflow.mjs:4585` increments
  `mutationCount` only when that filter returns true.
- `scripts/graphrag/batch-epub-workflow.mjs:12057` assigns the shared startup
  scan stats object to `durablePreflightMutationStats`.
- `scripts/graphrag/batch-epub-workflow.mjs:12058` runs `runner_start`
  durable preflight while that stats object is active.
- `scripts/graphrag/batch-epub-workflow.mjs:6008` emits
  `durable_preflight_blocked` during durable preflight.
- `scripts/graphrag/batch-epub-workflow.mjs:4590` writes events through
  `withJsonFileLock(eventsPath, ...)`.
- `scripts/graphrag/batch-epub-workflow.mjs:6641` can call
  `removeStaleJsonLock` when a JSON file lock already exists.
- `scripts/graphrag/batch-epub-workflow.mjs:6467` deletes the stale lock with
  `unlinkSync`.
- `scripts/graphrag/batch-epub-workflow.mjs:6470` emits
  `durable_lock_recovered`, which is not counted by the startup mutation filter.
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1301` requires
  startup recovery counts to derive from the same preflight scan result.
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1303` requires
  `mutationCount` to count actual lock, temp, checksum, meta, backfill,
  quarantine, delete, and rename write operations.

Required correction:

- Expand mutation accounting so durable delete, rename, and write mutation
  events during startup preflight increment the same startup scan stats object.
  This should include `durable_lock_recovered` and any other durable mutation
  event names reachable while `durablePreflightMutationStats` is active.

## Criteria Determinations

1. PASS. Type DD alignment is mostly enforced for book-scoped repair scope.
   Book-scoped mappings are marked as such, and normal `runner_start` delegates
   primary target checks to read-only diagnostics instead of writable repair.
   Evidence: `scripts/graphrag/batch-epub-workflow.mjs:5625`,
   `scripts/graphrag/batch-epub-workflow.mjs:5904`,
   `scripts/graphrag/batch-epub-workflow.mjs:5979`,
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273`.

2. PASS. `targetCount`, `degradedTargetCount`, and `mutationCount` are intended
   to share the same `startupScanStats` object. Evidence:
   `scripts/graphrag/runner-startup-preflight.mjs:38`,
   `scripts/graphrag/runner-startup-preflight.mjs:47`,
   `scripts/graphrag/runner-startup-preflight.mjs:57`,
   `scripts/graphrag/runner-startup-preflight.mjs:64`,
   `scripts/graphrag/batch-epub-workflow.mjs:12045`,
   `scripts/graphrag/batch-epub-workflow.mjs:12057`,
   `scripts/graphrag/batch-epub-workflow.mjs:12080`.

3. FAIL. Mutation accounting omits at least `durable_lock_recovered`, a durable
   delete event reachable during startup preflight. See blocking issue B2.

4. PASS. Book-scoped diagnostics expose the zero mutation budget with
   `maxRunnerStartMutationCount: 0` and `normalRunnerAction:
   "no_book_scoped_mutation"`. Evidence:
   `scripts/graphrag/runner-startup-preflight.mjs:273`,
   `scripts/graphrag/runner-startup-preflight.mjs:275`,
   `test/graphrag-runner-durable-preflight.test.ts:253`,
   `test/graphrag-runner-durable-preflight.test.ts:256`.

5. FAIL. The first blocker loses the read-only durable mode because the runner
   wrapper overwrites it with `"strict"`. See blocking issue B1.

6. PASS. Startup failure before claims writes a failed manifest and recovery
   summary before item checkpoints are loaded, leaving no ambiguous running
   manifest on that path. Evidence:
   `scripts/graphrag/runner-startup-preflight.mjs:106`,
   `scripts/graphrag/runner-startup-preflight.mjs:108`,
   `scripts/graphrag/runner-startup-preflight.mjs:114`,
   `scripts/graphrag/runner-startup-preflight.mjs:116`,
   `scripts/graphrag/batch-epub-workflow.mjs:7466`,
   `scripts/graphrag/batch-epub-workflow.mjs:7479`,
   `scripts/graphrag/batch-epub-workflow.mjs:12058`,
   `scripts/graphrag/batch-epub-workflow.mjs:12118`.

7. PASS. Blocked book-scoped startup failure stores fielded
   `nextOperatorAction: "run_explicit_repair"`. Evidence:
   `scripts/graphrag/runner-startup-preflight.mjs:126`,
   `scripts/graphrag/runner-startup-preflight.mjs:131`,
   `test/graphrag-runner-durable-preflight.test.ts:253`,
   `test/graphrag-runner-durable-preflight.test.ts:258`.

8. PASS. Exported runtime contracts accept the new durable diagnostic and
   startup recovery fields used by manifests and summaries. Evidence:
   `src/contracts/batch-run.ts:40`,
   `src/contracts/batch-run.ts:46`,
   `src/contracts/batch-run.ts:54`,
   `src/contracts/batch-run.ts:94`,
   `src/contracts/batch-run.ts:109`,
   `src/contracts/batch-run.ts:732`.

9. PASS. Status-json compatibility is preserved for existing read-only catalog
   diagnostics and provider request diagnostics. Evidence:
   `src/contracts/batch-run.ts:43`,
   `scripts/graphrag/batch-epub-workflow.mjs:12104`,
   `scripts/graphrag/batch-epub-workflow.mjs:12114`,
   `test/graphrag-runner-status-json-readonly.test.ts:250`,
   `test/graphrag-runner-status-json-readonly.test.ts:319`.

10. PASS. Focused tests cover the read-only book-scoped startup blocker and
    contract parsing for the new fields. Evidence:
    `test/graphrag-runner-durable-preflight.test.ts:153`,
    `test/graphrag-runner-durable-preflight.test.ts:240`,
    `test/graphrag-runner-durable-preflight.test.ts:253`,
    `test/graphrag-runner-durable-preflight.test.ts:281`,
    `test/integrations/contracts.test.ts:395`,
    `test/integrations/contracts.test.ts:408`,
    `test/integrations/contracts.test.ts:1874`,
    `test/integrations/contracts.test.ts:1912`.

## Residual Test Gap

The focused tests do not currently assert that
`startupRecovery.firstBlocker.durableMode` remains
`read_only_blocking_diagnostic`, and they do not exercise startup preflight
mutation counting for durable delete, rename, or generic write events. These
gaps allowed B1 and B2 to remain undetected by the current regression tests.
