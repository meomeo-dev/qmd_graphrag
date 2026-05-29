# Implementation Audit R3 - Agent B

Verdict: PASS

Baseline:
`audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/agent-b/implementation-criteria-r3.md`

Criteria SHA-256:
`a386b285d50e135e69b743c8e098c0f143637111b35270a7bd78e67cdea9013b`

## Findings

No blocking findings remain under the fixed R3 criteria.

## Criteria Review

1. PASS - `graph_vault/catalog/books.yaml` checksum meta backfill parent
   directory fsync maps to `graph_vault/catalog`. Runner primary mapping covers
   `books.yaml` and its preflight scope
   (`scripts/graphrag/batch-epub-workflow.mjs:251`), while the directory scope
   table maps `graph_vault/catalog` to `catalogWriterLane` and `repository`
   (`scripts/graphrag/batch-epub-workflow.mjs:482`). Production directory
   misses fail closed with `durable_target_mapping_missing`
   (`scripts/graphrag/batch-epub-workflow.mjs:2848`).

2. PASS - Derived parent directory fsync preserves the primary or sidecar
   operation closure. Runner directory evidence preserves or derives
   `primaryTargetLocator`, `sidecarTargetLocator`, `sidecarKind`, lane, owner,
   and `primaryDurableKind`
   (`scripts/graphrag/batch-epub-workflow.mjs:3412`). Shared durable store
   mirrors this closure for strict directory fsync
   (`src/job-state/durable-state-store.ts:1743`).

3. PASS - Checksum sidecar and checksum meta sidecar evidence are distinct.
   Runner writes `sidecarKind: "checksum"` and `sidecarKind: "checksum_meta"`
   through separate evidence builders
   (`scripts/graphrag/batch-epub-workflow.mjs:4697`,
   `scripts/graphrag/batch-epub-workflow.mjs:4711`). Shared durable store
   distinguishes the same sidecar kinds
   (`src/job-state/durable-state-store.ts:2036`).

4. PASS - Bare directory fsync uses explicit directory scope and production
   misses fail closed. Runner routes `directory-fsync` through
   `durableDirectoryFsyncMapping`
   (`scripts/graphrag/batch-epub-workflow.mjs:2807`), which consults only the
   directory scope table and throws `durable_target_mapping_missing` for
   unmapped production directories
   (`scripts/graphrag/batch-epub-workflow.mjs:2848`).

5. PASS - Directory fsync failure evidence includes required closure fields.
   Runner failure evidence includes `directoryTargetLocator`,
   `directoryDurableKind`, `fsyncTarget`, `fsyncPlatform`, `fsyncErrno`,
   `completedPublishRule`, lane, and owner
   (`scripts/graphrag/batch-epub-workflow.mjs:3450`). Shared durable store and
   qmd index directory fsync evidence preserve the same strict failure boundary
   (`src/job-state/durable-state-store.ts:1637`,
   `src/job-state/graphrag-book.ts:1712`).

6. PASS - Sentinel `fsyncErrno` values retain unavailable field markers.
   Runner marks sentinel errno values with
   `unavailableFieldSentinels: ["fsyncErrno"]`
   (`scripts/graphrag/batch-epub-workflow.mjs:3444`,
   `scripts/graphrag/batch-epub-workflow.mjs:3468`). Read-only diagnostics
   also use `not_attempted_read_only` with the same marker
   (`scripts/graphrag/batch-epub-workflow.mjs:4860`).

7. PASS - `--status-json` remains read-only. Runner `fsyncDirectory` returns
   immediately in status-json mode
   (`scripts/graphrag/batch-epub-workflow.mjs:3450`), and read-only durable
   inspection only projects diagnostics from existing target/checksum/meta
   files (`scripts/graphrag/batch-epub-workflow.mjs:4860`). Regression coverage
   confirms missing checksum meta does not mutate state
   (`test/graphrag-runner-status-json-readonly.test.ts:251`).

8. PASS - Read-only durable diagnostics use the same directory fsync rule.
   `inspectDurableSerializedTargetReadOnly` resolves primary and parent
   directory mapping, projects directory locator/kind, primary kind, lane,
   owner, repair gate, fsync sentinel, and unavailable marker
   (`scripts/graphrag/batch-epub-workflow.mjs:4860`).

