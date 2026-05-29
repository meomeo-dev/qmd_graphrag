# Development Audit Report C R2

## Conclusion: PASS

OpenAI retry-guidance failure classification fix satisfies all 10 fixed
criteria from `dev-agent-c/baseline.md`. No mandatory fixes are required.

## Criteria Results

1. PASS. The fix directly targets the observed provider wording from the EPUB
   batch failure: `an error occurred while processing your request` plus
   `you can retry your request`. The implementation uses a text token in
   `scripts/graphrag/batch-failure-classifier.mjs:73`; it does not depend on
   absolute paths, run directories, request IDs, item IDs, or other private
   runtime details. `status.yaml:26` to `status.yaml:34` records the affected
   observed run and prior `unknown` classification.

2. PASS. The regression fixture embeds the OpenAI retry wording inside a
   `GraphRAG index workflow failed` JSON-shaped string and asserts
   `failureKind=transient` and `retryable=true`
   (`test/cli.test.ts:1918` to `test/cli.test.ts:1926`). A direct classifier
   probe also returned `transient` for the wrapped JSON text.

3. PASS. The test fixture uses a synthetic request identifier, `req-1`, and
   contains no secret, token, credential, live endpoint, or real request ID
   (`test/cli.test.ts:1920` to `test/cli.test.ts:1922`).

4. PASS. Existing redaction boundaries remain unchanged. The patch only adds a
   classifier token and test assertion. Redaction still occurs through existing
   paths such as `redacted()` and `redactLog()`
   (`scripts/graphrag/batch-epub-workflow.mjs:1023` to
   `scripts/graphrag/batch-epub-workflow.mjs:1049`) and existing vault
   sanitization tests remain present (`test/cli.test.ts:8379` to
   `test/cli.test.ts:8397`).

5. PASS. The patch does not create new dependencies. `package.json` dependency,
   optional dependency, dev dependency, and peer dependency sections are
   unchanged (`package.json:71` to `package.json:110`). The only package script
   change is a `typecheck` alias to `npm run test:types`
   (`package.json:37` to `package.json:43`).

6. PASS. The patch does not change CLI output schemas or query result
   rendering. The relevant diff is limited to the classifier token, one
   regression assertion, and the package script alias. Batch schemas remain the
   same, including `BatchFailureKindSchema`, `BatchRecoveryDecisionSchema`, and
   command-check fields (`src/contracts/batch-run.ts:24` to
   `src/contracts/batch-run.ts:75`).

7. PASS. Retry budgets and provider recovery wait counts are unchanged. The
   batch checkpoint and recovery paths still carry `retryBudgetSeconds` and
   `maxProviderRecoveryWaits` without altered defaults or counters
   (`scripts/graphrag/batch-epub-workflow.mjs:4115` to
   `scripts/graphrag/batch-epub-workflow.mjs:4145`,
   `scripts/graphrag/batch-epub-workflow.mjs:4214` to
   `scripts/graphrag/batch-epub-workflow.mjs:4269`).

8. PASS. The implementation does not hide true data compatibility failures
   behind transient matching. Numeric provider status codes are classified
   first, so `HTTP 400` plus retry wording remains permanent
   (`scripts/graphrag/batch-failure-classifier.mjs:8` to
   `scripts/graphrag/batch-failure-classifier.mjs:32`). Pure GraphRAG data
   compatibility text still reaches the `data_compatibility` branch
   (`scripts/graphrag/batch-failure-classifier.mjs:40` to
   `scripts/graphrag/batch-failure-classifier.mjs:45`). Direct probe result:
   wrapped retry guidance is transient, `HTTP 400` with retry guidance is
   permanent, and pure `'float' object is not subscriptable` community-report
   text is `data_compatibility`.

9. PASS. The shared classifier module remains compatible with source runtime
   and built output. Both batch runner and checkpoint hydration import the
   same `.mjs` classifier (`scripts/graphrag/batch-epub-workflow.mjs:36` to
   `scripts/graphrag/batch-epub-workflow.mjs:40`;
   `scripts/graphrag/batch-checkpoint-hydration.mjs:1` to
   `scripts/graphrag/batch-checkpoint-hydration.mjs:4`). The change uses only
   runtime-compatible string matching and does not introduce TypeScript-only
   syntax or build-time indirection.

10. PASS. Verification commands are recorded in the audit status file
    (`audit/graphrag-openai-retry-classification-run_1__closed/status.yaml:22` to
    `audit/graphrag-openai-retry-classification-run_1__closed/status.yaml:25`).
    The recorded commands are:
    `npm run test:node -- test/cli.test.ts -t "keeps transient and permanent provider recovery decisions typed"`
    and `npm run test:types`.

## Verification

- `npm run test:node -- test/cli.test.ts -t "keeps transient and permanent provider recovery decisions typed"`:
  passed, 1 target test passed and 186 tests skipped by filter.
- `npm run test:types`: passed, TypeScript build check exited 0.
- Direct classifier probe: wrapped OpenAI retry guidance classified as
  `transient`; `HTTP 400` plus retry guidance classified as `permanent`;
  pure GraphRAG data compatibility text classified as `data_compatibility`.

## Mandatory Fixes

None.
