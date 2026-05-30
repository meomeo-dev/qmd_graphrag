# GraphRAG Cost Accounting Sidecar Mapping Final Report

## Status

Closed: PASS

Task: `graphrag-cost-accounting-sidecar-mapping`

Run: `20260529_r1`

## Trigger

The real EPUB batch run
`epub-batch-20260529-135547-full-real` stopped in `resume-book-1` with
`local_state_integrity` and `durable_target_mapping_missing`.

Primary target:
`graph_vault/catalog/cost-accounting.jsonl`

Visible failing auxiliary target:
`graph_vault/catalog/cost-accounting.jsonl.tmp-*.owner.json`

## Design Decision

The existing Type DD remained the only design baseline. The fix did not create
a new design document. The Type DD was amended to make production durable
auxiliary paths inherit their primary target mapping, including JSONL
read-reconcile-replace targets.

Design Audit R1 failed because the Type DD did not explicitly define JSONL
auxiliary sidecar mapping. Design Audit R2 passed after the Type DD patch.

## Implementation Summary

Implemented strict durable target normalization in small helper modules:

- `src/job-state/durable-target-normalizer.ts`
- `scripts/graphrag/durable-target-normalizer.mjs`

Wired the normalizer into:

- `src/job-state/durable-state-store.ts`
- `scripts/graphrag/batch-epub-workflow.mjs`

Preserved auxiliary evidence through:

- `src/contracts/batch-run.ts`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/resume-book-workspace.mjs`

Added focused tests:

- `test/durable-target-normalizer.test.ts`
- `test/graphrag-cost-accounting-durable.test.ts`

Updated existing contract coverage:

- `test/integrations/contracts.test.ts`

Updated package runtime file list:

- `package.json`

## Verification

Verification reports:

- `reports/verification-r1.md`
- `reports/verification-r2.md`

Final verification status: PASS.

R2 verification covered syntax checks, typecheck, focused durable/cost tests,
contract projection tests, package tests, existing provider cost accounting
tests, durable runner state tests, durable preflight tests and build.

## Implementation Audit

Fixed criteria files:

- `agent-a/implementation-audit-criteria.md`
- `agent-b/implementation-audit-criteria.md`
- `agent-c/implementation-audit-criteria.md`

Implementation Audit R1 failed because auditable verification records and
auxiliary evidence projection were incomplete.

Implementation Audit R2 passed for all three agents:

- `agent-a/implementation-audit-r2.md`: PASS
- `agent-b/implementation-audit-r2.md`: PASS
- `agent-c/implementation-audit-r2.md`: PASS

No minimum required fix remains.

## Closure

The audit loop is closed. The previous real-run blocker has a design-backed,
implemented and audited fix. Per instruction, execution stops after this audit
is closed.
