# Design Agent B Baseline: State Repository And Recovery Design

Scope: audit state-management design for repairing document identity during
GraphRAG resume and batch recovery.

1. The repository contract must expose a single clear operation for recording
   GraphRAG text-unit identity into the document identity map.
2. That operation must be safe when the qmd corpus row already exists, when the
   graph fields are missing, and when the graph fields are stale.
3. Repository reads used by `query_ready` validation must observe the identity
   written in the same resume pass.
4. Batch status must present this failure as a repairable local state problem
   only when valid outputs exist; otherwise it must remain a real stage failure.
5. The recovery design must avoid relabeling identity contract failures as
   provider transient failures.
6. The design must specify whether existing failed checkpoints are reopened by
   status projection, normal run, migration, or explicit repair.
7. The design must not require editing generated GraphRAG parquet artifacts.
8. The design must keep graph artifact lineage, producer run ids, fingerprints,
   and provider boundary fingerprints intact.
9. Tests must prove completed graph_extract artifacts can be reused after
   identity repair without rerunning GraphRAG extraction.
10. Operator-visible status must show qmd/GraphRAG/query state after repair in
    a way that explains why the book can resume.
