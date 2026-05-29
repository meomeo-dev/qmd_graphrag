# GraphRAG Repair Rebuild Recovery Final Report

## 结论

Development audit passed.

The repair closes the local artifact gate recovery gap for GraphRAG
book-scoped artifacts, query-ready identity projection, and same-run real
rebuild reopening. The fixed audit baselines remain stored under each agent
directory and were not changed during reaudits.

## 修复范围

- Repair-only local artifact gate now returns a typed blocked result with
  `requiresRealRebuild` when local evidence cannot publish query capability.
- Batch recovery reopens `requiresRealRebuild` items as transient,
  retryable, same-run work without marking them as manually blocked.
- Recovery events, checkpoints, and recovery summary use coherent fields for
  `failureKind`, `retryable`, `retryExhausted`, `recoveryDecision`, and
  `failedStage`.
- GraphRAG text-unit identity sidecars are treated as derived projection
  caches. Stale content/path metadata can be repaired only when
  `documents.parquet` and `text_units.parquet` prove the graph document and
  text-unit relationship.
- Wrong graph document binding, missing graph documents, missing text units,
  and corrupt parquet text-unit relations are blocked before `query_ready`.
- The new invalid sidecar evidence error is classified as a local artifact
  gate in both batch and standalone resume repair paths.

## 审计结果

- Dev Agent A: final PASS in `dev-agent-a/reaudit-2.md`.
- Dev Agent B: final PASS in `dev-agent-b/reaudit-1.md`.
- Dev Agent C: final PASS in `dev-agent-c/reaudit-1.md`.

## 验证

- `npm run test:node -- test/graphrag-book-state.test.ts -t "syncGraphRagBookWorkspace"`
  passed with 35 tests.
- `npm run test:node -- test/cli.test.ts -t "GraphRAG EPUB batch runner"`
  passed with 55 tests.
- `npm run test:types` passed.
- `npm run build` passed.

## 后续动作

The code is ready to resume the real EPUB batch run with the existing
`epub-batch-20260525-full-real` run id after commit.
