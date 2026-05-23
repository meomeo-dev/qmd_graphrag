# DSPy 集成研究报告入口

状态：superseded redirect。当前准生产规范以
`dspy-integration-plan-v10.md` 为准；本文只作为入口指针，不承载独立契约。

## 当前规范

- 当前版本：`dspy-integration-plan-v10.md`
- 当前职责：DSPy 只负责离线查询扩展策略优化
  （offline query expansion policy optimization）
- 当前线上入口：`qmd query` 只消费 active pointer 指向的 promoted decision
- 当前生命周期入口：`qmd dspy optimize-query-prompt`、
  `qmd dspy evaluate-expansion-policy`、
  `qmd dspy promote-expansion-policy`、
  `qmd dspy rollback-expansion-policy`、
  `qmd dspy disable-expansion-policy`

历史版本 `dspy-integration-plan-v01.md` 至 `dspy-integration-plan-v09.md`
仅保留迭代记录，不构成当前实现契约。
