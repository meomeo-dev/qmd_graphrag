# Dev Agent A Baseline

1. Python GraphRAG bridge must resolve `graph_query` capability from current
   book state even when an older explicit catalog exists.
2. Derived capability must be limited to requested `:graph_query`
   capability ids and must not derive unrelated books.
3. Derived capability must override stale explicit catalog entries for the
   same capability id.
4. Capability resolution must still validate document identity, source id,
   document id, content hash, qmd corpus registration, graph document id, and
   graph text-unit ids.
5. Capability resolution must still validate query-ready lineage artifacts and
   reject invalid or incomplete query-ready evidence.
6. Missing current book state must remain an unknown/not-ready capability
   error, not a silent success.
7. Missing or invalid document identity must surface as a concrete identity
   failure, not be hidden behind a generic unknown capability error.
8. The repair must not weaken GraphRAG book-scoped artifact isolation or allow
   cross-book capability reuse.
9. The change must preserve request-scope checks for selected book ids,
   capability ids, source ids, document ids, content hashes, and artifact ids.
10. Regression tests must cover explicit catalog present but missing current
    stable book-id capability.
