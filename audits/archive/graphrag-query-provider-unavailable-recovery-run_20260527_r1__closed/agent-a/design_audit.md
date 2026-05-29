# GraphRAG Query Provider Unavailable Recovery Design Audit

## Conclusion

FAIL.

The current design and implementation do not correctly handle the real
`provider_unavailable` GraphRAG query outage observed in
`epub-batch-20260527-real-resume-1`.

The strongest failures are:

- `provider_unavailable` is emitted as a structured typed query error with
  `retryable=false`, and the batch classifier preserves that as
  `failureKind=unknown`, `retryable=false`, `recoveryDecision=stop_until_fixed`.
  A transient provider outage therefore becomes permanent without proof.
- `stop_until_fixed` does not stop scheduling for this generic non-retryable
  query failure. The writer started the next book after the failed
  `qmd-query-graphrag-json` command.
- Status JSON does not expose provider recovery timing or reason for this
  case, because the item is not converted to provider recovery wait.
- Runbooks describe transient provider waits in general, but do not explicitly
  describe operator action for structured GraphRAG query
  `provider_unavailable` outages.
- Tests cover stale completed GraphRAG query retry metadata, but not the
  real structured error payload nor the same-process scheduling stop behavior.

The appropriate direction is修正设计并修正实现（revise design and
implementation）。This is not a case for trimming the design or continuing
implementation unchanged.

## Evidence

Real batch evidence:

- `graph_vault/catalog/batch-runs/epub-batch-20260527-real-resume-1/items/item-2d1d667301e9-095a11e7.json`
  is `Building Microservices (Sam Newman).epub`.
- The item failed at `qmd-query-graphrag-json` with the structured JSON:
  `provider=graphrag`, `capability=graph_query`,
  `code=provider_unavailable`, `retryable=false`, and redacted message
  `GraphRAG query provider failed before returning a response.`
- The persisted checkpoint has `failureKind=unknown`, `retryable=false`,
  `retryExhausted=true`, `recoveryDecision=stop_until_fixed`,
  `failedStage=qmd-query-graphrag-json`, and
  `metadata.waitingForProviderRecovery=false`.
- The same checkpoint has `graphBuildStatus.status=succeeded` and
  `graphQueryStatus.status=failed`; `qmdBuildStatus.status=pending` because
  the independent qmd build manifest was not written before the failing graph
  query check.
- The event log shows `command_failed`, `command_attempt_budget_exhausted`,
  `command_retry_exhausted`, and `item_failed` for this item at
  `2026-05-27T07:46:05Z` to `2026-05-27T07:46:09Z`, followed by
  `command_start` for the next book
  `Building Microservices Designing Fine-Grained Systems (Sam Newman).epub`
  at `2026-05-27T07:46:11Z`.
- `recovery-summary.json` reports this item as failed, but the batch-level
  `recoveryDecision` is `retry_same_run_id` because another item is retryable.
  The summary has no provider recovery timing or reason for this failed query
  item.

Implementation evidence:

- `src/query/unified-router.ts` creates typed GraphRAG provider errors with
  `retryable=false` for `provider_unavailable`.
- `scripts/graphrag/batch-failure-classifier.mjs` classifies by HTTP status
  and transient text tokens. It does not parse the typed error JSON or treat
  `code=provider_unavailable` / `provider=graphrag` /
  `capability=graph_query` as transient provider evidence.
- `scripts/graphrag/batch-epub-workflow.mjs` only enters provider recovery
  wait when the command check has `failureKind=transient` and
  `retryable=true`.
- `shouldStopBatchAfterFailure` only stops for data compatibility failures or
  unrecoverable provider auth failures. A generic
  `retryable=false + stop_until_fixed` query failure does not stop scheduling.
- `runItem` writes the qmd build manifest only after all CLI checks pass.
  Therefore a graph query check failure prevents qmd build evidence from being
  written, even when native qmd checks and GraphRAG build evidence are already
  present.

