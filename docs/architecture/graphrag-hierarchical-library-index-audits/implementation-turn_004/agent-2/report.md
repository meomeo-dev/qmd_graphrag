# implementation-turn_004 agent-2 实施复审报告

auditDate: 2026-06-06
overallStatus: PASS_WITH_RISK

## 审计依据

- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 唯一规范设计入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 失败复核入口：
  `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_003/agent-3/report.md`

本轮重点复核 turn_003 agent-3 的 D09 阻断项：
upper typed error 未按 Type DD 输出 `exitCode`、`scopeKind`、`scopeId`、
`remediationCommand`、`timingAvailable`，且 CLI 进程退出码错误。

## 本轮复核命令

本 agent 实跑并通过：

- `npm run test:types`
- `npm run test:node -- test/cli-graphrag-query-scope.test.ts
  test/cli-graphrag-route.test.ts test/graphrag-bookshelf-graph.test.ts`
  ：3 files、17 tests passed。
- `python3 -m py_compile scripts/graphrag/bookshelf-graph-parquet-bridge.py
  scripts/graphrag/bookshelf_graph_bridge_*.py`
- `npm run build`
- 真实 smoke：
  `node dist/cli/qmd.js query --bookshelf-id software-architecture-core
  --graph-vault graph_vault --python-bin /tmp/qmd_missing_python_bin
  --json --timing "architecture"`

真实 smoke 返回：

- process exit code: `70`
- payload `code`: `upper_index_runtime_error`
- payload `exitCode`: `70`
- payload `retryable`: `true`
- payload `scopeKind`: `bookshelf`
- payload `scopeId`: `software-architecture-core`
- payload `remediationCommand`:
  `qmd library status --scope software-architecture-core --json`
- payload `timingAvailable`: `true`
- payload `metadata.diagnostics` 包含
  `upper_index_validation_runtime_error`

采纳主控已验证事实：

- `test/integrations/contracts.test.ts` 通过。
- 相关 vitest、类型检查、Python 编译、build 均通过。
- `src/cli/qmd.ts` 已去除 upper typed error payload 中覆盖
  `...upperError.retryable` 的三处 `retryable:false`。
- `test/cli-graphrag-query-scope.test.ts` 已断言
  `upper_index_runtime_error` 的 `retryable:true`。

## D09 专项结论

status: PASS

turn_003 的 D09 阻断项已修复。

证据：

- `src/cli/graphrag-query-scope.ts` 的
  `resolveUpperTypedQueryErrorDetails` 为 upper typed errors 统一映射
  `exitCode`、`scopeKind`、`scopeId`、`retryable`、
  `remediationCommand` 和 `timingAvailable`。
- `upper_index_runtime_error` 映射为 `exitCode=70`、
  `retryable=true`，符合 Type DD。
- `src/query/unified-router.ts` 的 `createTypedQueryError` 已透传
  upper 公共字段。
- `src/contracts/unified-query.ts` 的 `TypedQueryErrorSchema` 已接受
  `exitCode`、`scopeKind`、`scopeId`、`remediationCommand` 和
  `timingAvailable`。
- `src/cli/qmd.ts` 的 `exitWithError` 对 `TypedQueryErrorException`
  使用 payload 内 `exitCode` 作为进程退出码。
- `test/cli-graphrag-route.test.ts` 已覆盖缺失书架
  `upper_index_missing` 的 exit code 66 与公共字段。
- 同一测试文件已覆盖 book scope 与 bookshelf scope 歧义时
  `ambiguous_scope` 的 exit code 64 与公共字段。
- 本轮真实 runtime smoke 覆盖缺失 Python bridge 场景，确认
  `upper_index_runtime_error` 保留 `retryable:true`，未再被 CLI 层
  固定覆盖为 `retryable:false`。

结论：

- typed error exit code：满足。
- 公共字段：满足。
- `retryable=true`：满足。
- scope：满足，输出 `bookshelf/software-architecture-core`。
- timing：满足，输出 `timingAvailable:true`。
- remediation：满足，输出 status remediation command。

## D01_authority_boundaries 权威边界与热插包隔离

status: PASS_WITH_RISK

结论：

- 单书包仍由 `BOOK_MANIFEST.json`、`PUBLISH_READY.json` 和包内质量门
  判定权威状态。
- 书架图构建和查询产物限定在
  `graph_vault/catalog/bookshelves/{bookshelfId}` 派生根下。
- 既有测试覆盖书架构建不写入成员单书包闭包。

剩余风险：

- `bookshelfId` 仍是路径组成部分；面向不可信 CLI 输入时，应继续收紧
  path segment schema，拒绝 `/`、`..`、URL scheme 和盘符形式。

## D02_fixed_query_budget 固定查询预算

status: PASS_WITH_RISK

结论：

- 书架 manifest 记录固定预算，包括 semantic units、成员 community refs、
  deepening books 和 input token 上限。
- 查询路径使用已发布上层 community reports 和 evidence map，不在交互路径
  全量扫描成员单书 community reports。
- 超预算路径使用 `budget_exceeded_narrow_scope_required` fail-closed
  语义。

剩余风险：

