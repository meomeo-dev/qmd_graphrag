# GraphRAG Artifact Id Rebinding Design Audit Criteria

1. Stage gates must validate current artifact manifests, not stale checkpoint
   identifiers, when the producer run id is unchanged.
2. Rebinding must be limited to the same book id, stage, producer run id,
   required artifact kinds, stage fingerprint, provider fingerprint, and corpus
   content hash.
3. Rebinding must not mask missing, invalid, cross-book, or stale artifacts.
4. Query-ready lineage must continue to require graph_extract,
   community_report, and embed producer evidence.
5. Repair must preserve fail-closed behavior for partial GraphRAG outputs.
6. The design must not weaken artifact content validation for parquet, JSON, or
   LanceDB outputs.
7. The change must not reintroduce duplicate high-cost GraphRAG stages when all
   current producer artifacts are valid.
8. The change must remain scoped to output-state reconciliation and avoid
   broad CLI/query behavior changes.
9. The design must include regression coverage for stale checkpoint artifact ids
   and current complete manifests.
10. The design must separate external credential failures from local artifact
    gate failures.