Documentation evidence:

- `docs/operations/graphrag-epub-batch-runbook.md` says `retryable=false`
  failed items normally continue processing other pending items, except for
  local readiness gate repair.
- The runbook describes transient provider recovery waits with `nextRetryAt`,
  `retryDelaySeconds`, `waitingForProviderRecovery=true`, and same-run resume.
- It does not explicitly state how to handle structured GraphRAG query
  `provider_unavailable` payloads whose embedded `retryable` value is false.

## Principle Results

1. Retryability preserves structured provider error semantics.

Result: FAIL.

The structured CLI error contains `retryable=false`, and the batch layer
preserves that too literally. For batch scheduling, `provider_unavailable`
from `provider=graphrag` and `capability=graph_query` is not the same as a
proven permanent user/data/config error. The design needs an explicit
translation boundary: typed query errors may keep their local payload
semantics, while batch recovery derives operational retryability from
provider/capability/code and known permanent evidence.

2. Transient upstream/provider failures do not become permanent without proof.

Result: FAIL.

The real outage became `failureKind=unknown`, `retryable=false`,
`retryExhausted=true`, and `stop_until_fixed` with no HTTP 4xx, auth failure,
data compatibility failure, local artifact gate failure, or invalid scope
proof. The fallback in `classifyFailure` turns unknown text into
non-retryable. For a provider outage code, this violates the principle.

3. Batch stage gates require book-scoped QMD build, command, GraphRAG build,
and GraphRAG query evidence before completion.

Result: PASS with design gap.

The completion gate correctly requires `qmdBuildStatus`, full command check
status, `graphBuildStatus`, and `graphQueryStatus` to be succeeded before
writing `completed`. The target item was not completed because graph query
failed. However, qmd build evidence is only written after all command checks
pass, so a late graph query failure leaves `qmdBuildStatus=pending` even after
many qmd checks succeeded. The gate protects completion, but the evidence
model should separate qmd build evidence from graph query success so recovery
can retry only the failed query stage.

4. Failed required evidence must prevent completion and expose the exact failed
stage.

Result: PASS.

The checkpoint exposes `failedStage=qmd-query-graphrag-json`; the command
check and `graphQueryStatus` both identify the same stage. The item remains
`failed`, not `completed`.

5. A stop-until-fixed decision must stop scheduling further books in the same
writer process.

Result: FAIL.

The real event order shows the writer started the next book about two seconds
after persisting the failed `stop_until_fixed` item. The code explains this:
`shouldStopBatchAfterFailure` only returns true for data compatibility or
provider auth failures. Generic non-retryable `stop_until_fixed` failures,
including this structured GraphRAG query provider outage, do not stop the
current writer.

6. Orphaned runner recovery must preserve checkpoint identity and not corrupt
adjacent book state.

Result: PASS for existing design; not fully exercised by this case.

The design has runner identity fields, stale runner detection, and locked
checkpoint updates. It recovers orphaned `running` items to `pending` without
changing book identity. In the real summary, an adjacent book was running after
manual stop, which the orphaned-runner path should handle. No evidence found
that the target failed item corrupted adjacent book state. This principle
still depends on adding a regression test around the post-stop adjacent
running item.

7. Provider recovery must be observable in status JSON with retry timing and
reason.

Result: FAIL.

The status/recovery summary schema can expose `waitingForProviderRecovery`,
`nextRetryAt`, `retryDelaySeconds`, `providerRecoveryWaitCount`, and
`providerRecoveryReason`, but the real `provider_unavailable` item does not
enter that state. It has `waitingForProviderRecovery=false` and no retry
timing. The operator sees a permanent-looking failed query even though the
evidence is a provider outage.

8. Retrying a failed query must not rebuild unrelated successful artifacts
unless lineage is stale.

Result: PARTIAL FAIL.

