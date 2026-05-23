# Current qmd_graphrag DSPy Boundary Evidence

Source: local repository review.

## Facts

- `src/contracts/dspy.ts` defines request, response, and generated expansion
  record schemas for DSPy query prompt optimization.
- `src/integrations/dspy.ts#optimizeQueryPrompt` validates the request and
  calls the Python bridge command `dspy_optimize_query_prompt`.
- `src/runtime.ts#createQmdGraphRagRuntime` exposes `optimizeQueryPrompt` as
  an SDK/runtime capability.
- `python/qmd_graphrag/bridge.py#_run_dspy_optimize_query_prompt` builds a
  command for `finetune/experiments/gepa/dspy_gepa.py`.
- `finetune/experiments/gepa/dspy_gepa.py` defines a DSPy signature and module
  for query expansion and uses `dspy.GEPA` to compile an optimized program.
- `finetune/experiments/gepa/generate.py` can use a saved GEPA prompt to
  generate expansion records for topics.
- `catalog/data-bus.catalog.yaml` declares
  `dspy_query_prompt_optimization_request`,
  `optimized_query_prompt_artifact`, and `dspy_generated_expansion_record`.
- No `src/cli` command currently calls `optimizeQueryPrompt`.
- The online `qmd query` path still uses `LlamaCpp.expandQuery`; it does not
  automatically load or promote DSPy artifacts.

## Integration Relevance

The current implementation is a typed offline optimization bridge. It is not
yet a complete product workflow because there is no user-facing CLI command,
no artifact registry/promotion state, and no online query consumption path for
the optimized artifact.

## Constraints

Any implementation must preserve the existing Type DD model and avoid letting
raw prompt strings or unvalidated JSONL bypass typed query expansion contracts.
