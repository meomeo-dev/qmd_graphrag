# GraphRAG 层级 Library 索引审计基准

本目录保存固定设计审计基准。所有后续审计轮次必须读取并复用
`evaluation-dimensions.yaml` 中的 10 个维度。

审计输出要求：

- 每个 agent 在独立目录 `design-turn_*/agent-*` 下保存 `report.md`。
- 报告必须逐项引用 D01-D10。
- 报告只能给出 `pass`、`pass_with_minor_notes` 或 `fail`。
- 若任一维度为 `fail`，该 agent 总体结论必须为 `fail`。
- 后续修订不得修改 base 基准，除非开启新的设计任务。
