Result: FAIL

## Findings

### High: Rejection and repair observability is still incomplete

`scripts/graphrag/batch-epub-workflow.mjs:739` builds projection rejection
metadata from error text, but the returned object does not include
`settingsProjectionSourceFingerprint`. For a valid `.qmd/index.yml` with a
user-owned or unmarked `settings.yaml`, the source fingerprint is computable
before rejection, but it is lost when `ensureManagedGraphRagSettings` throws.

`scripts/graphrag/batch-epub-workflow.mjs:4659` emits the final `item_failed`
event with only `projectionRejectionMetadata` in metadata. It does not include
`activeCommand`, although the checkpoint sets `activeCommand` separately.

The persisted local-artifact-gate repair path also drops settings projection
metadata. `RepairMetadataSchema` at
`scripts/graphrag/batch-epub-workflow.mjs:147` does not define any
`settingsProjection*` fields. `parseRepairMetadata` at line 721 uses that schema,
and Zod object parsing strips unknown keys by default. As a result, the
`projectionMetadata` added at line 3624 is removed before the reopened checkpoint
and recovery summary are written at lines 3769-3771.

Impact: Criterion 8 remains failed for rejection and persisted
`stop_until_fixed` repair paths. Events and recovery summaries do not
consistently expose active command, projection decision, rewrite flag, source
fingerprint, locators, and reason.

### High: Invalid source config rejection is heuristic and incomplete

`settingsProjectionRejectionMetadataFromText` only classifies invalid source
config when the error text contains `responses api` or
`graphrag.concurrent_requests`. General `.qmd/index.yml` parse failures are
raised by `loadConfig` as `Failed to parse <configPath>: ...` in
`src/collections.ts:260-272`, and other future projection validation failures
would not become `settingsProjectionDecision: rejected_invalid_source`.

Impact: invalid `.qmd/index.yml` failures can still reach the runner as ordinary
command failures without typed projection decision, evidence locator, or
settings projection reason. Criteria 8 and 10 remain failed for invalid source
config.

### Medium: Regression tests still do not fully pin the required failure surface

`test/graphrag-book-state.test.ts:1992` covers the async
`writeManagedGraphRagSettings` fail-closed path, but there is no corresponding
test for `writeManagedGraphRagSettingsSync`.

`test/cli.test.ts:4477` covers the exact real failure text for a user-owned
rejection and checks decision, rewrite flag, locators, and reason. It does not
assert `settingsProjectionSourceFingerprint`, `activeCommand`, or
`rejected_invalid_source`. Repository search found no runtime test that exercises
invalid `.qmd/index.yml` rejection.

Impact: Criterion 10 remains failed. The previous public writer overwrite issue
is fixed in implementation, but the test suite does not yet pin all required
negative and observability cases.

## Criteria Review

1. PASS: Runtime resume loads the configured `.qmd/index.yml` through
   `setConfigSource({ configPath })` and passes the resulting project config to
   `syncGraphRagBookWorkspace`.
2. PASS: Public async and sync writer functions now delegate to
   `ensureManagedGraphRagSettings` / `ensureManagedGraphRagSettingsSync`, which
   reject existing unmarked files.
3. PASS: Projection comparison uses `buildGraphRagRuntimeSettingsProjection`
   and deterministic hashes of parsed managed settings versus projected
   settings. No GraphRAG default-loaded config comparison was found.
4. PASS: Drifted managed settings are rewritten through temp-file plus rename
   after the source projection is built successfully.
5. PASS: Existing user-owned or unmarked `settings.yaml` files fail closed in
   the direct sync path and public writer path; the reviewed implementation does
   not overwrite them.
6. PASS: Direct settings projection repair is idempotent. The direct test
   rewrites once and then observes `already_valid` with the same source
   fingerprint.
7. PASS: Settings repair only writes `settings.yaml` and its temp file. The
   direct regression test preserves an unrelated book-scoped output file.
8. FAIL: Rejection and persisted repair paths do not consistently expose
   `activeCommand`, source fingerprint, typed invalid-source decision, and
   settings projection fields in both events and recovery summaries.
9. PASS: Runner recovery continues to preserve typed batch state and
   same-run-id retry semantics through heartbeat, orphan, and provider recovery
   paths.
10. FAIL: Tests cover the exact user-owned real failure text, managed drift
    rewrite, and async writer fail-closed behavior, but do not cover sync writer
    fail-closed behavior, invalid source config rejection, `rejected_invalid_source`,
    or full event/summary observability fields.

## Evidence

- `src/graphrag/settings-projection.ts:230-245` makes both public writer
  functions use the guarded ensure functions.
- `src/graphrag/settings-projection.ts:315-359` and `362-402` implement async
  and sync create/rewrite/reject behavior with managed-marker checks.
- `src/graphrag/settings-projection.ts:288-301` compares parsed managed settings
  to the qmd projection using deterministic hashes.
- `src/job-state/graphrag-book.ts:1558-1564` repairs or validates the managed
  settings projection before parsing settings fingerprints.
- `scripts/graphrag/batch-epub-workflow.mjs:739-764` classifies rejection from
  text and omits `settingsProjectionSourceFingerprint`.
- `scripts/graphrag/batch-epub-workflow.mjs:147-160`, `3624-3641`, and
  `3769-3771` show settings projection metadata being added before a strict
  repair schema parse, then omitted from reopened checkpoint metadata.
- `scripts/graphrag/batch-epub-workflow.mjs:4659-4681` emits the final
  non-provider `item_failed` event without `activeCommand` in metadata.
- `test/graphrag-book-state.test.ts:1842-1910` covers direct drift rewrite,
  output preservation, and idempotent second sync.
- `test/graphrag-book-state.test.ts:1992-2004` covers async writer rejection of
  a user-owned settings file.
- `test/cli.test.ts:4477-4599` covers the exact real failure text
  `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`
  for user-owned rejection observability.
- `docs/architecture/unified-retrieval-plane.md:748-761`,
  `docs/architecture/unified-retrieval-plane.md:868-873`, and
  `docs/operations/graphrag-epub-batch-runbook.md:99-109` document the required
  settings projection repair, rejection, idempotency, and observability behavior.

## Residual Risks

- This re-audit is a static code and test review. Tests were not executed to
  avoid creating files outside the allowed report path.
- Recovery metadata still uses absolute locators in several paths; this is
  usable locally but weaker than project-relative portable evidence.
- The existing output-preservation test is focused. It does not exercise a full
  pre-existing `graph_extract` / `community_report` / `embed` lineage across a
  settings projection repair.
