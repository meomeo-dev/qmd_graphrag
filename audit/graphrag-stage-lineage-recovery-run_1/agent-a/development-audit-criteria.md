# GraphRAG Stage Lineage Recovery Development Audit Criteria

Case: graphrag-stage-lineage-recovery
Run: run_1
Agent: agent-a

## Fixed Audit Criteria

1. A succeeded high-cost producer stage must not be rerun only because a later
   sync re-recorded the same physical artifacts with refreshed artifact ids.
2. Stage readiness must validate by producer lineage, required artifact kind,
   stage fingerprint, provider fingerprint, corpus content hash, book scope, and
   artifact file integrity.
3. Checkpoint artifact ids may be treated as stale references when fresh current
   artifacts for the same stage and producer run satisfy all readiness checks.
4. A failed or running checkpoint for a newer run must not hide a usable older
   succeeded checkpoint unless the newer run has actually completed and
   superseded the stage.
5. Query-ready readiness must continue to require graph_extract,
   community_report, and embed producer run ids and validated artifacts.
6. Query-ready capability publishing must include validated producer lineage
   artifact ids, not stale checkpoint artifact ids.
7. Partial or invalid artifacts must fail closed; recovery must not mark a
   producer stage ready from missing, empty, wrong-scope, wrong-hash,
   wrong-fingerprint, wrong-provider, wrong-corpus, or wrong-producer artifacts.
8. The fix must not weaken GraphRAG book isolation: shared output or artifacts
   from another book must remain unusable.
9. Resume plans and query-ready failures must remain observable by reporting the
   true next stage and missing or invalid artifact evidence when blocked.
10. The implementation must be minimally scoped to stage lineage and recovery
    and must not rewrite unrelated qmd search, GraphRAG query, CLI output, or
    rendering behavior.
