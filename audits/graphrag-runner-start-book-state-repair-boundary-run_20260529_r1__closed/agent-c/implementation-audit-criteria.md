# Implementation Audit Criteria Agent C

## Fixed Scope

Audit implementation risks for durable safety, observability, and file-size
discipline in the runner-start book-scoped repair boundary.

## Fixed Criteria

1. Type DD traceability: each implemented behavior must trace to the fixed
   Type DD startup preflight rules and the module split plan.
2. Read-only inspection: book-scoped primary target validation must use read
   operations only and must not call durable reconciliation helpers that write.
3. No sidecar mutation: missing or conflicting book-scoped checksum sidecars
   must be reported, not backfilled, replaced, quarantined, or renamed.
4. Temp and lock safety: book-scoped temp or lock anomalies during normal
   `runner_start` must block with diagnostics rather than cleanup or repair.
5. Durable failure envelope: thrown durable startup errors must preserve
   failure kind, failed stage, local failure class, target evidence, and
   `stop_until_fixed`.
6. Publication durability: failed manifest and recovery-summary writes must use
   existing typed durable write paths and schemas.
7. Active-resource closure: blocked startup must publish zero active provider
   slots, subprocesses, and book leases before returning control to the
   operator.
8. Regression isolation: changes must not alter item-level `before_claim`,
   `before_resume_book`, explicit repair, or migrate-only semantics outside the
   documented startup boundary.
9. File-size discipline: no new feature logic may be added to existing
   oversized files beyond minimal import/schema/wiring statements.
10. Verification evidence: syntax checks, type tests, focused runner tests,
    durable state tests, status-json tests, and contract tests must pass or any
    failure must be explained as a reproducible blocker.
