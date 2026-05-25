# GraphRAG Identity Projection Implementation Audit Baseline - Agent B

## Scope

Audit the implementation of GraphRAG document identity sidecars, qmd corpus
registration, and graph capability publication. Focus on schema boundaries,
portable identity, and query-route readiness. Do not audit UI, unrelated CLI
formats, or external provider pricing.

## Fixed Criteria

1. Runtime contracts must preserve canonical identities for `bookId`,
   `sourceId`, `sourceHash`, `documentId`, `contentHash`, `normalizedPath`,
   and GraphRAG text unit ids.
2. Document identity sidecars must remain book-scoped and portable, without
   host absolute path dependence.
3. Sidecar adoption must validate source hash, content hash, document id,
   normalized path, and text unit existence before catalog repair.
4. Sidecar mismatch must not silently overwrite catalog state.
5. Missing `DocumentIdentityMap` projections must be recoverable only from a
   valid sidecar or validated GraphRAG output.
6. Graph capability publication must depend on qmd corpus registration and
   valid query-ready artifacts.
7. Capability scope must reference only ready graph capability ids for the
   selected book/source/document.
8. Stale same-book or same-title artifacts must not satisfy a different content
   identity.
9. Query route refusal must remain typed when graph capability is unavailable.
10. Tests must exercise missing identity, sidecar mismatch, normalized path
    mismatch, missing capability projection, and stale producer lineage.
