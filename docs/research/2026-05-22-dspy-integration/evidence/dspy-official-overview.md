# DSPy Official Overview Evidence

Source: <https://dspy.ai/>

## Facts

- DSPy defines itself as a declarative framework for modular AI software,
  focused on structured code rather than brittle prompt strings.
- DSPy separates task interface from prompting implementation by using
  signatures and modules.
- `dspy.LM` configures providers. The official examples include OpenAI,
  Anthropic, Gemini, Databricks, local models, and OpenAI-compatible endpoints.
- Core modules include `dspy.Predict`, `dspy.ChainOfThought`, `dspy.ReAct`,
  and custom `dspy.Module` subclasses.
- DSPy optimizers compile programs into prompts or weights from representative
  inputs and metrics. The official overview names `BootstrapRS`, `GEPA`,
  `MIPROv2`, and `BootstrapFinetune`.

## Integration Relevance

DSPy fits qmd_graphrag as a typed optimization subsystem because it models LM
programs as signatures, modules, trainsets, metrics, and compiled artifacts.
That maps cleanly to Type DD payloads and avoids untyped prompt string mutation
inside the online retrieval path.

## Constraints

DSPy optimization is cost-bearing and dataset-dependent. The official overview
warns that optimization cost varies with model, dataset, and configuration.
