# GraphRAG Capability Scope Bridge Validation Final Report

## Result

Status: `development_audit_passed`

The implementation fixes Python bridge capability validation drift for
`graph_query` requests. Python bridge now projects query-ready lineage from the
same effective sources as the TypeScript capability projection:

- `books/<bookId>/checkpoints.yaml`
- `catalog/runs.yaml`
- `books/<bookId>/runs/<runId>.yaml`
- current `books/<bookId>/artifacts.yaml`

The bridge now selects producer artifacts by `bookId`, `stage`,
`producerRunId`, and required artifact kind before validating them. This
recovers valid current manifest artifacts when checkpoint `artifactIds` contain
stale ids, while preserving fail-closed behavior for missing, mismatched, or
invalid artifacts.

## Audit

Design audit required two revisions:

- Agent B required explicit `graphCapabilityIds` request scope invariants.
- Agent C required replacing a nonexistent Python test command with a verified
  `unittest discover` command.

Development audit required one revision:

- Agent B found that the first implementation did not include run record
  candidates, so Python projection was still narrower than TypeScript
  `projectQueryReadyLineage()`.

All final design and development reaudits passed.

## Verification

Passed commands:

- `python -m unittest discover -s test/python -p 'test_graphrag_bridge_scope.py' -k capability_scope`
- `python -m py_compile python/qmd_graphrag/bridge.py test/python/test_graphrag_bridge_scope.py`
- `_load_graph_capabilities` real failure probe for
  `book-356ff4920cdf-0bbd8bdb:graph_query`
- `_load_graph_capabilities` real failure probe for
  `book-2d1d667301e9-e5c877e8:graph_query`
- `npm run test:node -- test/cli.test.ts -t "reopens query-ready 'graph capability' projection gate failures"`
- `npm run test:node -- test/book-job-state.test.ts`
- `npm run typecheck`
- `git diff --check`

An earlier `cli.test.ts` command using `-t "capabilityScope references unknown"`
matched no tests and was not counted as verification.

## Files

Implementation files:

- `python/qmd_graphrag/bridge.py`
- `test/python/test_graphrag_bridge_scope.py`

Audit files:

- `audit/graphrag-capability-scope-bridge-validation-run_1__closed/`
