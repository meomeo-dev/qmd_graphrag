# Agent 1 Fresh-Vault Implementation Audit Report

## Scope

Audit role: `agent-1-fresh-vault`.

Scenario: a user copies only `graph_vault/books/{bookId}` into a fresh
`graph_vault`, then mount scan / catalog rebuild / query gate must establish
GraphRAG query capability using only `BOOK_MANIFEST.json`,
`PUBLISH_READY.json`, package-local `state/*`, package-local
`graphrag/output/*`, and package-local `graphrag/runs/*`.

Fixed baseline:
`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r2__open/agent-1-fresh-vault/baseline.yaml`.

Baseline dimensions and pass criteria were read only. They were not modified.

## Verification Commands

- `npm exec -- tsc -p tsconfig.build.json --noEmit`
  - Result: pass.
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000`
  - Result: pass, 1/1.
- `npx vitest run test/unified-query.test.ts -t "rejects graph capabilities" --testTimeout 120000`
  - Result: pass, 3/3 selected tests.
- `npx vitest run test/cli-graphrag-route.test.ts test/unified-query.test.ts test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000`
  - Result in this audit run: timeout at 180 seconds. Before timeout,
    `test/cli-graphrag-route.test.ts` had 8 passed and 1 test-level timeout
    in the non-JSON formatting case.
  - Known validation supplied for this audit: same focused command previously
    passed 46/46.
- Real package validation command over `graph_vault/books`.
  - Result in this audit run: 38 packages with manifests, 8 valid, 30 invalid.
    All 30 invalid packages reported `artifact_metadata_missing`.
- Fresh-vault copy smoke command using one valid package and
  `rebuildCatalogFromBookHotplugPackages`.
  - Result: `bookCount=1`, `identityCount=1`, `capabilityCount=1`.

## Baseline Results

### direct_query_entrypoint: pass

Evidence:

- `src/graphrag/book-hotplug-catalog.ts` loads candidate books from
  `books/*/BOOK_MANIFEST.json` and requires `PUBLISH_READY.json` before
  projection.
- `rebuildCatalogFromBookHotplugPackages` writes fresh
  `catalog/books.yaml`, `catalog/sources.yaml`,
  `catalog/document-identity-map.yaml`, and `catalog/graph-capabilities.yaml`
  from package-local data.
- `src/graphrag/capability-catalog.ts` calls
  `ensureCatalogProjectionFromBookHotplugPackages` before capability loading.
- `src/cli/qmd.ts` resolves query `dataDir` through
  `resolveBookGraphRagDataDir`, and CLI tests assert the bridge receives
  `books/{bookId}/graphrag/output`.
- Fresh-vault smoke result for copied package:
  `bookCount=1`, `identityCount=1`, `capabilityCount=1`.

The query path still builds derived catalog files, but those files are
rebuildable projections rather than package authority. This satisfies the
fresh-vault entrypoint baseline.

### artifact_minimum_closure: partial

Evidence:

- The design lists the GraphRAG query artifact closure, including
  `qmd_output_manifest.json`, `qmd_graph_text_unit_identity.json`,
  `artifact-metadata.json`, JSON support files, parquet files, and LanceDB.
- `scripts/graphrag/book-hotplug-package.mjs` now includes
  `graphrag/output/artifact-metadata.json` in `RequiredGraphRagArtifacts`.
- `buildFileEntries` records package-relative path, role, bytes, sha256,
  required flag, sensitivity, and producer run id for files and directories.
- `validateBookHotplugPackage` validates manifest sidecars, file bytes,
  file sha256, required files, forbidden material, and artifact metadata.
- Real validation found only 8/38 current packages valid; 30 packages are
  missing `artifact-metadata.json`.

The implementation defines and validates the closure for newly generated or
already repaired packages, but current package state is not uniformly closed.
Until all real packages are repacked or backfilled with artifact metadata, this
dimension is not a full pass.

### artifact_gate_state_machine: partial

Evidence:

- Design documents define copied/candidate/validated/mounted/query-ready and
  quarantine/visible-not-query-ready behavior.
- `validateBookHotplugPackage` fails closed on missing manifest sidecar,
  publish marker, checksum mismatch, path escape, forbidden sensitive material,
  missing required files, and artifact metadata diagnostics.
- `mountScanBookPackages` separates `mounted` and `failed` candidates.
- `book-hotplug-catalog.ts` only projects graph capabilities when producer
  evidence is readable and `projectQueryReadyLineage` succeeds.
- `test/cli-graphrag-route.test.ts` verifies missing stats artifact prevents
  auto GraphRAG upgrade.

Limit:

- The implemented scanner records `failed` diagnostics but does not yet show a
  full persisted quarantine lifecycle or last-good rollback transaction for
  fresh-vault mount scan.

The query gate behavior is implemented, but the full state machine persistence
is incomplete.

### producer_lineage_completeness: partial

Evidence:

- `book-hotplug-catalog.ts` requires all `manifest.graphrag.producerRunIds` to
  exist in package-local `graphrag/runs/*.yaml`; unreadable run evidence blocks
  capability projection.
- `capability-catalog.ts` reconstructs lineage from package-local
  `state/checkpoints.yaml`, `state/artifacts.yaml`, and `graphrag/runs`.
- `projectQueryReadyLineage` requires successful producer checkpoints for
  `graph_extract`, `community_report`, and `embed`, plus a query-ready
  checkpoint, then validates producer run ids, stage fingerprints, provider
  fingerprint, and corpus content hash.
- `book-hotplug-artifact-metadata.mjs` records per-artifact producer id,
  fingerprint, corpus content hash, file sha, bytes, and createdAt.

Limit:

- The metadata helper does not yet prove every baseline field in one schema:
  tool version, input hash, schema version, and upstream artifact hash are only
  partly represented through run records, fingerprints, and manifests.
- Current real packages are not uniformly backfilled with artifact metadata.

This meets the runtime fail-closed intent but remains incomplete against the
full producer lineage completeness requirement.

### lineage_artifact_binding: partial

Evidence:

- `manifest.graphrag.producerRunIds` is cross-checked against
  package-local `graphrag/runs/*.yaml` before graph capability projection.
- `artifact-metadata.json` rows bind artifact id, package path, file sha,
  bytes, producer run id, stage fingerprint, provider fingerprint, corpus
  content hash, and closure digest.
- `validateArtifactMetadata` checks required artifact rows, producer presence,
  file sha, bytes, run binding, and closure digest.
- `validateBookArtifactSet` rejects mismatched producer run id, stage
  fingerprint, provider fingerprint, corpus content hash, hash mismatch, path
  escape, and sibling/vault escape.

Limit:

- 30/38 existing packages still lack `artifact-metadata.json`, so binding is
  not established for all current package outputs.
- `book-hotplug-catalog.ts` can still project a capability from
  `state/artifacts.yaml` and run evidence even when package-level
  `artifact-metadata.json` validation has not been run in the catalog path.

The binding design is now implemented in package validation, but fresh catalog
projection does not yet require the full package validator, and real packages
are not fully migrated.

### schema_runtime_compatibility: partial

Evidence:

- Design distinguishes package schema, layout version, qmd index schema,
  GraphRAG artifact schema, producer lineage schema, and compatibility failure
  outcomes.
- `BOOK_MANIFEST.json` includes `layoutVersion`, package version,
  `qmdIndexSchema`, `graphRagArtifactSchema`, and `artifactSchema`.
- `capability-catalog.ts` validates parquet magic/footer/row count,
  JSON artifact shape, LanceDB table presence, positive Lance row count, and
  artifact hashes.
- `resolveBookGraphRagDataDir` resolves `BOOK_MANIFEST.graphrag.outputManifestPath`
  to package-local `graphrag/output`.

Limit:

- Runtime compatibility gate does not yet fully enforce GraphRAG runtime
  version, embedding model/dimension, LanceDB schema version, output manifest
  schema compatibility, or package layout compatibility before query-ready
  projection.

The important artifact-level checks exist, but schema/runtime compatibility is
not fully implemented.

### query_scope_isolation: pass

Evidence:

- Fresh catalog rebuild scans only `graph_vault/books/*` and package-local
  manifest/publish marker.
- Graph identity and output manifest reads use
  `books/{bookId}/graphrag/output`.
- Producer evidence reads use `books/{bookId}/graphrag/runs`.
- State reads use `books/{bookId}/state/{artifacts,checkpoints,job}.yaml`,
  with legacy fallback only for migration compatibility.
- `validateBookArtifactSet` requires `artifact.bookId === input.bookId`,
  `requireBookScopedGraphOutput`, and realpath confinement inside the vault.
- CLI selected-book tests assert only the selected book's
  `graphrag/output` is passed to the bridge.
- `test/unified-query.test.ts -t "rejects graph capabilities"` passes the
  outside-vault artifact path rejection test.

The fresh-vault query scope is isolated to the selected package and its
validated projections.

### privacy_payload_exclusion: pass

Evidence:

- Design forbids provider payload, raw prompt/completion, secrets, logs, and
  absolute local paths in distributable package material.
- `scripts/graphrag/book-hotplug-package.mjs` excludes `.env`,
  `provider-requests`, `provider-responses`, logs, debug/trace files, durable
  recovery payloads, corrupt files, and `.DS_Store`.
- `validateBookHotplugPackage` rejects forbidden sensitive material inside
  manifest file entries.
- `book-hotplug-artifact-metadata.mjs` uses metadata, hashes, fingerprints,
  run ids, and package-relative paths. It does not read provider payload roots.
- Capability metadata is sanitized by `sanitizeVaultMetadata`.

No implementation evidence showed fresh-vault artifact gate requiring provider
request/response payloads, secrets, logs payloads, or recovery payloads.

### recovery_diagnostics: partial

Evidence:

- `validateBookHotplugPackage` emits stable diagnostics such as
  `missing_manifest`, `missing_publish_marker`, `manifest_sha256_mismatch`,
  `path_escape`, `forbidden_sensitive_material`, `missing_required_file:*`,
  `artifact_metadata_missing`, and artifact metadata mismatch codes.
- `validateBookArtifactSet` reports invalid artifact reasons such as
  `path_outside_graph_vault`, `realpath_outside_graph_vault`,
  `content_hash_mismatch`, `producer_run_id_mismatch`,
  `stage_fingerprint_mismatch`, `provider_fingerprint_mismatch`, and
  `corpus_content_hash_mismatch`.
- Catalog projection fails closed by not creating graph capability when
  producer evidence is unreadable or lineage projection is null.
- `mountScanBookPackages` returns `failed` candidates with diagnostics.

Limit:

- A persisted quarantine record, repair entrypoint, and last-good catalog
  projection rollback contract are defined in design but not fully wired into
  the fresh-vault implementation path.

Diagnostics are strong enough for query gate failures, but operational recovery
is not yet complete.

### executable_contract_tests: partial

Evidence:

- `test/graphrag-book-hotplug-catalog.test.ts` verifies catalog projection from
  a `BOOK_MANIFEST` package.
- `test/cli-graphrag-route.test.ts` verifies GraphRAG CLI routing, selected
  book dataDir, fresh settings projection recreation, missing stats artifact
  downgrade, and multi-book ambiguity handling.
- `test/unified-query.test.ts` includes negative tests for producer stage
  rewrites, missing required artifact kind, and outside-vault artifact path.
- Current audit reran:
  - hotplug catalog test: pass 1/1.
  - selected reject graph capability tests: pass 3/3.

Limit:

- This audit did not find dedicated tests for all fresh-vault contract
  failures: missing `PUBLISH_READY`, missing manifest sidecar, artifact
  metadata missing/mismatch, schema/runtime incompatibility, missing producer
  run evidence, and explicit provider payload no-read.
- Full focused suite timed out in this environment, although known prior
  validation reports 46/46 passing.

Executable coverage exists for the core route and several fail-closed cases,
but it is not complete against the fixed baseline.

## Overall Result

overall_result: partial

The implementation now satisfies the central fresh-vault behavior: a copied
single-book package can rebuild catalog projection and produce one graph query
capability using package-local manifest, state, output, and run evidence. The
CLI query path resolves the selected book to `graphrag/output`, and the query
gate validates artifact hashes, producer ids, fingerprints, corpus hashes, and
scope boundaries.

It is not a full pass because the current real package set is not uniformly
closed under the final artifact metadata contract: this audit found 30/38
manifest packages failing validation with `artifact_metadata_missing`. In
addition, schema/runtime compatibility, persisted quarantine/recovery, and
complete executable contract tests remain partial.

## Recommended Next Actions

1. Backfill or repack all 38 current packages so every query-ready package has
   `graphrag/output/artifact-metadata.json` and passes
   `validateBookHotplugPackage`.
2. Make fresh catalog projection require full package validation, not only
   `BOOK_MANIFEST.json` and `PUBLISH_READY.json`, before creating graph
   capability.
3. Add focused tests for missing publish marker, missing manifest sidecar,
   artifact metadata missing/mismatch, missing producer run evidence,
   schema/runtime incompatibility, and provider payload no-read.
4. Implement persisted quarantine and last-good projection rollback for
   mount-scan failures.
5. Extend runtime compatibility checks to include GraphRAG runtime version,
   embedding model/dimension, LanceDB schema, output manifest schema, and
   package layout version.
