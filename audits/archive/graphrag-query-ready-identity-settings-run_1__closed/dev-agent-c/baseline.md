# GraphRAG Settings Projection Design Audit Baseline - Agent C

## Scope

Audit whether the design documents define robust settings projection,
observability, and recovery behavior for real batch GraphRAG runs. Focus on
managed `graph_vault/settings.yaml`, `.qmd/index.yml` projection, and resume
recoverability under long-running GraphRAG stages.

## Fixed Criteria

1. The design defines `.qmd/index.yml` as the source of truth for managed
   GraphRAG settings.
2. `graph_vault/settings.yaml` must be treated as a generated projection, not a
   manually owned configuration file.
3. Projection comparison must use the same loader semantics as the writer and
   must not compare against an accidentally default-loaded config.
4. A mismatched managed settings projection must be recoverable by rewriting
   the projection when source config is valid and no user-owned settings file is
   being overwritten.
5. Recovery must be idempotent across repeated resume attempts.
6. Projection repair must not delete or invalidate unrelated book-scoped
   GraphRAG outputs.
7. Logs and recovery summaries must make the active GraphRAG stage, command,
   and projection repair decision observable.
8. Long-running GraphRAG stages must be resumable or recoverable after runner
   interruption without corrupting batch state.
9. Design acceptance must include the real failure
   `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`.
10. The design must specify where implementation tests and operational runbook
    notes belong.
