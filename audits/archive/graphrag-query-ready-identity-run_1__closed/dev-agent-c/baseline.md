# Dev Agent C Baseline: End-To-End Safety And Regression Scope

Scope: audit whether the implementation satisfies the approved design without
overreaching into unrelated query/output behavior.

1. Runtime code changes must be limited to the approved modules:
   `src/job-state/repository.ts` and `src/job-state/graphrag-book.ts`.
2. Tests must be limited to relevant state and GraphRAG book sync regressions.
3. The implementation must not change CLI output format logic, query routing,
   provider configuration, or GraphRAG vendor code.
4. The implementation must not rerun high-cost GraphRAG stages during local
   identity projection repair when valid outputs already exist.
5. Producer manifest, producer run ids, stage fingerprints, provider
   fingerprints, and corpus content hash gates must remain intact.
6. `query_ready` capability publication must still depend on validated producer
   artifacts, qmd corpus registration, and graph identity.
7. The code must not add new dependencies or external services.
8. Generated runtime outputs, `.tmp-tests`, `graph_vault`, and inbox contents
   must not be staged for commit.
9. Type checking, focused GraphRAG state tests, CLI tests, and Python bridge
   scope tests must pass.
10. Remaining risks must be documented if true real EPUB resume has not yet
   been rerun after the patch.
