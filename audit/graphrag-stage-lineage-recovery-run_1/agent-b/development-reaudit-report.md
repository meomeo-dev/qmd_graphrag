# Development Reaudit Report

Verdict: fail

## Findings

- High. Query-ready capability loading and restore still let a newer
  non-succeeded producer checkpoint hide an older usable succeeded producer run.
  `src/graphrag/capability-catalog.ts:324` to
  `src/graphrag/capability-catalog.ts:327` builds query-ready lineage only from
  the currently persisted succeeded checkpoints in `checkpoints.yaml`, and
  `src/graphrag/capability-catalog.ts:390` to
  `src/graphrag/capability-catalog.ts:405` silently drops the capability when
  that reconstructed lineage is missing or invalid. The same pattern exists in
  restore: `src/vault/restore.ts:390` to `src/vault/restore.ts:393` reads only
  current succeeded checkpoints, and `src/vault/restore.ts:335` to
  `src/vault/restore.ts:354` rejects the capability when those current
  checkpoints do not cover lineage. A local reproduction completed
  `query_ready`, confirmed `loadGraphQueryCapabilities()` returned 1, then
  started a newer `graph_extract` run; after that,
  `loadGraphQueryCapabilities()` returned 0 even though the older succeeded
  `graph_extract` run record and valid current artifacts still existed. This
  violates criteria 4, 6, and 9 because the repository resume planner can
  recover older producer success from run records, but capability loading and
  restore do not use equivalent effective checkpoint resolution.

- Medium. The new recovered-capability regression covers stale producer
  artifact ids only while the producer checkpoint remains the current succeeded
  checkpoint. `test/book-job-state.test.ts:2082` to
  `test/book-job-state.test.ts:2202` verifies refreshed `graph_extract`
  artifact ids are loaded, but it does not add a query-ready capability loading
  or restore test where a newer running or failed producer checkpoint has
  overwritten the current checkpoint row. The existing newer-running test at
  `test/book-job-state.test.ts:2001` to `test/book-job-state.test.ts:2076`
  stops at `getResumePlan`, so it does not protect the loader/restore consumer
  paths that still fail.

## Criteria Coverage

1. Partial. Repository resume recovery and the added loader changes handle the
   refreshed-artifact-id case when the producer checkpoint is still the current
   succeeded checkpoint. The consumer paths still fail when the usable
   succeeded producer checkpoint has been displaced by a newer running or failed
   checkpoint and must be recovered from run records.
2. Pass. Stage and capability artifact validation still goes through
   `validateBookArtifactSet`, preserving producer run, required kind, stage
   fingerprint, provider fingerprint, corpus content hash, book scope, and file
   integrity checks.
3. Partial. Current producer artifacts are rebound by producer run id in
   `src/graphrag/capability-catalog.ts:62` to
   `src/graphrag/capability-catalog.ts:78` and
   `src/vault/restore.ts:181` to `src/vault/restore.ts:199`, but only for
   producer run ids visible in current succeeded checkpoints. Older usable
   succeeded candidates from run records are not considered by these paths.
4. Fail. A newer running or failed checkpoint can hide an older usable
   succeeded producer run from capability loading and restore because those
   paths use only current succeeded checkpoint rows and do not apply the
   repository's effective checkpoint selection.
5. Partial. Query-ready completion in `src/job-state/repository.ts` still
   requires `graph_extract`, `community_report`, and `embed` producer run ids
   and validated artifacts. Capability loading and restore also require those
   producers, but reconstruct them from an incomplete source and therefore
   reject recoverable query-ready state.
6. Fail. Query-ready publishing can include recovered producer lineage artifact
   ids, but the published capability can later become unloadable when
   `loadGraphQueryCapabilities()` reconstructs lineage from stale current
   checkpoint state instead of the validated effective producer lineage.
7. Pass. The reviewed changes fail closed rather than marking invalid or
   partial artifacts ready. Wrong-scope, wrong-hash, wrong-fingerprint,
   wrong-provider, wrong-corpus, wrong-producer, missing, and empty artifacts
   remain blocked by the validator.
8. Pass. The new producer artifact rebinding filters by `bookId`, stage,
   producer run id, and required kind before validation. Existing book-scoped
   GraphRAG output checks remain in place.
9. Fail. Resume plans remain observable, but query-ready capability failures in
   `loadGraphCapabilities()` are still silent filtering. In the reproduced
   newer-running case, a valid published graph query capability disappeared
   from the loader output instead of surfacing lineage evidence or preserving
   the recovered producer state.
10. Pass. The new source changes are scoped to stage lineage recovery,
    capability lineage loading, vault restore validation, and focused tests.
    They do not rewrite unrelated qmd search, GraphRAG query execution, CLI
    output, or rendering behavior.

## Residual Risks

- `community_report` and `embed` stale-id recovery still lack direct
  stage-specific tests. The current tests exercise `graph_extract` stale-id
  recovery and a generic query-ready capability load path.
- Capability-catalog and restore now duplicate lineage reconstruction logic
  instead of reusing the repository's effective checkpoint resolution. This
  increases the risk of future drift between resume planning, capability
  loading, and restore.
- Restore-specific recovered-lineage behavior is not directly covered by the
  new regression test; the defect identified above is visible by code
  inspection in restore and by the analogous capability-loader reproduction.

## Verification

- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run
  --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts`
  with 48 tests passing.
- Passed: `npm run test:types`.
- Passed: `git diff --check -- src/graphrag/capability-catalog.ts
  src/job-state/repository.ts src/vault/restore.ts test/book-job-state.test.ts`.
- Failed manual reproduction: a temporary `node --import tsx` scenario returned
  `loadGraphQueryCapabilities()` count `1` immediately after `query_ready`
  completion, then count `0` after starting a newer `graph_extract` run with
  the same fingerprint, while the older successful producer run record and
  artifacts remained available.
