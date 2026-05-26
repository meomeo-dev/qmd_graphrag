Verdict: fail

Findings

- High - Stale `query_ready` checkpoints can still publish graph query
  capabilities after the query-ready fingerprint changes. The recovered lineage
  projection rebuilds run-record candidates with the current book
  `stageFingerprints` at `src/graphrag/capability-catalog.ts:150`, then
  `selectQueryReadyCheckpoint` accepts a historical `query_ready` run if the
  current community_report and embed artifacts validate at
  `src/graphrag/capability-catalog.ts:266`. This skips the stale-check that
  `getResumePlan()` applies to the checkpoint `inputFingerprint` and
  `actualFingerprint` at `src/job-state/repository.ts:802`. I reproduced the
  mismatch with a temporary vault: after a successful `query_ready` run, only
  `book.stageFingerprints.query_ready` was changed from `fp-query-old` to
  `fp-query-new`; `getResumePlan()` returned `nextStage: "query_ready"` and
  `canQuery: false`, while `loadGraphQueryCapabilities()` still returned one
  ready graph query capability. This violates criteria 2 and 9 because
  query-ready readiness is no longer aligned with the true next stage or the
  query-ready stage fingerprint evidence.

Criteria Coverage

1. Pass. A refreshed artifact id for the same physical high-cost producer
   artifact no longer forces rerun: resume planning and query-ready lineage
   projection rebind current producer artifacts by stage and `producerRunId`.
2. Fail. Producer stages are still validated by producer lineage, required
   kind, stage fingerprint, provider fingerprint, corpus content hash, book
   scope, and file integrity. However, `query_ready` itself can be projected
   from a stale historical run record after the query-ready fingerprint changes.
3. Pass. Stale checkpoint artifact ids are treated as references only; current
   artifacts for the same producer stage and run id are selected and validated.
4. Pass. The prior high-severity issue is closed. `projectQueryReadyLineage`
   now reads current checkpoints plus run records, so a newer running producer
   checkpoint no longer hides an older usable succeeded producer run.
5. Pass. Query-ready projection still requires graph_extract,
   community_report, and embed producer run ids and validated artifacts before a
   capability is published or restored.
6. Pass. Query-ready capability publishing and loading now use validated
   current producer lineage artifact ids rather than stale checkpoint artifact
   ids; the recovered capability regression verifies this for graph_extract.
7. Pass. Partial or invalid producer/query artifacts continue to fail closed
   through `validateBookArtifactSet`, including missing, wrong-kind,
   wrong-scope, wrong-hash, wrong-fingerprint, wrong-provider,
   wrong-corpus-content, and wrong-producer evidence.
8. Pass. Book isolation remains enforced by `bookId`, book-scoped output path,
   producer run id, corpus content hash, stage fingerprint, provider
   fingerprint, and file-integrity validation.
9. Fail. Resume plans report stale `query_ready` and `canQuery: false`, but
   capability loading can still expose a ready graph query capability for that
   stale query-ready state.
10. Pass. The implementation remains scoped to stage lineage recovery,
    capability lineage projection, vault restore projection, and focused tests;
    unrelated qmd search, GraphRAG query routing, CLI output, and rendering
    behavior were not rewritten.

Residual Risks

- The prior checkpoint-only producer lineage bug is closed for capability
  loading and restore, but the new shared projection still duplicates
  repository resume semantics instead of calling one canonical effective-state
  implementation. The stale `query_ready` mismatch is a concrete drift example.
- Regression coverage is strongest for the graph_extract refreshed-artifact-id
  path. Equivalent explicit recovered-id tests for community_report and embed
  would reduce future drift risk, although both now use the same projection
  code.
- Restore now reuses `projectQueryReadyLineage`, so it inherits both the fixed
  producer run-record recovery and the remaining stale `query_ready` projection
  risk.

Verification

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts`
  passed: 48 tests.
- `npm run test:types` passed.
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/integrations/contracts.test.ts`
  passed: 70 tests.
- Manual temporary reproduction confirmed the previous high finding is closed:
  after `query_ready` completed, starting a newer running graph_extract run left
  `loadGraphQueryCapabilities()` at one capability.
- Manual temporary reproduction found the new stale `query_ready` mismatch:
  changing only `book.stageFingerprints.query_ready` made `getResumePlan()`
  report `nextStage: "query_ready"` and `canQuery: false`, while
  `loadGraphQueryCapabilities()` still returned one capability.
