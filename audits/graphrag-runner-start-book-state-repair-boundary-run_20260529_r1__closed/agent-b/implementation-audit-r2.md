# Implementation Audit R2 Agent B

## Result

PASS

## Fixed Baseline

- Criteria source:
  `audits/graphrag-runner-start-book-state-repair-boundary-run_20260529_r1__open/agent-b/implementation-audit-criteria.md`
- Criteria count: 10
- Criteria changes: none
- Audit scope: implementation delta after R1, Type DD, runtime contracts, and
  focused regression tests.

## R1 Failure Recheck

### B1. Criterion 5: first blocker durable mode preservation

PASS. The runner now preserves the blocker durable mode when wrapping the
preflight diagnostic into `DurableStateError` evidence. The fallback to
`"strict"` only applies when the blocker does not provide a durable mode.

Evidence:

- `scripts/graphrag/runner-startup-preflight.mjs:204` creates the primary
  read-only diagnostic.
- `scripts/graphrag/runner-startup-preflight.mjs:205` sets
  `read_only_blocking_diagnostic` mode for book-scoped primary targets.
- `scripts/graphrag/runner-startup-preflight.mjs:371` stores that mode in the
  durable diagnostic base.
- `scripts/graphrag/batch-epub-workflow.mjs:6048` copies the first blocker into
  `DurableStateError` evidence.
- `scripts/graphrag/batch-epub-workflow.mjs:6051` uses
  `first.durableMode ?? "strict"`, preserving the read-only mode.
- `test/graphrag-runner-durable-preflight.test.ts:266` asserts the manifest
  `startupRecovery.firstBlocker`.
- `test/graphrag-runner-durable-preflight.test.ts:269` asserts
  `durableMode: "read_only_blocking_diagnostic"`.
- `test/graphrag-runner-durable-preflight.test.ts:281` checks the recovery
  summary first blocker.
- `test/graphrag-runner-durable-preflight.test.ts:283` asserts the recovery
  summary durable mode remains `read_only_blocking_diagnostic`.

### B2. Criterion 3: startup mutation accounting coverage

PASS. Startup preflight mutation accounting now covers durable recovery,
delete, rename, write, and commit suffixes in addition to quarantine,
checksum backfill, checksum meta backfill, and temp reconciliation.

Evidence:

- `scripts/graphrag/runner-startup-preflight.mjs:76` defines the startup
  mutation event filter.
- `scripts/graphrag/runner-startup-preflight.mjs:78` counts durable target
  quarantine, checksum backfill, and temp reconciliation events.
- `scripts/graphrag/runner-startup-preflight.mjs:80` counts durable recovered,
  deleted, renamed, written, and committed events.
- `scripts/graphrag/runner-startup-preflight.mjs:82` counts
  `durable_checksum_meta_backfilled`.
- `scripts/graphrag/runner-startup-preflight.mjs:83` counts
  `durable_checksum_meta_sidecar_quarantined`.
- `scripts/graphrag/runner-startup-preflight.mjs:84` counts checksum meta commit
  events.
- `scripts/graphrag/batch-epub-workflow.mjs:4587` increments startup mutation
  stats through the shared filter while startup preflight stats are active.
- `scripts/graphrag/batch-epub-workflow.mjs:6518` emits
  `durable_lock_recovered`, which now matches the recovered suffix.

## Criteria Determinations

1. PASS. Type DD alignment is enforced for normal `runner_start`: book-scoped
   repair is outside the normal startup boundary, and book-scoped targets use
   read-only blocking diagnostics. Evidence:
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273`,
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1277`,
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1286`,
   `scripts/graphrag/batch-epub-workflow.mjs:5662`,
   `scripts/graphrag/batch-epub-workflow.mjs:6027`.

2. PASS. `targetCount`, `degradedTargetCount`, and `mutationCount` derive from
   one `startupScanStats` object during runner-start preflight. Evidence:
   `scripts/graphrag/runner-startup-preflight.mjs:87`,
   `scripts/graphrag/batch-epub-workflow.mjs:12093`,
   `scripts/graphrag/batch-epub-workflow.mjs:12094`,
   `scripts/graphrag/batch-epub-workflow.mjs:12105`,
   `scripts/graphrag/batch-epub-workflow.mjs:12109`,
   `scripts/graphrag/batch-epub-workflow.mjs:12130`.

3. PASS. Startup mutation accounting covers durable quarantine, checksum
   backfill, checksum meta backfill, temp reconciliation, delete, rename, write,
   recovery, and commit events. Evidence:
   `scripts/graphrag/runner-startup-preflight.mjs:76`,
   `scripts/graphrag/runner-startup-preflight.mjs:78`,
   `scripts/graphrag/runner-startup-preflight.mjs:80`,
   `scripts/graphrag/batch-epub-workflow.mjs:4587`,
   `scripts/graphrag/batch-epub-workflow.mjs:6518`.

4. PASS. Book-scoped diagnostics expose a zero normal runner-start mutation
   budget. Evidence:
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1283`,
   `scripts/graphrag/runner-startup-preflight.mjs:180`,
   `scripts/graphrag/runner-startup-preflight.mjs:181`,
   `scripts/graphrag/runner-startup-preflight.mjs:313`,
   `scripts/graphrag/runner-startup-preflight.mjs:314`,
   `test/graphrag-runner-durable-preflight.test.ts:270`,
   `test/graphrag-runner-durable-preflight.test.ts:271`.

