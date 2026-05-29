# GraphRAG Query Provider Unavailable Recovery Development Audit

## Verdict

FAIL.

The implementation fixes the real `qmd-query-graphrag-json`
`provider_unavailable` projection and same-writer stop behavior for the audited
case, but one classifier boundary violates the structured provider error
contract. A typed `provider_unavailable` payload emitted at `stage=provider`
for "provider not configured" is currently reclassified as transient provider
wait, although the runtime intentionally emits it as non-retryable. This can
hide configuration defects behind `retry_same_run_id`.

## Scope

- Audit case:
  `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open`
- Real batch run id: `epub-batch-20260527-real-resume-1`
- Real failed item: `Building Microservices (Sam Newman).epub`
- Required report path:
  `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/dev-agent-c/development_audit.md`

## Principle Results

1. **FAIL - Retryability preserves structured provider error semantics.**

   `src/query/unified-router.ts:553` to `src/query/unified-router.ts:563`
   emits missing `queryGraphRag` as `stage=provider`,
   `code=provider_unavailable`, and `retryable=false`. The batch classifier in
   `scripts/graphrag/batch-failure-classifier.mjs:68` to
   `scripts/graphrag/batch-failure-classifier.mjs:77` ignores `stage` and
   `redactedMessage`, so any typed payload with
   `provider=graphrag`, `capability=graph_query`, and
   `code=provider_unavailable` becomes `failureKind=transient`,
   `retryable=true`. The intended GraphRAG query runtime outage is
   `stage=graphrag_query`; the provider-not-configured payload is not the same
   failure class.

2. **PASS - Transient upstream/provider failures do not become permanent without proof.**

   The real structured query outage is correctly recognized as transient by
   `scripts/graphrag/batch-failure-classifier.mjs:71` to
   `scripts/graphrag/batch-failure-classifier.mjs:77`, and network/provider
   tokens are covered by
   `scripts/graphrag/batch-failure-classifier.mjs:116` to
   `scripts/graphrag/batch-failure-classifier.mjs:178`. The query bridge also
   retries transient GraphRAG query failures before surfacing them in
   `src/integrations/graphrag.ts:49` to `src/integrations/graphrag.ts:127`.

3. **PASS - Batch stage gates require book-scoped QMD build, command, GraphRAG build, and GraphRAG query evidence before completion.**

   Completion requires qmd build evidence, GraphRAG build evidence, and
   GraphRAG query evidence to be succeeded in
   `scripts/graphrag/batch-epub-workflow.mjs:5150` to
   `scripts/graphrag/batch-epub-workflow.mjs:5227`. The command set is checked
   in `scripts/graphrag/batch-epub-workflow.mjs:5005` to
   `scripts/graphrag/batch-epub-workflow.mjs:5104`, with
   `qmd-query-graphrag-json` included at
   `scripts/graphrag/batch-epub-workflow.mjs:5098` to
   `scripts/graphrag/batch-epub-workflow.mjs:5102`.

4. **PASS - Failed required evidence must prevent completion and expose the exact failed stage.**

   `graphQueryEvidence` returns `status=failed` and the failed command name as
   stage in `scripts/graphrag/batch-epub-workflow.mjs:3542` to
   `scripts/graphrag/batch-epub-workflow.mjs:3555`. `runItem` throws instead of
   completing when this status is not succeeded at
   `scripts/graphrag/batch-epub-workflow.mjs:5200` to
   `scripts/graphrag/batch-epub-workflow.mjs:5208`.

5. **PASS - A stop-until-fixed decision must stop scheduling further books in the same writer process.**

   `shouldStopBatchAfterFailure` is now generic in
   `scripts/graphrag/batch-epub-workflow.mjs:5334` to
   `scripts/graphrag/batch-epub-workflow.mjs:5338`, and the main scheduling loop
   checks it before processing further books in
   `scripts/graphrag/batch-epub-workflow.mjs:5479` to
   `scripts/graphrag/batch-epub-workflow.mjs:5488` and
   `scripts/graphrag/batch-epub-workflow.mjs:6029` to
   `scripts/graphrag/batch-epub-workflow.mjs:6036`. The regression
   `test/cli.test.ts:6454` to `test/cli.test.ts:6616` proves a generic
   permanent stop prevents the next book from receiving `command_start`.

