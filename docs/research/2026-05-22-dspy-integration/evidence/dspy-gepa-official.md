# DSPy GEPA Official Evidence

Source: <https://github.com/stanfordnlp/dspy/blob/main/docs/docs/api/optimizers/GEPA/overview.md>

## Facts

- `dspy.GEPA` is a reflective prompt optimizer based on Genetic-Pareto
  evolution.
- GEPA evolves textual components such as prompts for arbitrary systems.
- GEPA can use both scalar scores and textual feedback supplied by the metric.
- The metric should return a `dspy.Prediction` with `score` and `feedback`.
- With `track_stats=True`, GEPA returns detailed metadata in
  `optimized_program.detailed_results`.
- GEPA can also operate as inference-time search when `valset` is the
  evaluation batch and `track_best_outputs=True`.

## Integration Relevance

qmd_graphrag should treat GEPA output as an auditable optimization artifact.
The online query path should consume a selected compiled artifact by version,
not run GEPA on every user query.

## Constraints

GEPA depends heavily on metric quality. For query expansion, the metric must
evaluate retrieval-oriented behavior, not just textual fluency.
