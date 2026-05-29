# Dev Agent C Baseline

1. The fix must address the real failure shape:
   `capabilityScope references unknown or not-ready graphCapabilityId(s)`.
2. A book with `graphBuildStatus=query_ready` and missing graph query command
   checks must be recoverable without deleting or hand-editing `graph_vault`.
3. Batch recovery must be able to reopen the failed item after code fix through
   normal runner logic.
4. Current running book work must not be interrupted or corrupted by the
   repair.
5. Observability must distinguish projection repair from real rebuild:
   events/checkpoints must not falsely mark projection-only repair as a
   provider/network retry.
6. Provider transient failures must remain classified as transient and must not
   be confused with local projection failures.
7. Permanent data compatibility failures must remain stop-until-fixed and must
   not be hidden by derived capability fallback.
8. Python and TypeScript capability behavior should remain coherent: both must
   prefer validated current book state over stale explicit catalog data.
9. Verification must include targeted Python bridge tests and script syntax
   checks at minimum.
10. Any remaining verification gap, such as missing optional Python packages,
    must be recorded explicitly instead of treated as a pass.