6. **PASS - Orphaned runner recovery must preserve checkpoint identity and not corrupt adjacent book state.**

   `hydrateBatchCheckpoint` preserves checkpoint identity fields in
   `scripts/graphrag/batch-checkpoint-hydration.mjs:39` to
   `scripts/graphrag/batch-checkpoint-hydration.mjs:47`, and
   `recoverOrphanedRunningCheckpoint` only reopens the owning checkpoint as
   pending transient in
   `scripts/graphrag/batch-epub-workflow.mjs:3758` to
   `scripts/graphrag/batch-epub-workflow.mjs:3799`. Same-book concurrent
   execution is also guarded by
   `scripts/graphrag/batch-epub-workflow.mjs:1586` to
   `scripts/graphrag/batch-epub-workflow.mjs:1598` and
   `scripts/graphrag/batch-epub-workflow.mjs:5732` to
   `scripts/graphrag/batch-epub-workflow.mjs:5749`.

7. **PASS with risk - Provider recovery must be observable in status JSON with retry timing and reason.**

   The summary schema exposes `nextRetryAt`, `retryDelaySeconds`,
   `providerRecoveryWaitCount`, `maxProviderRecoveryWaits`,
   `providerRecoveryReason`, and `waitingForProviderRecovery` in
   `src/contracts/batch-run.ts:221` to `src/contracts/batch-run.ts:253`.
   The real run currently projects the audited item as pending transient with
   all expected fields through `--status-json`. However, the new in-budget
   transient deferral path writes `waitingForProviderRecovery=true` but does not
   write `providerRecoveryReason` in
   `scripts/graphrag/batch-epub-workflow.mjs:5230` to
   `scripts/graphrag/batch-epub-workflow.mjs:5260`; the summary only forwards a
   reason if metadata already contains one at
   `scripts/graphrag/batch-epub-workflow.mjs:4034` to
   `scripts/graphrag/batch-epub-workflow.mjs:4077`. This is a non-blocking
   observability gap for fresh transient failures.

8. **PASS - Retrying a failed query must not rebuild unrelated successful artifacts unless lineage is stale.**

   The single-book resume path uses `BookResumePlan.nextStage`; when
   `nextStage == null`, it refreshes producer manifest and runs only the query
   path in `scripts/graphrag/resume-book-workspace.mjs:1127` to
   `scripts/graphrag/resume-book-workspace.mjs:1162`. High-cost stages are only
   entered for explicit `nextStage` values in
   `scripts/graphrag/resume-book-workspace.mjs:1274` to
   `scripts/graphrag/resume-book-workspace.mjs:1441`. The real status projection
   for the audited item shows `graphBuildStatus.status=succeeded` and
   `graphQueryStatus.status=failed`, so same-run recovery should resume at the
   query/check layer rather than rebuilding successful graph artifacts.

9. **PASS - Docs and runbooks must describe the operator action for provider query outages.**

   The runbook documents structured GraphRAG query provider outages and legacy
   reclassification in `docs/operations/graphrag-epub-batch-runbook.md:199` to
   `docs/operations/graphrag-epub-batch-runbook.md:251`, provider wait behavior
   in `docs/operations/graphrag-epub-batch-runbook.md:252` to
   `docs/operations/graphrag-epub-batch-runbook.md:266`, and the required
   `--status-json` observability fields in
   `docs/operations/graphrag-epub-batch-runbook.md:360` to
   `docs/operations/graphrag-epub-batch-runbook.md:376`. The command appendix
   provides a focused status projection command in
   `docs/operations/graphrag-epub-resume-commands.md:41` to
   `docs/operations/graphrag-epub-resume-commands.md:80`.

10. **PASS - Tests must pin retry classification and batch stop behavior for this case.**

    The exact structured `provider_unavailable` payload and SSL-wrapped variant
    are pinned in `test/cli.test.ts:2364` to `test/cli.test.ts:2385`.
    Status-json recovery of the GraphRAG query provider failure is pinned in
    `test/cli.test.ts:4137` to `test/cli.test.ts:4303`. Generic same-writer
    stop behavior is pinned in `test/cli.test.ts:6454` to
    `test/cli.test.ts:6616`.

## Blocking Issues

