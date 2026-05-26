# Development Final Reaudit Report

Verdict: pass

## Findings

No open findings.

The previous high-severity finding is closed. `projectQueryReadyLineage`
now loads candidates from current checkpoints and run records, selects
validated producer checkpoints, and rebinds lineage artifacts from the
current manifest by `producerRunId` before capability publication:
`src/graphrag/capability-catalog.ts:170`,
`src/graphrag/capability-catalog.ts:194`,
`src/graphrag/capability-catalog.ts:226`,
`src/graphrag/capability-catalog.ts:266`,
`src/graphrag/capability-catalog.ts:369`. `src/vault/restore.ts`
reuses the same projection for restore validation at
`src/vault/restore.ts:28`, `src/vault/restore.ts:230`,
`src/vault/restore.ts:299`, and `src/vault/restore.ts:306`.

The regression added in `test/book-job-state.test.ts:2082` completes
`query_ready`, then starts a newer `graph_extract` running checkpoint, and
still expects `loadGraphQueryCapabilities` to return the capability with
the refreshed producer artifact id. This directly covers the previous
failure mode.

## Criteria Coverage

1. Pass. High-cost producer readiness now uses current artifacts for the
   same producer run instead of trusting stale checkpoint artifact ids. The
   repository path does this in `artifactIdsForCheckpointCandidate`
   (`src/job-state/repository.ts:2491`), and query capability projection
   does the same in `artifactIdsForProducerStage`
   (`src/graphrag/capability-catalog.ts:97`).
2. Pass. Readiness still validates required artifact kind, book scope,
   producer run lineage, stage fingerprint, provider fingerprint, corpus
   content hash, and file integrity through `validateBookArtifactSet`
   (`src/job-state/artifact-validation.ts:477`).
3. Pass. Stale checkpoint artifact ids are recoverable when current
   manifest artifacts for the same stage and producer run satisfy all
   checks (`src/job-state/repository.ts:2491`,
   `src/graphrag/capability-catalog.ts:97`).
4. Pass. Newer failed or running checkpoints no longer shadow an older
   usable success. Candidate selection filters for succeeded checkpoints
   and continues through newer invalid candidates
   (`src/job-state/repository.ts:2598`,
   `src/graphrag/capability-catalog.ts:226`). The regression at
   `test/book-job-state.test.ts:2001` covers this for resume plans, and
   `test/book-job-state.test.ts:2082` covers query capability loading.
5. Pass. Query-ready projection still requires validated `graph_extract`,
   `community_report`, and `embed` producer run ids and artifacts before
   returning lineage (`src/graphrag/capability-catalog.ts:393`,
   `src/graphrag/capability-catalog.ts:414`,
   `src/graphrag/capability-catalog.ts:440`).
6. Pass. Capability publication and loading now publish validated lineage
   artifact ids rather than stale checkpoint ids
   (`src/job-state/repository.ts:1860`,
   `src/job-state/repository.ts:2920`,
   `src/graphrag/capability-catalog.ts:473`,
   `src/graphrag/capability-catalog.ts:497`).
7. Pass. Missing, empty, wrong-scope, wrong-hash, wrong-fingerprint,
   wrong-provider, wrong-corpus, and wrong-producer artifacts continue to
   fail closed through `validateBookArtifactSet` and `validateArtifact`
   (`src/job-state/artifact-validation.ts:398`,
   `src/job-state/artifact-validation.ts:510`,
   `src/job-state/artifact-validation.ts:527`,
   `src/job-state/artifact-validation.ts:535`,
   `src/job-state/artifact-validation.ts:543`,
   `src/job-state/artifact-validation.ts:550`,
   `src/job-state/artifact-validation.ts:573`).
8. Pass. Book isolation remains enforced by `bookId` checks and
   book-scoped graph output validation
   (`src/job-state/artifact-validation.ts:510`,
   `src/job-state/artifact-validation.ts:520`,
   `src/job-state/artifact-validation.ts:583`,
   `src/graphrag/capability-catalog.ts:211`).
9. Pass. Resume planning keeps observable stage validity, missing
   artifact ids, missing kinds, and invalid artifact evidence while using
   effective recovered checkpoints
   (`src/job-state/repository.ts:2521`,
   `src/job-state/repository.ts:2635`,
   `src/job-state/repository.ts:2690`). Query-ready completion still
   reports missing producer stages or invalid producer/query artifacts
   (`src/job-state/repository.ts:1811`,
   `src/job-state/repository.ts:1888`).
10. Pass. The diff is scoped to stage lineage recovery, query capability
    projection, restore reuse of the projection, and regression tests. No
    unrelated qmd search, GraphRAG query, CLI output, or rendering
    behavior was changed.

## Residual Risks

- `projectQueryReadyLineage` duplicates part of the repository's effective
  checkpoint projection instead of sharing an internal repository API. The
  current behavior is aligned, but future drift remains possible.
- Run-record candidates in `capability-catalog.ts` derive stage and
  provider fingerprints from current book state before artifact
  validation. This does not weaken the current fail-closed artifact checks,
  but it makes manifests the decisive evidence for recovered run records.
- The new query capability regression directly covers a newer running
  `graph_extract` after `query_ready`. Equivalent stage-specific stale-id
  tests for `community_report` and `embed` are still less explicit.
- Restore targeted tests passed, but there is no dedicated restore test for
  the exact sequence `query_ready` succeeded, then a newer producer stage
  started running. Restore now reuses the same projection, reducing but not
  eliminating this test gap.

## Verification

- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run
  --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts`
  (`48 passed`).
- Passed: `npm run test:types`.
- Passed: `git diff --check -- src/graphrag/capability-catalog.ts
  src/job-state/repository.ts src/vault/restore.ts
  test/book-job-state.test.ts`.
- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run
  --reporter=verbose --testTimeout 60000
  test/integrations/contracts.test.ts -t
  "restores qmd index and capability mirror from graph vault catalogs"`
  (`1 passed`, `69 skipped`).
- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run
  --reporter=verbose --testTimeout 60000
  test/integrations/contracts.test.ts -t "restore"`
  (`8 passed`, `62 skipped`).
