# implementation-turn_020 agent-2 实施审计报告

## 审计范围

本报告按固定基准
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
复核 D01-D10。复核重点为负向与失效路径：
`upper_package_migration_required`、missing/stale/failed/staging/over-budget
typed errors、synthesis budget fail-closed、查询路径不隐式 build/repair、
catalog 与 `batch-runs` 不作为语义输入、`CURRENT.json`、
`PUBLISH_READY.json`、manifest、quality gate 与 sha256 状态闭环。

采用主线程已执行证据：真实 bookshelf/library package 构建与 repair；
删除或不依赖 catalog projection 的显式上层查询；真实 `--upper-synthesis`
成功；200 output budget fail-closed；真实单书 `--graph-book-id` 成功；
单书 package/runtime gate 成功；聚焦测试与 YAML parse 通过。

## 固定维度结论

- D01_authority_boundaries: PASS
- D02_fixed_query_budget: PASS
- D03_graphrag_semantic_alignment: PASS
- D04_evidence_traceability: PASS
- D05_state_recovery: PASS
- D06_quality_gates: PASS
- D07_incremental_scaling: PASS
- D08_security_privacy: PASS
- D09_cli_operability: PASS
- D10_testability: PASS

## 复核要点

`readQueryReadyPackage()` 以 `graph_vault/bookshelves/{id}/` 与
`graph_vault/library/{id}/` 为查询权威根。缺少上层 package root 且仅存在
legacy catalog 产物时返回 `upper_package_migration_required`。查询路径先校验
`CURRENT.json`、`PUBLISH_READY.json`、root/generation manifest、root/generation
quality gate 与 sha256 sidecar；不通过时快速返回 typed error，不进入语义查询。

bookshelf/library 查询入口只调用 package-local readiness validation 与固定预算
bridge 查询。未发现查询路径调用 `build*Graph()`、`resolve*Membership()` 或
`repair`。catalog projection 仅在构建发布后重建，status/list 中声明
`catalogProjectionIsAuthority: false`；`catalog/batch-runs` 未作为上层语义输入。

上层 synthesis 为显式 `--upper-synthesis`，默认关闭。实现只对已选 upper
evidence 调用一次 runner，先按 package-local input/output budget 收窄；请求预算
超过 package budget、首条证据无法纳入预算、runner 缺失、runner token 回报超限
均 fail-closed 到 `budget_exceeded_narrow_scope_required` 或
`upper_index_runtime_error`。CLI runner 将 `input.maxOutputTokens` 传给
`session.generate({ maxTokens })`，OpenAI Responses 请求体包含
`max_output_tokens`，测试断言覆盖该字段。

发布索引包含 `semantic_units`、`semantic_edges`、`communities`、
`community_reports` 与 `evidence_map`。回答 evidence 暴露 `bookId`、`sourceId`、
`documentId`、`contentHash`、`graphTextUnitId` 与 community report artifact。
library 由已发布 bookshelf package 构建，成员 manifest sha256 与 generation
参与 stale 检测。

敏感信息路径满足当前合同。构建阶段对 manifest 与 quality gate 扫描 forbidden
fields；查询 validation 通过 parquet inspect 捕获 provider payload、raw prompt、
raw completion、绝对路径等污染，并返回 `upper_quality_gate_failed`。synthesis
response 不保留 prompt、completion 或 provider payload，metadata 经
`sanitizeVaultMetadata()` 处理。

## Required Fixes

无。

## Final Verdict

PASS
