Result: FAIL

## Findings

### High: Public settings writers can overwrite user-owned settings

File/Line: `src/graphrag/settings-projection.ts:230`,
`src/graphrag/settings-projection.ts:241`

Reason: `writeManagedGraphRagSettings` and
`writeManagedGraphRagSettingsSync` always build the projection and rename it
over `graph_vault/settings.yaml`. They do not first read an existing
`settings.yaml` and reject files that lack `qmd_graphrag.managed_by:
qmd_graphrag`. The resume repair path uses
`ensureManagedGraphRagSettings` and correctly rejects unmarked files, but the
public writer path remains an overwrite path for user-owned settings.

Fix: Share the same managed-marker guard across all writer paths. Allow
creation when the file is absent, allow rewrite only when the existing file has
the managed marker, and require an explicit separate force path if a caller
must replace a user file. Add regression coverage for both async and sync
writers against an existing unmarked `settings.yaml`.

### High: Projection rejection observability is incomplete

File/Line: `scripts/graphrag/batch-epub-workflow.mjs:739`,
`scripts/graphrag/batch-epub-workflow.mjs:4524`,
`scripts/graphrag/batch-epub-workflow.mjs:4586`

Reason: `rejectedSettingsProjectionMetadata` only matches error text that
contains `managed projection` and always reports `rejected_user_owned`. The
schema has `rejected_invalid_source`, but no runtime path sets it. If
`.qmd/index.yml` is invalid before projection can be built, the batch summary
does not receive a settings projection decision. In addition, the final
`item_failed` event for non-provider failures omits the projection metadata, so
events do not consistently expose projection decision, rewrite flag, locators,
or reason.

Fix: Classify invalid source config separately and emit
`settingsProjectionDecision: rejected_invalid_source`. Persist the same
projection metadata to the failed checkpoint, recovery summary, and
`item_failed` event. Include the active command and command check name in the
same event metadata so event and summary projections carry the same facts.

### Medium: Regression tests do not fully pin the real settings failure surface

File/Line: `test/graphrag-book-state.test.ts:1842`,
`test/graphrag-book-state.test.ts:1960`,
`test/integrations/contracts.test.ts:1672`

Reason: Tests cover managed drift rewrite, body mutation rewrite, idempotency,
and unmarked rejection through `syncGraphRagBookWorkspace`. They do not cover
the public writer overwrite path, invalid `.qmd/index.yml` rejection,
`rejected_invalid_source`, or event-level projection metadata. The only test
assertion for the real failure text is a broad substring match on
`managed projection`, while docs contain the full string.

Fix: Add focused tests for the exact failure
`graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`,
including writer fail-closed behavior, invalid source config rejection,
event/summary projection metadata, and the no-GraphRAG-default-loaded-config
comparison invariant.

## Criteria Review

1. PASS: Runtime resume paths load project config from `.qmd/index.yml` and
   pass that config into managed projection repair.
2. FAIL: The resume repair path is marker-gated, but public settings writer
   functions can overwrite existing unmarked settings.
3. PASS: Projection comparison uses the qmd projection object and deterministic
   hashes, not GraphRAG default-loaded config.
4. PASS: Managed drift is rewritten through temp-file plus rename after source
   config projection succeeds.
5. FAIL: `ensureManagedGraphRagSettings` rejects unmarked files, but the public
   writer functions still provide an unguarded overwrite path.
6. PASS: Repeated resume after repair returns `already_valid` with the same
   source fingerprint.
7. PASS: The repair implementation only writes `settings.yaml`; focused tests
   verified unrelated book output preservation.
8. FAIL: Recovery summary coverage exists for successful rewrite, but rejection
   and invalid-source paths do not consistently expose projection decisions in
   both events and summaries.
9. PASS: Runner interruption recovery preserves typed checkpoints and supports
   same-run-id retry through heartbeat ownership and orphan recovery.
10. FAIL: Docs cover the real failure string, but tests do not fully cover the
   exact failure surface, invalid source rejection, public writer fail-closed
   behavior, or event-level metadata.

## Evidence

- `src/graphrag/settings-projection.ts:319` implements
  `ensureManagedGraphRagSettings`, including marker-gated rewrite,
  `already_valid`, and unmarked rejection.
- `src/graphrag/settings-projection.ts:256` and
  `src/graphrag/settings-projection.ts:265` use temp-file plus rename for
  atomic managed writes.
- `src/job-state/graphrag-book.ts:1558` repairs settings before
  `parseSettingsFingerprint`, so stage fingerprints use the repaired
  `.qmd/index.yml` projection.
- `scripts/graphrag/resume-book-workspace.mjs:875` loads `configPath`, whose
  default is `.qmd/index.yml`, before syncing the current book.
- `src/contracts/batch-run.ts:256` defines typed projection decision fields for
  recovery summary items.
- Verified tests passed:
  `test/graphrag-book-state.test.ts` focused settings projection subset
  covering drift rewrite, body mutation rewrite, and unmarked rejection.
- Verified tests passed:
  `test/integrations/contracts.test.ts` focused batch envelope schema subset
  covering `settingsProjectionDecision`, rewrite flag, fingerprint, locators,
  reason, and `activeCommand`.
- Verified tests passed:
  `test/cli.test.ts` focused runner interruption subset covering heartbeat,
  orphaned running recovery, fresh remote non-steal, stale remote projection,
  and normal-run stale recovery.
- Design docs cover the required failure and policy in
  `docs/architecture/unified-retrieval-plane.md:748`,
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:1666`, and
  `docs/operations/graphrag-epub-batch-runbook.md:100`.

## Residual Risks

- The code preserves output files during settings repair, but tests do not yet
  exercise a full existing `graph_extract` / `community_report` / `embed`
  lineage across a settings repair.
- Projection metadata currently stores absolute paths in some checkpoint paths;
  this is usable locally but weaker than project-relative portable locators.
- Invalid source config behavior depends on child-process stderr classification
  unless an explicit typed rejection path is added.
