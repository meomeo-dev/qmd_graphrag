# Implementation Turn 005 Agent-1 审计报告

overallVerdict: PASS_WITH_RISK

审计范围为书-书架-Library 层级 GraphRAG 索引改造当前实现，按固定
D01-D10 评估维度逐项核查。审计判定以最新唯一 Type DD 为准：本轮已交付
目标是 bookshelf/library membership、graph build、以及 `--bookshelf-id` /
`--library-id` 的 fixed-budget upper-index report search。`qmd library`
管理命令、LLM synthesis、bounded deepening into single-book GraphRAG 仍为
remainingNewCapabilities，不作为本轮 fixed-budget 查询交付失败项。

本轮未发现必须阻断发布的合同缺陷。主要残余风险集中在公共查询函数预算
覆盖、semantic_edges 的关系证据强度、质量门敏感扫描深度、以及 typed
error remediation 仍引用待实现管理命令。

## D01_authority_boundaries

verdict: PASS

evidence:

- bookshelf membership 从单书 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
  hotplug quality/runtime gate 读取成员状态，未把上层索引写入单书包。
- `buildBookshelfGraph` 和 `buildLibraryGraph` 只在
  `graph_vault/catalog/bookshelves/{bookshelfId}` 与
  `graph_vault/catalog/library/{libraryId}` 下写 staging/current 产物。
- `test/graphrag-bookshelf-graph.test.ts` 断言成员书目录下不存在
  `BOOKSHELF_MANIFEST.json` 和 `semantic_units.parquet`。
- 本轮摘要中的单书回归命令仍走 `cli.invoke_graphrag_runtime`，说明 upper
  catalog 不改变单书 GraphRAG 查询路径。

risks:

- 无阻塞风险。当前实现保持 catalog 派生物与单书包权威分离。

requiredFixes:

- 无。

## D02_fixed_query_budget

verdict: PASS_WITH_RISK

evidence:

- Type DD 最新状态明确 fixed-budget report search 为已交付目标，不包含 LLM
  synthesis 或跨 scope 下钻。
- bookshelf/library manifest 均记录固定预算：`maxSemanticUnits: 32`、
  `maxInputTokens: 64000`、下钻数量上限和 `simulationStatus: passed`。
- query path 从已发布 upper current 读取 `community_reports.parquet` 与
  `evidence_map.parquet`，Python bridge 按 `maxReports` 选取固定数量 report，
  超过 `maxInputTokens` 返回 `budget_exceeded_narrow_scope_required`。
- 真实 library smoke 显示 `provider attemptedRequestCount=0`，
  `estimated/prompt tokens=923`，timing 包含
  `cli.query_library_upper_index`。

risks:

- `queryBookshelfGraph` 与 `queryLibraryGraph` 的函数入参允许调用方传入
  高于 manifest 的 `maxReports` 或 `maxInputTokens`；CLI 未暴露该入口，但
  公共函数边界尚未 fail-closed 到 manifest 预算。
- 质量门预算模拟使用 `selectedSemanticUnits * 640` 的估算，真实查询阶段
  会再检查 tokens，但 gate simulation 不是完整的最坏情况证明。

requiredFixes:

- 无阻塞修复。建议在后续收敛公共 API 时把查询入参预算 clamp 到 manifest
  预算，或在超出 manifest 时直接返回 typed error。

## D03_graphrag_semantic_alignment

verdict: PASS_WITH_RISK

evidence:

- bookshelf builder 以成员书 `community_reports.parquet` 生成
  `semantic_units.parquet`，sourceKind 为 `book_community_report`。
- library builder 以 bookshelf `community_reports.parquet` 和
  `evidence_map.parquet` 生成 library 级 semantic units，sourceKind 为
  `bookshelf_community_report`。
- bookshelf/library 均生成 `semantic_edges.parquet`、`communities.parquet`、
  `community_reports.parquet`，真实 catalog 验证显示 schema 与行数存在。
- fixed-budget 查询消费上层 community reports，而不是查询时扫描全部单书
  community reports。

risks:

- 当前 `semantic_edges` 主要由词元重叠和成员关系派生；真实抽样中
  `sourceRelationshipIds` 全为空。builder payload 虽传入 entities 与
  relationships 路径，但 bridge 未实际读取 relationship parquet 来形成关系
  证据。
- `sourceEntityTitles` 当前为 token overlap，不等同于单书 GraphRAG entity
  表中的实体标题。实现符合第一版 report search 目标，但 GraphRAG 关系语义
  强度仍有限。

requiredFixes:

- 无阻塞修复。建议后续增强 semantic_edges 生成，优先接入成员
  `entities.parquet` 与 `relationships.parquet` 的真实 id/title evidence。

## D04_evidence_traceability

