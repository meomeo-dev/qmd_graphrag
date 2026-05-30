# Agent B Implementation Audit Criteria

1. The implementation must follow the patched Type DD
   `auxiliarySidecarMappingRule` and `jsonl_read_reconcile_replace` policy.
2. No explicit targetMapping row may be added for `.tmp-*`, `.owner.json`,
   `.lock`, `.sha256`, `.sha256.meta.json` or `.corrupt-*` auxiliary paths.
3. Auxiliary path evidence must include a primary target locator when a
   visible failing target is auxiliary.
4. Normalization must strip only fixed durable engine suffix forms, not broad
   arbitrary `.owner.json` or catalog fallback patterns.
5. `cost-accounting.jsonl` must not implicitly gain checksum sidecars in this
   patch.
6. Runner adapter parity must be tested against shared durable store
   normalization.
7. Package distribution must include any new runtime `.mjs` helper imported by
   `batch-epub-workflow.mjs`.
8. New behavior must be placed in small files rather than expanding already
   oversized runner or durable-store files with substantial logic.
9. Failure classification for unknown production targets must remain
   `durable_target_mapping_missing`.
10. Audit reports must cite concrete files and tests and return PASS only when
    all fixed criteria are satisfied.
