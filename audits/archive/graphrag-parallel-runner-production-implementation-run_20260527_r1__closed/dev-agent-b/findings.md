# GraphRAG Parallel Runner Implementation Findings

## Decision

Fail. The implementation has useful single-process worker-pool behavior and
checkpoint-derived status projection, but it does not meet the production
durability and recovery contract in the Type-DD design.

## Blocking Findings

### B-01. Missing durable coordinator, item, and book lease fencing

Severity: Blocking

Evidence:

- Design requires a run lock with runner session, pid, heartbeat, expiry, and
  takeover rules in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:63`.
- Design requires item leases with worker id, heartbeat, expiry, and fencing
  token, and commit-time fencing checks in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:71`.
- Design requires an independent book lease with fencing token and generation in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:79`.
- `scripts/graphrag/batch-epub-workflow.mjs:153` creates only an in-process
  `runnerSessionId`.
- `scripts/graphrag/batch-epub-workflow.mjs:5663` marks an item running by
  comparing a few checkpoint fields under a per-file lock, but it does not
  create a durable item lease with fencing token, expiry, generation, or worker
  id.
- `scripts/graphrag/batch-epub-workflow.mjs:1738` prevents duplicate book work
  only by scanning in-memory checkpoint state for another running item with the
  same book id. This is not an atomic book lease.
- `src/job-state/repository.ts:1938`, `src/job-state/repository.ts:1945`, and
  `src/job-state/repository.ts:2813` write book stage checkpoints without any
  lease or fencing-token validation.

Function:

- `markItemRunning`
- `activeRunningBookCheckpoint`
- `runWorkerPool`
- `FileBookJobStateRepository.writeStageCheckpoint`

Test gap:

- `test/cli.test.ts:2257` proves two different books can run concurrently, but
  it does not start two coordinators for the same run, force two workers to race
  for one item, or assert stale fencing-token commit rejection.
- No test covers duplicate `bookId` atomic claim across two items or processes.

Fix recommendation:

- Add a durable run lock under the batch run state with heartbeat and expiry.
- Add item and book lease records with `runnerSessionId`, `workerId`,
  `fencingTokenHash`, `heartbeatAt`, `expiresAt`, and `generation`.
- Use atomic compare-and-swap for claim, heartbeat, expiry takeover, and release.
- Require lease validation in checkpoint, event, manifest, catalog, qmd index,
  book checkpoint, and artifact commit paths.

### B-02. Provider semaphore is in-memory only and is not a durable slot lease

Severity: Blocking

Evidence:

- Design requires provider slot leases with provider, worker id, item id,
  book id, command id, expiry, fencing token, release event, and recovery from
  leaked slots in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:123`.
- `scripts/graphrag/batch-epub-workflow.mjs:1859` implements
  `AsyncSemaphore` as process memory only.
- `scripts/graphrag/batch-epub-workflow.mjs:1879` and
  `scripts/graphrag/batch-epub-workflow.mjs:1902` emit slot acquired/released
  events, but the event metadata has no durable slot id, generation, expiry, or
  fencing token.
- `scripts/graphrag/batch-epub-workflow.mjs:5122` wraps each GraphRAG resume
  subprocess in the semaphore, but the child receives no provider slot lease or
  diagnostic lease identity.
- Status summary fields are built in
  `scripts/graphrag/batch-epub-workflow.mjs:4314`, but there are no
  `activeProviderSlots`, `providerWaitMs`, or `providerSlotGeneration` fields.

Function:

- `AsyncSemaphore.acquire`
- `withSemaphore`
- `runGraphResume`
- `qmd`
- `buildRecoverySummary`

Test gap:

- `test/cli.test.ts:1827` checks that strings such as `_slot_acquired` and
  `providerSlotProvider` exist, but it does not verify durable slot leases,
  leaked slot recovery, status slot fields, or that child processes cannot run
  without a lease.

Fix recommendation:

- Persist provider slot leases before starting provider-using subprocesses.
- Include slot id, provider, generation, expiry, command id, item id, book id,
  worker id, and fencing token hash in events and status.
- On process exit, timeout, worker lease loss, and coordinator restart, release
  or reclaim slot leases and record recovery events.

### B-03. Event log lacks event id, sequence, fsync, and partial-tail recovery

Severity: Blocking

Evidence:

