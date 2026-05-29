# Development Reaudit Report

Verdict: fail

## Findings

- High - Recovered query-ready capability loading still fails when a newer
  non-succeeded producer checkpoint shadows the persisted checkpoint slot.
  `src/job-state/repository.ts:1792` resolves query-ready producer run ids from
  effective resume state, including older succeeded run records, so
  `completeStage({ stage: "query_ready" })` can succeed after a newer
  `graph_extract` run is merely `running`. However,
  `src/graphrag/capability-catalog.ts:196` builds `checkpointByStage` only from
  succeeded entries in `checkpoints.yaml`, and `src/graphrag/capability-catalog.ts:315`
  reconstructs lineage from the same current checkpoint file without run-record
  fallback. Because `writeStageCheckpoint` stores only one checkpoint per stage,
  a newer running or failed producer checkpoint removes the older succeeded
  producer from `checkpoints.yaml`; the loader cannot see the older validated
  run record that query-ready used. Reproduction with current source:
  complete `graph_extract` run 1, complete `community_report` and `embed`, start
  `graph_extract` run 2 without completing it, complete `query_ready`, then call
  `loadGraphQueryCapabilities()`. Result: query-ready completion succeeds and
  publishes a capability, but `loadGraphQueryCapabilities()` returns `[]`. This
  violates criteria 4, 6, and 9 because a non-succeeded newer producer attempt
  still hides an older usable success in the capability consumer path, making
  published recovered lineage unusable and observable only as a silently missing
  capability.

- High - Vault restore has the same stale checkpoint-slot gap for recovered
  query-ready lineage. `src/vault/restore.ts:390` builds `checkpointByStage`
  only from succeeded entries in `checkpoints.yaml`, and
  `src/vault/restore.ts:380` / `src/vault/restore.ts:425` do not reconstruct
  effective producer checkpoints from run records. In the same newer-running
  producer scenario, `projectValidatedCapabilityForRestore` can reject a
  capability that repository query-ready completion already validated and
  published, because restore reconstructs lineage from the current checkpoint
  file rather than the effective producer state. This violates criteria 4, 6,
  and 9 for vault restore and leaves the agent-c failure class only partially
  fixed.

- Medium - The new recovered capability loading regression covers stale
  artifact-id rebinding but not non-succeeded checkpoint shadowing in capability
  and restore readers. `test/book-job-state.test.ts:2082` refreshes
  `graph_extract` stats artifact ids while the `graph_extract` checkpoint
  remains succeeded, so `src/graphrag/capability-catalog.ts:196` can still find
  a succeeded current checkpoint. It does not cover the case already required
  by criterion 4: a newer running or failed checkpoint must not hide an older
  usable success in every query-ready lineage consumer. No restore regression
  test covers recovered lineage after checkpoint-slot shadowing.

## Criteria Coverage

1. Partial. Repository resume recovery handles refreshed artifact ids for
   succeeded high-cost producer stages through
   `src/job-state/repository.ts:2491`. Capability loading and restore now rebind
   producer artifacts by `producerRunId`, but only after they discover producer
   run ids from current succeeded checkpoints. They still fail when the usable
   producer run id exists only in run records because a newer non-succeeded
   checkpoint occupies the stage slot.
2. Pass. Selected artifact sets continue to route through
   `validateBookArtifactSet`, including required kind, producer run id, stage
   fingerprint, provider fingerprint, corpus content hash, book scope, and file
   integrity checks.
3. Partial. Checkpoint artifact ids are treated as stale references in the
   repository and in the new capability/restore artifact-id rebinding helpers.
   The treatment is incomplete for checkpoint selection because capability and
   restore readers do not use the same effective checkpoint recovery as the
   repository.
4. Fail. Repository resume and query-ready completion do not let a newer
   running checkpoint hide an older success, but capability loading and restore
   still do because they read only current succeeded checkpoints from
   `checkpoints.yaml` and ignore run records.
5. Pass. Query-ready completion still requires `graph_extract`,
   `community_report`, and `embed` producer run ids and validated artifacts via
   effective repository state.
6. Fail. Query-ready publishing can include validated recovered producer
   lineage ids, but `loadGraphCapabilities` and restore can reject or drop the
   same capability when producer checkpoint-slot shadowing exists.
7. Pass. Invalid and partial artifacts still fail closed through the strict
   artifact validator. The observed failure is not unsafe acceptance; it is a
   false negative in recovered lineage consumers.
8. Pass. Book isolation remains enforced by `artifact.bookId` filtering and
   book-scoped GraphRAG output validation in repository, capability, and restore
   paths.
9. Fail. Resume plans remain observable, but recovered capability-load and
   restore failures are not reported as true next-stage or invalid-evidence
   diagnostics to callers. `loadGraphQueryCapabilities()` silently returns no
   capability in the reproduced valid recovered state.
10. Partial. The implementation remains mostly scoped to lineage recovery, but
   the fix now touches `capability-catalog` and `vault restore` as expected.
   Those changes are still within the lineage recovery domain and do not rewrite
   qmd search, GraphRAG query ranking, CLI output, or rendering behavior.

## Residual Risks

- Recovery remains directly tested only for `graph_extract` stale-id refresh.
  Equivalent stale-id and checkpoint-shadowing cases for `community_report` and
  `embed` are not separately asserted, even though both are query-ready
  producers.
- `capability-catalog` and `vault restore` now duplicate parts of repository
  lineage logic. Divergence risk remains high unless they share the same
  effective producer checkpoint resolution, including run-record fallback and
  failed/running shadowing semantics.
- Explicit capability catalogs with old artifact ids may be rejected during
  restore even when book state can derive valid recovered lineage. The current
  merge path can derive capabilities from book state only when the loader can
  reconstruct lineage from current checkpoints.
- The reproduced failure was validated with a focused `tsx` script against
  current source, not added as a permanent test because this audit was
  explicitly no-code-change except the report.

## Verification

- Passed: `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/book-job-state.test.ts`
  with 48 tests passing.
- Passed: `npm run test:types`.
- Reproduced failure with current source using `./node_modules/.bin/tsx -`:
  after completing query-ready with an older usable `graph_extract` run hidden
  by a newer running `graph_extract` checkpoint, `loadGraphQueryCapabilities()`
  returned `capabilityCount: 0` while `checkpoints.yaml` contained
  `graph_extract` as `running` and `query_ready` as `succeeded`.