1. `scripts/graphrag/batch-failure-classifier.mjs:71`

   The typed query classifier treats every structured
   `provider=graphrag`, `capability=graph_query`,
   `code=provider_unavailable` payload as transient. It does not require
   `stage=graphrag_query` or distinguish the runtime-not-configured message.
   This conflicts with `src/query/unified-router.ts:553` to
   `src/query/unified-router.ts:563`, where missing GraphRAG provider wiring is
   deliberately emitted as `stage=provider`, `retryable=false`.

   Reproduction:

   ```bash
   node --input-type=module - <<'NODE'
   import { classifyFailure } from './scripts/graphrag/batch-failure-classifier.mjs';
   const payload = JSON.stringify({
     schemaVersion: '1.0.0',
     route: 'graphrag',
     stage: 'provider',
     provider: 'graphrag',
     capability: 'graph_query',
     code: 'provider_unavailable',
     retryable: false,
     redactedMessage: 'GraphRAG query provider is not configured.'
   });
   console.log(classifyFailure(payload));
   NODE
   ```

   Observed result:

   ```text
   { failureKind: "transient", retryable: true }
   ```

   Expected result: non-retryable permanent or unknown stop-until-fixed, not
   provider recovery wait.

## Non-Blocking Risks

- Fresh transient provider failures in the in-budget deferral path may lack
  `providerRecoveryReason` in status JSON. `buildRecoverableTransientCheckpoint`
  writes `waitingForProviderRecovery`, `nextRetryAt`, and `retryDelaySeconds`,
  but not `providerRecoveryReason`
  (`scripts/graphrag/batch-epub-workflow.mjs:5230` to
  `scripts/graphrag/batch-epub-workflow.mjs:5260`). The summary forwards the
  reason only when metadata has it
  (`scripts/graphrag/batch-epub-workflow.mjs:4075` to
  `scripts/graphrag/batch-epub-workflow.mjs:4077`). Legacy recovery and real
  status projection do expose a reason, so this is not blocking for the
  audited historical item.

- The real persisted checkpoint for `Building Microservices (Sam Newman).epub`
  still contains the historical `failed`, `failureKind=unknown`,
  `retryable=false`, and `recoveryDecision=stop_until_fixed` values. The current
  code recovers it during `--status-json` and normal load, but the read-only
  status projection intentionally does not write the recovered checkpoint. This
  is operationally acceptable if the next write runner persists the recovered
  form before scheduling, but operators should rely on `--status-json` rather
  than raw checkpoint files until then.

- The current implementation now writes the qmd build manifest after qmd-native
  checks and before the GraphRAG query checks in
  `scripts/graphrag/batch-epub-workflow.mjs:5088` to
  `scripts/graphrag/batch-epub-workflow.mjs:5092`. The historical real
  checkpoint still projects `qmdBuildStatus=pending` until a write runner
  persists the new manifest, so operators should treat that field as stale
  historical observability rather than evidence that the future retry will
  rebuild qmd artifacts.

## Verified Evidence

Focused tests executed during this audit:

```bash
npm exec vitest -- run test/cli.test.ts -t \
  "classifies provider failures|status-json recovers GraphRAG query provider_unavailable|generic stop-until-fixed failure stops before next book"
```

Result:

```text
test/cli.test.ts: 2 passed, 209 skipped
```

Read-only real-run projection executed with provider environment variables
cleared and `--skip-dotenv`:

```bash
env -u OPENAI_API_KEY -u JINA_API_KEY -u OPENAI_BASE_URL -u JINA_API_BASE \
  node scripts/graphrag/batch-epub-workflow.mjs \
    --run-id epub-batch-20260527-real-resume-1 \
    --skip-dotenv \
    --status-json \
    --log-root /tmp/qmd-graphrag-status-audit-c
```

Observed projection for `Building Microservices (Sam Newman).epub`:

```text
status=pending
failureKind=transient
retryable=true
retryExhausted=false
recoveryDecision=retry_same_run_id
failedStage=qmd-query-graphrag-json
waitingForProviderRecovery=true
providerRecoveryWaitCount=1
maxProviderRecoveryWaits=3
providerRecoveryReason=legacy_retry_exhausted_transient
retryDelaySeconds=300
qmdBuildStatus=pending
graphBuildStatus=succeeded
graphQueryStatus=failed
```

## Suggested Validation Commands

```bash
node --check scripts/graphrag/batch-failure-classifier.mjs
node --check scripts/graphrag/batch-checkpoint-hydration.mjs
node --check scripts/graphrag/batch-epub-workflow.mjs
npm run test:types
npm exec vitest -- run test/cli.test.ts -t \
  "status-json recovers GraphRAG query provider_unavailable|generic stop-until-fixed failure stops before next book"
```

After fixing the blocking classifier boundary, add and run a regression for the
provider-not-configured payload:

```bash
npm exec vitest -- run test/cli.test.ts -t \
  "GraphRAG query provider is not configured"
```

The blocking issue section includes the minimal manual classifier reproduction.
