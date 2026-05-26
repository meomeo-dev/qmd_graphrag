# GraphRAG Partial-Output Early Stop Design

## Problem

GraphRAG community report generation can continue after provider-side
transient failures and emit partial output warnings such as
`Community Report Extraction Error` and `No report found for community`.
The current stage-end health gate rejects those logs after `graphIndex`
returns, but large books can continue issuing requests for a long time after
the first recoverable partial-output signal is already present.

This wastes provider budget and delays recovery. It also makes observability
late: the batch checkpoint remains `running` until the Python bridge exits,
even though the active stage has already become unrecoverable without retry.

## Required Behavior

The executor must fail fast after a recoverable GraphRAG partial-output signal
appears in the active stage log. The stage must be marked failed with
machine-readable retry metadata and must not publish GraphRAG artifacts,
producer manifests, `query_ready`, or `graph_query` capabilities.

The recovery unit remains:

```text
book_id + processing_stage + command_check
```

The early stop is not a second state source. It is an earlier observation of
the same stage health invariant currently enforced by the stage-end health
gate.

## Design

GraphRAG index execution uses the existing Python bridge boundary. The
TypeScript bridge caller owns the child process and can monitor the active
stage report log while the bridge runs.

The implementation adds a bounded log watcher around `graphIndex` calls.
This watcher is owned by the same TypeScript bridge layer that owns the
`ChildProcess`; it must not live in the batch runner and must not use process
name matching, `killall`, or process-group cleanup.

- It watches only the current stage `reportDir/indexing-engine.log`.
- It starts from the `graphRagIndexLogOffset` captured before the stage starts.
- It scans appended bytes for the same actionable partial-output patterns used
  by `assertGraphRagStageReportHealthy`.
- It terminates the Python bridge child when a partial-output signal appears.
- It rejects the bridge promise with a sanitized error containing
  `GraphRAG stage report partial-output failure`.

The existing batch failure classifier already treats this text as retryable
provider recovery (`retry_same_run_id`). The batch runner persists the failed
command check, retry timing, and `recoveryDecision` through the normal
checkpoint path.

Stage-end health checking remains mandatory. Early stop is an optimization and
observability improvement, not the only correctness gate.

## Interface Contract

Early stop is a TypeScript bridge option, not a Python bridge request field and
not a GraphRAG public contract:

```ts
type PythonBridgeEarlyStop = {
  kind: "graphrag_stage_report";
  stage: BookStage;
  reportDir: string;
  logStartOffset: number;
  outputDir: string;
  logLocator: string;
};
```

`runGraphRagIndex` passes this option only for `graphrag_index` calls when
`GraphRagIndexRequest` includes `reportDir` and the caller provides the current
stage plus `logStartOffset`. `graphQuery`, DSPy, qmd search/query, and Jina
embedding paths never receive this option.

`GraphRagIndexRequestSchema` may remain unchanged if the option is carried as
a runtime-only argument between `resume-book-workspace.mjs`,
`runGraphRagIndex`, and `callPythonBridge`. If the implementation chooses to
make it typed in `GraphRagIndexRequest`, it must remain optional and must not
change existing callers.

## Child Lifecycle

The bridge layer must use settle-once semantics:

1. Start the Python bridge child.
2. Start the watcher after stdin is written and the report log offset is known.
3. If the watcher detects actionable partial-output evidence, store an
   early-stop error object and stop polling.
4. Send `SIGTERM` only to the current child PID.
5. If the child is still alive after a bounded grace period, send `SIGKILL` to
   the same child PID.
6. When the child closes, reject with the stored early-stop error if present.
7. If the child exits before watcher detection, stop the watcher and follow the
   existing stdout/stderr parsing path.

If early stop has been triggered, stdout must never be parsed as
`GraphRagIndexResponse`, even if the child wrote partial or stale JSON before
termination.

The watcher must clear timers and file descriptors on all paths: successful
child exit, child error, early-stop termination, and forced kill. Polling must
be bounded, with a default interval no lower than 250 ms and no busy wait.

## Failed Attempt Output

Early stop does not publish stage artifacts, but the killed Python process may
leave partial files under the book-scoped GraphRAG output directory. The
implementation must ensure those residual files cannot be adopted as the next
successful attempt.

Required rule:

