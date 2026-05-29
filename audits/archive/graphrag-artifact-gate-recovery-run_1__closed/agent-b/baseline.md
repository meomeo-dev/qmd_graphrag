# Agent B Baseline: Artifact Isolation And Provider Boundary

Scope: audit GraphRAG raw output isolation, provider request boundaries,
path hygiene, and output projection after query execution.

1. GraphRAG index requests must require an explicit per-book `reportDir`; a
   missing `reportDir` must fail before invoking the Python bridge.
2. Raw GraphRAG reports must be written under the current book workspace, not a
   shared default such as a global `output/reports` path.
3. `resume-book-workspace` and batch runners must always pass the same isolated
   per-book report directory to the TypeScript and Python GraphRAG layers.
4. Provider request artifacts must capture the explicit request scope without
   expanding lineage from unrelated catalog capabilities.
5. Cost ledger records for indexing must use only the explicit index scope and
   request artifact lineage, not query-ready artifacts from another stage.
6. User-facing query output must not leak absolute graph vault paths, temporary
   workspace paths, API keys, or provider-private request details.
7. `--json`, `--csv`, `--md`, `--xml`, and `--files` outputs must be renderings
   of the same post-query answer model, not separate query implementations.
8. Non-JSON formats must expose enough identifiers to reconcile with JSON:
   document ID, content hash, book ID, graph capability ID, text-unit ID, and
   artifact ID when available.
9. Markdown and XML renderings must include the answer text and evidence
   content, not only titles or route summaries.
10. Tests must verify GraphRAG-specific non-JSON output, not only the QMD route
    or JSON route.
