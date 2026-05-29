# Implementation Audit Criteria Agent B

## Fixed Scope

Audit the implementation of normal `runner_start` startup state publication,
counter consistency, and recovery projection for book-scoped durable blockers.

## Fixed Criteria

1. Type DD alignment: implementation must enforce the latest Type DD rule that
   book-scoped durable repair is outside normal `runner_start`.
2. Shared scan source: `targetCount`, `degradedTargetCount`, and
   `mutationCount` must derive from the same startup preflight scan state.
3. Mutation accounting: any durable quarantine, checksum backfill, checksum meta
   backfill, temp reconciliation, delete, rename, or write event during startup
   preflight must increment `mutationCount`.
4. Book-scoped budget: the normal `runner_start` book-scoped mutation budget
   must be fixed at `0` and reflected in diagnostics.
5. First blocker evidence: the first book-scoped blocker must preserve
   target locator, primary target locator, local failure class, checksum
   evidence where available, durable mode, and recovery decision.
6. Failure state closure: startup failure before claims must leave no
   ambiguous running manifest and must not create item checkpoint files.
7. Operator action: blocked book-scoped durable mismatch must use fielded
   `nextOperatorAction: run_explicit_repair`, not only natural-language hints.
8. Contract schemas: exported runtime contracts must accept the new durable
   diagnostic and startup recovery fields used by manifest and summaries.
9. Status-json compatibility: read-only status JSON behavior must remain
   compatible with existing recovery-summary and provider diagnostic contracts.
10. Tests: focused regression tests must cover read-only book-scoped startup
    blocker behavior and contract parsing for the new fields.