- Before retrying a GraphRAG producer stage, remove that stage's owned output
  files and directories when the previous checkpoint for the same stage failed
  with `failureKind=transient` or an early-stop partial-output marker.

Stage-owned cleanup is limited to files produced by the active stage:

- `community_report`: `community_reports.parquet` and any stage-local report
  temp files known to the adapter.
- `embed`: LanceDB output directories and embedding artifacts owned by the
  stage.
- `graph_extract`: graph extraction artifacts owned by that stage.

Cleanup must not remove prior successful-stage artifacts, source input,
normalized markdown, other books, catalog files, batch manifests, or command
logs. The cleanup decision and deleted relative locators must be recorded in
the stage checkpoint metadata or command failure metadata.

An attempt-scoped temporary output directory is also acceptable if the
implementation atomically publishes only after stage health and artifact gates
pass. Direct book-scoped output without cleanup or attempt isolation is not
acceptable.

## Invariants

- Early stop must be opt-in for GraphRAG index calls with `reportDir`,
  `stage`, and `logStartOffset`; query and DSPy bridge calls are unaffected.
- Only current-stage appended log bytes are scanned; old log history must not
  trigger false early stops.
- The termination path must reject the command as retryable and must not parse
  partial stdout as a successful bridge response.
- The batch runner must keep ownership and heartbeat semantics intact while
  the command is running.
- Existing completed stages and other books must not be modified.
- If the watcher misses a signal or the process exits first, the existing
  stage-end health gate still enforces the same invariant.
- Source-runtime execution through `tsx` and built `dist` execution must share
  the same implementation path.

## Observability

The failed command text must start with
`GraphRAG stage report partial-output failure` and include a bounded JSON
payload with:

- `stage`
- `failureKind: "partial_output"`
- `logLocator`
- `logStartOffset`
- `logEndOffset`
- `evidence`

Evidence is bounded to at most 20 actionable lines. Each line is sanitized and
truncated to 240 characters before serialization. The whole early-stop message
must prioritize fixed metadata before evidence so batch `errorSummary`
truncation cannot remove stage, failure kind, locator, or offsets.

Log locators must be project-relative, vault-relative, or explicit report-root
relative strings. Absolute private paths, URL credentials, API keys, provider
payload bodies, and environment values must not be emitted. Existing batch log
redaction remains a second line of defense, not the primary boundary.

The batch event log must continue to show the normal `command_failed`,
`command_retry_scheduled` or `command_attempt_budget_exhausted` facts. No new
parallel recovery ledger is introduced.

## Recovery

On the next run with the same `runId`, the existing resume logic reads the
book checkpoint, computes `BookResumePlan.nextStage`, and retries the same
GraphRAG stage. Prior successful stages are reused. Incomplete artifacts from
the failed attempt must not be published through producer manifests or
capabilities.

If the retry budget is exhausted, the item enters provider recovery wait with
`retryable=true`, `retryExhausted=false`, `recoveryDecision=retry_same_run_id`,
and `nextRetryAt` as already defined in the batch recovery contract.

## Test Plan

The implementation must add tests for these acceptance cases:

- Current-offset watcher: old log history contains partial-output evidence but
  appended bytes are healthy, so no early stop occurs.
- Active watcher: appended `Community Report Extraction Error`,
  `error generating community report`, or `No report found for community`
  terminates only the current fake Python bridge child.
- Settlement: if the fake bridge writes valid-looking JSON before the watcher
  fires, the call still rejects with the early-stop error and does not parse
  stdout as success.
- Retry classification: early-stop error text classifies as transient,
  retryable, and maps to `recoveryDecision=retry_same_run_id`.
- Residual output: a failed early-stop attempt leaves a stage-owned artifact,
  and the next retry cleans or isolates it before artifact adoption.
- Healthy non-regression: a long-running fake bridge with non-actionable log
  lines completes normally.
- Scope non-regression: qmd search/query, GraphRAG query, DSPy, and Jina
  embedding do not start the watcher.
- Existing recovery non-regression: completed-item recovery and local artifact
  gate repair tests still pass.
- Source/dist compatibility: the watcher path is exercised through source
  runtime and remains available from built `dist`.
- Stage-end fallback: if early stop is disabled or misses the signal, the
  existing `assertGraphRagStageReportHealthy` path still rejects partial output.
