# Dev Agent B Baseline: GraphRAG Sidecar Repair

Scope: audit the implementation that repairs missing catalog graph identity
from `qmd_graph_text_unit_identity.json` and validated GraphRAG output.

1. Existing sidecar repair must validate `bookId`, `sourceId`, `sourceHash`,
   `documentId`, `contentHash`, and `normalizedPath` against the current job.
2. Sidecar repair must validate that `graphDocumentId` is non-empty and
   `graphTextUnitIds` is non-empty.
3. Sidecar repair must prove referenced text unit ids exist in
   `text_units.parquet`, scoped by `graphDocumentId` when `document_id` exists.
4. A mismatched sidecar must fail closed and must not silently fall back to
   parquet extraction.
5. Missing sidecar may fall back to validated parquet extraction.
6. Multi-document GraphRAG output may be repaired only with a valid sidecar or
   direct document identity match; it must not pick by title or first row.
7. Repair must not edit generated GraphRAG parquet artifacts.
8. Repair must write the validated mapping back through repository state and
   refresh the sidecar deterministically.
9. Tests must cover the real failure shape: sidecar exists, catalog lacks graph
   fields, sync repairs `DocumentIdentityMap`.
10. Tests must cover negative sidecar mismatch or stale identity.
