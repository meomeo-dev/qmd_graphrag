# Query Rewriting RAG Evidence

Source: <https://arxiv.org/abs/2305.14283>

## Facts

- "Query Rewriting for Retrieval-Augmented Large Language Models" proposes a
  rewrite-retrieve-read framing for retrieval augmented generation.
- The paper treats query rewriting as an upstream step before retrieval and
  reading.
- This supports the general pattern that query transformation can improve RAG
  retrieval quality when evaluated against downstream task performance.

## Integration Relevance

qmd query expansion is a concrete form of query rewriting. DSPy should optimize
the query transformation policy offline, then the online qmd retriever should
consume the compiled expansion policy deterministically.

## Constraints

The paper is a general RAG query rewriting reference. It does not prescribe
DSPy-specific implementation or qmd-specific schemas.
