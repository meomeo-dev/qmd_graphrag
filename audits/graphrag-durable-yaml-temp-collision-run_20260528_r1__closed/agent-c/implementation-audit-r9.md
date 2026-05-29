# Implementation Audit R9 - Agent C

Verdict: FAIL

## Criteria Results

| ID | Result | Evidence |
| --- | --- | --- |
| I01_temp_identity_exclusive_create | PASS | Shared durable store temp identity includes target path, pid, timestamp and UUID operationId in `src/job-state/durable-state-store.ts:1760`, `src/job-state/durable-state-store.ts:1764`, `src/job-state/durable-state-store.ts:1765`, and uses `wx` exclusive create for target and checksum temps in `src/job-state/durable-state-store.ts:483`, `src/job-state/durable-state-store.ts:500`. Runner adapter uses the same pid/timestamp/operationId identity and `wx` writes in `scripts/graphrag/batch-epub-workflow.mjs:2407`, `scripts/graphrag/batch-epub-workflow.mjs:2409`, `scripts/graphrag/batch-epub-workflow.mjs:4183`, `scripts/graphrag/batch-epub-workflow.mjs:4204`. Same-millisecond YAML writes are tested in `test/book-job-state.test.ts:421` through `test/book-job-state.test.ts:453`. |
| I02_single_durable_boundary | PASS | Repository, capability catalog, settings projection, durable-json, python bridge and DSPy policy store reuse shared durable APIs in `src/job-state/repository.ts:70`, `src/job-state/repository.ts:400`, `src/graphrag/capability-catalog.ts:31`, `src/graphrag/capability-catalog.ts:745`, `src/graphrag/settings-projection.ts:7`, `src/graphrag/settings-projection.ts:263`, `src/job-state/durable-json.ts:1`, `src/job-state/durable-json.ts:17`, `src/integrations/python-bridge.ts:11`, `src/integrations/python-bridge.ts:151`, `src/dspy/policy-store.ts:55`, `src/dspy/policy-store.ts:190`. Runner YAML readers hold the same target lock through reconcile/read/parse in `scripts/graphrag/batch-epub-workflow.mjs:5820`, `scripts/graphrag/batch-epub-workflow.mjs:5823`, `scripts/graphrag/batch-epub-workflow.mjs:6464`, `scripts/graphrag/batch-epub-workflow.mjs:6466`, `scripts/graphrag/batch-epub-workflow.mjs:6471`. |
| I03_lock_owner_fencing | PASS | Shared lock owners record pid, host, runnerSessionId, generation, fencingTokenHash, targetLocator, operationId, heartbeatAt and expiresAt in `src/job-state/durable-state-store.ts:1798` through `src/job-state/durable-state-store.ts:1819`. Stale lock removal validates TTL, expiry, recovery fence, host and liveness, then writes durable recovery records in `src/job-state/durable-state-store.ts:891` through `src/job-state/durable-state-store.ts:923`. Runner JSON lock owners include equivalent fields and fencing in `scripts/graphrag/batch-epub-workflow.mjs:5245` through `scripts/graphrag/batch-epub-workflow.mjs:5272`. R9 adds a direct recovery-record assertion in `test/book-job-state.test.ts:722` through `test/book-job-state.test.ts:757`. |
| I04_live_temp_cleanup_safety | PASS | Shared temp cleanup validates owner evidence, target match, createdAt, cleanup fence, target generation, age, host liveness and lease expiry before deletion in `src/job-state/durable-state-store.ts:969` through `src/job-state/durable-state-store.ts:1026` and sync path in `src/job-state/durable-state-store.ts:1033` through `src/job-state/durable-state-store.ts:1090`. Runner cleanup uses the same decision path and keeps unresolved temps in preflight in `scripts/graphrag/batch-epub-workflow.mjs:4446` through `scripts/graphrag/batch-epub-workflow.mjs:4464`. Tests preserve fresh temps, incomplete-owner temps and target-generation-advanced temps in `test/cli.test.ts:2883`, `test/cli.test.ts:2977`, `test/cli.test.ts:3049`, and assert nested preflight blocks in `test/cli.test.ts:3464` through `test/cli.test.ts:3606`. |
| I05_checksum_commit_recovery | PASS | Shared store covers target-new/checksum-missing, pending meta, checksum-old and mismatch quarantine in `src/job-state/durable-state-store.ts:575` through `src/job-state/durable-state-store.ts:650` and sync path in `src/job-state/durable-state-store.ts:653` through `src/job-state/durable-state-store.ts:728`. Backfill writes checksum via durable replace in `src/job-state/durable-state-store.ts:1100` through `src/job-state/durable-state-store.ts:1145`. Runner YAML/JSON reconcile covers equivalent checksum windows in `scripts/graphrag/batch-epub-workflow.mjs:4837` through `scripts/graphrag/batch-epub-workflow.mjs:4918` and `scripts/graphrag/batch-epub-workflow.mjs:4967` through `scripts/graphrag/batch-epub-workflow.mjs:5053`. Tests cover JSON pending meta and YAML checksum quarantine in `test/cli.test.ts:3207`, `test/book-job-state.test.ts:1842`, and `test/book-job-state.test.ts:3441`. |
| I06_fsync_platform_failure | PASS | Shared file and directory fsync failures become `DurableStateError` with fsyncTarget, fsyncErrno, fsyncPlatform, durableMode and completedPublishRule in `src/job-state/durable-state-store.ts:1479` through `src/job-state/durable-state-store.ts:1550`. Runner adapter has equivalent strict directory/file fsync evidence in `scripts/graphrag/batch-epub-workflow.mjs:2838` through `scripts/graphrag/batch-epub-workflow.mjs:2899`. The directory fsync fault test is included in the R9 pre-audit verification at `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:84`. |
| I07_batch_observability_schema | PASS | Contracts carry failureKind, localFailureClass, recoveryDecision, failedStage, evidence locators, tempId, operationId, lock owner evidence, checksum recovery and fsync fields across command checks, item checkpoints, manifest durableFailureSummary, events and recovery summary in `src/contracts/batch-run.ts:134` through `src/contracts/batch-run.ts:185`, `src/contracts/batch-run.ts:226` through `src/contracts/batch-run.ts:255`, `src/contracts/batch-run.ts:344` through `src/contracts/batch-run.ts:367`, `src/contracts/batch-run.ts:382` through `src/contracts/batch-run.ts:417`, and `src/contracts/batch-run.ts:433` through `src/contracts/batch-run.ts:456`. Runner projects durable fields into manifest and recovery summary in `scripts/graphrag/batch-epub-workflow.mjs:7986` through `scripts/graphrag/batch-epub-workflow.mjs:7999` and `scripts/graphrag/batch-epub-workflow.mjs:8123` through `scripts/graphrag/batch-epub-workflow.mjs:8139`. |
| I08_failure_classifier_mapping | PASS | Durable local-state classification runs before provider transient matching in `scripts/graphrag/batch-failure-classifier.mjs:7` through `scripts/graphrag/batch-failure-classifier.mjs:14` and `scripts/graphrag/batch-failure-classifier.mjs:47`. The mapping covers rename ENOENT, temp collision, live temp deletion, fsync failures, checksum windows/mismatch and lock timeout in `scripts/graphrag/batch-failure-classifier.mjs:83` through `scripts/graphrag/batch-failure-classifier.mjs:200`, plus lock-timeout text in `scripts/graphrag/batch-failure-classifier.mjs:347` through `scripts/graphrag/batch-failure-classifier.mjs:354`. Classifier tests assert local durable classes in `test/cli.test.ts:2606` through `test/cli.test.ts:2638`. |
| I09_direct_call_chain_coverage | PASS | Direct durable YAML/JSON write paths for repository, capability catalog, settings projection, durable-json, python bridge and DSPy policy store are routed through shared durable APIs in `src/job-state/repository.ts:400` through `src/job-state/repository.ts:428`, `src/graphrag/capability-catalog.ts:342` through `src/graphrag/capability-catalog.ts:355`, `src/graphrag/settings-projection.ts:259` through `src/graphrag/settings-projection.ts:270`, `src/job-state/durable-json.ts:1` through `src/job-state/durable-json.ts:18`, `src/integrations/python-bridge.ts:151` through `src/integrations/python-bridge.ts:155`, `src/dspy/policy-store.ts:190` through `src/dspy/policy-store.ts:200`, and `src/dspy/policy-store.ts:625` through `src/dspy/policy-store.ts:633`. Runner checkpoint/manifest/status durable paths use typed durable JSON and locks in `scripts/graphrag/batch-epub-workflow.mjs:4168` through `scripts/graphrag/batch-epub-workflow.mjs:4229` and `scripts/graphrag/batch-epub-workflow.mjs:5419` through `scripts/graphrag/batch-epub-workflow.mjs:5425`. |
| I10_fault_injection_tests | FAIL | R9 adds direct tests for shared stale lock recovery records and shared quarantine rename ENOENT in `test/book-job-state.test.ts:539` through `test/book-job-state.test.ts:574` and `test/book-job-state.test.ts:722` through `test/book-job-state.test.ts:757`. Existing tests cover same-ms YAML temp identity, runner live/stale temp cleanup, checksum crash window, fsync boundary, rename ENOENT and event fields in `test/book-job-state.test.ts:421`, `test/cli.test.ts:2883`, `test/cli.test.ts:3280`, `test/cli.test.ts:3611`. However, no test found injects a YAML target fault through the runner YAML reader paths `loadCatalogBySourceHash()` or `readYamlFileIfExists()` after the R8 lock-boundary fix. The only preflight checksum fault in R9 mutates `manifest.json` at `test/cli.test.ts:3336` through `test/cli.test.ts:3343`, so it does not prove the required runner YAML reader/preflight path. |

