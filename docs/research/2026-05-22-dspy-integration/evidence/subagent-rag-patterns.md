# Subagent RAG Pattern Findings

Source: GPT-5.4 xhigh subagent public-source research.

## Findings

- DSPy represents RAG as a program graph rather than a fixed template.
- Common RAG components map to query rewriting, retrieval, optional reranking,
  answer synthesis, and metric-driven optimization.
- Query rewriting can be modeled as an explicit DSPy subtask such as
  `context, question -> search query` or multi-hop query generation.
- Retrieval is usually an injected backend, such as `dspy.Retrieve`, a custom
  `search()` function, or a ColBERT-backed retriever.
- Reranking is not emphasized as a first-class primitive in the same way as
  retrieval and answer synthesis; it is usually modeled as a custom module or
  external late-interaction step.
- Offline DSPy artifacts should be treated as a versioned policy layer.
  Runtime bindings such as index version, embedding model, reranker, top-k,
  schema validator, cache, and timeout remain separate.
- Evaluation should be layered: retrieval quality, answer quality, and
  pipeline cost/latency/citation completeness.
- DSPy signatures are useful soft interfaces, but they do not replace hard
  JSON Schema validation in a schema-first system.

## Integration Relevance

qmd_graphrag should keep DSPy at the strategy optimization boundary. The data
bus should validate generated expansions with Type DD schemas before online
retrieval consumes them.

## URLs Reported By Subagent

- <https://dspy.ai/>
- <https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/programming/modules.md>
- <https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md>
- <https://github.com/stanfordnlp/dspy/blob/main/docs/docs/faqs.md>
- <https://arxiv.org/abs/2305.14283>
- <https://arxiv.org/abs/2404.13781>
- <https://arxiv.org/abs/2408.08067>
- <https://arxiv.org/abs/2311.09476>
- <https://arxiv.org/abs/2104.08663>
