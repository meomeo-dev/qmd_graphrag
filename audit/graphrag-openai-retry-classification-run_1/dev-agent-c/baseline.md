# Development Audit Baseline C

## Scope

Audit implementation quality, observability, and regression coverage for the
OpenAI retry-guidance classifier fix.

## Fixed Criteria

1. The fix must directly address the real failed text from the EPUB batch
   without relying on absolute paths or private runtime details.
2. The failure text must classify as transient even when embedded in
   `GraphRAG index workflow failed` JSON text.
3. The test fixture must not include secrets or real request IDs.
4. Existing redaction boundaries must remain unchanged.
5. The patch must not create new dependencies.
6. The patch must not change CLI output schemas or query result rendering.
7. The patch must not change retry budgets or provider recovery wait counts.
8. The patch must not hide true data compatibility failures behind transient
   matching.
9. The implementation must be compatible with source runtime and built output
   because the classifier module is shared.
10. Verification commands must be recorded in the audit status file.