## Blocking Findings

### 1. Runner YAML reader/preflight fault coverage remains missing

Evidence:

- The implementation now holds the per-target lock across YAML reconcile/read/parse:
  `scripts/graphrag/batch-epub-workflow.mjs:5820`,
  `scripts/graphrag/batch-epub-workflow.mjs:5823`,
  `scripts/graphrag/batch-epub-workflow.mjs:6464`,
  `scripts/graphrag/batch-epub-workflow.mjs:6466`,
  `scripts/graphrag/batch-epub-workflow.mjs:6471`.
- Design requires a `runner_yaml_reader_preflight_fault` case where checksum crash
  window or live temp in a YAML target fails `stop_until_fixed`:
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1332`,
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1334`,
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1335`.
- The R9 preflight checksum fault mutates `manifest.json`, not `books.yaml`,
  `artifacts.yaml`, `checkpoints.yaml`, or another runner YAML reader target:
  `test/cli.test.ts:3336`, `test/cli.test.ts:3337`,
  `test/cli.test.ts:3338`, `test/cli.test.ts:3370`.
- Repository/capability YAML checksum tests cover shared durable store behavior,
  but not the batch runner YAML reader call chain:
  `test/book-job-state.test.ts:1842`,
  `test/book-job-state.test.ts:1870`,
  `test/book-job-state.test.ts:3441`,
  `test/book-job-state.test.ts:3475`.

Impact:

I10 requires fault injection evidence that local durable state failures do not
publish erroneous `completed` state and write stable checkpoint, event,
status-json and recovery summary fields. The runner YAML reader lock-boundary
fix is present, but the regression evidence still does not inject checksum or
live-temp faults through `loadCatalogBySourceHash()` or `readYamlFileIfExists()`.

Suggested fix:

Add a focused runner test that creates a durable YAML target used by the runner,
for example `graph_vault/catalog/books.yaml` or a book-scoped YAML artifact
read by `readYamlFileIfExists()`, then injects one of:

- checksum mismatch or partial checksum sidecar;
- unresolved live temp with owner evidence;
- post-reconcile YAML target mutation.

The test should assert non-zero exit or blocked status, `failureKind`,
`localFailureClass`, `retryable=false`, `recoveryDecision=stop_until_fixed`,
`failedStage`, evidence locator, and recovery-summary/status-json projection.

## R8 Closure

R8 Agent C closure is partial.

- Closed: shared-store stale lock recovery record now has direct fault evidence.
  The test creates a stale lock, triggers durable read, verifies lock removal,
  and asserts `.durable-recovery.jsonl` includes `durable_lock_recovered`,
  `lockPath`, `recoveryDecision` and lockOwnerEvidence:
  `test/book-job-state.test.ts:722` through
  `test/book-job-state.test.ts:757`.
- Closed: shared-store quarantine rename ENOENT now has direct fault evidence.
  The test injects quarantine rename ENOENT and asserts
  `localFailureClass=durable_temp_rename_enoent`, `failedSyscall=rename`,
  `errno=ENOENT`, `renameCause`, `tempId` and `operationId`:
  `test/book-job-state.test.ts:539` through
  `test/book-job-state.test.ts:574`.
- Not closed: runner YAML reader/preflight fault regression evidence remains
  absent for the R8 call-chain blocker. The code path is repaired, but I10
  requires executable fault evidence for the runner path.

## Verification Reviewed

Reviewed R9 status evidence in
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:83`
through
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:124`.

Ran focused verification:

- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/book-job-state.test.ts -t "durable|checksum|quarantine rename ENOENT|stale durable temps"`
  passed: 9 passed, 57 skipped.
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 180000 test/cli.test.ts -t "durable JSON lock timeout is stop-until-fixed with owner evidence|forced durable temp collision is stop-until-fixed before overwrite|directory fsync failure blocks completed publication with evidence|durable reconcile preserves fresh temps and cleans stale temps with owner evidence|durable reconcile preserves stale temps without complete owner evidence|durable reconcile preserves stale temps when target generation advanced|durable reconcile commits matching pending checksum metadata|durable preflight blocks partial checksum sidecar crash window|durable preflight blocks unresolved stale lock without fencing evidence|before-claim preflight blocks nested book output durable sidecar temp|rename ENOENT during durable checkpoint write is stop-until-fixed|all batch qmd commands acquire the qmd index file lock"`
  passed: 12 passed, 236 skipped.

No `.env` or secret files were read. No real EPUB runner was started. No inbox
books were processed. Criteria files were not modified.