verdict: PASS_WITH_RISK

evidence:

- schemas 定义 `evidence_map.parquet`，字段包含 `targetBookId`、
  `targetBookshelfId`、`targetSourceId`、`targetDocumentId`、
  `targetContentHash`、`targetCommunityReportId`、`targetTextUnitId`。
- 真实 library evidence 抽样包含 `ownerLevel=library`、
  `targetBookshelfId=delivery-devops-core`、book/source/document/content hash
  和 text unit id。
- `queryBookshelfGraph` 与 `queryLibraryGraph` 将 evidence_map 映射到
  GraphRAG response evidence，并在 metadata 暴露 scopeKind、libraryId 或
  bookshelfId、upper report id、target community report id。
- 本轮 library smoke 的 evidence metadata 包含 scopeKind、libraryId、
  targetBookshelfId、bookId、sourceId、documentId、contentHash。

risks:

- library bridge 在 lower evidence 缺失时有 `unknown-*` fallback。真实 catalog
  未触发该 fallback，但 validator 尚未显式拒绝 `unknown-book`、
  `unknown-source` 等占位 lineage。

requiredFixes:

- 无阻塞修复。建议 validators 对 evidence_map 的 unknown/empty lineage
  加强 fail-closed 检查。

## D05_state_recovery

verdict: PASS_WITH_RISK

evidence:

- membership 与 graph build 均先写 `staging/{generation}`，写入
  `runs/{runId}/events.jsonl`、`status.json`、`recovery-summary.json` 和
  checkpoints，验证通过后提升为 `current`。
- bookshelf graph build 在成员 manifest sha 或 package generation 变化时抛出
  `upper_index_stale`；library graph build 在成员 bookshelf manifest sha 变化
  时抛出 `upper_index_stale`。
- library membership 支持 graph current 发布后的 membership archive fallback，
  `validateLibraryMembership` 对 `current` 与 `current/membership` 均可校验。
- 真实 validators 对两个 bookshelf、library membership、library graph 均返回
  `ok: true` 且 diagnostics 为空。

risks:

- 当前实现有 durable state artifacts，但不是完整断点续跑：builder 开始时会
  删除同 generation staging 后重建。
- current promotion 采用 current -> previous -> staging -> current 的两步
  rename，通常可用，但不是严格单 rename publish marker 协议。

requiredFixes:

- 无阻塞修复。建议后续实现真正 checkpoint resume 与更严格的 publish marker
  语义。

## D06_quality_gates

verdict: PASS_WITH_RISK

evidence:

- bookshelf gate 包含 member manifest sha、member package gates、schema、
  evidence lineage、embedding fingerprint、fixed budget simulation、sensitive
  payload scan、stale marker 等 checks。
- library gate 包含 member bookshelf manifest sha、member gates、library
  membership gate、semantic schemas、evidence links、fixed budget simulation、
  sensitive payload scan、stale marker 等 checks。
- 真实 `graph_vault/catalog` 中两个 bookshelf gate 与 library gate 均为
  `queryReady: true`、`status: passed`；library membership gate 为
  `queryReady: false`、`status: passed`。
- 查询入口在 manifest/gate 缺失、stale 或 gate failed 时映射到
  `upper_index_missing`、`upper_index_stale`、`upper_quality_gate_failed`。

risks:

- sensitive scan 主要检查 manifest 和 quality gate 文本；未证明对 parquet
  report 内容、archived membership 目录和所有 diagnostics 文本做完整深扫。
- fixed budget simulation 是估算型检查，未覆盖 10/100/1000 规模代表性模拟。

requiredFixes:

- 无阻塞修复。建议将 sensitive scan 与 budget simulation 扩展为可复验的
  gate 子检查，并增加失败 fixture。

## D07_incremental_scaling

verdict: PASS_WITH_RISK

evidence:

- bookshelf generation 纳入 membership generation、成员 manifest sha、builder
  version、预算参数等；library generation 纳入 library membership generation、
  member bookshelf manifest sha、builder version 与预算参数。
- library membership 记录 `expandedMaterializedBookshelfIds`、partition plan、
  `directBookLimit`、`shelfLimit`，并限制 direct book membership。
- 大库结构通过 bookshelf 分层进入 library build；library graph build 读取
  bookshelf semantic artifacts，而不是直接吞入全量单书。

risks:

- 当前是 conservative generation rebuild，尚无真实增量刷新 planner。
- partition plan 能记录超限 partition，但实际 nested partition 查询与虚拟父
  expansion 策略仍属后续增强。

requiredFixes:

- 无阻塞修复。建议在后续 phase 中实现 member-level dirty set 与 affected
  community rebuild。

## D08_security_privacy

verdict: PASS_WITH_RISK

evidence:

