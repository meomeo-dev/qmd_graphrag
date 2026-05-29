# Agent A Baseline: GraphRAG Stage Gates And Book State

Scope: audit the business contract for per-book QMD plus GraphRAG construction,
artifact readiness, and externally observable build state.

1. `query_ready` must not be treated as sufficient by itself. A graph-ready
   book must validate the full lineage:
   `graph_extract -> community_report -> embed -> query_ready`.
2. Graph extract readiness must require all core GraphRAG artifacts, including
   documents, text units, entities, relationships, communities, context JSON,
   and stats JSON.
3. Community report readiness must be bound to the same book identity,
   normalized content hash, stage fingerprint, provider fingerprint, and
   producer run lineage as the rest of the graph lineage.
4. Embed readiness must require a validated LanceDB artifact with a stable
   content hash and must not accept an arbitrary directory as a substitute.
5. Graph capability catalog entries must only mark `ready: true` when the
   validated checkpoint lineage and validated manifest artifacts agree.
6. QMD-only candidates with matching content hashes but mismatched source or
   document identity must not be upgraded into GraphRAG candidates.
7. Every book must expose a clear QMD state and GraphRAG state that an operator
   can inspect without inferring state from raw files alone.
8. The default batch construction path must run real QMD and real GraphRAG for
   each book unless an explicit resume gate proves the stage already succeeded.
9. A failed, incomplete, or stale stage must not silently unlock downstream
   graph query behavior.
10. Tests or fixtures used for this audit must include negative cases for
    missing stats, missing lineage stages, mixed identities, and incomplete
    manifests.
