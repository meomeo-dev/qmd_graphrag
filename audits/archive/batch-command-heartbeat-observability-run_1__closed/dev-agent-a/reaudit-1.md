# Batch Command Heartbeat Observability Reaudit 1

## Overall Result

PASS

上一轮 FAIL 项已修复。当前实现将 heartbeat 写入和命令完成清理统一限定
到同一 `runnerSessionId`、`runnerHost`、`runnerPid`，并在非 running
checkpoint 持久化前清理 `currentCommand` 与 `currentCommandStartedAt`。
新增测试覆盖了运行中 summary 投影、命令结束后的最终 checkpoint 清理，
以及最终 recovery summary 不残留 active command。

## Reviewed Scope

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `test/integrations/contracts.test.ts`

## Criteria Results

1. PASS: Long-running commands refresh `runnerHeartbeatAt` while the parent
   runner is blocked in `spawnSync`.

   `runCommand` starts `startCommandHeartbeatMonitor` before `spawnSync`, and
   the monitor process writes `runnerHeartbeatAt`, `currentCommand`, and
   `currentCommandStartedAt` from outside the blocked parent.

2. PASS: The heartbeat is written only for the owning runner session, host,
   and PID.

   Monitor writes require matching `runnerSessionId`, `runnerHost`, and
   `runnerPid` before updating the checkpoint. Completion cleanup now applies
   the same ownership checks before writing `runnerHeartbeatAt` or clearing the
   active-command fields.

3. PASS: The heartbeat does not steal, overwrite, or reopen another runner's
   item.

   The monitor exits without writing when the checkpoint is not `running` or
   when session, host, or PID ownership differs. It does not change status,
   retry fields, or ownership fields.

4. PASS: `currentCommand` and `currentCommandStartedAt` identify the active
   command without changing command retry semantics.

   Retry classification remains based on `spawnSync` result, command output,
   `classifyFailure`, retry budget, and existing retry decisions. The heartbeat
   fields are observability state only.

5. PASS: Command completion clears active-command fields for the same owning
   session.

   `clearCommandHeartbeat` now holds the checkpoint lock, verifies session,
   host, PID, and command ownership, then clears `currentCommand` and
   `currentCommandStartedAt`. `withCheckpointPersistenceInvariants` also clears
   these fields for all non-running checkpoint persistence paths.

6. PASS: Failed commands still preserve existing failure classification and
   retry decision behavior.

   The failure path still constructs checks from the same `failureText`,
   `classifyFailure`, `shouldRetry`, `recoveryDecision`, and retry delay logic.
   Targeted transient, fail-fast, and provider recovery tests pass.

7. PASS: The monitor exits when the parent runner dies, the stop file appears,
   or the checkpoint is no longer owned by the runner.

   The monitor checks `stopPath`, parent PID liveness, a parent-side lifeline
   pipe, and checkpoint ownership on each write attempt.

8. PASS: The monitor tolerates transient checkpoint read failures without
   corrupting state.

   Failed checkpoint reads return `null`; the monitor skips that write and
   keeps retrying. Writes are protected by a checkpoint lock and atomic rename.

9. PASS: Heartbeat state is reflected in normal checkpoint files and recovery
   summary output.

   Running checkpoints and `--status-json` recovery summaries expose
   `currentCommand`, `currentCommandStartedAt`, and refreshed
   `runnerHeartbeatAt`. The final non-running checkpoint and final recovery
   summary do not retain active-command fields.

10. PASS: The change avoids broad rewrites of batch execution, qmd, and
    GraphRAG stage gate logic.

    The diff is limited to batch runner heartbeat observability, checkpoint
    write safety, schemas, and targeted tests. It does not rewrite qmd indexing
    or GraphRAG stage gate semantics.

## Prior FAIL Follow-up

- Fixed: Completion cleanup now checks `runnerHost` and `runnerPid` in addition
  to `runnerSessionId` and `currentCommand`.
- Fixed: Non-running checkpoint persistence clears `currentCommand` and
  `currentCommandStartedAt`.
- Fixed: The heartbeat test now asserts that final checkpoint and final
  recovery summary do not contain active-command fields.

## Residual Risk

Some control-flow paths still call `checkpoints.set(...)` with the pre-parse
object rather than the value returned by `saveCheckpoint`. Current tested paths
do not leave active-command fields in persisted non-running checkpoint files or
final recovery summaries, because command completion cleanup and persistence
invariants remove them. For future hardening, using the normalized
`saveCheckpoint` return value consistently would reduce memory-state drift.

## Verification

- PASS:
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "updates batch checkpoint heartbeat while long commands run"`
- PASS:
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/integrations/contracts.test.ts -t "accepts batch execution bus envelopes with real schemas"`
- PASS:
  `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit`
- PASS:
  `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "keeps transient and permanent provider recovery decisions typed|fail-fast transient failure persists recoverable pending checkpoint|normal run exits after provider recovery wait limit|status-json recovers orphaned running item to retryable pending|status-json does not steal fresh remote running items|normal run does not steal fresh remote running items|normal run recovers stale remote running items before processing"`
