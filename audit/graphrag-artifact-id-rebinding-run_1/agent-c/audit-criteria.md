# GraphRAG Artifact Id Rebinding Design Audit Criteria

1. The design must address the observed failure: generated `stats.json` exists
   and is registered, but checkpoint ids reference an obsolete stats artifact.
2. The repaired gate must return the current valid artifact ids for downstream
   checkpoint and capability projection.
3. The repair must not accept artifacts whose producer run id differs from the
   checkpoint run id.
4. The repair must not accept artifacts whose stage fingerprint differs from the
   current job fingerprint.
5. The repair must not accept artifacts with mismatched provider boundary or
   corpus content hash.
6. Existing GraphRAG product isolation under `books/<bookId>/output` must remain
   mandatory.
7. The implementation must not rely on global `graph_vault/settings.yaml`
   changes to fix artifact state.
8. Regression tests must prove the resume plan does not return graph_extract
   when current producer artifacts are complete.
9. Regression tests must prove stale or missing stats artifacts still fail.
10. The final run decision must explicitly block on `INVALID_API_KEY` until the
    upstream credential/proxy is fixed.
