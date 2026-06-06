# 书架图查询实施复审摘要

## 结论

`implementation-turn_004` 通过，整体状态为 `PASS_WITH_RISK`。3 个 agent
均按固定 D01-D10 基准复审，并确认 `implementation-turn_003` 的 D09 阻断项
已经修复。

## 已修复阻断项

turn_003 的 D09 失败点是 upper typed error 没有完整输出 Type DD 要求的
公共字段，并且 CLI 进程退出码没有使用 payload 内 `exitCode`。本轮复审确认：

- `upper_index_missing` 返回 exit code `66`。
- `upper_index_runtime_error` 返回 exit code `70`。
- typed error payload 包含 `exitCode`、`scopeKind`、`scopeId`、
  `retryable`、`remediationCommand` 和 `timingAvailable`。
- `upper_index_runtime_error` 保留 `retryable: true`，不再被 CLI 层覆盖为
  `false`。
- `TypedQueryErrorException` 使用 payload 内 `exitCode` 作为进程退出码。

## 验证记录

主控与复审 agent 已验证：

- `npm run test:types`
- `test/cli-graphrag-query-scope.test.ts`
- `test/cli-graphrag-route.test.ts`
- `test/graphrag-bookshelf-graph.test.ts`
- `test/integrations/contracts.test.ts`
- bookshelf Python bridge `py_compile`
- `npm run build`
- 真实 runtime error smoke：
  `qmd query --bookshelf-id software-architecture-core --graph-vault graph_vault
  --python-bin /tmp/qmd_missing_python_bin --json --timing "architecture"`

真实 runtime error smoke 结果为 exit code `70`，payload code 为
`upper_index_runtime_error`，并包含 `retryable: true`、scope、remediation 和
timing 字段。

## 通过报告

- `implementation-turn_004/agent-1/report.md`
- `implementation-turn_004/agent-2/report.md`
- `implementation-turn_004/agent-3/report.md`

## 阶段边界

本轮确认 `bookshelf_membership_resolution`、
`materialized_bookshelf_graph_build` 和 `--bookshelf-id` fixed-budget 查询已闭环。
`library_membership_resolution`、`library_graph_build`、`--library-id` 查询、
library 质量门和不同规模 library 固定预算测试仍属于后续阶段，不能被本轮
结果误判为已完成。
