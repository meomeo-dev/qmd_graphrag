# Dev Agent C Baseline

1. The batch runner must keep every book item independently resumable and must
   never let one book's local artifact repair pollute another book.
2. Status fields must remain machine-readable and schema-valid after every
   recovery transition.
3. `failureKind`, `retryable`, `retryExhausted`, `recoveryDecision`,
   `failedStage`, and `activeCommand` must be coherent for all repaired and
   blocked cases.
4. Real rebuild recovery must not leave stale `nextRetryAt` or retry delay
   fields that defer immediate reconstruction unnecessarily.
5. The event log must make the recovery decision auditable without reading raw
   command stdout.
6. Existing recovery-summary output must still classify the batch decision
   correctly after real-rebuild reopening.
7. The fix must not weaken redaction of absolute paths, URLs, API keys, or
   provider error payloads.
8. Tests must include the same-run transition from repair-only blocked to
   normal `resume-book`.
9. Tests must avoid network calls and must remain deterministic under CI.
10. The final state must be safe for resuming the real EPUB batch without
    deleting or manually editing `graph_vault`.
