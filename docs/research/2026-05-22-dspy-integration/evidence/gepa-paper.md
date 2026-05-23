# GEPA Paper Evidence

Source: <https://arxiv.org/abs/2507.19457>

## Facts

- The paper title is "GEPA: Reflective Prompt Evolution Can Outperform
  Reinforcement Learning".
- The arXiv page shows version 2 revised on 2026-02-14 and notes acceptance to
  ICLR 2026 Oral.
- The abstract describes GEPA as a prompt optimizer that uses natural language
  reflection over trajectories, tool calls, outputs, and failures.
- The paper reports that GEPA can obtain large quality gains from a small
  number of rollouts and reports fewer rollouts than GRPO in the studied tasks.

## Integration Relevance

GEPA is appropriate for offline optimization of qmd query expansion prompts
because qmd can expose retrieval traces and metric feedback as text, not only
scalar scores.

## Constraints

The paper's benchmark claims do not automatically transfer to qmd_graphrag.
qmd_graphrag needs its own retrieval evaluation set, budget controls, and
artifact promotion gates.
