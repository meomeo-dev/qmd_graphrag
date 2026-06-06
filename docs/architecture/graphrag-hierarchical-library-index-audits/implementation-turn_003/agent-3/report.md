# implementation-turn_003 agent-3 实施审计报告

auditDate: 2026-06-06
overallStatus: FAIL_D09_ONLY

## 审计边界

审计对象包括：

- `src/graphrag/upper-index/bookshelf-query.ts`
- `src/graphrag/upper-index/bookshelf-graph-contracts.ts`
- `src/graphrag/upper-index/bookshelf-graph-validator.ts`
- `src/graphrag/upper-index/bookshelf-graph-parquet.ts`
- `src/graphrag/upper-index/bookshelf-graph.ts`
- `src/cli/qmd.ts`
- `src/cli/graphrag-query-scope.ts`
- `src/integrations/python-bridge.ts`
- `scripts/graphrag/bookshelf_graph_bridge_*.py`
- `test/graphrag-bookshelf-graph.test.ts`
- `test/cli-graphrag-query-scope.test.ts`
- 真实产物
  `graph_vault/catalog/bookshelves/software-architecture-core/current`

固定复用 base D01-D10 维度。`--library-id`、library build、LLM synthesis
和受控下钻在 Type DD 中仍标记为未实现，不作为本轮失败项。

仓库内未找到落盘 `AGENTS.md`；本轮使用对话中提供的 AGENTS 指令块作为
项目约束。已读取 Type DD、base `evaluation-dimensions.yaml` 和
`implementation-turn-002-summary.md`。

## 验证摘要

采纳主控已跑事实：类型检查、`py_compile`、11 项 vitest、`npm run build`、
真实 `build-bookshelf-graph`、`--bookshelf-id` JSON+timing smoke、成员单书包
gate 和 digest 非污染均通过。

本 agent 复核：

- `npm run test:node -- test/cli-graphrag-query-scope.test.ts
  test/graphrag-bookshelf-graph.test.ts`：4 tests passed。
- `python3 -m py_compile scripts/graphrag/bookshelf-graph-parquet-bridge.py
  scripts/graphrag/bookshelf_graph_bridge_*.py`：passed。
- 真实 current manifest：`queryReady=true`、`memberCount=3`、
  `maxSemanticUnits=32`、`maxBooksForDeepening=3`、
  `maxMemberCommunityRefs=24`、`maxInputTokens=64000`、
  `evidenceMap.rowCount=131`、`filesCount=21`，manifest sidecar 与
  `CURRENT.json.manifestSha256` 均匹配。
- 真实 parquet inspect：`semantic_units=24`、`semantic_edges=96`、
  `communities=4`、`community_reports=4`、`evidence_map=131`、
  diagnostics 为空。
- `maxInputTokens=1` 的 Python query bridge 返回
  `budget_exceeded_narrow_scope_required`，证明超预算 fail-closed。
- `qmd query --bookshelf-id software-architecture-core --json --timing` 返回
  JSON 内 `metadata.queryTiming`，阶段包括
  `cli.prepare_graphrag_query`、`route.resolve_graph_scope_capabilities`、
  `route.decide`、`cli.query_bookshelf_upper_index`、
  `route.query_graphrag_provider` 和 `route.build_answer`。
- 缺失书架 CLI smoke 返回 typed JSON `code=upper_index_missing`，但实际
  exit code 为 `1`，且 payload 缺少 Type DD 要求的公共字段。

主控新增修复已纳入审计：`resolveGraphRagQueryMethod` 使显式
`--query-method` 优先，书架默认 `global`，单书默认配置值或 `local`。
对应测试 `test/cli-graphrag-query-scope.test.ts` 已通过。

## D01_authority_boundaries 权威边界与热插包隔离

status: PASS

证据：

- 书架图构建读取 membership current 和成员单书包，写入根限定为
  `graph_vault/catalog/bookshelves/{bookshelfId}`；发布时从 staging rename 到
  `current`，并写 `CURRENT.json`。
- 成员验证继续使用单书 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内
  quality gate、runtime gate、package validator 和 runtime validator。
- `test/graphrag-bookshelf-graph.test.ts` 断言书架图产物未写入
  `graph_vault/books/{bookId}`。