- Design requires every event to include `eventId` and `sequence`, append with
  newline plus flush/fsync, and recover partial tails in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:231`.
- `scripts/graphrag/batch-epub-workflow.mjs:559` defines `BatchEventLogSchema`
  without `eventId` or `sequence`.
- `scripts/graphrag/batch-epub-workflow.mjs:2099` builds events with timestamp
  and payload only.
- `scripts/graphrag/batch-epub-workflow.mjs:2114` appends using
  `writeFileSync(..., { flag: "a" })` without a dedicated event writer lane,
  explicit flush/fsync, event sequence allocation, duplicate detection, or
  partial-line recovery.
- `scripts/graphrag/batch-epub-workflow.mjs:4475` migrates existing events by
  parsing every non-empty line; one partial JSONL tail would throw instead of
  being truncated and recorded.

Function:

- `event`
- `migrateEventLog`

Test gap:

- No test creates a partial trailing JSONL line, duplicate event id or sequence,
  or concurrent event append pressure.
- Tests parse event lines directly, for example `test/cli.test.ts:2245`, but do
  not assert event id, sequence, or recovery diagnostics.

Fix recommendation:

- Add an event writer lane that allocates monotonically increasing per-run
  sequence numbers and stable event ids.
- Append through a file descriptor with newline, flush, and fsync.
- On startup, scan `events.jsonl`, truncate the last invalid line, ignore
  duplicate event ids or sequences deterministically, and emit
  `partial_event_tail_recovered` or `duplicate_event_ignored`.

### B-04. Durable replace writes are not fsync/generation safe and have no
partial-write reconciliation

Severity: Blocking

Evidence:

- Design requires temp file, file fsync, atomic rename, parent fsync, and
  generation/checksum validation in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:236`.
- `scripts/graphrag/batch-epub-workflow.mjs:2130` writes JSON temp files and
  renames them, but it does not fsync the file or parent directory and does not
  embed generation or checksum.
- `src/job-state/repository.ts:375` uses the same write-then-rename pattern for
  YAML book state without fsync or generation/checksum validation.
- `src/job-state/graphrag-book.ts:1334` writes `qmd_output_manifest.json`
  directly using `writeFile`, so a crash can leave a partial producer manifest.
- Startup paths such as `scripts/graphrag/batch-epub-workflow.mjs:2474` and
  `src/job-state/repository.ts:1762` parse current files but do not reconcile
  leftover temp files, invalid generations, or valid previous versions.

Function:

- `writeJsonAtomic`
- `writeTypedJson`
- `writeYamlFile`
- `writeGraphRagOutputProducerManifest`
- `loadCheckpoint`
- `FileBookJobStateRepository.listStageCheckpoints`

Test gap:

- No test leaves checkpoint temp files, corrupts a current checkpoint while a
  previous valid version exists, or simulates a crash between temp write and
  rename.

Fix recommendation:

- Centralize durable replace writes with file fsync, rename, parent-directory
  fsync, generation, and checksum.
- Keep enough previous valid state to recover if the target file fails checksum.
- On startup, remove stale temp files and reconcile invalid targets according to
  the authority order in the design.

### B-05. Crash/restart recovery does not track or neutralize orphan
subprocesses and stale writers

Severity: Blocking

Evidence:

- Design requires worker crash recovery to reject stale writes by fencing token
  and terminate or quarantine lost process groups in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:384`.
- Design requires coordinator crash recovery to scan a durable subprocess
  registry and prevent old generation commits in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:395`.
- `scripts/graphrag/batch-epub-workflow.mjs:4685` starts subprocesses but does
  not write a durable subprocess registry with pid, process group, command id,
  item id, book id, provider slot, and expected output paths.
- `scripts/graphrag/batch-epub-workflow.mjs:4706` kills only the direct child on
  timeout; it does not manage process groups or record `subprocess_cancelled` /
  `subprocess_killed`.
- `scripts/graphrag/batch-epub-workflow.mjs:4065` recovers stale running
  checkpoints by setting them to pending, but there is no stale worker fencing
  or artifact quarantine if the old process continues writing.

Function:

- `spawnCommand`
- `recoverOrphanedRunningCheckpoint`
- `runningCheckpointIsOrphaned`
- `runCommand`

Test gap:

