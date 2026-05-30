# Agent A Implementation Audit Criteria

1. Only the existing Type DD may define the design baseline; no new design
   baseline or audit directory may be introduced.
2. `cost-accounting.jsonl.tmp-*.owner.json` must normalize to
   `graph_vault/catalog/cost-accounting.jsonl`.
3. Auxiliary path normalization must remain strict and must not map unknown
   production JSONL targets to a non-production default.
4. Shared durable store and runner adapter must use equivalent normalization
   semantics for primary, temp, temp owner, checksum, checksum meta, lock and
   corrupt quarantine locators.
5. The opaque JSONL owner sidecar write must reuse the primary operation
   evidence and must not create an independent owner-sidecar operation.
6. `providerCostAccounting` must keep `eventWriterLane`, `durableKind: jsonl`
   and strict durable failure evidence.
7. The fix must not modify provider cost schema, accounting totals, provider
   auth, retry policy, EPUB scheduling or GraphRAG stage gates.
8. Tests must cover production `graph_vault/catalog/cost-accounting.jsonl`
   append without `durable_target_mapping_missing`.
9. Tests must cover corrupt-tail quarantine and unknown production target
   fail-closed behavior.
10. Build, typecheck and focused durable runner/cost tests must pass.
