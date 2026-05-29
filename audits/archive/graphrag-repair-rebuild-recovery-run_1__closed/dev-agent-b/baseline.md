# Dev Agent B Baseline

1. `qmd_graph_text_unit_identity.json` is a derived projection cache, not the
   source of truth for book identity.
2. Stale sidecar `contentHash` and `normalizedPath` must be rewritten from the
   current query-ready identity when the graph document and text unit evidence
   still validate.
3. Sidecars with mismatched `bookId`, `sourceId`, `sourceHash`, or
   `documentId` must not be trusted.
4. Sidecars that reference missing text units must not publish graph identity.
5. If a sidecar is unusable, recovery may fall back to GraphRAG parquet evidence
   but must still require valid text-unit identity before `query_ready`.
6. Rewriting a sidecar must update the persisted document identity map
   consistently with the repaired sidecar.
7. Multi-document GraphRAG output must not bind the current book to the wrong
   graph document.
8. The repair path must not mask real corruption in parquet or LanceDB
   artifacts.
9. Existing query-ready GraphRAG capability checks must continue to require
   producer manifests, stage checkpoints, and qmd corpus registration.
10. Tests must prove both stale sidecar metadata repair and invalid evidence
    rejection remain distinct behaviors.