- 真实 `software-architecture-core/current` 的书架产物均在 catalog 派生根下。

剩余风险：

- `bookshelfId` 仍直接参与路径拼接；当前可信输入下通过，面向不可信 CLI
  输入仍应补路径段 schema，拒绝 `/`、`..`、URL scheme 和盘符路径。

## D02_fixed_query_budget 固定查询预算

status: PASS_WITH_RISK

证据：

- `BOOKSHELF_MANIFEST.json.fixedQueryBudget` 记录固定预算：
  `maxSemanticUnits=32`、`maxBooksForDeepening=3`、
  `maxMemberCommunityRefs=24`、`maxInputTokens=64000`。
- 构建期 `budgetSimulation` 计算 selected semantic units、estimated tokens
  和 selected books，并在超过 token 预算时抛出
  `budget_exceeded_narrow_scope_required`。
- 查询期只读取已发布书架 `community_reports.parquet` 和
  `evidence_map.parquet`，按 `maxReports` 选择 top-K；不会扫描全部成员单书
  `community_reports`，也不会创建按成员数增长的 LLM map 调用。
- Python query bridge 在 `maxInputTokens=1` 时返回
  `budget_exceeded_narrow_scope_required`。
- 成功 JSON 显示 `llmCalls=0`、`selectedReportCount=4`、
  `estimatedInputTokens=1184`、`maxInputTokens=64000`。

剩余风险：

- 当前 query bridge 会对书架级 `community_reports.parquet` 全量打分后截断。
  对当前 bounded bookshelf 可接受；进入大规模 library 或更大书架时，应改为
  真正的 vector/hybrid top-K 召回，避免 CPU/I/O 随上层报告数增长。

## D03_graphrag_semantic_alignment GraphRAG 语义对齐

status: PASS_WITH_RISK

证据：

- 构建输入从成员单书 `community_reports.parquet` 生成
  `semantic_units.parquet`，并发布书架级 `community_reports.parquet`。
- schema 明确包含 `semantic_edges.parquet`，字段覆盖
  `relationType`、`sourceEntityTitles`、`sourceRelationshipIds`、
  `evidenceMapIds`。
- 真实 current 存在 `semantic_edges.parquet`，row count 为 96。
- 查询回答基于预计算的书架级 community reports，而不是查询时读取原始全文
  或临时生成社区报告。

剩余风险：

- 当前 edge builder 主要基于语义单元 token overlap 与 bookshelf membership
  生成 `co_clustered_topic`/`bookshelf_membership` 边；成员
  `entities.parquet` 和 `relationships.parquet` 被验证和记录 digest，但尚未
  深度消费，`sourceRelationshipIds` 当前为空。后续应补真实 entity/relationship
  lineage，以提高 GraphRAG 语义保真度。

## D04_evidence_traceability 证据可追溯

status: PASS_WITH_RISK

证据：

- `RequiredParquetColumns.evidence_map.parquet` 覆盖 `targetBookId`、
  `targetSourceId`、`targetDocumentId`、`targetContentHash`、
  `targetCommunityReportId`、`targetTextUnitId` 和
  `targetArtifactDigest`。
- Python builder 的 `add_evidence` 为 semantic unit、semantic edge 和
  community report 写入 evidence rows。
- 真实 `evidence_map.parquet` 有 131 行，row count 与 manifest 一致。
- `queryBookshelfGraph` 将 evidence map 转为 UnifiedAnswer evidence，暴露
  `bookId`、`sourceId`、`documentId`、`contentHash`、`graphTextUnitId`、
  `artifactId` 和 upper community report metadata。
- `test/graphrag-bookshelf-graph.test.ts` 覆盖 evidence 输出中 book/source/
  document/content hash/text unit/locator 字段。

剩余风险：

- validator 当前主要检查 parquet schema、row count 和 member manifest stale；
  尚未逐项验证每个 `evidenceMapIds` 都能双向解析到存在的 evidence row。
  建议补 semantic unit/report/edge 到 evidence_map 的全量 referential check。

## D05_state_recovery 状态闭环与恢复

status: PASS_WITH_RISK

证据：

