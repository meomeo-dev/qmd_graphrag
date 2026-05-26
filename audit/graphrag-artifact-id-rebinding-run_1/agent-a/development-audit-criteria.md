# GraphRAG Artifact Id Rebinding Development Audit Criteria

1. Implementation must rebind stale checkpoint artifact ids to current valid
   artifacts for the same book id, stage, producer run id, and required kinds.
2. Selection must be deterministic when duplicate current artifacts exist.
3. Missing or invalid required artifacts must still fail closed with observable
   missing and invalid evidence.
4. Bootstrap high-cost checkpoints must not be promoted to real successful
   producer evidence.
5. Query_ready must still validate graph_extract, community_report, and embed
   producer artifacts.
6. Batch status must use the same current-manifest evidence semantics as
   repository resume planning.
7. JSON, parquet, and LanceDB validators must not be weakened.
8. Tests must cover refreshed stats artifact id rebinding and missing/invalid
   stats rejection.
9. The implementation must not alter qmd query routing or OpenAI credential
   error classification.
10. The real batch status must show GraphRAG succeeded for the repaired
    Accelerate item while preserving the `INVALID_API_KEY` blocker.
