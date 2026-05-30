# Agent C Implementation Audit Criteria

1. Implementation must be scoped to cost-accounting auxiliary durable mapping
   and required parity wiring.
2. `normalizeDurableTargetForMapping` must produce deterministic output for
   primary, temp, temp owner, checksum, checksum meta, lock and corrupt paths.
3. Temp owner sidecars must be classified as auxiliary evidence, not primary
   JSON durable targets.
4. Corrupt quarantine paths for `cost-accounting.jsonl` must inherit the
   primary mapping.
5. Unknown production JSONL auxiliary paths must still fail closed after
   normalization to their unknown primary.
6. Tests must verify no leftover `.tmp-*` or `.owner.json` files after a
   successful cost accounting append.
7. Existing GraphRAG provider cost accounting integration tests must continue
   to pass.
8. Existing durable runner preflight/state tests relevant to mapping and
   fsync evidence must continue to pass.
9. The Type DD patch, implementation, tests and package file list must be
   internally consistent.
10. No unrelated refactor, formatting churn or generated artifact mutation may
    be included as part of the fix.