- 书架图构建写入 staging generation，并在 manifest、quality gate、diagnostics、
  events、status、recovery-summary、checkpoints 和 validator 全部通过后才发布
  `current`。
- current 中存在 `runs/{runId}/events.jsonl`、`status.json`、
  `recovery-summary.json` 和 3 个 member checkpoint，均有 `.sha256` sidecar。
- `validateBookshelfGraphAtRoot` 检查 manifest/gate、manifest file closure、
  sidecar、parquet schema、evidence_map row count 和成员 manifest stale。
- 成员 manifest sha 变化时 validator 诊断 `member_manifest_stale:{bookId}`，
  查询层映射为 `upper_index_stale`。

剩余风险：

- 当前实现有 durable checkpoints 和 partial publish 防护，但没有真正的
  interrupted build resume 流程；失败后主要依赖重跑生成新 staging。

## D06_quality_gates 质量门

status: PASS_WITH_RISK

证据：

- `BookshelfQualityGateSchema` 要求 `readyState=bookshelf_query_ready`、
  `queryReady=true`、`status=passed`、checks、artifact row counts 和
  fixed budget simulation。
- `BookshelfGraphChecks` 覆盖 member manifest、member package gates、
  semantic schemas、evidence lineage、embedding fingerprint、fixed budget、
  sensitive scan 和 stale marker。
- 真实 `state/bookshelf-quality-gate.json` 为 passed，12 个 check 全部 passed，
  budget simulation 为 passed。
- 查询层在 manifest/gate 缺失、validator 失败或 gate not query-ready 时快速
  抛出 upper typed error。

剩余风险：

- library quality gate 尚未实现，但当前实现未宣称 library query-ready，不计为
  本轮失败。
- 部分 check 仍偏声明式，例如 `evidence_map_lineage_valid` 和
  `sensitive_payload_scan_passed` 的 validator 深度可继续加强。

## D07_incremental_scaling 增量扩展

status: PASS_WITH_RISK

证据：

- graph generation hash 纳入 builder version、bookshelf id、membership
  generation、member manifest sha 和预算配置。
- manifest 记录 `membershipManifestSha256`、`membersDigest`、
  `decisionsDigest`、`splitPlanDigest` 和每个 member manifest sha。
- 成员当前 manifest sha 与记录不一致时 validator 标记 stale，不会静默复用。
- 构建成本允许在构建期随成员增长；查询期使用固定预算。

剩余风险：

- 当前书架图构建仍是保守全量重建；尚未实现按受影响 semantic units/communities
  的增量刷新。对于本轮 bookshelf fixed-query target 可接受，后续大库需要实现。

## D08_security_privacy 安全与隐私

status: PASS_WITH_RISK

证据：

- manifest `sensitivityPolicy` 声明 forbidden fields 和 scope-relative locator
  rule；`ForbiddenFields` 包含 provider payload、raw prompt/completion、apiKey、
  credential、absoluteLocalPath 和 queryLogContent。
- builder 在发布 manifest 前对 manifest 与 quality gate 做 forbidden text
  scan；文件 closure path validator 拒绝绝对路径、`..`、URL scheme 和盘符路径。
- 真实 current manifest `files[]` 无绝对路径、URL scheme、`..` 或 manifest
  自引用。
- 结构化扫描 JSON、JSONL 和 parquet 值，排除 `sensitivityPolicy` 的策略名称后，
  未发现绝对路径、真实 secret、provider payload、raw prompt/completion 或
  `query.log`；唯一命中为 `risk-relevant` 中的 `sk-r` 误报。
- `src/integrations/python-bridge.ts` 对单书 GraphRAG bridge stderr/log evidence
  做 provider payload、secret 和绝对路径脱敏，且 subprocess record 不记录请求
  payload。

剩余风险：

- 书架 parquet bridge 直接 spawn，错误路径中会把 Python stderr 拼进
  `upper_index_runtime_error`。当前成功路径无泄漏；后续应复用
  `python-bridge.ts` 的脱敏逻辑，或在 `bookshelf-graph-parquet.ts` 中对 stderr
  做同等 redaction。
- secret 扫描规则需词边界化，避免把普通词片段如 `risk-relevant` 误判为
  `sk-` key。

