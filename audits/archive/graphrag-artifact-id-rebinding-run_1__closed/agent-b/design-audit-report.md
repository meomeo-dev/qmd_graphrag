# Design Audit Report

Verdict: fail

1. Pass. The design uses validated current artifacts from the same producer run.
2. Pass. The graph_extract required kind set includes stats, context, and graph
   parquet artifacts.
3. Pass. Community_report and embed required kinds remain unchanged.
4. Pass. Query_ready remains gated by producer lineage.
5. Fail. The design does not define deterministic selection when multiple
   current artifacts exist for the same book id, stage, producer run id, and
   kind.
6. Fail. The design does not explicitly preserve bootstrap and legacy
   checkpoint exclusion rules.
7. Pass. User-owned source inputs and config files are not changed.
8. Fail. The design does not require batch status reporting to use the same
   validated evidence model as repository resume and query_ready gates.
9. Pass. The design requires a regression case for checkpoint/current artifact
   mismatch on `graphrag_stats_json`.
10. Pass. OpenAI authentication errors remain external stop-until-fixed
    failures.

Required fixes:

1. Define deterministic rebinding for duplicate candidate artifacts.
2. Exclude bootstrap and legacy checkpoints unless existing rules already mark
   them usable.
3. Require batch status, recovery summary, GraphRAG build status, and query
   status to use the same current-manifest rebinding model as repository gates.
