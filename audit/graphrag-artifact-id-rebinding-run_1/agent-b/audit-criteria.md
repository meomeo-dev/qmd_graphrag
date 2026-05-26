# GraphRAG Artifact Id Rebinding Design Audit Criteria

1. A succeeded checkpoint may be repaired only through validated current
   artifacts from the same producer run.
2. The required artifact kind set for graph_extract must include stats,
   context, graph parquets, and must remain complete.
3. Community_report and embed gates must retain their existing required kinds.
4. Query_ready must publish only after producer artifacts satisfy their own
   gates.
5. Rebinding must be deterministic and must not depend on filesystem order.
6. Legacy or bootstrap checkpoints must not be treated as real successful runs
   unless existing rules already allow them.
7. The implementation must not mutate user-owned source inputs or config files.
8. Batch status reporting must show qmd, GraphRAG, and query state from the same
   validated evidence model.
9. Test fixtures must include the mismatch between checkpoint artifact id and
   current artifact id for `graphrag_stats_json`.
10. External OpenAI authentication errors must stay classified as external
    stop-until-fixed failures, not as code recovery events.
