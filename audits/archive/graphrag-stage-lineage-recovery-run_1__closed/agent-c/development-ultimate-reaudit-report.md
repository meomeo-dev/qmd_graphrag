Verdict: pass

Findings

- None. The previous high-severity stale `query_ready` fingerprint capability
  loading issue is closed. `src/graphrag/capability-catalog.ts:158` now builds
  run-record candidates from historical `metadata.stageFingerprint` or
  `inputFingerprint` instead of the current book stage fingerprint, and
  `src/graphrag/capability-catalog.ts:220` rejects candidates whose typed stage
  fingerprint does not match current book state. The new regression at
  `test/book-job-state.test.ts:2215` verifies `getResumePlan()` reports
  `canQuery: false` and `loadGraphQueryCapabilities()` returns no capability
  after `query_ready` becomes stale.

Criteria Coverage

1. Pass. High-cost producer recovery no longer reruns solely because refreshed
   current artifact ids replace stale checkpoint ids. Repository resume planning
   and capability projection rebind producer artifacts by stage and
   `producerRunId`.
2. Pass. Readiness continues to validate producer lineage, required artifact
   kind, stage fingerprint, provider fingerprint, corpus content hash, book
   scope, and file integrity through `validateBookArtifactSet`. Stale
   `query_ready` run records now fail closed instead of being projected as
   current readiness.
3. Pass. Checkpoint artifact ids are treated as stale references when current
   artifacts for the same stage and producer run satisfy validation.
4. Pass. A newer running producer checkpoint no longer hides an older usable
   succeeded producer run. `projectQueryReadyLineage` reads current checkpoints
   plus run records, and the recovered capability test keeps the capability
   loadable after starting a newer running `graph_extract` run.
5. Pass. Query-ready projection still requires graph_extract,
   community_report, and embed producer run ids plus validated artifacts before
   graph query capabilities are loaded or restored.
6. Pass. Query-ready capability publication and loading include validated
   producer lineage artifact ids. The recovered capability test confirms the
   refreshed graph_extract artifact id is included and the stale checkpoint id
   is excluded.
7. Pass. Partial or invalid artifacts fail closed through shared validation for
   missing ids, missing required kinds, wrong scope, wrong hash, wrong
   fingerprint, wrong provider, wrong corpus content hash, wrong producer run,
   and invalid file integrity.
8. Pass. Book isolation remains enforced by `bookId`, book-scoped GraphRAG
   output paths, producer run ids, corpus content hash, fingerprints, and
   identity checks.
9. Pass. Resume readiness and capability loading are aligned for the previously
   failing stale `query_ready` case: resume reports `nextStage: "query_ready"`
   and `canQuery: false`, while capability loading returns no graph capability.
10. Pass. The implementation remains scoped to stage lineage recovery,
    capability lineage projection, vault restore validation, and focused tests;
    unrelated qmd search, GraphRAG query routing, CLI output, and rendering
    behavior were not rewritten.

Residual Risks

- Capability and restore projection still maintain their own effective
  checkpoint candidate logic instead of reusing one canonical repository
  effective-state implementation. The current high-risk drift cases are covered,
  but future divergence remains possible.
- Regression coverage is strongest for graph_extract refreshed artifact ids and
  stale `query_ready` fingerprints. Community_report and embed refreshed-id
  behavior relies on the shared projection path rather than stage-specific
  tests.
- Legacy run records without typed `metadata.stageFingerprint` now fall back to
  `inputFingerprint` in the capability projection. This is fail-closed for
  stale query-ready recovery, but older data whose input fingerprint differs
  from typed stage fingerprint may require rerun rather than recovery.
- Restore reuses `projectQueryReadyLineage`, so it shares the fixed producer
  run-record recovery and stale `query_ready` rejection behavior, but restore
  does not yet have a dedicated stale-query-ready regression test.

Verification

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts`
  passed: 49 tests.
- `npm run test:types` passed.
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/integrations/contracts.test.ts`
  passed: 70 tests.
- `git diff --check` passed.
- Manual temporary reproduction confirmed the previous high finding is closed:
  before changing `query_ready` fingerprint, `loadGraphQueryCapabilities()`
  returned one capability; after changing only `query_ready` from
  `fp-query-old` to `fp-query-new`, `getResumePlan()` reported
  `nextStage: "query_ready"` and `canQuery: false`, and
  `loadGraphQueryCapabilities()` returned zero capabilities.