GraphRAG build evidence is book-scoped and succeeded, and the resume design
can skip completed GraphRAG stages. That part is sound. The gap is qmd build
evidence: because `writeQmdBuildManifest` runs only after all 27 checks pass,
a failed graph query leaves `qmdBuildStatus=pending`. A retry may therefore
repeat qmd-native checks or rebuild qmd artifacts even though the only failed
required evidence is GraphRAG query. The design should persist qmd build and
native qmd command evidence before graph query checks, or otherwise mark
lineage-current qmd evidence without requiring successful graph query.

9. Docs and runbooks must describe the operator action for provider query
outages.

Result: FAIL.

The runbooks cover transient provider/network failures generally, provider
auth failures, and local artifact gate failures. They do not name the
structured `provider_unavailable` GraphRAG query payload, do not explain why
it should be treated as provider recovery wait despite the embedded
`retryable=false`, and do not give the operator a focused action such as
checking `--status-json`, waiting for `nextRetryAt`, then resuming the same
`runId` without deleting book output or creating a new run.

10. Tests must pin retry classification and batch stop behavior for this case.

Result: FAIL.

Existing tests include a status-json stale completed graph query case with a
manually seeded transient command check, but not the actual structured JSON
payload:

```json
{"provider":"graphrag","capability":"graph_query","code":"provider_unavailable","retryable":false}
```

No located test proves that this payload is reclassified into provider
recovery wait, no test proves the same writer stops scheduling after a
`stop_until_fixed` decision for generic non-retryable failures, and no test
captures the real event ordering where the next book started after the
failed query item.

## Must Fix

1. Add an explicit batch classification rule for structured typed query
   errors.

   The classifier should parse JSON payloads when present and classify
   `provider=graphrag`, `capability=graph_query`,
   `code=provider_unavailable` as a transient provider recovery candidate
   unless there is stronger permanent evidence such as auth failure,
   data compatibility failure, invalid scope, missing local artifact, or an
   explicit non-retryable configuration error.

2. Define the retryability boundary between CLI typed errors and batch
   recovery.

   The typed query payload may remain `retryable=false` for direct CLI callers
   if that is the intended CLI contract, but the batch layer must not treat
   that field alone as proof of permanence. Batch recovery should derive
   operational retryability from structured code, provider, capability,
   status code, and permanent-failure evidence.

3. Convert GraphRAG query provider outage failures to provider recovery wait.

   For this case, the item should become `pending` with:

   - `failureKind=transient`
   - `retryable=true`
   - `retryExhausted=false`
   - `recoveryDecision=retry_same_run_id`
   - `failedStage=qmd-query-graphrag-json`
   - `nextRetryAt`
   - `retryDelaySeconds`
   - `retryBudgetSeconds`
   - `metadata.waitingForProviderRecovery=true`
   - `metadata.providerRecoveryReason` describing the structured outage

4. Make `stop_until_fixed` stop scheduling by decision, not only by selected
   subclasses.

   If an item is `failed`, `retryable=false`, and
   `recoveryDecision=stop_until_fixed`, the same writer process must not start
   later books. The stop reason can still distinguish `provider_auth`,
   `data_compatibility`, `provider_query_unavailable`, and `non_transient`,
   but the stop policy must not silently continue for unknown stop-until-fixed
   failures.

5. Preserve successful book-scoped artifacts and retry only the failed query
   when lineage is current.

   GraphRAG stages that already have current `graph_extract`,
   `community_report`, `embed`, and `query_ready` evidence must not be rebuilt
   for a pure GraphRAG query provider outage. The design should also avoid
   invalidating qmd build evidence merely because the graph query check failed.

6. Repair qmd build evidence timing or contract.

   Persist qmd build/native qmd command evidence before executing
   GraphRAG query checks, or split the manifest so the qmd build artifact is
   not blocked by `qmd-query-graphrag-json`. This prevents recovery summaries
   from reporting `qmdBuildStatus=pending` when the actual failed stage is
   graph query provider access.