## D09_cli_operability CLI 可操作性与降级

status: FAIL

证据：

- `--bookshelf-id` 已进入 CLI 解析和帮助文本；即使未显式传 `--graphrag`，
  `qmd query` 也会进入 GraphRAG 书架路径。
- 主控修复已生效：`resolveGraphRagQueryMethod` 保证显式 `--query-method`
  优先；书架默认 `global`；单书默认配置值或 `local`。对应 3 个测试通过。
- 成功路径 `--json --timing` 输出可读 timing，metadata 显示
  `bookshelfId=software-architecture-core`、`graphMethod=global`，stage 中包含
  `cli.query_bookshelf_upper_index`。
- 缺失书架 `qmd query --bookshelf-id __missing__ --json --timing` 快速返回
  typed JSON，`code=upper_index_missing`，diagnostics 为
  `missing_bookshelf_manifest_or_gate`。
- 但 Type DD 要求 upper typed errors 带 `exitCode`、`scopeKind`、`scopeId`、
  `remediationCommand` 和 `timingAvailable`，且 `upper_index_missing` exit code
  应为 66。实际 CLI smoke 的 process exit code 为 `1`，payload 不含上述公共字段。
- `TypedQueryErrorSchema` 当前仅包含 schemaVersion、route、stage、provider、
  capability、code、retryable、redactedMessage、graphCapabilityError 和 metadata；
  `exitWithError` 对 `TypedQueryErrorException` 使用默认 exit code `1`。

最小修复建议：

- 为 upper typed errors 增加统一 exit-code mapping：
  `missing_scope/ambiguous_scope/budget_exceeded_narrow_scope_required=64`，
  `upper_index_stale/upper_quality_gate_failed=65`，
  `upper_index_missing=66`，`upper_index_runtime_error=70`。
- 扩展 typed error payload 或增加 upper error envelope，至少在 upper-index CLI
  错误中输出 `exitCode`、`scopeKind`、`scopeId`、
  `remediationCommand`、`timingAvailable`；`--timing` 时应把已收集 timing 放进
  payload metadata 或标记可用。
- `BookshelfQueryScopeError` 到 `createTypedQueryError` 的映射应填充
  bookshelf scope 和对应 remediation command。

需重跑命令：

- `npm run test:types`
- `npm run test:node -- test/cli-graphrag-query-scope.test.ts
  test/graphrag-bookshelf-graph.test.ts test/cli-graphrag-route.test.ts`
- `npm run build`
- `node node_modules/tsx/dist/cli.mjs src/cli/qmd.ts query --bookshelf-id
  __missing_bookshelf_for_audit__ --graph-vault graph_vault --json --timing
  "architecture"`，期望 exit code 66 且 payload 含 Type DD 公共字段。

剩余风险：

- `upper_index_runtime_error` 目前可能被普通 `cli_error` 包装，需确认所有
  bookshelf query runtime failures 都保留 upper typed code 和正确 exit code。

## D10_testability 可测试性

status: PASS_WITH_RISK

证据：

- `test/graphrag-bookshelf-graph.test.ts` 覆盖 membership handoff、书架图发布、
  manifest/gate、parquet/schema sidecar、单书包非污染、capabilities 和
  evidence lineage。
- `test/cli-graphrag-query-scope.test.ts` 覆盖 method 解析修复：书架默认
  `global`、显式 `--query-method` 优先、单书默认配置值。
- membership 测试已覆盖 closure digest mismatch、runtime gate 缺失不发布
  current。
- 主控已跑 11 项 vitest、typecheck、build、真实 build-bookshelf-graph、JSON+timing
  smoke、单书包 gate 和 digest 非污染。
- 本 agent 复核真实 current manifest/parquet、预算 fail-closed、成功 timing 和
  缺失书架 typed JSON。

剩余风险：

- 尚缺 CLI typed error exit code 与公共字段的断言测试；这是 D09 当前失败的直接
  回归保护缺口。
- 尚缺不同规模书架/library 的固定预算模拟、stale upper index CLI、敏感负向
  fixture、删除 upper catalog 后单书 query 非回归，以及全量 evidence_map
  referential integrity 测试。