- manifests 包含 `sensitivityPolicy.forbiddenFields`，并规定仅允许
  graph_vault-relative 和 scope-relative locators。
- path validator 拒绝绝对路径、`../`、URL scheme 和 Windows drive path。
- 本次只读扫描 `graph_vault/catalog/bookshelves` 与
  `graph_vault/catalog/library` 的非 parquet 可发布文本产物，除
  `sensitivityPolicy.forbiddenFields` 策略名外，未发现 provider payload、
  raw prompt/completion、api key、绝对 `/Users/jin` 路径或 query.log 内容。
- fixed-budget upper query 的 provider runtime metrics 为
  `attemptedRequestCount=0`，不产生 provider payload。

risks:

- 文本 rg 扫描不覆盖 parquet 内部字段内容；当前 builder 由上游 community
  report 派生文本，仍建议由 gate 对 parquet 内容执行敏感字段抽检或全检。
- remediationCommand 中的 `qmd library ...` 命令为待实现管理命令，属于 CLI
  运营风险而非敏感信息泄漏。

requiredFixes:

- 无阻塞修复。建议把 parquet 内容敏感扫描纳入 quality gate 可复验输出。

## D09_cli_operability

verdict: PASS_WITH_RISK

evidence:

- CLI 支持 `--graph-book-id`、`--bookshelf-id`、`--library-id` 显式 scope，并
  对多个 explicit scope 返回 `ambiguous_scope` typed error。
- bookshelf/library query capability loading 只读取已发布 current；缺 manifest
  或 gate 返回 `upper_index_missing`，stale diagnostics 返回
  `upper_index_stale`。
- `--bookshelf-id` 与 `--library-id` 查询分别记录
  `cli.query_bookshelf_upper_index` 与 `cli.query_library_upper_index` timing；
  单书路径仍记录 `cli.invoke_graphrag_runtime`。
- 本轮真实 library smoke exit 0，selectedRoute 为 `graphrag`，timing 包含
  `cli.query_library_upper_index`。

risks:

- typed error remediationCommand 引用 `qmd library list/build/status/rebuild`，
  但最新 Type DD 已明确这些管理命令仍未实现。因此错误可以快速返回，但
  remediation 的实际可操作性尚不完整。
- 默认 library scope resolution 与无 scope 的 upper typed `missing_scope` 行为
  未作为本轮已交付能力验证。

requiredFixes:

- 无阻塞修复。建议在管理命令落地前为 remediation 增加可用的脚本级替代
  指引，或在 CLI 输出中标注 management command 尚未实现。

## D10_testability

verdict: PASS_WITH_RISK

evidence:

- `test/graphrag-bookshelf-membership.test.ts` 覆盖 membership-only handoff、
  file closure digest mismatch、成员 runtime gate 失败。
- `test/graphrag-bookshelf-graph.test.ts` 覆盖 query-ready bookshelf graph、
  单书包不被写入上层 artifact、query provider calls 为 0、evidence lineage。
- `test/graphrag-library-membership.test.ts` 覆盖两个 bookshelf 的 library
  membership、queryReady=false handoff、directBookLimit enforcement。
- `test/graphrag-library-graph.test.ts` 覆盖 library graph build、validator、
  fixed-budget query、provider calls 为 0、library evidence metadata。
- `test/cli-graphrag-query-scope.test.ts` 覆盖 method 默认值和 upper typed
  error mapping。主控提供的额外验证显示
  `test/integrations/contracts.test.ts` 75 tests passed。

risks:

- 尚未看到 10/100/1000 规模库的固定预算测试。
- upper query stale、missing、budget exceeded 的 CLI 端到端测试覆盖不足；
  目前更多由 query module 与 helper mapping 间接覆盖。
- 敏感信息扫描和 semantic relationship provenance 的负面 fixture 不足。

requiredFixes:

- 无阻塞修复。建议补充规模预算、stale/missing/gate failed CLI JSON、parquet
  敏感字段和 relationship evidence 的 fixture tests。

## 实际检查的命令和文件

commands:

