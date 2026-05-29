# Development Audit Report A R2

## Conclusion

Conclusion: PASS.

The revised audit uses the fixed baseline in `baseline.md` and the project
type-check entrypoints in `package.json`. The OpenAI retry-guidance failure
classification fix satisfies all 10 fixed criteria. No mandatory source fixes
are required.

## Criteria Results

1. PASS. `classifyFailure` now includes the observed provider wording
   `an error occurred while processing your request. you can retry your request`
   in the provider transient token list. The wrapped GraphRAG index workflow
   regression asserts `failureKind=transient` and `retryable=true`.

2. PASS. The added match requires explicit retry guidance, not a generic
   OpenAI mention. A direct probe of `OpenAI Responses failed while processing
   a request` returned `failureKind=unknown` and `retryable=false`.

3. PASS. HTTP 4xx status handling precedes textual retry matching in
   `classifyFailure`. The tests cover `HTTP 400 timeout` and `HTTP 409
   conflict` as permanent, and a direct probe of `HTTP 400` with the retry
   guidance text still returned permanent with `providerStatusCode=400`.

4. PASS. Data compatibility detection remains intact after provider transient
   and status-code handling. The direct probe of `GraphRAG community
   text-unit context references missing text units: tu-1` returned
   `failureKind=data_compatibility` and `retryable=false`; the mixed data
   compatibility regression also passed.

5. PASS. Local artifact gate failures still classify as permanent unless an
   independent provider transient signal is present. A direct probe of the
   missing-artifact gate returned permanent/non-retryable, and the
   `status-json keeps local GraphRAG artifact gate failures stop-until-fixed`
   test passed.

6. PASS. Query-ready capability and identity projection failures remain local
   artifact gate cases. The classifier still recognizes query-ready identity,
   sidecar, managed settings projection, and capability-scope text as local
   artifact gate failures, and the focused query-ready projection test passed.

7. PASS. The source diff is limited to `package.json`,
   `scripts/graphrag/batch-failure-classifier.mjs`, and `test/cli.test.ts`.
   There are no changes to GraphRAG stage execution, artifact cleanup,
   query-ready projection, or qmd output rendering.

8. PASS. `test/cli.test.ts` includes a regression for the observed
   `GraphRAG index workflow failed` wrapper containing the OpenAI retry
   guidance message and asserts transient/retryable classification.

9. PASS. Type checking passes through the project-standard entrypoints:
   `npm run typecheck` and `npm run test:types`. Both execute
   `tsc -p tsconfig.build.json --noEmit` and exited successfully.

10. PASS. Legacy status hydration uses the shared classifier. Both
    `batch-checkpoint-hydration.mjs` and `batch-epub-workflow.mjs` import
    `classifyFailure` from `batch-failure-classifier.mjs`, and the legacy
    status-json recovery regression passed.

## Evidence

- `scripts/graphrag/batch-failure-classifier.mjs`: 4xx status classification
  is evaluated before provider transient text; the new retry-guidance token is
  in the shared provider transient token list.
- `test/cli.test.ts`: the provider classification test covers 4xx permanence,
  429/5xx transience, the GraphRAG workflow wrapper, partial-output, network
  transients, local artifact gates, and query-ready projection failures.
- `scripts/graphrag/batch-checkpoint-hydration.mjs`: legacy checkpoint
  hydration classifies failed command and checkpoint text through the shared
  classifier.
- Verification commands passed:
  `npm run typecheck`,
  `npm run test:types`,
  `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "keeps transient and permanent provider recovery decisions typed"`,
  and the focused preservation regression set for local gate, data
  compatibility, provider 4xx, and legacy status-json recovery.

## Required Fixes

None.
