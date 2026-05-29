Verdict: fail

Findings

- High - Capability and restore lineage readers still let a newer running or
  failed producer checkpoint hide an older usable succeeded producer run.
  `src/graphrag/capability-catalog.ts:196` and
  `src/graphrag/capability-catalog.ts:324` build producer state only from
  `checkpoints.yaml` entries whose current status is `succeeded`. If
  `graph_extract` later starts `run-graph-extract-2`, `writeStageCheckpoint`
  replaces the stage checkpoint, so the older successful
  `run-graph-extract-1` remains available only in run records. Repository resume
  planning correctly recovers that older success through
  `buildEffectiveResumeState`, but `loadGraphQueryCapabilities()` drops the
  already published query-ready capability because the capability loader never
  reads those run records. The same checkpoint-only pattern exists in restore at
  `src/vault/restore.ts:390` and `src/vault/restore.ts:448`. I reproduced this:
  before starting a newer `graph_extract` run, `loadGraphQueryCapabilities()`
  returned one capability; after `repo.startStage({ stage: "graph_extract",
  runId: "run-graph-extract-2" })`, it returned zero while
  `repo.getResumePlan()` still reported `graph_extract` ready on
  `run-graph-extract-1`. This violates criteria 4 and 9, and can make an
  existing query-ready capability disappear during an in-progress or failed
  rerun.

- Medium - The new regression test closes the stale artifact-id capability
  loading gap, but does not cover capability stability under newer non-succeeded
  producer checkpoints. `test/book-job-state.test.ts:2082` verifies that
  recovered current producer artifact ids are loaded and stale ids are excluded.
  There is still no test that completes `query_ready`, starts or fails a newer
  producer run, and asserts the previously validated capability remains
  loadable via the older succeeded run record.

Criteria Coverage

1. Partial. Resume planning no longer reruns a high-cost producer solely because
   refreshed artifact ids replaced stale checkpoint ids. Capability and restore
   readers can still lose the validated lineage after a newer non-succeeded
   checkpoint replaces the producer checkpoint entry.
2. Pass. Stage readiness validation continues to use `validateBookArtifactSet`
   with producer run id, required artifact kind, stage fingerprint, provider
   fingerprint, corpus content hash, book scope, and file integrity checks.
3. Pass. Repository resume and query-ready publishing paths treat producer
   checkpoint artifact ids as stale references and rebind current artifacts by
   stage and producer run. Capability and restore readers now also rebind
   artifacts by producer run id for the checkpoint they select.
4. Fail. Repository resume planning satisfies this criterion, but capability
   loading and restore do not: a newer running or failed producer checkpoint can
   hide the older succeeded run because those modules only use current
   succeeded checkpoint entries and ignore run records.
5. Pass. Query-ready readiness still requires `graph_extract`,
   `community_report`, and `embed` producer run ids and validated artifacts.
6. Pass. The previous high-severity stale lineage finding is closed for the
   tested path. `queryReadyLineageArtifactIds` publishes recovered current
   producer artifact ids, and `loadGraphQueryCapabilities()` now loads the
   recovered `graphrag_stats_json` id instead of the stale checkpoint id.
7. Partial. Invalid artifacts still fail closed through the shared validation
   path. The remaining issue is not acceptance of invalid artifacts, but loss of
   valid older lineage when a newer non-succeeded checkpoint shadows it outside
   repository resume planning.
8. Pass. The added producer-run rebinding filters by `artifact.bookId`, stage,
   producer run id, required kind, and then validates book-scoped GraphRAG
   output, so book isolation is not weakened.
9. Fail. Resume plans report the recovered true next stage, but capability and
   restore failures remain poorly observable: the loader silently filters out a
   previously valid capability when a newer running or failed checkpoint hides
   the producer run.
10. Pass. The implementation remains scoped to stage lineage, capability
    lineage projection, restore lineage projection, and focused tests; it does
    not rewrite unrelated qmd search, GraphRAG query, CLI output, or rendering
    behavior.

Residual Risks

- The fixed stale artifact-id path is covered for `graph_extract`; equivalent
  recovered-id coverage for `community_report` and `embed` would reduce
  regression risk because both are also query-ready producers.
- Capability catalog and vault restore now duplicate lineage-rebinding logic.
  Until they share the same effective producer selection semantics as
  `FileBookJobStateRepository`, drift between resume planning and capability
  projection remains likely.
- Restore-specific behavior was reviewed statically and by analogy with the
  capability loader; there is no focused restore regression covering recovered
  producer artifact ids or newer non-succeeded producer checkpoints.

Verification

- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts`
  passed: 48 tests.
- `npm run test:types` passed.
- Manual temporary reproduction confirmed the prior stale-id loading bug is
  closed for recovered `graphrag_stats_json`, and confirmed the remaining
  newer-running-checkpoint shadowing bug described above.