5. PASS. The first book-scoped blocker preserves locator fields, local failure
   class, checksum evidence where available, durable mode, and recovery
   decision. Evidence:
   `scripts/graphrag/runner-startup-preflight.mjs:101`,
   `scripts/graphrag/runner-startup-preflight.mjs:107`,
   `scripts/graphrag/runner-startup-preflight.mjs:135`,
   `scripts/graphrag/batch-epub-workflow.mjs:6048`,
   `scripts/graphrag/batch-epub-workflow.mjs:6051`,
   `test/graphrag-runner-durable-preflight.test.ts:266`,
   `test/graphrag-runner-durable-preflight.test.ts:269`,
   `test/graphrag-runner-durable-preflight.test.ts:281`,
   `test/graphrag-runner-durable-preflight.test.ts:283`.

6. PASS. Startup failure before item claims writes failed manifest state,
   clears active counts, and does not create item checkpoint files in the
   focused startup blocker path. Evidence:
   `scripts/graphrag/runner-startup-preflight.mjs:111`,
   `scripts/graphrag/runner-startup-preflight.mjs:117`,
   `scripts/graphrag/runner-startup-preflight.mjs:118`,
   `scripts/graphrag/runner-startup-preflight.mjs:119`,
   `scripts/graphrag/batch-epub-workflow.mjs:12105`,
   `scripts/graphrag/batch-epub-workflow.mjs:12114`,
   `scripts/graphrag/batch-epub-workflow.mjs:12120`,
   `test/graphrag-runner-durable-preflight.test.ts:247`,
   `test/graphrag-runner-durable-preflight.test.ts:251`.

7. PASS. Blocked book-scoped durable mismatch uses a fielded
   `nextOperatorAction: "run_explicit_repair"`. Evidence:
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1315`,
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1317`,
   `scripts/graphrag/runner-startup-preflight.mjs:138`,
   `test/graphrag-runner-durable-preflight.test.ts:263`,
   `test/graphrag-runner-durable-preflight.test.ts:278`,
   `test/integrations/contracts.test.ts:1886`,
   `test/integrations/contracts.test.ts:1912`.

8. PASS. Runtime contracts accept durable diagnostic fields and
   `startupRecovery` fields used by manifests and recovery summaries. Evidence:
   `src/contracts/batch-run.ts:40`,
   `src/contracts/batch-run.ts:46`,
   `src/contracts/batch-run.ts:54`,
   `src/contracts/batch-run.ts:84`,
   `src/contracts/batch-run.ts:94`,
   `src/contracts/batch-run.ts:101`,
   `src/contracts/batch-run.ts:109`,
   `src/contracts/batch-run.ts:121`,
   `src/contracts/batch-run.ts:732`.

9. PASS. Status-json compatibility remains intact for existing read-only
   recovery-summary and provider diagnostic contracts. Evidence:
   `src/contracts/batch-run.ts:43`,
   `src/contracts/batch-run.ts:62`,
   `scripts/graphrag/batch-epub-workflow.mjs:5845`,
   `scripts/graphrag/batch-epub-workflow.mjs:5847`,
   `scripts/graphrag/batch-epub-workflow.mjs:12124`,
   `test/integrations/contracts.test.ts:1908`.

10. PASS. Focused tests cover read-only book-scoped startup blockers and
    contract parsing for the new fields. Evidence:
    `test/graphrag-runner-durable-preflight.test.ts:231`,
    `test/graphrag-runner-durable-preflight.test.ts:243`,
    `test/graphrag-runner-durable-preflight.test.ts:256`,
    `test/graphrag-runner-durable-preflight.test.ts:269`,
    `test/graphrag-runner-durable-preflight.test.ts:418`,
    `test/graphrag-runner-durable-preflight.test.ts:429`,
    `test/graphrag-runner-durable-preflight.test.ts:493`,
    `test/graphrag-runner-durable-preflight.test.ts:502`,
    `test/integrations/contracts.test.ts:408`,
    `test/integrations/contracts.test.ts:1874`.

## Verification

- `node --check scripts/graphrag/batch-epub-workflow.mjs`: PASS.
- `node --check scripts/graphrag/runner-startup-preflight.mjs`: PASS.
- `npm run test:types`: PASS.
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 120000 test/graphrag-runner-durable-preflight.test.ts`: PASS,
  4 tests.
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 120000 test/integrations/contracts.test.ts`: PASS, 72 tests.

## Residual Risk

No blocking issue remains against Agent B's fixed 10 criteria. The mutation
accounting evidence is based on event-name coverage and reachable event sites;
there is no dedicated unit test that directly emits every durable mutation
event name through `isStartupPreflightMutationEvent`.
