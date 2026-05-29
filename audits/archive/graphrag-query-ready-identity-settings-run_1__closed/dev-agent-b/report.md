# GraphRAG Identity Projection Design Audit - Agent B

## Conclusion

FAIL

The design is largely sufficient for `DocumentIdentityMap` repair,
`query_ready` capability publication, graph capability routing, and typed
refusal semantics. It does not satisfy the fixed baseline completely because
`normalizedPath` is not defined as a first-class canonical identity or locator
contract in the Type DD identity model, and sidecar adoption rules do not
require `normalizedPath` validation.

## Findings

- `normalizedPath` is mentioned as a repair fact source in
  `docs/architecture/unified-retrieval-plane.md:351`, but it is absent from the
  Type DD `identity_model` entries in
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:226`.
- The sidecar repair rule validates
  `bookId/sourceId/sourceHash/documentId/contentHash` and text unit existence in
  `docs/architecture/unified-retrieval-plane.md:365`, but it does not require
  `normalizedPath` validation.
- The Type DD `graph_text_unit_identity_map` required identity fields list
  `sourceId`, `sourceHash`, `documentId`, and `contentHash` in
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:493`, but omits
  `normalizedPath`.
- The fail-closed rejection policy covers mixed-book output, hash/document
  mismatch, empty or absent text units, invalid `outputDir`, and producer
  lineage mismatch in
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:503`, but it does not
  cover `normalizedPath` mismatch.

## Criterion Results

1. FAIL - Canonical identities are defined for `bookId`, `sourceId`,
   `documentId`, `contentHash`, and GraphRAG text unit ids in
   `docs/architecture/unified-retrieval-plane.md:301` and
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:226`. `sourceHash`
   is used as the derivation input for `sourceId` and `bookId`. `normalizedPath`
   is not defined as a canonical identity or typed locator contract.

2. PASS - The document identity sidecar is book-scoped under
   `graph_vault/books/<book_id>/output/qmd_graph_text_unit_identity.json` and is
   defined as repair evidence, not a host-path authority, in
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:498`.

3. FAIL - Sidecar adoption validates `sourceHash`, `contentHash`,
   `documentId`, and text unit existence, but not `normalizedPath`. The omission
   appears in both
   `docs/architecture/unified-retrieval-plane.md:365` and
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:493`.

4. PASS - Sidecar mismatch cannot silently overwrite valid catalog state:
   `DocumentIdentityMap` upserts are non-destructive, and graph identity can be
   cleared only on content identity change or validated stale evidence per
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:475`.

5. PASS - Missing `DocumentIdentityMap` graph projection is recoverable from a
   valid sidecar or validated parquet extraction, then `query_ready` is retried,
   as specified in
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1681`.

6. PASS - Graph capability publication depends on qmd corpus registration and
   valid `query_ready` artifacts. The canonical readiness gate requires
   `DocumentIdentityMap.metadata.qmdCorpusRegistered=true`, graph identity, and
   validated checkpoints/manifests in
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1762`.

7. PASS - Capability scope is derived from selected ready `GraphCapability`
   records, and GraphRAG query reads only sources with `graph_query` capability,
   as stated in
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1533` and
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1946`.

8. PASS - Stale same-book or same-title artifacts are rejected by content hash,
   producer lineage, and title-as-locator rules. The design explicitly prevents
   same-title authority and requires artifact content hash validation in
   `docs/architecture/unified-retrieval-plane.md:338` and
   `docs/architecture/unified-retrieval-plane.md:779`.

9. PASS - Query route refusal remains typed when graph capability is
   unavailable. Explicit `--graphrag` refusal returns a typed capability error
   and does not silently fall back to qmd retrieval in
   `docs/architecture/unified-retrieval-plane.md:784` and
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1513`.

10. PASS - Test requirements cover missing identity, sidecar mismatch or stale
    sidecar, missing capability projection, and stale or missing producer
    lineage through focused regressions and negative reopen tests in
    `docs/architecture/unified-retrieval-plane.type-dd.yaml:1958` and
    `docs/operations/graphrag-epub-batch-runbook.md:155`.

## Required Remediation

To reach PASS, the design should promote `normalizedPath` into the Type DD
identity or locator model and require sidecar adoption to validate it against
the current book job and qmd corpus registration. The rejection policy should
fail closed on `normalizedPath` mismatch.
