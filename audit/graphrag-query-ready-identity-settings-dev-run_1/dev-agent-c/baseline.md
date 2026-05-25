# GraphRAG Settings Projection Implementation Audit Baseline - Agent C

## Scope

Audit the implementation of managed GraphRAG settings projection, observability,
and recovery under network or runner interruption. Focus on `.qmd/index.yml`,
`graph_vault/settings.yaml`, resume behavior, and recovery summaries. Do not
audit unrelated configuration surfaces.

## Fixed Criteria

1. Runtime code must treat `.qmd/index.yml` as the source of truth for managed
   GraphRAG settings.
2. `graph_vault/settings.yaml` must be generated and managed only when it has
   the managed projection marker.
3. Projection comparison must use loader-equivalent semantics and must not
   compare against an accidental default configuration.
4. Drifted managed settings must be atomically rewritten when the source config
   is valid.
5. User-owned or unmarked `settings.yaml` files must fail closed and must not
   be overwritten.
6. Settings projection repair must be idempotent across repeated resume
   attempts.
7. Settings projection repair must not delete, truncate, or invalidate
   book-scoped GraphRAG outputs.
8. Recovery summaries and events must expose active command, projection
   decision, rewrite flag, source fingerprint, locators, and reason.
9. Runner interruption recovery must preserve typed batch state and allow safe
   same-run-id retry.
10. Tests and docs must cover the real failure
    `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`.
