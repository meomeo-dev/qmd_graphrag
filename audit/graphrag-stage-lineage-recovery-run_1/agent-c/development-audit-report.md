Verdict: fail

Findings

- High - Recovered query-ready capabilities can be published but then become
  unloadable. `src/job-state/repository.ts:2925` now publishes capability
  lineage from `queryReadyLineageArtifactIds`, which can contain fresh current
  artifact ids recovered from the same producer run. However,
  `src/graphrag/capability-catalog.ts:280` still derives query-ready lineage
  from each producer checkpoint's persisted `artifactIds`, and
  `src/graphrag/capability-catalog.ts:338` validates capabilities against that
  stale checkpoint-derived set. In a reproduced stale-id case, `completeStage`
  for `query_ready` succeeded and `graph-capabilities.yaml` contained the fresh
  recovered `graphrag_stats_json` id, but `loadGraphQueryCapabilities()` returned
  an empty list because the loader revalidated the stale graph_extract
  checkpoint id. This violates criteria 6 and 9: capability publishing is not
  consumable as validated producer lineage, and the failure is observed only as
  a silently missing capability.

- Medium - Tests cover resume-plan recovery but not recovered capability
  loading. The new recovery test at `test/book-job-state.test.ts:1915` stops at
  `getResumePlan`, while the capability publishing test at
  `test/book-job-state.test.ts:2161` exercises only the non-stale producer
  checkpoint path. No test completes `query_ready` after a producer checkpoint
  has stale artifact ids, then asserts that `loadGraphQueryCapabilities()`
  returns the published capability with the recovered artifact ids. This is the
  missing regression that allowed the high-severity loader/publisher mismatch.

Criteria Coverage

1. Partial. Producer-stage resume recovery handles refreshed artifact ids for
   high-cost stages such as `graph_extract`, but the capability loading path can
   still treat the same recovered lineage as invalid.
2. Pass. The implementation routes producer readiness through
   `validateBookArtifactSet`, preserving checks for producer run id, required
   kind, stage fingerprint, provider fingerprint, corpus content hash, book
   scope, and file integrity.
3. Partial. `artifactIdsForCheckpointCandidate` treats producer checkpoint ids
   as stale for high-cost producer stages by selecting current artifacts for the
   same stage and producer run. The same recovery model is not applied by the
   capability loader, which still uses checkpoint `artifactIds`.
4. Pass. `buildCheckpointCandidates` includes run records and
   `selectUsableSucceededCheckpoint` ignores failed/running candidates, so a
   newer running checkpoint does not hide an older usable succeeded checkpoint.
5. Pass. Query-ready completion still requires `graph_extract`,
   `community_report`, and `embed` producer run ids plus validated producer and
   query artifacts.
6. Fail. Published query-ready capability lineage can contain recovered current
   artifact ids, but `loadGraphCapabilities` reconstructs and validates lineage
   from stale checkpoint ids, making the published capability unusable.
7. Partial. Selected artifact sets fail closed through existing validation for
   missing, invalid, wrong-scope, wrong-hash, wrong-fingerprint,
   wrong-provider, wrong-corpus, and wrong-producer artifacts. The missing
   recovered capability-load test leaves the stale-id consumer path unprotected.
8. Pass. Book isolation remains enforced by `artifact.bookId` checks and
   book-scoped GraphRAG output validation.
9. Partial. Resume plans still report the true next stage and artifact evidence
   when blocked. Recovered capability load failures are not observable; the
   loader silently filters the capability out.
10. Pass. The implementation stays scoped to stage lineage and recovery in the
    modified source and test files, with no unrelated qmd search, GraphRAG query,
    CLI output, or rendering rewrites.

Residual Risks

- Recovery is tested for `graph_extract` only. Equivalent stale-id recovery for
  `community_report` and `embed` producer checkpoints should be covered because
  both participate in query-ready lineage.
- The run-record-to-checkpoint recovery path depends on historical run records
  having enough fingerprint-compatible metadata or input fingerprints. Legacy
  records with incomplete metadata should remain fail-closed.
- The audited focused test file passed, but full-suite interaction with CLI,
  restore, and capability projection paths remains important because those
  modules independently reconstruct query-ready lineage.

Verification

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts`
- `npm run test:types`
