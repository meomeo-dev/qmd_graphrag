# DSPy RAG Pattern Evidence

Source: <https://dspy.ai/>

## Facts

- The official DSPy overview includes a RAG example where a `search` function
  retrieves context and a `dspy.ChainOfThought("context, question -> response")`
  module generates an answer.
- The official overview states that a RAG program can be optimized with a
  trainset of questions and ground-truth responses.
- The official overview shows `dspy.evaluate.SemanticF1` as a metric for RAG
  long-output optimization.
- DSPy can optimize intermediate modules as long as the final output can be
  evaluated.

## Integration Relevance

For qmd_graphrag, DSPy can optimize query expansion, graph-route prompting, or
answer synthesis modules, but each optimized component needs a typed input,
typed output, and metric contract.

## Constraints

qmd should not optimize all RAG stages in one opaque program first. Query
expansion is the safest initial boundary because it already has a compact
typed output shape: lexical, vector, and HyDE query variants.
