# GraphRAG Artifact Id Rebinding Development Audit Criteria

1. The fix must be limited to artifact readiness and status reconciliation.
2. The fix must reuse existing validation rules rather than introduce a weaker
   validation path.
3. Query_ready producer requirements must remain intact.
4. Partial GraphRAG products must not be accepted.
5. Book-scoped product isolation must remain mandatory.
6. Regression tests must include a refreshed `graphrag_stats_json` artifact id.
7. Regression tests must include missing or invalid stats behavior.
8. The implementation must preserve previous diagnostics expected by tests.
9. Audit records must include development verification commands.
10. Real execution must be blocked only by the external credential/proxy
    failure after local GraphRAG status is repaired.
