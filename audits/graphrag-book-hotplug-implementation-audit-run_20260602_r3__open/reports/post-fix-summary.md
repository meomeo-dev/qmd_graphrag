# R3 Implementation Post-Fix Summary

## Scope

This report records implementation fixes after the first R3 audit results for
single-book hotplug packages. Fixed baselines were not changed.

## Fixed Issues

- Package validation now rejects undeclared forbidden material in the copied
  book directory, including provider payload, logs, debug traces, corrupt files,
  durable recovery journals, `.env`, and `.DS_Store`.
- Runtime GraphRAG query capability derivation now requires hotplug package
  query gate validation. A copied package that loses `graphrag/runs` evidence no
  longer produces query capabilities from stale state.
- Book creation uses a pre-live publish candidate validation before writing
  `BOOK_MANIFEST.json` and `PUBLISH_READY.json` to the live book root.
- Backfill uses the same pre-live publish candidate validation path as book
  creation.
- Backfill quarantines forbidden legacy residues outside `books/{bookId}` while
  preserving sha256, bytes, source locator, quarantine locator, and status.
- Migration evidence now includes `manifest-diff.yaml`, richer state detection,
  conflict records, quarantine results, and file-level copy-map entries.
- `state/hotplug-quality-gate.json` and its sidecars are excluded from the
  distributable manifest closure so local quality reports do not invalidate
  copied packages.

## Verification Snapshot

- `npm exec -- tsc -p tsconfig.build.json --noEmit`: passed.
- `npm run build`: passed.
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts
  --testTimeout 120000`: 7/7 passed.
- `npx vitest run test/unified-query.test.ts --testTimeout 120000`: 36/36
  passed.
- `npx vitest run test/integrations/python-bridge-early-stop.test.ts
  --testTimeout 120000`: 7/7 passed.
- `npx vitest run test/cli-graphrag-route.test.ts --testTimeout 120000
  --pool forks --poolOptions.forks.singleFork=true`: 9/9 passed.
- Focused suite
  `test/cli-graphrag-route.test.ts test/unified-query.test.ts
  test/graphrag-book-hotplug-catalog.test.ts`: 52/52 passed.
- Real backfill:
  `node scripts/graphrag/backfill-hotplug-packages.mjs --state-root graph_vault
  --force --rebuild-catalog --fail-fast`: 38 processed, 0 failed.

## Real Vault State

- `BOOK_MANIFEST.json` packages: 38.
- `validateBookHotplugPackage`: 38/38 passed.
- `state/hotplug-quality-gate.json`: 38/38 passed with
  `copyDistributionAllowed=true`.
- Manifest `graphrag.queryReady=true`: 30.
- Catalog projection:
  - `books.yaml`: 38.
  - `sources.yaml`: 38.
  - `document-identity-map.yaml`: 38.
  - `graph-capabilities.yaml`: 30.
- Forbidden copied-directory residue scan under `graph_vault/books`: 0.
- Latest migration evidence:
  `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602171023255/`.

## Retest Targets

Implementation re-audit should reuse the existing R3 fixed baselines and focus
on:

- Agent 1 fresh-vault single-book copy mount.
- Agent 2 batch backfill, migration cleanup, and quarantine evidence.
- Agent 3 runtime provider/query recovery.
