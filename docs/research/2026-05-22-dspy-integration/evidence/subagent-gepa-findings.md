# Subagent GEPA Findings

Source: GPT-5.4 xhigh subagent public-source research.

## Findings

- GEPA is a reflective prompt optimizer that uses execution traces, errors,
  textual feedback, and a reflection model to propose prompt mutations.
- GEPA requires a DSPy program, a metric, a non-empty trainset, and either a
  reflection model or a custom instruction proposer.
- A separate valset is strongly preferred. Reusing trainset as valset behaves
  more like inference-time search and increases overfitting risk.
- Metrics for GEPA should return both score and textual feedback when possible.
  Query optimization should report retrieval misses, irrelevant captures,
  over-broad or over-narrow rewrites, and repeated source-query text.
- Official save/load flows preserve compiled DSPy programs. Logs, data splits,
  model versions, seeds, and corpus/index snapshots are required for
  reproducibility.
- Query prompt optimization should start with a narrow query generator module,
  not a full end-to-end RAG program.

## Integration Relevance

qmd_graphrag should add a CLI workflow that produces versioned optimization
artifacts, evaluates them against frozen qmd retrieval snapshots, and promotes
only passing artifacts to online query expansion.

## URLs Reported By Subagent

- <https://github.com/stanfordnlp/dspy/blob/main/docs/docs/api/optimizers/GEPA/overview.md>
- <https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md>
- <https://raw.githubusercontent.com/stanfordnlp/dspy/main/dspy/teleprompt/gepa/gepa.py>
- <https://dspy.ai/>
- <https://github.com/gepa-ai/gepa>
- <https://arxiv.org/abs/2507.19457>
- <https://openreview.net/forum?id=4oo6XTL6Oj>
