# Development Audit Baseline B

## Scope

Audit whether the patch preserves batch recovery semantics for upstream
provider instability during GraphRAG indexing.

## Fixed Criteria

1. The observed provider wording must not leave items in `unknown` failure
   state.
2. The resulting recovery decision must be derivable as `retry_same_run_id`
   by existing batch logic.
3. The patch must not introduce a separate recovery ledger or state source.
4. The change must remain deterministic and side-effect free.
5. The classifier must continue to prioritize numeric provider status codes.
6. The test must exercise classification directly and not depend on live
   provider calls.
7. The change must not broaden retry handling to arbitrary help-center or
   request-ID messages.
8. The change must preserve existing partial-output and network transient
   classification.
9. The change must preserve permanent local artifact gate classification.
10. The code must remain small enough that a future provider phrase can be
    added without touching unrelated GraphRAG runtime paths.

