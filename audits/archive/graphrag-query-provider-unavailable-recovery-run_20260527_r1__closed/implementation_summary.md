# GraphRAG Query Provider Unavailable Recovery Implementation Summary

## Status

Implementation complete for the current development pass. Development audit is
pending.

## Design Audit Baseline

The active audit case remains:

```text
audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open
```

The fixed audit principles are defined in `README.md` and must not be changed
between audit passes.

Agents A, B, and C all reported initial design audit result `FAIL`. Their
findings were consolidated into this implementation pass.

## Real Failure Being Fixed

Real run:

```text
epub-batch-20260527-real-resume-1
```

Real failed item:

```text
Building Microservices (Sam Newman).epub
```

Observed failed stage:

```text
qmd-query-graphrag-json
```

Structured failure payload:

```json
{
  "schemaVersion": "1.0.0",
  "route": "graphrag",
  "stage": "graphrag_query",
  "provider": "graphrag",
  "capability": "graph_query",
  "code": "provider_unavailable",
  "retryable": false,
  "redactedMessage": "GraphRAG query provider failed before returning a response."
}
```

The historical checkpoint had incorrectly persisted this as
`failureKind=unknown`, `retryable=false`, `retryExhausted=true`, and
`recoveryDecision=stop_until_fixed`.

## Implemented Fixes

### Structured Provider Failure Classification

`scripts/graphrag/batch-failure-classifier.mjs` now parses typed query error
JSON embedded in stderr/stdout.

The following structured payload is classified as operationally transient for
batch recovery:

```text
stage=graphrag_query
provider=graphrag
capability=graph_query
code=provider_unavailable
```

The override is intentionally scoped to `stage=graphrag_query`. A structured
`stage=provider` payload for "GraphRAG query provider is not configured"
remains non-retryable and must not enter provider recovery wait.

The classifier also covers network/provider tokens observed in the real
GraphRAG query failure, including SSL EOF, Jina, httpx, aiohttp, urllib3, DNS,
connection reset, and API connection failures.

### GraphRAG Query Runtime Retryability

`src/query/unified-router.ts` now annotates GraphRAG provider runtime failures
with `retryable=true` when the underlying error text is a transient
network/provider failure.

Provider-not-configured remains non-retryable. Runtime provider failure before
a response uses `stage=graphrag_query`, while missing provider wiring uses
`stage=provider`; the batch classifier preserves that boundary.

`src/integrations/graphrag.ts` now retries GraphRAG query bridge calls for the
same transient network/provider tokens before surfacing a typed query failure.

### Legacy Checkpoint Recovery

`scripts/graphrag/batch-checkpoint-hydration.mjs` and
`scripts/graphrag/batch-epub-workflow.mjs` reclassify legacy failed checkpoints
using the current classifier.

Legacy checkpoints that were persisted as
`failed + retryable=false + stop_until_fixed` but contain a structured
GraphRAG query `provider_unavailable` payload are recovered to:

```text
status=pending
failureKind=transient
retryable=true
retryExhausted=false
recoveryDecision=retry_same_run_id
waitingForProviderRecovery=true
```

The recovery state exposes `nextRetryAt`, `retryDelaySeconds`,
`providerRecoveryWaitCount`, `maxProviderRecoveryWaits`, and
`providerRecoveryReason`.

### Same-Writer Stop Semantics

`shouldStopBatchAfterFailure` now treats every
`failed + retryable=false + recoveryDecision=stop_until_fixed` checkpoint as a
stop condition, unless that checkpoint is first recovered by a safe recovery
path.

The stop condition is no longer limited to provider auth and data
compatibility failures.

### Status And Runbook Updates

The operations documents now explicitly describe GraphRAG query provider
outages:

- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/operations/graphrag-epub-resume-boost.md`
- `docs/operations/graphrag-epub-resume-commands.md`

The boost document now points to the current open audit case and records the
latest verified real batch status.

## Tests Added Or Extended

`test/cli.test.ts` now pins:

- Direct classification of the exact structured GraphRAG query
  `provider_unavailable` payload.
- Classification of the same payload when wrapped with SSL EOF provider
  evidence.
- Negative classification of structured `stage=provider`
  provider-not-configured payloads.
- `--status-json` recovery of a persisted legacy failed checkpoint with the
  exact structured payload.
- Runtime persistence of `qmd_build_manifest.json` after qmd-native command
  checks and before GraphRAG query checks.
- Generic same-writer stop behavior for any permanent
  `stop_until_fixed` failure, not only provider auth or data compatibility.

## Verification

The following checks passed:

```text
node --check scripts/graphrag/batch-epub-workflow.mjs
node --check scripts/graphrag/batch-failure-classifier.mjs
node --check scripts/graphrag/batch-checkpoint-hydration.mjs
npm run test:types
git diff --check
focused vitest recovery/stop regression set: 6 passed
```

## Real Batch Verification

Read-only status projection was executed with provider environment variables
cleared from the shell.

Latest verified snapshot:

```text
generatedAt=2026-05-27T10:24:25Z
totalItems=38
completedItems=1
pendingItems=37
runningItems=0
failedItems=0
recoveryDecision=retry_same_run_id
retryableItemCount=3
```

`Building Microservices (Sam Newman).epub` now projects as:

```text
status=pending
failureKind=transient
retryable=true
retryExhausted=false
recoveryDecision=retry_same_run_id
failedStage=qmd-query-graphrag-json
waitingForProviderRecovery=true
providerRecoveryReason=legacy_retry_exhausted_transient
qmdBuildStatus=pending
commandCheckStatus=failed
graphBuildStatus=succeeded
graphQueryStatus=failed
```

This confirms the real legacy checkpoint no longer appears as a permanent
failed item in `--status-json`.

## Development Audit Follow-Up

Development audit agents B and C both reported the same blocking issue: the
structured `provider_unavailable` classifier did not require
`stage=graphrag_query`. The implementation now requires that stage and includes
a regression for `stage=provider` provider-not-configured payloads.

Audit C also identified a non-blocking observability gap: fresh transient
provider recovery checkpoints could enter provider wait without
`providerRecoveryReason`. `buildRecoverableTransientCheckpoint` now writes
`providerRecoveryReason=transient_failure_recovered`, and the fail-fast
transient regression asserts it.

## Known Residual Risk

The historical real `Building Microservices (Sam Newman).epub` checkpoint may
still show `qmdBuildStatus=pending` until a write runner persists the new qmd
build manifest. Future runs now write `qmd_build_manifest.json` immediately
after qmd-native command checks and before GraphRAG query checks, so late
GraphRAG query failures preserve qmd build success evidence.
