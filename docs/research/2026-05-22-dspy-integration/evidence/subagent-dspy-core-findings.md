# Subagent DSPy Core Findings

Source: GPT-5.4 xhigh subagent public-source research.

## Findings

- `Signature` declares the behavior of an LM task as named inputs and outputs.
  It can be written inline or as a class with `InputField` and `OutputField`.
- `Module` is the basic program unit. It can compose predictors, submodules,
  and custom `forward()` logic into multi-stage pipelines.
- `Predict` is the simplest prediction module. More advanced modules build on
  this pattern.
- `ChainOfThought` adds a reasoning field before final output fields and is
  useful when explicit intermediate reasoning improves task behavior.
- `dspy.LM(...)` configures models; `dspy.configure(lm=...)` sets a default,
  and context-level overrides can adjust model behavior locally.
- `dspy.Example` stores named fields; `with_inputs(...)` marks the fields used
  as inputs while remaining fields act as labels or metadata.
- Optimizers compile a program from a program, metric, and training examples.

## Integration Relevance

qmd_graphrag query expansion should be modeled as an explicit DSPy signature
and module. The optimized program should produce typed expansion items rather
than free-form query strings crossing the qmd data bus.

## URLs Reported By Subagent

- <https://dspy.ai/>
- <https://dspy.ai/learn/programming/signatures/>
- <https://dspy.ai/learn/programming/modules/>
- <https://dspy.ai/learn/programming/language_models/>
- <https://dspy.ai/learn/optimization/optimizers/>
- <https://dspy.ai/api/primitives/Example/>
- <https://dspy.ai/api/modules/Module/>
- <https://dspy.ai/api/modules/ChainOfThought/>
- <https://arxiv.org/abs/2310.03714>
- <https://arxiv.org/abs/2406.11695>
- <https://arxiv.org/abs/2212.14024>