- `test/cli.test.ts:9860` covers stale remote running item recovery before
  processing, but it does not leave an orphan child alive, verify process-group
  termination, or attempt a stale post-takeover commit.

Fix recommendation:

- Persist a subprocess registry per run with pid, pgid, command id, item id,
  book id, stage, provider slot id, started time, and expected output dirs.
- On cancellation, lease loss, timeout, and restart, terminate process groups,
  escalate to kill, and write explicit events.
- Quarantine or revalidate outputs from stale generations before query_ready can
  use them.

### B-06. Retry exhaustion does not implement the designed deterministic
excluded terminal state

Severity: Blocking

Evidence:

- Design requires transient retry budget exhaustion to become
  `failed_retry_exhausted`, emit `retry_budget_exhausted`, and be excluded from
  the runnable queue while other books continue in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:346`.
- The runtime checkpoint schema allows only `pending`, `running`, `skipped`,
  `completed`, and `failed` in
  `scripts/graphrag/batch-epub-workflow.mjs:264`; there is no
  `failed_retry_exhausted` state.
- `scripts/graphrag/batch-epub-workflow.mjs:5924` through
  `scripts/graphrag/batch-epub-workflow.mjs:5999` keeps exhausted transient
  provider failures as `pending`, `retryable: true`, and
  `recoveryDecision: "retry_same_run_id"`.
- `scripts/graphrag/batch-epub-workflow.mjs:5748` treats provider wait-limit
  pending checkpoints as a scheduler-exit condition, but not as an excluded
  durable item terminal state.
- No implementation emits `retry_budget_exhausted`; the only nearby event is
  `command_retry_exhausted` in `scripts/graphrag/batch-epub-workflow.mjs:4930`.

Function:

- `handleRunItemFailure`
- `providerRecoveryWaitLimitReached`
- `eventProviderRecoveryWaitLimit`
- `recoverProviderTransientCheckpoint`
- `BatchItemStatusSchema`

Test gap:

- `test/cli.test.ts:3703` and `test/cli.test.ts:3871` cover provider recovery
  wait projection and runner exit, but they do not assert a durable exhausted
  terminal state or `retry_budget_exhausted` event.

Fix recommendation:

- Extend the checkpoint/status model to represent retry-exhausted transient
  items as a non-runnable durable state.
- Emit `retry_budget_exhausted` once per exhausted item and keep other runnable
  items progressing.
- Require an explicit resume or retry-budget reset command to move that state
  back to pending.

### B-07. Fail-fast stop can leave active worker-pool items running rather than
persisting recoverable stopped state

Severity: Blocking

Evidence:

- Design requires non-transient provider failures to stop the coordinator only
  after quiescing the scheduler, preventing new claims, cancelling active
  provider subprocesses, and writing live running items as recoverable stopped
  state in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:364`.
- `scripts/graphrag/batch-epub-workflow.mjs:6224` launches up to
  `bookConcurrency` workers concurrently.
- `scripts/graphrag/batch-epub-workflow.mjs:6312` records
  `stopAfterNonTransientFailure`, but active workers continue until settlement;
  there is no cancellation path.
- `scripts/graphrag/batch-epub-workflow.mjs:6819` records the pool settled after
  active promises complete; it does not cancel sibling provider subprocesses or
  convert still-running items to recoverable stopped checkpoints.

Function:

- `runWorkerPool`
- `runClaimedBatchItem`
- `handleRunItemFailure`

Test gap:

- `test/cli.test.ts:8940` verifies a runtime auth failure stops before the next
  book in sequential mode, but there is no parallel-mode test where one worker
  hits INVALID_API_KEY while another provider subprocess is already running.

Fix recommendation:

- Add a pool-wide cancellation signal and scheduler quiesce state.
- When a stop_until_fixed failure is durably recorded, stop launching new work,
  cancel active provider subprocesses, persist live siblings as recoverable
  stopped or stale-running evidence, then rebuild manifest/status.

## Nonblocking Findings

### N-01. Status output lacks provider slot and SQLite retry observability

Severity: Nonblocking

Evidence:

- Design requires status fields such as `activeProviderSlots`,
  `providerWaitMs`, `providerSlotGeneration`, and `sqliteRetryCount` in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:146` and
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:509`.
- `scripts/graphrag/batch-epub-workflow.mjs:4314` builds recovery summary items
  but omits these fields.
