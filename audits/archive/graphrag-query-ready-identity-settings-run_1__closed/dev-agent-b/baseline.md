# GraphRAG Identity Projection Design Audit Baseline - Agent B

## Scope

Audit whether the design documents provide enough Type DD and data-contract
detail for GraphRAG document identity sidecars, qmd corpus registration, and
graph capability publication. Focus on schema boundaries, identity consistency,
and query route readiness.

## Fixed Criteria

1. The design defines canonical identities for `bookId`, `sourceId`,
   `sourceHash`, `documentId`, `contentHash`, `normalizedPath`, and GraphRAG
   text unit ids.
2. The document identity sidecar contract must be book-scoped, portable, and
   independent of host absolute paths.
3. Sidecar adoption must validate source hash, content hash, document id,
   normalized path, and text unit existence.
4. Sidecar mismatch must not silently overwrite valid catalog state without
   lineage checks.
5. Missing `DocumentIdentityMap` projection must be recoverable from a valid
   sidecar or GraphRAG parquet output.
6. Graph capability publication must depend on qmd corpus registration and
   valid `query_ready` artifacts.
7. Capability scope must reference only ready graph capability ids for the
   selected book/source/document.
8. The design must prevent stale same-book or same-title artifacts from
   satisfying a different content identity.
9. Query route refusal semantics must remain typed when graph capability is
   unavailable.
10. Tests must cover missing identity, sidecar mismatch, missing capability
    projection, and stale producer lineage.
