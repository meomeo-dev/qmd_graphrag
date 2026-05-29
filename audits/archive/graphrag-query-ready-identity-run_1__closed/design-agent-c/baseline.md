# Design Agent C Baseline: Documentation And Acceptance Design

Scope: audit documentation and acceptance criteria for the query-ready identity
repair design.

1. Architecture docs must state that `query_ready` capability publication
   depends on both qmd corpus registration and GraphRAG text-unit identity.
2. Type-DD docs must specify how QMD document identity relates to GraphRAG
   internal document identity.
3. Docs must describe the allowed single-document fallback and explicitly reject
   ambiguous multi-document fallback.
4. Docs must explain how `qmd_graph_text_unit_identity.json` is derived and
   whether it is source of truth or repair evidence.
5. Docs must describe resume behavior when GraphRAG outputs are valid but the
   identity map is missing or stale.
6. Acceptance criteria must include rerunning the failed real book without
   redoing high-cost GraphRAG extraction when valid outputs already exist.
7. Acceptance criteria must include batch status checks for qmd, graph build,
   and graph query status after repair.
8. Acceptance criteria must include all core CLI output formats after the book
   reaches graph-ready state.
9. The design must state which generated runtime outputs should not be
   committed.
10. The design audit report must decide whether docs need supplementing,
    correction, trimming, implementation continuation, or over-implementation
    pruning.
