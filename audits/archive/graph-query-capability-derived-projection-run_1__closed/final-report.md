# Graph Query Capability Derived Projection Final Report

## Conclusion

PASS.

The fixed audit baseline was preserved in each agent directory. Initial audit
found blocking defects in Python graph query capability resolution and
repair-only `query_ready` projection recovery. Two re-audit rounds were run
against the same fixed baselines. The final round passed for all three agents.

## Implemented Decisions

- Requested `*:graph_query` capabilities are derived from the current
  `books.yaml` book state in the Python bridge.
- Explicit `catalog/graph-capabilities.yaml` entries cannot satisfy a requested
  `*:graph_query` capability when current book state is missing or derivation
  fails.
- Python graph capability derivation rejects stale identity state by checking
  `sourceHash`, `sourceId`, `documentId`, `contentHash`, qmd corpus
  registration, `graphDocumentId`, and non-empty list `graphTextUnitIds`.
- Request-scope validation now uses the same strict graph identity checks for
  `graphDocumentId` and `graphTextUnitIds`.
- Repair-only query-ready projection recovery completes `query_ready` through
  repository completion semantics, so persistent graph capability projection is
  refreshed instead of relying on derived in-memory visibility.

## Verification

- `python -m pytest test/python/test_graphrag_bridge_scope.py -k 'capability_scope'`
  passed: 12 passed, 17 deselected.
- `python -m pytest test/python/test_graphrag_bridge_scope.py -k 'capability_scope or index_scope or filter_graphrag_frames_for_scope or build_graphrag_evidence'`
  passed: 20 passed, 9 deselected.
- `node --check scripts/graphrag/resume-book-workspace.mjs` passed.
- `node --check scripts/graphrag/batch-epub-workflow.mjs` passed.
- `npm run test:node -- test/cli.test.ts -t "GraphRAG EPUB batch runner"`
  passed: 55 passed, 132 skipped.
- `npm run test:types` passed.
- `npm run build` passed.

## Residual Risks

- Full `test/python/test_graphrag_bridge_scope.py` is blocked in this
  environment by missing `nest_asyncio2` in an unrelated GraphRAG index provider
  registration path.
- The real long-running EPUB batch was still processing `Code Complete A
  Practical Handbook of Software Construction (Steve McConnell).epub` at final
  audit close. It should continue after this commit and validate real recovery
  on the previously failed `Building Microservices (Sam Newman).epub` item.
