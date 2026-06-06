# implementation-turn_004 agent-3 实施复审报告

auditDate: 2026-06-06
overallStatus: PASS_WITH_RISK

## 审计边界

本轮复审固定使用
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
的 D01-D10 基准，并以
`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml` 作为唯一规范
设计入口。

重点复核 turn_003 agent-3 报告中的 D09 阻断项：

- upper typed error 的合同退出码 (exit code)。
- typed error 公共字段：`exitCode`、`scopeKind`、`scopeId`、
  `remediationCommand`、`timingAvailable`。
- `upper_index_runtime_error` 的 `retryable=true`。
- 书架 scope、timing 与 remediation 输出是否满足 Type DD 合同。

本 agent 未修改 `agent-3/report.md` 以外文件。工作树中已有其他 agent 或主控
改动，未回退、未整理。

## 复核命令

- `npm run test:node -- test/cli-graphrag-query-scope.test.ts
  test/cli-graphrag-route.test.ts`：16 tests passed。
- `node dist/cli/qmd.js query --bookshelf-id software-architecture-core
  --graph-vault graph_vault --python-bin /tmp/qmd_missing_python_bin --json
  --timing "architecture"`：exit code 70，payload 为
  `upper_index_runtime_error`，`retryable=true`。
- `node dist/cli/qmd.js query --bookshelf-id
  __missing_bookshelf_for_turn004_agent3__ --graph-vault graph_vault --json
  --timing "architecture"`：exit code 66，payload 为 `upper_index_missing`。
- `node dist/cli/qmd.js query --bookshelf-id software-architecture-core
  --graph-vault graph_vault --python-bin /Users/jin/.pyenv/shims/python3
  --json --timing "architecture"`：exit code 0，返回书架固定预算查询结果。

主控已验证的 `npm run test:types`、相关 vitest、contracts test、Python
`py_compile`、`npm run build` 和 runtime smoke 事实纳入本轮结论。

## D01_authority_boundaries 权威边界与热插包隔离

status: PASS

书架索引仍发布在 `graph_vault/catalog/bookshelves/{bookshelfId}` 派生根下；
单书权威继续来自 `BOOK_MANIFEST.json`、`PUBLISH_READY.json` 和包内质量门。
测试覆盖书架构建不写入成员单书包闭包。catalog 上层索引缺失、损坏或 stale
不会改变单书包 query-ready 判定。

## D02_fixed_query_budget 固定查询预算

status: PASS_WITH_RISK

书架 manifest 和 quality gate 记录固定预算，查询路径消费已发布的书架级
community reports 与 evidence map，并按固定 top-K/预算返回结果。成功 smoke
显示 `selectedReportCount=4`、`estimatedInputTokens=1184`、
`maxInputTokens=64000`、`llmCalls=0`。

剩余风险：当前书架 query bridge 对书架级 reports 做本地打分后截断。对现有
bounded bookshelf 可接受；更大 library 规模仍需要真正的 vector/hybrid top-K
召回，避免上层报告数增长时 CPU/I/O 线性放大。

## D03_graphrag_semantic_alignment GraphRAG 语义对齐

status: PASS_WITH_RISK

构建输入包含成员单书 community reports，并生成书架级 `semantic_units`、
`semantic_edges`、`communities` 和 `community_reports`。查询回答基于预计算
书架级 community reports，不退化为原文全文扫描。

剩余风险：当前 edge builder 仍主要依赖语义单元重叠和 membership 关系；
成员 `entities.parquet` 与 `relationships.parquet` 已进入合同和校验边界，
但真实 relationship lineage 仍需加强。

## D04_evidence_traceability 证据可追溯

status: PASS_WITH_RISK

`evidence_map.parquet` 覆盖 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report 与 text unit 引用。成功查询输出 evidence，
并暴露书架 scope、成员 book、source/document/content hash、text unit 和上层
community report metadata。

剩余风险：validator 已检查 schema、row count 和 stale，但尚未完全验证每个
`evidenceMapIds` 与 evidence row 的双向引用完整性。

## D05_state_recovery 状态闭环与恢复

status: PASS_WITH_RISK

书架构建使用 staging generation，质量门和 validator 通过后才发布 current；
产物包含 events、status、recovery summary、checkpoints 与 sidecar digest。
成员 manifest sha 变化会触发 stale 诊断并拒绝默认查询。

剩余风险：当前更接近可重跑恢复；中断后按 checkpoint 精确 resume 的能力仍不
完整。