7. Update operations documentation.

   Add a dedicated section for GraphRAG query provider outages that includes
   the structured JSON signature, expected status JSON fields, operator
   action, and forbidden actions.

## Recommended Fix Scope

Design changes:

- Add a short design note or runbook subsection for
  `GraphRAG query provider unavailable` recovery semantics.
- State the precedence order for failure classification:
  permanent local evidence and auth errors first; structured provider outage
  second; HTTP 429/5xx and transient text third; unknown last.
- State that batch operational retryability is not a blind copy of typed CLI
  `retryable`.
- State that every `stop_until_fixed` item stops same-process scheduling.
- State that query retry uses current lineage and must not rebuild qmd or
  GraphRAG artifacts unless fingerprint, source hash, provider fingerprint, or
  required artifact evidence is stale.

Implementation changes:

- Update `scripts/graphrag/batch-failure-classifier.mjs` to parse typed JSON
  errors and classify this exact payload as transient/retryable for batch
  recovery.
- Update `scripts/graphrag/batch-epub-workflow.mjs` so generic
  `stop_until_fixed` failures stop same-process scheduling.
- Ensure recovery summary and `--status-json` show provider recovery timing
  and reason for this case.
- Split qmd build/native command evidence from GraphRAG query command
  evidence, or move qmd build manifest persistence before graph query checks.
- Keep all retries book-scoped by `bookId`, existing producer run ids, and
  current artifact fingerprints.

Documentation changes:

- Update `docs/operations/graphrag-epub-batch-runbook.md` and
  `docs/operations/graphrag-epub-resume-commands.md`.
- Include a concrete operator flow:
  run `--status-json`, confirm `waitingForProviderRecovery=true` and
  `nextRetryAt`, wait until the retry time, resume the same `runId`, and do
  not delete `graph_vault/books/<bookId>/output` or create a replacement run
  unless lineage is stale for an unrelated reason.

## Test Recommendations

1. Unit-test the classifier with the exact structured JSON payload.

   Expected result:

   - `failureKind=transient`
   - `retryable=true`
   - no provider auth status code
   - optional structured metadata/code available to callers if added

2. Unit-test precedence for permanent evidence.

   The same payload plus HTTP `401`, `403`, `INVALID_API_KEY`, invalid
   capability scope, or known local artifact gate text must remain
   non-retryable/permanent or local-repair scoped as appropriate.

3. Batch integration-test `qmd-query-graphrag-json` failure with structured
   `provider_unavailable`.

   Use the existing test hook runner. Assert the item becomes pending provider
   recovery wait with `nextRetryAt`, `retryDelaySeconds`,
   `providerRecoveryReason`, and `failedStage=qmd-query-graphrag-json`.

4. Batch integration-test same-process stop for `stop_until_fixed`.

   Fixture with two books: first produces a generic non-retryable
   `stop_until_fixed` failure; second runner must not start. Assert no
   `command_start` or `item_start` exists for the second item.

5. Batch integration-test successful GraphRAG build is not rebuilt for query
   retry.

   Seed current book-scoped `graph_extract`, `community_report`, `embed`, and
   `query_ready` evidence; fail only the query command; rerun after
   `nextRetryAt`; assert producer run ids and artifact ids are unchanged and
   no high-cost GraphRAG stage command is invoked.

6. Status JSON regression test.

   Assert `--status-json` for this case includes the failed stage,
   `waitingForProviderRecovery=true`, retry timing, recovery reason, and
   preserves `graphBuildStatus.status=succeeded`.

7. qmd build evidence regression test.

   Fail only `qmd-query-graphrag-json` after qmd-native checks pass. Assert
   qmd build/native evidence remains succeeded or separately observable, and
   the failed evidence is specifically graph query.

## Final Recommendation

Do not continue implementation unchanged. Revise the design and implementation
before resuming the real batch. The next implementation pass should be narrow:
classification, stop scheduling semantics, provider recovery observability,
qmd evidence timing, runbook updates, and regression tests for the exact real
payload and event sequence.