- `sed -n '1,240p' docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `sed -n '1,260p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '261,620p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '620,1040p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '1040,1480p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '1480,1860p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `rg -n "implementedStageTargets|remainingNewCapabilities|library_membership_resolution|library_graph_build|library scoped_query_execution|scoped_query_execution" docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '1010,1055p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '1600,1785p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '1,320p' src/graphrag/upper-index/bookshelf-membership.ts`
- `sed -n '321,720p' src/graphrag/upper-index/bookshelf-membership.ts`
- `sed -n '1,260p' src/graphrag/upper-index/bookshelf-graph.ts`
- `sed -n '261,560p' src/graphrag/upper-index/bookshelf-graph.ts`
- `sed -n '561,920p' src/graphrag/upper-index/bookshelf-graph.ts`
- `sed -n '1,260p' src/graphrag/upper-index/bookshelf-query.ts`
- `sed -n '261,460p' src/graphrag/upper-index/bookshelf-query.ts`
- `sed -n '1,320p' src/graphrag/upper-index/library-membership.ts`
- `sed -n '321,720p' src/graphrag/upper-index/library-membership.ts`
- `sed -n '721,1240p' src/graphrag/upper-index/library-membership.ts`
- `sed -n '1,260p' src/graphrag/upper-index/library-graph.ts`
- `sed -n '261,560p' src/graphrag/upper-index/library-graph.ts`
- `sed -n '561,840p' src/graphrag/upper-index/library-graph.ts`
- `sed -n '1,320p' src/graphrag/upper-index/library-graph-validator.ts`
- `sed -n '1,280p' src/graphrag/upper-index/library-query.ts`
- `sed -n '281,460p' src/graphrag/upper-index/library-query.ts`
- `sed -n '3440,3745p' src/cli/qmd.ts`
- `sed -n '3745,3825p' src/cli/qmd.ts`
- `sed -n '1,260p' scripts/graphrag/bookshelf_graph_bridge_build.py`
- `sed -n '260,620p' scripts/graphrag/bookshelf_graph_bridge_build.py`
- `sed -n '1,320p' scripts/graphrag/library_graph_bridge_build.py`
- `sed -n '1,320p' scripts/graphrag/bookshelf_graph_bridge_query.py`
- `python3` parquet 抽样读取 bookshelf/library
  `semantic_units.parquet`、`semantic_edges.parquet`、`communities.parquet`、
  `community_reports.parquet`、`evidence_map.parquet`
- `node --input-type=module` 调用 dist validators:
  `validateBookshelfGraph`、`validateLibraryMembership`、`validateLibraryGraph`
- `rg -n "providerRequestPayload|providerResponsePayload|rawPrompt|rawCompletion|apiKey|credential|absoluteLocalPath|/Users/jin|query\\.log" graph_vault/catalog/bookshelves graph_vault/catalog/library --glob '!*.parquet'`
- `rg -n "fixed|budget|budget_exceeded|stale|upper_index_missing|upper_quality_gate_failed|single-book|hotplug|library|bookshelf" test src scripts`

files:

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `src/cli/qmd.ts`
- `src/cli/graphrag-query-scope.ts`
- `src/graphrag/upper-index/bookshelf-membership.ts`
- `src/graphrag/upper-index/bookshelf-graph-contracts.ts`
- `src/graphrag/upper-index/bookshelf-graph.ts`
- `src/graphrag/upper-index/bookshelf-graph-validator.ts`
- `src/graphrag/upper-index/bookshelf-query.ts`
- `src/graphrag/upper-index/library-membership.ts`
- `src/graphrag/upper-index/library-graph-contracts.ts`
- `src/graphrag/upper-index/library-graph.ts`
- `src/graphrag/upper-index/library-graph-validator.ts`
- `src/graphrag/upper-index/library-query.ts`
- `scripts/graphrag/bookshelf-graph-parquet-bridge.py`
- `scripts/graphrag/bookshelf_graph_bridge_build.py`
- `scripts/graphrag/library_graph_bridge_build.py`
- `scripts/graphrag/bookshelf_graph_bridge_query.py`
- `scripts/graphrag/bookshelf_graph_bridge_io.py`
- `scripts/graphrag/bookshelf_graph_bridge_contracts.py`
- `test/graphrag-bookshelf-membership.test.ts`
- `test/graphrag-bookshelf-graph.test.ts`
- `test/graphrag-library-membership.test.ts`
- `test/graphrag-library-graph.test.ts`
- `test/cli-graphrag-query-scope.test.ts`
- `test/integrations/contracts.test.ts`
- `graph_vault/catalog/bookshelves/software-architecture-core/current/BOOKSHELF_MANIFEST.json`
- `graph_vault/catalog/bookshelves/software-architecture-core/current/state/bookshelf-quality-gate.json`
- `graph_vault/catalog/bookshelves/delivery-devops-core/current/BOOKSHELF_MANIFEST.json`
- `graph_vault/catalog/bookshelves/delivery-devops-core/current/state/bookshelf-quality-gate.json`
- `graph_vault/catalog/library/software-engineering-library/current/membership/LIBRARY_MEMBERSHIP_MANIFEST.json`
- `graph_vault/catalog/library/software-engineering-library/current/membership/library_members.json`
- `graph_vault/catalog/library/software-engineering-library/current/LIBRARY_MANIFEST.json`
- `graph_vault/catalog/library/software-engineering-library/current/state/library-quality-gate.json`
