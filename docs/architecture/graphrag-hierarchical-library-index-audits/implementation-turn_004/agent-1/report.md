# implementation-turn_004 agent-1 实施复审报告

auditDate: 2026-06-06
overallStatus: PASS_WITH_RISK

## 审计依据

- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 唯一规范设计入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 失败复核来源：
  `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_003/agent-3/report.md`

本轮重点复核 turn_003 D09 失败项：upper typed error 的 exit code、
公共字段（common fields）、`retryable=true`、scope、timing 与
remediation 是否满足 Type DD 合同。

## 验证摘要

采纳主控已验证事实：

- `src/cli/qmd.ts` 已去除 upper typed error payload 中覆盖
  `...upperError.retryable` 的三处 `retryable:false`。
- `test/cli-graphrag-query-scope.test.ts` 已断言
  `upper_index_runtime_error` 为 `retryable:true`。
- `npm run test:types`、相关 vitest、integration contracts、
  Python bridge `py_compile`、`npm run build` 均通过。
- 真实 smoke 中缺失 Python bridge 路径返回
  `upper_index_runtime_error`，exit code 70，`retryable:true`，
  `scopeKind=bookshelf`，`scopeId=software-architecture-core`，
  且 `remediationCommand` 与 `timingAvailable` 存在。

本 agent 复核命令：

- `npm run test:node -- test/cli-graphrag-query-scope.test.ts`：
  5 tests passed。
- `node dist/cli/qmd.js query --bookshelf-id
  __missing_bookshelf_for_turn004_agent1__ --graph-vault graph_vault --json
  --timing "architecture"`：
  exit code 66，payload code `upper_index_missing`，包含 `exitCode`、
  `scopeKind`、`scopeId`、`retryable:false`、`remediationCommand`、
  `timingAvailable:true`。
- `node dist/cli/qmd.js query --bookshelf-id software-architecture-core
  --graph-vault graph_vault --python-bin /tmp/qmd_missing_python_bin --json
  --timing "architecture"`：
  exit code 70，payload code `upper_index_runtime_error`，
  `retryable:true`，`scopeKind=bookshelf`，
  `scopeId=software-architecture-core`，
  `remediationCommand="qmd library status --scope software-architecture-core --json"`，
  `timingAvailable:true`。

实现侧复核结果：

- `src/cli/graphrag-query-scope.ts` 中
  `resolveUpperTypedQueryErrorDetails` 按 Type DD 映射
  `missing_scope/ambiguous_scope/budget_exceeded_narrow_scope_required=64`，
  `upper_index_stale/upper_quality_gate_failed=65`，
  `upper_index_missing=66`，`upper_index_runtime_error=70`。
- `upper_index_runtime_error` 映射为 `retryable:true`。
- `src/contracts/unified-query.ts` 的 `TypedQueryErrorSchema` 已包含
  `exitCode`、`scopeKind`、`scopeId`、`remediationCommand`、
  `timingAvailable`。
- `src/cli/qmd.ts` 的 `exitWithError` 对 `TypedQueryErrorException`
  使用 `error.payload.exitCode` 退出。

结论：turn_003 D09 的阻断失败已修复。

## D01-D10 逐项结论

| id | status | 结论 |
| --- | --- | --- |
| D01_authority_boundaries | PASS | 书架图产物发布在 `graph_vault/catalog/bookshelves/{bookshelfId}`，不写回单书包文件闭包；单书 query-ready 权威仍来自单书 `BOOK_MANIFEST.json`、`PUBLISH_READY.json` 和包内 gate。 |
| D02_fixed_query_budget | PASS_WITH_RISK | `BOOKSHELF_MANIFEST.json.fixedQueryBudget` 记录固定预算，书架查询读取已发布上层 reports 并按预算截断；后续大规模 library 仍需要真正的 vector/hybrid top-K 来避免上层报告数增长带来的 CPU/I/O 风险。 |
| D03_graphrag_semantic_alignment | PASS_WITH_RISK | 上层构建使用成员书 community reports，并发布 `semantic_units`、`semantic_edges`、`community_reports`；当前 edge 语义仍偏保守，真实 entity/relationship lineage 还可增强。 |
| D04_evidence_traceability | PASS_WITH_RISK | `evidence_map.parquet` 覆盖 book/source/document/content hash/community report/text unit 回链字段，真实 current 记录 row count 131；建议后续加强 semantic unit/report/edge 到 evidence map 的双向引用完整性校验。 |
| D05_state_recovery | PASS_WITH_RISK | 构建具备 staging、manifest、quality gate、sidecar、diagnostics、events/status/checkpoints 与发布防护；真正的 interrupted build resume 仍主要是后续能力。 |
| D06_quality_gates | PASS_WITH_RISK | 书架 quality gate 和 required checks 已实现并可阻断查询；library gate 在 Type DD 中定义但尚未实现，当前未宣称 library query-ready，不构成本轮阻断。 |
| D07_incremental_scaling | PASS_WITH_RISK | generation 与 member manifest sha256 已记录，成员变化可 stale；当前书架图仍以保守全量重建为主，增量刷新是后续扩展风险。 |
| D08_security_privacy | PASS_WITH_RISK | manifest 声明 forbidden fields 和 scope-relative locator rule，builder/validator 具备敏感扫描与路径约束；Python bookshelf bridge 错误 stderr 的脱敏深度仍建议与既有 `python-bridge.ts` 对齐。 |
| D09_cli_operability | PASS | turn_003 失败项已修复。upper typed errors 现在有合同 exit code、公共字段、scope、remediation 与 timing 标记；`upper_index_runtime_error` 为 `retryable:true`，真实 CLI smoke 返回 exit code 70。 |
| D10_testability | PASS_WITH_RISK | 已有 helper 测试、CLI route 测试、书架 graph 测试、integration contracts、typecheck、build 与真实 smoke 覆盖 D09 回归；后续仍需补不同规模 library 固定预算、stale upper index、敏感负向 fixture 和 evidence referential integrity 的系统测试。 |

## D09 详细判定

status: PASS

turn_003 记录的失败是：缺失 upper index 时 typed JSON 缺少 Type DD 公共字段，
进程 exit code 为 1，且 runtime failure 可能未保留正确 upper code 与
retryable 语义。

本轮复核确认：

- `upper_index_missing`：exit code 为 66，payload 含 `exitCode=66`、
  `scopeKind=bookshelf`、`scopeId`、`retryable=false`、
  `remediationCommand`、`timingAvailable=true`。
- `upper_index_runtime_error`：exit code 为 70，payload 含 `exitCode=70`、
  `scopeKind=bookshelf`、`scopeId=software-architecture-core`、
  `retryable=true`、`remediationCommand`、`timingAvailable=true`。
- `TypedQueryErrorException` 不再落入默认 exit code 1；CLI 按 payload
  `exitCode` 退出。
- `--json --timing` 错误路径能暴露 timing availability，不触发隐式重建、
  全库扫描或长时间无输出。

D09 合同满足。

## 阻断项

无。

## 后续风险

- library membership、library graph build、library scoped query 仍是 Type DD
  已定义但未实现的能力，应避免把书架部分实现误判为全 library ready。
- 书架查询当前是固定预算 community report 检索，不包含 LLM synthesis 或
  bounded deepening；这是已声明的部分实现边界。
- 大规模上层索引应补真正的 vector/hybrid top-K、增量刷新和更强 evidence
  referential integrity 校验。
- 上层 bridge runtime stderr 建议统一复用或等价实现既有 provider payload、
  secret、绝对路径脱敏策略。
