# Batch Command Heartbeat Observability Audit Baseline - Agent C

## Scope

Audit operational safety, process lifecycle, and failure-mode handling for the
heartbeat monitor. The audit should focus on whether this change improves
observability without adding new stuck processes or invalid recovery behavior.

## Fixed Criteria

1. The monitor process cannot keep the main batch runner alive after the command
   completes.
2. The monitor has an explicit shutdown path and does not run indefinitely after
   normal command completion.
3. The monitor stops if the parent process exits unexpectedly.
4. Monitor writes are limited to the current item checkpoint and preserve all
   unrelated fields.
5. Concurrent monitor/checkpoint writes do not introduce a likely permanent
   corruption mode.
6. The implementation remains portable enough for Node-supported platforms used
   by the project.
7. Long-running GraphRAG commands can be distinguished from stale or orphaned
   runners by fresh heartbeat timestamps.
8. Failure handling still records stdout/stderr, command checks, and retry
   metadata exactly once per attempt.
9. Added tests are deterministic and do not depend on live LLM, GraphRAG, or
   network calls.
10. Any residual risk is documented clearly enough to decide whether another
    implementation pass is needed.

