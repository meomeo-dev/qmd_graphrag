# Batch Command Heartbeat Observability Audit Report

## Overall Result

FAIL

The change refreshes heartbeat state during `spawnSync` and projects the new
fields into typed checkpoint and recovery-summary contracts. However, command
completion cleanup is not fully ownership-guarded and is not robust against
monitor/write races or transient cleanup read failures. This can leave stale
`currentCommand` state in non-running checkpoints and recovery summaries.

## Reviewed Scope

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`

## Criteria Results

1. PASS: Long-running commands refresh `runnerHeartbeatAt` while the parent
   runner is blocked in `spawnSync`. The monitor starts before `spawnSync` and
   writes from a separate Node process.

2. FAIL: Heartbeat writes are not consistently guarded by runner session, host,
   and PID. The monitor checks all three, but completion cleanup writes
   `runnerHeartbeatAt` after checking only `runnerSessionId` and
   `currentCommand`.

3. PASS: The monitor does not intentionally steal, reopen, or take ownership of
   another runner's item. It exits on status, session, host, or PID mismatch.
   See Finding F1 for stale same-runner overwrite risk during completion.

4. PASS: `currentCommand` and `currentCommandStartedAt` identify the active
   command and do not directly alter retry classification or retry decisions.

5. FAIL: Command completion does not reliably clear active-command fields for
   the owning run. Cleanup is best-effort only, and later non-running checkpoint
   writes can preserve stale active-command fields if cleanup misses or races.

6. PASS: Failed commands preserve existing failure classification and retry
   decision behavior. The command result classification path remains unchanged
   after the heartbeat monitor stops.

7. PASS: The monitor exits when the parent dies, the stop file appears, or the
   checkpoint is no longer owned by the runner.

8. PASS: The monitor tolerates transient checkpoint read failures by skipping
   the write and retrying on the next interval.

9. PASS: Heartbeat fields are reflected in normal checkpoint schemas and
   recovery summary output. This projection can expose stale active-command
   fields if Finding F1 is not fixed.

10. PASS: The change avoids broad rewrites of batch execution, qmd, and
    GraphRAG stage gate logic.

## Findings

### F1 - Stale active-command fields can survive command completion

Severity: High

Evidence:

- `scripts/graphrag/batch-epub-workflow.mjs:3036` stops the monitor and
  `scripts/graphrag/batch-epub-workflow.mjs:3037` clears command heartbeat
  state after `spawnSync` returns.
- `scripts/graphrag/batch-epub-workflow.mjs:1390` to
  `scripts/graphrag/batch-epub-workflow.mjs:1406` makes cleanup best-effort:
  parse/read failures are swallowed and no retry or final invariant enforcement
  follows.
- `scripts/graphrag/batch-epub-workflow.mjs:3694`,
  `scripts/graphrag/batch-epub-workflow.mjs:4249`,
  `scripts/graphrag/batch-epub-workflow.mjs:4324`, and
  `scripts/graphrag/batch-epub-workflow.mjs:4350` build pending/failed
  checkpoints by spreading `running` without explicitly clearing
  `currentCommand` or `currentCommandStartedAt`.
- `scripts/graphrag/batch-epub-workflow.mjs:1335` lets the detached monitor
  write a full checkpoint snapshot. If it races with completion cleanup or a
  later state transition, it can reintroduce active-command fields or stale
  running state after the command has ended.

Impact:

Non-running checkpoints can retain `currentCommand` and
`currentCommandStartedAt`. Because `buildRecoverySummary` projects these fields
at `scripts/graphrag/batch-epub-workflow.mjs:2715` and
`scripts/graphrag/batch-epub-workflow.mjs:2716`, recovery summaries can report
an active command that is no longer active.

Suggested fix:

- Clear `currentCommand` and `currentCommandStartedAt` explicitly on every
  transition out of active command execution, especially completed, pending
  retry, provider-wait, and failed checkpoints.
- Stop the monitor in a way that prevents post-completion checkpoint writes, or
  make monitor writes atomic and conditional on the current checkpoint still
  matching the same active command.
- Add tests that assert final completed, pending-retry, and failed checkpoints
  and recovery summaries do not contain active-command fields after command
  exit.

### F2 - Completion cleanup does not verify host and PID ownership

Severity: Medium

Evidence:

- `scripts/graphrag/batch-epub-workflow.mjs:1392` to
  `scripts/graphrag/batch-epub-workflow.mjs:1396` checks `status`,
  `runnerSessionId`, and `currentCommand`.
- The same cleanup write updates `runnerHeartbeatAt` at
  `scripts/graphrag/batch-epub-workflow.mjs:1401`, but it does not verify
  `runnerHost` or `runnerPid`.

Impact:

The fixed baseline requires heartbeat writes to be scoped to the owning runner
session, host, and PID. The monitor satisfies that condition, but the cleanup
path does not.

Suggested fix:

- Require `checkpoint.runnerHost === runnerHost` and
  `checkpoint.runnerPid === runnerPid` before cleanup writes.
- Keep the same ownership predicate in both monitor heartbeat writes and
  command-completion cleanup.

## Verification

- PASS:
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "updates batch checkpoint heartbeat while long commands run"`
- PASS:
  `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit`
- PASS:
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "status-json (recovers orphaned running item|does not steal fresh remote running items|projects stale remote running items as retryable pending)|normal run (does not steal fresh remote running items|recovers stale remote running items before processing|exits after provider recovery wait limit)|status-json emits recovery summary"`