- 当前书架 query bridge 对书架级 reports 做上层范围内打分后截断。对当前
  bounded bookshelf 可接受；扩大到 library 或大规模上层索引时，需要真正的
  vector/hybrid top-K 检索，避免上层报告数带来线性 I/O 和 CPU 成本。

## D03_graphrag_semantic_alignment GraphRAG 语义对齐

status: PASS_WITH_RISK

结论：

- 上层构建输入包含成员单书 `community_reports.parquet`。
- 书架产物包含 `semantic_units.parquet`、`semantic_edges.parquet`、
  `community_reports.parquet` 和 `evidence_map.parquet`。
- 查询回答基于预计算上层 community reports，而不是临时普通摘要检索。

剩余风险：

- 当前 edge 语义仍偏保守，主要体现 topic overlap 与 membership 关系。
  成员 `entities.parquet`、`relationships.parquet` 的深度 lineage 仍需增强。

## D04_evidence_traceability 证据可追溯

status: PASS_WITH_RISK

结论：

- evidence map schema 覆盖 book、source、document、content hash、
  community report 和 text unit 级别引用。
- 查询输出能把上层回答证据投影为 UnifiedAnswer evidence。
- 相关测试覆盖 bookId、sourceId、documentId、contentHash、text unit 与
  locator 字段。

剩余风险：

- validator 仍应补强 semantic unit、edge、report 到 evidence map 的双向
  referential integrity 检查。

## D05_state_recovery 状态闭环与恢复

status: PASS_WITH_RISK

结论：

- 构建使用 staging generation，并在 manifest、quality gate、diagnostics、
  events、status、recovery summary 和 checkpoints 可用后发布 current。
- partial build 不会发布 query-ready 上层索引。
- 成员 manifest sha 变化会被标记为 stale，并映射为 upper typed error。

剩余风险：

- 当前恢复机制具备 durable state 和重跑基础，但 interrupted build resume
  仍偏保守，尚未形成细粒度恢复流程。

## D06_quality_gates 质量门

status: PASS_WITH_RISK

结论：

- 书架质量门覆盖 manifest、成员 gate、semantic schema、evidence lineage、
  embedding fingerprint、fixed budget、sensitive scan 和 stale marker。
- 查询路径在 manifest/gate 缺失、validator 失败或 gate 非 query-ready 时
  快速返回 upper typed error。

剩余风险：

- library 质量门仍未完整实现；当前实现未声明 library query-ready，因此不构成
  本轮阻断。
- 部分质量门检查仍偏声明式，应继续加强 evidence lineage 与 sensitive scan
  的实际验证深度。

## D07_incremental_scaling 增量扩展

status: PASS_WITH_RISK

结论：

- generation hash 纳入 builder version、bookshelf id、membership generation、
  member manifest sha 和预算配置。
- manifest 记录 membership digest、members digest、decisions digest、
  split plan digest 和成员 manifest sha。
- 成员 manifest 改变时不会静默复用旧上层索引。

剩余风险：

- 当前书架图构建仍以保守全量重建为主。library 规模扩大后，需要按受影响
  semantic unit、community 或 bookshelf 分区做增量刷新。

## D08_security_privacy 安全与隐私

status: PASS_WITH_RISK

结论：

- manifest 声明 forbidden inputs 和 sensitivity policy。
- manifest file closure 使用相对 locator，不应包含绝对路径或 query log。
- 构建与质量门包含敏感信息扫描要求。

剩余风险：

- 书架 parquet bridge runtime stderr 进入
  `upper_index_runtime_error` 前仍应复用单书 Python bridge 的 redaction
  策略，降低异常路径泄漏本地路径或 provider payload 的风险。

## D09_cli_operability CLI 可操作性与降级

status: PASS

结论：

- scope resolution 已覆盖显式 book 与显式 bookshelf 的互斥错误。
- 缺失书架索引快速返回 `upper_index_missing`，进程退出码为 66。
- 运行时上层索引错误快速返回 `upper_index_runtime_error`，进程退出码为 70。
- `upper_index_runtime_error` payload 保留 `retryable:true`。
- upper typed error payload 包含 Type DD 要求的 scope、timing 和 remediation
  公共字段。
- `--timing` 场景输出 `timingAvailable:true`，不会长时间无输出或隐式重建
  upper index。

阻断项：

- 无。

## D10_testability 可测试性

status: PASS_WITH_RISK

结论：

- 已有测试覆盖书架构建、manifest/gate、parquet schema、sidecar、单书包
  非污染、capabilities、evidence lineage、CLI method resolution 和 upper
  typed error 字段。
- 本轮新增或确认的回归测试覆盖 turn_003 D09 失败根因：
  `upper_index_runtime_error retryable:true`。
- 主控已验证集成合同测试通过。

剩余风险：

- 仍缺更大规模 library 固定预算模拟、stale upper index CLI smoke、
  sensitive negative fixture 和 evidence map 全量 referential integrity 测试。

## 总结

turn_003 agent-3 标记的 D09 阻断项已修复。当前实现满足 upper typed error
exit code、公共字段、`retryable=true`、scope、timing 与 remediation 合同。

本轮未发现新的阻断项。由于 library 质量门、真正大规模 top-K 检索、增量刷新、
异常路径 redaction 和 evidence referential integrity 仍有后续工程风险，整体
结论为 `PASS_WITH_RISK`。
