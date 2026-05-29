# GraphRAG Query-Ready Recovery Design Audit Baseline - Agent A

## Scope

Audit whether the design documents define correct runtime behavior for
recovering real GraphRAG query-ready projection failures observed in batch EPUB
runs. Focus on state-machine correctness and stage-gate invariants. Do not
audit heartbeat implementation, generic CLI output rendering, or unrelated DSPy
policy behavior.

## Fixed Criteria

1. The design distinguishes `graph_extract`, `community_report`, `embed`, and
   `query_ready` ownership, and never marks `query_ready` complete without
   producer-stage lineage.
2. `query_ready` repair must reopen affected batch items to pending work, not
   mark them completed directly.
3. Repair must preserve existing valid high-cost producer run ids for
   `graph_extract`, `community_report`, and `embed` when artifacts are valid.
4. Repair must rebuild or refresh only missing local projections such as
   document identity and graph capability metadata.
5. The design must classify missing capability projection failures as local
   projection repair candidates, not provider/network transient failures.
6. The design must classify document identity missing or sidecar mismatch as
   local projection repair candidates when source/content lineage matches.
7. The design must fail closed when source hash, normalized content hash,
   document id, book id, or artifact producer lineage mismatches.
8. The design must require normal command checks after repair before any item
   can become completed.
9. Recovery events and checkpoint metadata must record the repair reason,
   repaired projection, evidence locator, and reused producer run ids.
10. The design must include regression acceptance for the real failure texts
    seen in the batch run.