- `src/job-state/graphrag-book.ts:1048` implements a file lock around qmd index
  writes, but there is no bounded SQLite busy retry counter exposed as
  `sqliteRetryCount`.

Function:

- `buildRecoverySummary`
- `withQmdIndexFileLock`
- `registerQmdCorpusDocument`

Test gap:

- No test forces SQLite busy/locked behavior or asserts status exposure of
  provider slot and SQLite retry counters.

Fix recommendation:

- Add status fields for current provider slots, wait durations, slot generation,
  and SQLite retry counts.
- Configure SQLite busy timeout and classify exhausted busy retries into
  retryable or stop_until_fixed state with event evidence.

### N-02. Some implementation checks are string-presence tests rather than
behavioral tests

Severity: Nonblocking

Evidence:

- `test/cli.test.ts:1827` reads implementation and contract files and checks for
  string tokens such as `runWorkerPool`, `_slot_acquired`,
  `withJsonFileLock`, and `renameSync`.
- These tests do not prove the production invariants required by the design,
  especially fencing, durable slot leases, fsync, event sequence, and recovery
  behavior.

Function:

- Test-only issue covering `GraphRAG EPUB batch runner` tests.

Test gap:

- Behavioral tests are missing for concurrent claims, partial writes, stale
  commits, and durable provider slot recovery.

Fix recommendation:

- Replace string-presence assertions with black-box fixtures that create the
  target failure mode and inspect persisted checkpoint, event, manifest, and
  status evidence.

### N-03. Manifest derivation is mostly checkpoint-based but does not diagnose
manifest mismatch rebuilds

Severity: Nonblocking

Evidence:

- `scripts/graphrag/batch-epub-workflow.mjs:4229` recomputes counts from the
  loaded checkpoint array and writes the manifest, which is directionally
  aligned with derived-cache behavior.
- However, `scripts/graphrag/batch-epub-workflow.mjs:2338` loads an existing
  manifest and `scripts/graphrag/batch-epub-workflow.mjs:6390` overwrites it
  without recording a `manifest_rebuilt` event when counts differ.
- Design requires manifest mismatch rebuild diagnostics in
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:413`.

Function:

- `loadManifest`
- `updateManifest`
- `main`

Test gap:

- `test/cli.test.ts:12248` covers source growth reconciliation, but no test
  creates a manifest whose counts disagree with durable checkpoints and expects
  `manifest_rebuilt`.

Fix recommendation:

- Compare loaded manifest counts and generation/checksum with derived checkpoint
  state on startup.
- Rebuild mismatched manifest/status and emit `manifest_rebuilt` with before and
  after counts.

### N-04. Book-state repository writes are atomic renames but not protected by a
global catalog writer lane

Severity: Nonblocking

Evidence:

- Design requires serialized global writes through catalog and checkpoint writer
  lanes in `docs/architecture/graphrag-parallel-runner.type-dd.yaml:98`.
- `src/job-state/repository.ts:375` writes YAML state by temp rename, but the
  repository has no global writer lane or lock around catalog, artifact, and
  checkpoint read-modify-write sequences.
- `src/job-state/repository.ts:1988` records artifacts by reading existing
  artifacts and then writing the list; concurrent writers can lose updates.

Function:

- `writeYamlFile`
- `FileBookJobStateRepository.recordArtifacts`
- `FileBookJobStateRepository.writeStageCheckpoint`

Test gap:

- No test runs two repository writers against the same graph vault and asserts
  no lost catalog, artifact, or checkpoint updates.

Fix recommendation:

- Add repository-level file locks or writer lanes around catalog, artifact, and
  stage checkpoint read-modify-write paths.
- Pair these locks with the book lease fencing described in B-01.

## Positive Observations

- `scripts/graphrag/batch-epub-workflow.mjs:4229` derives manifest counts from
  checkpoint objects rather than incrementing a completed counter.
- `scripts/graphrag/batch-epub-workflow.mjs:4065` can project stale running
  checkpoints to retryable pending, and tests cover both fresh and stale remote
  running items at `test/cli.test.ts:9517` and `test/cli.test.ts:9631`.
- `scripts/graphrag/batch-epub-workflow.mjs:5502` gates completion on qmd,
  GraphRAG, and query evidence before writing `item_completed`.
- `test/cli.test.ts:8940` covers sequential stop behavior for runtime provider
  auth failure.