## D06_quality_gates 质量门

status: PASS_WITH_RISK

书架质量门存在并要求 `readyState=bookshelf_query_ready`、`queryReady=true`、
checks passed 和 fixed budget simulation passed。查询层在 gate 缺失、失败或
validator 失败时快速返回 upper typed error。

剩余风险：library quality gate 仍未实现，但当前实现未宣称 library query-ready。
部分检查仍偏声明式，尤其 evidence lineage 与敏感信息扫描的深度可继续加强。

## D07_incremental_scaling 增量扩展

status: PASS_WITH_RISK

书架 generation 记录 membership generation、成员 manifest sha、members digest、
decisions digest、split plan digest 和预算配置。成员变化会标记 stale，不会
静默复用旧 generation。查询阶段保持固定预算。

剩余风险：书架图构建仍是保守全量重建，尚未实现按受影响 semantic units 或
communities 的增量刷新。

## D08_security_privacy 安全与隐私

status: PASS_WITH_RISK

manifest 声明 sensitivity policy 和 forbidden fields，文件闭包使用相对路径，
质量门包含 sensitive scan。主控验证未发现 provider payload、原始 prompt、
原始 completion、密钥、绝对路径或 query.log 进入可发布上层 manifest/index。

剩余风险：书架 parquet bridge 的失败 stderr 仍应复用更完整的 redaction 逻辑，
避免未来 runtime diagnostics 泄露本地路径或 provider payload。

## D09_cli_operability CLI 可操作性与降级

status: PASS

turn_003 的 D09 阻断项已修复。

确认结果：

- `resolveUpperTypedQueryErrorDetails` 已按 Type DD 映射 upper typed error：
  `upper_index_missing=66`、`upper_index_stale=65`、
  `upper_quality_gate_failed=65`、
  `budget_exceeded_narrow_scope_required=64`、
  `upper_index_runtime_error=70`。
- `TypedQueryErrorSchema` 和 `createTypedQueryError` 已支持
  `exitCode`、`scopeKind`、`scopeId`、`remediationCommand`、
  `timingAvailable`。
- `exitWithError` 对 `TypedQueryErrorException` 使用
  `error.payload.exitCode` 退出，不再固定为 1。
- `src/cli/qmd.ts` 的 bookshelf capability 与 query error 映射保留
  `...upperError` 中的 `retryable`，未再用 `retryable:false` 覆盖
  `upper_index_runtime_error`。
- 缺失书架 smoke 返回 exit code 66，payload 含
  `code=upper_index_missing`、`exitCode=66`、`scopeKind=bookshelf`、
  `scopeId=__missing_bookshelf_for_turn004_agent3__`、
  `retryable=false`、`remediationCommand=qmd library build --scope ...`、
  `timingAvailable=true`。
- runtime error smoke 返回 exit code 70，payload 含
  `code=upper_index_runtime_error`、`exitCode=70`、
  `scopeKind=bookshelf`、`scopeId=software-architecture-core`、
  `retryable=true`、
  `remediationCommand=qmd library status --scope software-architecture-core
  --json`、`timingAvailable=true`。
- 成功书架查询返回 timing breakdown，包含
  `cli.prepare_graphrag_query`、
  `route.resolve_graph_scope_capabilities`、`route.decide`、
  `cli.query_bookshelf_upper_index`、`route.query_graphrag_provider` 和
  `route.build_answer`。

结论：D09 typed error exit code、公共字段、`retryable=true`、scope、timing 与
remediation 均满足当前 Type DD 合同。

## D10_testability 可测试性

status: PASS_WITH_RISK

测试已覆盖 GraphRAG CLI route、书架 query scope helper、missing upper index
typed error、book/bookshelf scope ambiguity、runtime error helper 映射、书架
图产物、contracts、Python bridge 编译和 build。D09 已有端到端回归断言：
缺失书架 exit code 66 与公共字段，以及 helper 层 runtime error exit code 70、
`retryable=true`。

剩余风险：仍建议补 stale upper index CLI、budget exceeded CLI、不同规模
library 固定预算、敏感负向 fixture、删除 upper catalog 后单书查询非回归，以及
evidence_map 全量 referential integrity 测试。

## 总结

turn_003 agent-3 标记的 D09 阻断项已修复。当前未发现新的阻断项。由于
library 层实现、增量刷新、深层 entity/relationship lineage、全量 evidence
引用校验和部分安全扫描仍有后续工程风险，本轮 overallStatus 判定为
PASS_WITH_RISK。
