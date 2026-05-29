# Batch Provider Auth Fail-Fast Final Report

## Result

Status: `development_audit_passed`

The batch EPUB runner now stops the current batch when a non-retryable provider
authentication or authorization failure is observed. This prevents invalid API
key or forbidden provider states from launching subsequent books and consuming
additional LLM requests.

The fix handles provider auth failure evidence from both checkpoint-level and
failed command-check records:

- HTTP/provider status code `401`
- HTTP/provider status code `403`
- `invalid api key`
- `invalid_api_key`
- `unauthorized`
- `forbidden`
- `authentication`

The implementation intentionally does not use a broad `auth` substring and does
not expand all 4xx failures into global batch stops. Existing 429/5xx transient
provider recovery behavior remains unchanged.

## Audit

Design audit passed with three fixed criteria files under the agent
subdirectories.

Development audit required one revision cycle:

- Agent A required a same-runner runtime 401 test, not only a pre-existing
  failed checkpoint test.
- Agent B required cleanup of `.tmp-tests/` runtime artifacts before
  submission.
- Agent C passed and recommended the same runtime 401 coverage as a non-blocking
  strengthening item.

All final development reaudits passed.

## Verification

Passed commands:

- `npm run test:node -- test/cli.test.ts -t "provider"`
- `npm run test:node -- test/cli.test.ts -t "non-transient"`
- `npm run test:node -- test/cli.test.ts -t "data compatibility"`
- `npm run test:node -- test/cli.test.ts -t "fail-fast transient"`
- `npm run typecheck`
- `git diff --check`

A broader `status-json` sweep surfaced an unrelated stale GraphRAG producer
lineage expectation mismatch (`stage_artifact_missing` vs
`stage_artifact_producer_run_mismatch`). It is outside this provider auth
fail-fast change and was not counted as verification for this case.

## Files

Implementation files:

- `scripts/graphrag/batch-epub-workflow.mjs`
- `test/cli.test.ts`

Audit files:

- `audit/batch-provider-auth-failfast-run_1__closed/`

