# Dev Agent A Baseline: Repository And Catalog Projection

Scope: audit the implementation of non-destructive document identity map writes
and query-ready catalog projection repair.

1. Re-registering the same `canonicalBookId/sourceHash/documentId/contentHash`
   must preserve `chunkIds`, qmd corpus registration metadata, `graphDocumentId`,
   and `graphTextUnitIds`.
2. Re-registering after content identity changes must not carry stale
   `graphDocumentId` or `graphTextUnitIds` into the new identity.
3. `recordGraphTextUnitIdentity` must remain the single repository operation
   that writes GraphRAG text-unit identity into `DocumentIdentityMap`.
4. `validateQueryReadyGraphIdentity` must still read `DocumentIdentityMap` and
   require qmd corpus registration plus non-empty graph identity.
5. The implementation must not introduce duplicate canonical identities for the
   same book and document.
6. The implementation must preserve aliases and portable normalized paths.
7. The implementation must not weaken vault-relative path validation.
8. The implementation must avoid storing secrets, host absolute paths, or raw
   provider payloads in identity metadata.
9. Tests must cover non-destructive identity map upsert after qmd and GraphRAG
   identity have both been recorded.
10. Type checking and focused repository/state tests must pass.
