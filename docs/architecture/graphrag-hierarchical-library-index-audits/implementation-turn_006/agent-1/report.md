overallVerdict: PASS_WITH_RISK

# Implementation Turn 006 Agent-1 Audit Report

审计对象：书-书架-Library 层级 GraphRAG 索引改造
（hierarchical library index）。

固定审计基准：
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

唯一规范设计入口：
`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮结论：implementation-turn_005 agent-3 的 library 阻塞项已修复。当前
library generation 为 `library-696099bd32c6427b`，`queryReady=true`，
`semanticUnitCount=8`，`evidenceMapCount=46`。当前 library
`semantic_edges.parquet` 未再出现 `library_same_shelf` 或
`cross_shelf_topic`，实际 `relationType` 只有 `co_clustered_topic` 与
`library_membership`。CLI typed error remediation 已不再指向未实现的
`qmd library ...` 管理命令。

剩余风险不构成本轮阻塞：当前已发布 library gate 已包含并执行
`semantic_edges_relation_types_allowed`；源码合同中的 bookshelf/library
checks 也包含该 check。但两个已发布 bookshelf current generation 的 gate
metadata 仍是旧形态，未列出该 checkId。其 parquet 实际枚举值有效，查询路径
validator 仍会重新 inspect 并 fail closed。建议后续重建 bookshelf current，
使已发布 gate metadata 与新合同完全一致。

## 重点复核结论

- `library_same_shelf` / `cross_shelf_topic`：已修复。当前 library parquet
  relation types 为 `co_clustered_topic`、`library_membership`。
- relationType allowed set：已由
  `scripts/graphrag/bookshelf_graph_bridge_inspect.py` 读取
  `semantic_edges.parquet` 的 `relationType` 并检查
  `ALLOWED_RELATION_TYPES`。若发现非法值，会输出
  `disallowed_relation_type:semantic_edges.parquet:<value>`。
- required check：`src/graphrag/upper-index/library-graph-contracts.ts` 的
  `LibraryGraphChecks` 包含 `semantic_edges_relation_types_allowed`；当前
  `state/library-quality-gate.json` 的 `checks` 也包含该 checkId。
- current library generation：`LIBRARY_MANIFEST.json` 与 `CURRENT.json`
  均记录 `generation=library-696099bd32c6427b`、`queryReady=true`。
  `library-quality-gate.json` 记录 `semantic_units.parquet=8`、
  `evidence_map.parquet=46`。
- CLI remediation：`resolveUpperTypedQueryErrorDetails` 对 library 的
  `upper_index_missing`、`upper_index_stale`、`upper_quality_gate_failed` 和
  `upper_index_runtime_error` 均返回
  `node scripts/graphrag/build-library-graph.mjs --graph-vault <path>
  --library-id <scopeId>`，不再返回未实现的 `qmd library build/status/rebuild`。

## D01_authority_boundaries

verdict: PASS

evidence:

- Type DD 保持单书包权威（authority）边界：单书 query-ready 只能来自
  `graph_vault/books/{bookId}/BOOK_MANIFEST.json`、`PUBLISH_READY.json` 和
  包内质量门。
- 当前 library 产物位于
  `graph_vault/catalog/library/software-engineering-library/current`，书架产物位于
  `graph_vault/catalog/bookshelves/{bookshelfId}/current`，未写入单书包闭包。
- `test/graphrag-bookshelf-graph.test.ts` 断言单书目录中不存在
  `BOOKSHELF_MANIFEST.json` 与 `semantic_units.parquet`。
- bookshelf/library query path 会读取 upper current 并独立校验；upper index
  缺失或失败映射为 upper typed error，不改变单书包状态。

risks:

- 无本轮阻塞风险。catalog upper index 仍是可重建派生物
  （rebuildable derived artifact），该边界保持成立。

requiredFixes:

- 无。

## D02_fixed_query_budget

verdict: PASS_WITH_RISK

evidence:

- 当前 library manifest 记录 `maxSemanticUnits=32`、
  `maxBookshelvesForDeepening=3`、`maxShelfCommunityRefs=24`、
  `maxInputTokens=64000`。
- 当前 library gate 的 fixed budget simulation 为 `passed`，
  `selectedSemanticUnits=8`、`estimatedInputTokens=5120`、
  `selectedBookshelvesForDeepening=2`。
- `bookshelf_graph_bridge_query.py` 从 upper
  `community_reports.parquet` 与 `evidence_map.parquet` 选择固定数量报告；
  估算 token 超过预算时返回
  `budget_exceeded_narrow_scope_required`。
- `test/graphrag-library-graph.test.ts` 与
  `test/graphrag-bookshelf-graph.test.ts` 断言 upper query provider
  `attemptedRequestCount=0`，符合当前固定预算 report search 边界。

risks:

- 查询 bridge 会对已发布 upper community reports 做本地打分后取 top-K。
  这不违反“不得全量扫描所有单书 community_reports”的硬边界，但 CPU 成本
  仍随 upper reports 数增长。
- 未在本轮抽查中看到 100/1000 本规模的独立性能回归证据。

requiredFixes:

- 无阻塞修复。建议增加大规模 upper report 数量下的固定预算回归测试。

## D03_graphrag_semantic_alignment

verdict: PASS_WITH_RISK

evidence:

- Type DD 的 `allowedRelationTypes` 为 `shared_entity`、
  `source_relationship`、`co_clustered_topic`、
  `parent_child_community`、`bookshelf_membership`、`library_membership`。
- 当前 library `semantic_edges.parquet` 实际 relation types 为
  `co_clustered_topic` 与 `library_membership`，未出现
  `library_same_shelf` 或 `cross_shelf_topic`。
- 当前两个 bookshelf `semantic_edges.parquet` 实际 relation types 为
  `bookshelf_membership` 与 `co_clustered_topic`。
- `scripts/graphrag/library_graph_bridge_build.py` 已将同 shelf edge 映射为
  `library_membership`，跨 shelf topic edge 映射为 `co_clustered_topic`。
- 上层 semantic units 来源于 book 或 bookshelf community reports，并通过
  upper community reports 提供 fixed-budget GraphRAG report search。

risks:

- 当前 edge 构造仍主要基于 token overlap，`sourceRelationshipIds` 为空。
  其语义结构已满足当前 Type DD 的最小 durable edge contract，但距离完整
  entity/relationship 级 GraphRAG 语义仍有提升空间。

requiredFixes:

- 无阻塞修复。后续可增强 `shared_entity` 与 `source_relationship` 生成逻辑。

## D04_evidence_traceability

verdict: PASS

evidence:

- Type DD 定义了 `evidence_map.parquet`，包含 `targetBookId`、
  `targetBookshelfId`、`targetSourceId`、`targetDocumentId`、
  `targetContentHash`、`targetCommunityReportId`、`targetTextUnitId` 和
  `targetArtifactDigest`。
- 当前 library manifest 记录 `evidenceMap.rowCount=46`；parquet 只读抽查也
  确认 `evidence_map.parquet` 行数为 46。
- `queryLibraryGraph` 将 evidence 映射为 `bookId`、`sourceId`、
  `documentId`、`contentHash`、`graphTextUnitId`，并在 metadata 中保留
  `scopeKind=library`、`libraryId`、`targetBookshelfId` 与
  `targetCommunityReportId`。
- `test/graphrag-library-graph.test.ts` 断言 library query evidence 包含
  book id、target bookshelf id 和 upper artifact locator。

risks:

- 无本轮阻塞风险。当前能力是 fixed-budget report search，不含 LLM
  synthesis；这是 Type DD 当前实现边界。

requiredFixes:

- 无。

## D05_state_recovery

verdict: PASS_WITH_RISK

evidence:

- library current 下存在 `runs/{runId}/status.json`、`events.jsonl`、
  `checkpoints/{bookshelfId}.json` 与 `recovery-summary.json`。
- 当前 library recovery summary 记录 `status=passed`、`queryReady=true`、
  `currentGenerationPublished=true`、`recoveryDecision=not_required`、
  `checkpointCount=2`。
- build path 先写 staging generation，再发布 current；manifest、gate、
  parquet 与 sidecar checksum 一起纳入 file closure。
- `validateLibraryGraphAtRoot` 会比较成员 bookshelf manifest sha256，成员变化时
  产生 stale 诊断，并由 query path 映射为 `upper_index_stale`。

risks:

- 当前实现具备 durable state 与 stale validation，但未证明可从中断
  checkpoint 精确 resume；同 generation staging 仍偏向重新构建。
- 未看到独立 stale marker 发布流程，stale 主要在查询/验证时动态检测。

requiredFixes:

- 无阻塞修复。建议补充 interrupted promote repair、checkpoint resume 与
  stale marker 回归测试。

## D06_quality_gates

verdict: PASS_WITH_RISK

evidence:

- 当前 library gate 为 `status=passed`、`readyState=library_query_ready`、
  `queryReady=true`，并记录 artifact row counts：
  `semantic_units.parquet=8`、`semantic_edges.parquet=28`、
  `evidence_map.parquet=46`。
- 当前 library gate 的 `checks` 包含
  `semantic_edges_relation_types_allowed`。
- `LibraryGraphChecks` 与 `BookshelfGraphChecks` 源码合同均包含
  `semantic_edges_relation_types_allowed`。
- `bookshelf_graph_bridge_inspect.py` 在 inspect 阶段读取
  `semantic_edges.parquet` 的 `relationType` 列；若值不在 allowed set 内，
  `ok=false` 并返回 `disallowed_relation_type` 诊断。
- `buildLibraryGraph` 与 `buildBookshelfGraph` 在 bridge inspect/build 返回
  `ok=false` 时抛出 `upper_quality_gate_failed`，不会发布 query-ready gate。
- `validateLibraryGraph` 只读复核返回 `ok=true`、`diagnostics=[]`、
  `semanticUnitCount=8`、`evidenceMapCount=46`。
- `test/graphrag-library-graph.test.ts` 覆盖负例：将
  `relationType` 改为 `cross_shelf_topic` 后，validator 返回
  `disallowed_relation_type:semantic_edges.parquet:cross_shelf_topic`。

risks:

- 当前已发布的两个 bookshelf quality gate metadata 未列出
  `semantic_edges_relation_types_allowed`，应是旧 current generation 未重建。
  其实际 parquet relation types 有效，且查询/validator 路径会重新 inspect；
  因此不构成本轮 library 阻塞，但 gate metadata 与新合同不完全一致。
- `sensitive_payload_scan_passed` 的深度仍需持续验证，尤其是 parquet 文本列和
  json/jsonl closure 的敏感字段扫描。

requiredFixes:

- 建议重建现有 bookshelf current generation，使
  `state/bookshelf-quality-gate.json` 的 `checks` 也显式包含
  `semantic_edges_relation_types_allowed`。
- 建议补齐 parquet 文本列与 json/jsonl closure 的敏感信息负例测试。

## D07_incremental_scaling

verdict: PASS_WITH_RISK

evidence:

- 当前 library manifest 记录 `membershipGeneration`、
  `memberBookshelfManifestSha256`、`membersDigest` 与
  `partitionPlanDigest`。
- 当前 library membership 包含 2 个 materialized bookshelves，direct book
  count 为 0；library graph build 从 bookshelf current artifacts 派生。
- Type DD 定义大库通过书架分层限制影响范围，并保留 partition plan 与
  conservative rebuild 条件。
- 当前 library recovery checkpoints 按 bookshelf 记录，支持按成员书架发现
  stale。

risks:

- 当前代码更偏保守全量重建 library graph；尚未证明单 shelf 变化时只刷新受影响
  partition 或局部 semantic units。

requiredFixes:

- 无阻塞修复。建议后续实现或测试 partition-aware incremental refresh。

## D08_security_privacy

verdict: PASS_WITH_RISK

evidence:

- Type DD 定义 forbidden inputs：provider payload、raw prompt/completion、
  query logs、绝对路径和 batch-runs ledger 不得作为上层语义输入。
- manifest 中包含 `sensitivityPolicy.forbiddenFields`，当前 library gate 包含
  `sensitive_payload_scan_passed`。
- `validateFileClosure` 拒绝 manifest file path 中的绝对路径、`..` 与 URI-like
  path，并校验 checksum sidecar。
- 抽查 CLI typed error remediation 使用 `<path>` 占位符，不泄露本地绝对路径。

risks:

- 本轮未证明 sensitive payload scan 已覆盖所有 parquet 文本列、membership
  json/jsonl、diagnostics 与 run events。
- 质量门记录 checkId 不等同于完整敏感内容检测；该点仍需负例测试支撑。

requiredFixes:

- 无阻塞修复。建议增加 provider payload、raw prompt/completion、absolute path
  与 query log 在 parquet/json/jsonl closure 中的泄露负例。

## D09_cli_operability

verdict: PASS

evidence:

- Type DD 当前将 `qmd library list/build/status/rebuild` 归入 remaining
  capabilities，不作为当前已实现管理命令。
- `src/cli/graphrag-query-scope.ts` 的 rebuild remediation 对 library 返回
  `node scripts/graphrag/build-library-graph.mjs --graph-vault <path>
  --library-id <scopeId>`，对 bookshelf 返回
  `node scripts/graphrag/build-bookshelf-graph.mjs --graph-vault <path>
  --bookshelf-id <scopeId>`。
- 只读抽查 `upper_index_missing`、`upper_index_stale`、
  `upper_quality_gate_failed`、`upper_index_runtime_error` 的 library
  remediation，均指向 build-library-graph 脚本，未指向未实现的
  `qmd library ...`。
- `test/cli-graphrag-route.test.ts` 断言缺失 bookshelf/library index 的 JSON
  typed error 包含 exit code、scope、retryable、remediationCommand 与
  timingAvailable。

risks:

- 完整 `qmd library` 管理命令仍未交付；Type DD 已明确为 remaining
  capability，因此不作为本轮失败项。

requiredFixes:

- 无。

## D10_testability

verdict: PASS_WITH_RISK

evidence:

- 现有测试覆盖 bookshelf graph build/query、library graph build/query、CLI
  upper typed errors、query scope helper、contracts，以及单书 hotplug 非回归。
- `test/graphrag-library-graph.test.ts` 增加 relationType 正例与负例，明确断言
  不包含 `library_same_shelf`、不包含 `cross_shelf_topic`，且所有值属于
  allowed set。
- 用户提供的主控验证结果显示：`npm run build` 通过；Python bridge
  `py_compile` 通过；6 个上层测试文件 26 项通过；`contracts.test.ts` 75 项
  通过；真实单书、真实 library smoke 均通过。
- 本轮独立只读复核运行了 parquet inspect、`validateLibraryGraph` 与 CLI
  remediation helper 抽查，均与上述结果一致。

risks:

- 本轮未重新执行完整测试套件；独立复核仅覆盖关键证据路径。
- 大规模 fixed budget、sensitive payload scan 和 interrupted recovery 的负例
  测试仍偏弱。

requiredFixes:

- 无阻塞修复。建议补齐大规模 budget、全 closure 敏感扫描、stale marker 与
  interrupted recovery 的自动化测试。

## Required Fix Summary

blockingRequiredFixes: none

nonBlockingRecommendedFixes:

- 重建当前两个 bookshelf graph generation，使已发布 bookshelf
  `state/bookshelf-quality-gate.json` 的 `checks` 显式包含
  `semantic_edges_relation_types_allowed`。
- 增加大规模 fixed budget、全 closure sensitive payload scan、
  partition-aware incremental refresh、stale marker 与 interrupted recovery
  回归测试。
- 后续增强 upper semantic edges 的 entity/relationship 来源，减少仅依赖
  token overlap 的语义弱点。
