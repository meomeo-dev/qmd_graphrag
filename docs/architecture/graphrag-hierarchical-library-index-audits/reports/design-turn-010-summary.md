# 书架 membership 设计审计摘要

## 结论

第 10 轮设计复审通过。3 个 agent 均按固定基准
`base/evaluation-dimensions.yaml` 判定 D01-D10 全部 PASS。

## 收敛点

- `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 是 membership-only handoff manifest。
- `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 的 `queryReady` 必须为 false。
- `BOOKSHELF_MANIFEST.json` 只能由 `materialized_bookshelf_graph_build`
  在上层 GraphRAG 产物和书架质量门通过后发布。
- membership 阶段状态闭环覆盖 manifest、checksum、quality gate、
  diagnostics、events、status、checkpoints 和 recovery summary。
- handoff reject 条件覆盖 membership manifest 缺失、checksum mismatch、
  `queryReady` 非 false、成员 digest mismatch、decision digest mismatch、
  split plan digest mismatch 和 membership quality gate 失败。

## 通过报告

- `design-turn_010/agent-1/report.md`
- `design-turn_010/agent-2/report.md`
- `design-turn_010/agent-3/report.md`

## 后续边界

本摘要只确认 `bookshelf_membership_resolution` 设计闭环。书架级
GraphRAG 派生索引、`BOOKSHELF_MANIFEST.json`、`--bookshelf-id` 查询、
library membership 和 library 图构建仍属于后续阶段。