9. PASS - Contract schemas and runner schemas accept directory fsync closure
   fields. `src/contracts/batch-run.ts` covers status-json diagnostics,
   command checks, checkpoints, manifest durable summaries, events, and
   recovery summary items (`src/contracts/batch-run.ts:45`,
   `src/contracts/batch-run.ts:186`, `src/contracts/batch-run.ts:286`,
   `src/contracts/batch-run.ts:422`, `src/contracts/batch-run.ts:474`,
   `src/contracts/batch-run.ts:527`). Runner internal schemas retain the same
   diagnostic field family
   (`scripts/graphrag/batch-epub-workflow.mjs:722`,
   `scripts/graphrag/batch-epub-workflow.mjs:1207`).

10. PASS - Regression coverage includes catalog parent fsync, read-only
    projection, checksum sidecar evidence, non-catalog directory scope, shared
    durable store parity, qmd index lock release, and contract closure
    (`test/graphrag-runner-status-json-readonly.test.ts:251`,
    `test/graphrag-runner-status-json-readonly.test.ts:376`,
    `test/graphrag-runner-status-json-readonly.test.ts:442`,
    `test/book-job-state.test.ts:623`, `test/book-job-state.test.ts:678`,
    `test/cli.test.ts:2823`, `test/cli.test.ts:3296`,
    `test/cli.test.ts:3627`, `test/integrations/contracts.test.ts:1771`,
    `test/integrations/contracts.test.ts:1812`).

## Focused Fix Confirmation

- `context.json` and `stats.json` target mappings are synchronized across Type
  DD, runner, and shared durable store
  (`docs/architecture/graphrag-parallel-runner.type-dd.yaml:514`,
  `scripts/graphrag/batch-epub-workflow.mjs:432`,
  `src/job-state/durable-state-store.ts:207`).
- `durableLocator` no longer projects out-of-root `..` paths as
  `graph_vault/..`; it checks state-root containment before returning
  `graph_vault/*`, then checks qmd-root containment before returning `.qmd/*`
  (`scripts/graphrag/batch-epub-workflow.mjs:2667`).
- Runner qmd index lock release and stale cleanup pass the owner operation into
  strict directory fsync (`scripts/graphrag/batch-epub-workflow.mjs:3895`,
  `scripts/graphrag/batch-epub-workflow.mjs:3931`). The shared durable store
  release path does the same for durable file locks
  (`src/job-state/durable-state-store.ts:905`).

## Verification

- `shasum -a 256
  audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/agent-b/implementation-criteria-r3.md`:
  PASS.
- `git diff --
  audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/agent-b/implementation-criteria-r3.md`:
  PASS, no diff.
- `node --check scripts/graphrag/batch-epub-workflow.mjs`: PASS.
- YAML parse of
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`: PASS.
- `npm run test:types -- --pretty false`: PASS.
- `npx vitest run test/book-job-state.test.ts -t
  "shared durable publish reports checksum sidecar directory fsync evidence|qmd index lock release reports directory fsync evidence"
  --reporter=verbose --testTimeout=120000`: PASS, 2 passed.
- `npx vitest run test/graphrag-runner-status-json-readonly.test.ts
  --reporter=verbose --testTimeout=150000`: PASS, 7 passed.
- `npx vitest run test/graphrag-runner-durable-preflight.test.ts
  --reporter=verbose --testTimeout=120000`: PASS, 1 passed.
- `npx vitest run test/integrations/contracts.test.ts -t
  "batch execution bus envelopes|durable schema closure" --reporter=verbose`:
  PASS, 2 passed.
- `npx vitest run test/cli.test.ts -t
  "directory fsync failure blocks completed publication with evidence|durable state classifier preserves local failure classes|durable reconcile commits matching pending checksum metadata|durable preflight blocks partial checksum sidecar crash window|runner-start preflight blocks book YAML temp from target mapping|all batch qmd commands acquire the qmd index file lock"
  --reporter=verbose --testTimeout=180000`: PASS, 6 passed.
- `npx vitest run test/cli.test.ts -t
  "before-claim preflight blocks nested book output durable sidecar temp"
  --reporter=verbose --testTimeout=120000`: PASS, 1 passed.

Criteria file was not modified. No `.env`, secret, or credential file was read.
