# Batch Command Heartbeat Observability Audit Baseline - Agent B

## Scope

Audit schema, contract, and compatibility behavior for the batch command
heartbeat change. The audit must verify that persisted state remains typed,
portable, and backwards-compatible with existing batch checkpoints.

## Fixed Criteria

1. New checkpoint fields are optional and do not break existing persisted item
   JSON.
2. New recovery summary fields are optional and preserve existing consumers.
3. New manifest policy fields are optional for legacy manifests and present for
   newly written manifests.
4. The public TypeScript contract mirrors the runner-local schemas.
5. `--status-json` remains read-only and does not start heartbeat monitors.
6. Redaction and log-root isolation rules remain intact.
7. Stop files and heartbeat metadata do not leak source paths, secrets, or raw
   GraphRAG content.
8. The new `--heartbeat-interval-seconds` option has a safe default and lower
   bound.
9. Typed validation still catches malformed running checkpoints.
10. Tests cover both static contract presence and a real long-command heartbeat
    behavior.

