# implementation-turn_003 agent-1 实施审计报告

## 审计范围

本轮按固定 D01-D10 基准审计 bookshelf membership、materialized
bookshelf graph build、`--bookshelf-id` fixed-budget report search、Python
bridge 子进程清理，以及单书 hotplug 非回归。

输入规则包括本轮提示注入的 AGENTS.md instructions。仓库根目录未发现额外
实体 `AGENTS.md`；未读取相邻项目的 AGENTS 文件。基准文件保持未修改：
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`。

`library` 层仍是未实现的后续能力。当前实现未声明 `LIBRARY_MANIFEST`、
`--library-id` 或 library graph 已完成，因此本报告不将 library 未实现判为
FAIL；只在相关维度记录剩余风险。

## 验证记录

主控提供的已跑验证：

- `npm run test:types` 通过。
- Python bridge `py_compile` 通过。
- bookshelf membership、bookshelf graph、Python bridge early-stop 等 vitest
  11 项通过。
- 新增 `test/cli-graphrag-query-scope.test.ts` 覆盖 GraphRAG method scope
  解析规则。
- `npm run build` 通过。
- 真实 `build-bookshelf-graph` 通过，`queryReady=true`，
  `semanticUnitCount=24`，`evidenceMapCount=131`。
- `--bookshelf-id` 查询 smoke 通过，`llmCalls=0`，
  `estimatedInputTokens=1184`，证据 lineage 返回
  `bookId/sourceId/documentId/contentHash/community/text_unit`。
- 3 个成员单书 `validatePublishedBookHotplugPackage` 与
  `validateHotplugRuntimeQueryGate` 均通过。
- 查询前后成员单书包闭包 digest 一致。
- 本轮只读复核 `ps -axo pid=,command= | awk ...graphrag_query...`
  输出为空，未见遗留 `graphrag_query` 子进程。

## D01_authority_boundaries

status: PASS

证据：

- Membership 阶段显式要求成员单书通过 `PUBLISH_READY`、hotplug quality gate
  和 runtime gate；见 `src/graphrag/upper-index/bookshelf-membership.ts:306`
  至 `src/graphrag/upper-index/bookshelf-membership.ts:366`。
- Graph build 再次校验成员 manifest sha、package generation、单书发布 gate
  与 runtime gate；见 `src/graphrag/upper-index/bookshelf-graph.ts:302`
  至 `src/graphrag/upper-index/bookshelf-graph.ts:332`。
- Membership manifest 的 `queryReady` 固定为 `false`，且 next stage 明确要求
  `BOOKSHELF_MANIFEST.json`；见
  `src/graphrag/upper-index/bookshelf-membership.ts:707` 至
  `src/graphrag/upper-index/bookshelf-membership.ts:775`，真实产物
  `graph_vault/catalog/bookshelves/software-architecture-core/current/membership/BOOKSHELF_MEMBERSHIP_MANIFEST.json:4`
  至 `:30`。
- Graph build 只发布到
  `graph_vault/catalog/bookshelves/{bookshelfId}/current`，并写
  `CURRENT.json`；见 `src/graphrag/upper-index/bookshelf-graph.ts:484`
  和 `src/graphrag/upper-index/bookshelf-graph.ts:805` 至 `:821`。
- 测试确认 bookshelf graph artifacts 不写入成员单书根；
  `test/graphrag-bookshelf-graph.test.ts:101` 至 `:113`。

结论：单书包权威边界保持，bookshelf 为 catalog 派生物。单书 hotplug 非回归
由源码 gate、测试和主控真实验证共同支撑。

## D02_fixed_query_budget

status: PASS

证据：

- Graph build 输入和默认配置包含固定预算：
  `maxReportsPerBook/maxSemanticUnits/maxEdges/maxInputTokens/maxBooksForDeepening`；
  见 `src/graphrag/upper-index/bookshelf-graph.ts:55` 至 `:66` 和
  `src/graphrag/upper-index/bookshelf-graph.ts:460` 至 `:465`。
- Build quality gate 执行固定预算模拟，超预算时 fail closed 为
  `budget_exceeded_narrow_scope_required`；见
  `src/graphrag/upper-index/bookshelf-graph.ts:391` 至 `:423`。
- Query 只读取已发布 upper index，并把 `maxReports` 与 `maxInputTokens` 传入
  bridge；见 `src/graphrag/upper-index/bookshelf-query.ts:198` 至 `:220`。
- Python query bridge 只在 `community_reports.parquet` 中选定固定
  `maxReports`，超 token 返回
  `budget_exceeded_narrow_scope_required`；见
  `scripts/graphrag/bookshelf_graph_bridge_query.py:95` 至 `:121`。
- CLI 对 `--bookshelf-id` 进入
  `cli.query_bookshelf_upper_index` timing stage；见
  `src/cli/qmd.ts:3583` 至 `:3617`。
- Method 解析修复已纳入：显式 `--query-method` 优先，bookshelf 默认
  `global`，单书默认配置或 `local`；见
  `src/cli/graphrag-query-scope.ts:12` 至 `:26` 和
  `test/cli-graphrag-query-scope.test.ts:6` 至 `:25`。

结论：交互查询预算不随成员书数量线性增长。真实 smoke 的 `llmCalls=0` 和
`estimatedInputTokens=1184` 与该路径一致。

## D03_graphrag_semantic_alignment

status: PASS_WITH_RISK

证据：

- Artifact contract 要求 `semantic_units`、`semantic_edges`、
  `communities`、`community_reports` 和 `evidence_map` 的 GraphRAG 对齐列；
  见 `src/graphrag/upper-index/bookshelf-graph-contracts.ts:6` 至 `:80`。
- Build bridge 从成员 `community_reports.parquet` 选取 source reports 生成
  bookshelf semantic units；见
  `scripts/graphrag/bookshelf_graph_bridge_build.py:21` 至 `:90`。
- Bridge 生成 `semantic_edges`，relation type 包含 `bookshelf_membership` 与
  `co_clustered_topic`；见
  `scripts/graphrag/bookshelf_graph_bridge_build.py:102` 至 `:157`。
- Bridge 生成 bookshelf-level communities 与 community reports；见
  `scripts/graphrag/bookshelf_graph_bridge_build.py:160` 至 `:315`。
- 真实 manifest 声明并发布上述上层 artifacts；
  `graph_vault/catalog/bookshelves/software-architecture-core/current/BOOKSHELF_MANIFEST.json:35`
  至 `:129`。

风险：当前 edge 构造主要依赖 report 文本 token overlap，且
`sourceRelationshipIds` 为空；见
`scripts/graphrag/bookshelf_graph_bridge_build.py:118` 至 `:154`。这满足
第一版 fixed-budget report search，但较完整 GraphRAG entity/relationship
聚合仍浅。后续增强应在同一 artifact contract 内补强 entity/relationship
来源，而不是改变查询预算模型。

## D04_evidence_traceability

status: PASS

证据：

- Contract 定义 `evidence_map.parquet` 必备列，覆盖 book、source、
  document、content hash、community report、text unit 和 artifact digest；
  见 `src/graphrag/upper-index/bookshelf-graph-contracts.ts:63` 至 `:80`。
- Python bridge `add_evidence` 写入
  `targetBookId/targetSourceId/targetDocumentId/targetContentHash/
  targetCommunityReportId/targetTextUnitId/targetArtifactDigest`；
  见 `scripts/graphrag/bookshelf_graph_bridge_io.py:98` 至 `:131`。
- Query 输出把 bridge evidence 映射到 UnifiedAnswer evidence；
  见 `src/graphrag/upper-index/bookshelf-query.ts:234` 至 `:270`。
- Graph 测试断言 query evidence 带回 bookId、sourceId、documentId、
  contentHash、graphTextUnitId 和 bookshelf community report locator；
  见 `test/graphrag-bookshelf-graph.test.ts:136` 至 `:144`。
- 真实 `BOOKSHELF_MANIFEST.json` 记录 `evidenceMap.rowCount=131`；
  见 `graph_vault/catalog/bookshelves/software-architecture-core/current/BOOKSHELF_MANIFEST.json:108`
  至 `:129`。

结论：bookshelf answer evidence 可回链到成员书的关键身份字段。

## D05_state_recovery

status: PASS_WITH_RISK

证据：

- Membership 写 durable events、status、recovery-summary 和 per-decision
  checkpoints；见 `src/graphrag/upper-index/bookshelf-membership.ts:644`
  至 `:706`。
- Membership 采用 staging 后 rename current，并写 `CURRENT.json`；见
  `src/graphrag/upper-index/bookshelf-membership.ts:759` 至 `:775`。
- Graph build 写 status、recovery-summary、events 和 per-member checkpoints；
  见 `src/graphrag/upper-index/bookshelf-graph.ts:604` 至 `:710`。
- Graph build 在 staging root 完成 validate 后才发布 current；见
  `src/graphrag/upper-index/bookshelf-graph.ts:792` 至 `:821`。
- Stale 检测覆盖成员 manifest sha 与 package generation；见
  `src/graphrag/upper-index/bookshelf-graph.ts:313` 至 `:317` 和
  `src/graphrag/upper-index/bookshelf-graph-validator.ts:130` 至 `:140`。
- Python bridge 修复 active child 跟踪、进程组 SIGTERM/SIGKILL、early-stop
  reject 和 close 记录；见 `src/integrations/python-bridge.ts:175` 至
  `:220`、`:418` 至 `:459`、`:483` 至 `:499`。测试覆盖 early-stop 终止当前
  child；见 `test/integrations/python-bridge-early-stop.test.ts:314` 至 `:359`。

风险：当前 recovery summary 多为 `not_required`，实现偏向 atomic rebuild 与
保守重建；尚未证明从中断 checkpoint 增量恢复。该风险不阻断当前已跑通的
publish/query 路径。

## D06_quality_gates

status: PASS_WITH_RISK

证据：

- Bookshelf graph quality gate schema 包含 artifact row counts 与
  fixed query budget simulation；见
  `src/graphrag/upper-index/bookshelf-graph-contracts.ts:192` 至 `:217`。
- Required checks 覆盖 member sha、package gates、schemas、lineage、
  embedding fingerprint、budget、sensitive scan 和 stale marker；
  见 `src/graphrag/upper-index/bookshelf-graph-contracts.ts:357` 至 `:370`。
- Query 读取 manifest 与 quality gate，并拒绝 missing、stale 或 gate failed；
  见 `src/graphrag/upper-index/bookshelf-query.ts:77` 至 `:143`。
- 真实 quality gate `queryReady=true`、`status=passed`，12 项 checks 全部
  passed，行数为 `semantic_units=24`、`evidence_map=131`；
  见 `graph_vault/catalog/bookshelves/software-architecture-core/current/state/bookshelf-quality-gate.json:1`
  至 `:79`。

风险：library quality gate 尚未实现，但当前实现未声称 library 完成。该点按
后续能力记录，不作为本轮 bookshelf 实施 FAIL。

## D07_incremental_scaling

status: PASS_WITH_RISK

证据：

- Membership generation 由 bookshelfId、成员 bookIds 和 policy 输入稳定生成；
  见 `src/graphrag/upper-index/bookshelf-membership.ts:537` 至 `:545`。
- Graph generation 纳入 builder version、membership generation、成员 manifest
  sha 与预算配置；见 `src/graphrag/upper-index/bookshelf-graph.ts:374` 至 `:389`。
- Manifest 保存每个成员 `memberManifestSha256`、builderVersion、budget 和
  evidence schema；真实产物见
  `graph_vault/catalog/bookshelves/software-architecture-core/current/BOOKSHELF_MANIFEST.json:20`
  至 `:33`。
- Query 前 validator 对成员 manifest sha mismatch 返回 stale diagnostics；
  见 `src/graphrag/upper-index/bookshelf-graph-validator.ts:130` 至 `:140`。

风险：当前实现支持保守 whole-bookshelf rebuild 和 stale 标记；尚无
per-member 增量刷新 planner，也无 library 分区层。对当前 3 本书 bookshelf
切片可接受，规模化阶段仍需补实现。

## D08_security_privacy

status: PASS_WITH_RISK

证据：

- Membership 与 graph manifest 均声明 forbidden fields；
  见 `src/graphrag/upper-index/bookshelf-membership.ts:235` 至 `:244` 和
  `src/graphrag/upper-index/bookshelf-graph-contracts.ts:372` 至 `:381`。
- Graph build 对 manifest 和 quality gate 执行 forbidden text 检查，并在
  manifest 中写 locator rule；见
  `src/graphrag/upper-index/bookshelf-graph.ts:425` 至 `:445` 和
  `src/graphrag/upper-index/bookshelf-graph.ts:780` 至 `:786`。
- Scope-relative path normalization 拒绝绝对路径、URL scheme 和 traversal；
  见 `src/graphrag/upper-index/bookshelf-graph.ts:93` 至 `:106` 与
  `src/graphrag/upper-index/bookshelf-graph-validator.ts:27` 至 `:40`。
- Python bridge early-stop redacts provider payload、secret、URL 与 unsafe
  locator；见 `src/integrations/python-bridge.ts:232` 至 `:269`。测试断言
  secret、absolute path、provider payload 不进入错误消息；见
  `test/integrations/python-bridge-early-stop.test.ts:362` 至 `:437`。
- 真实 manifest 的 `sensitivityPolicy` 不含密钥或绝对路径；
  `graph_vault/catalog/bookshelves/software-architecture-core/current/BOOKSHELF_MANIFEST.json:248`
  至 `:260`。

风险：当前 `sensitive_payload_scan_passed` 主要覆盖 manifest/quality gate 和
bridge error surface，未证明对所有 parquet 文本 payload 做全量敏感扫描。
建议后续把 artifact content scan 明确落入 quality gate。

## D09_cli_operability

status: PASS

证据：

- CLI 引入 bookshelf query helper；见 `src/cli/qmd.ts:191` 至 `:196`。
- CLI parse args 和 help 暴露 `--bookshelf-id`；见
  `src/cli/qmd.ts:4153` 至 `:4161` 和 `src/cli/qmd.ts:4771` 至 `:4778`。
- `--graph-book-id` 与 `--bookshelf-id` 互斥并返回 typed error；见
  `src/cli/qmd.ts:3486` 至 `:3502`。
- `--bookshelf-id` 不需要额外 `--graphrag` 即进入 GraphRAG query path；
  见 `src/cli/qmd.ts:5906` 至 `:5908`。
- Scoped graph capabilities 先于 QMD retrieval 解析，使 bookshelf query 走
  graph scope candidates；见 `src/query/unified-router.ts:414` 至 `:437` 和
  `src/query/unified-router.ts:499` 至 `:537`。
- Bookshelf query typed errors 覆盖 `upper_index_missing`、`upper_index_stale`、
  `upper_quality_gate_failed`、`budget_exceeded_narrow_scope_required`；
  见 `src/graphrag/upper-index/bookshelf-query.ts:27` 至 `:31`。
- 新 method 解析修复已覆盖显式 method、bookshelf default global、单书
  configured default；见 `src/cli/graphrag-query-scope.ts:12` 至 `:26` 和
  `test/cli-graphrag-query-scope.test.ts:6` 至 `:25`。

结论：`--bookshelf-id` 的窄接口已接入 fixed-budget upper index 查询，单书
`--graph-book-id` 路径未被改写为 bookshelf 默认。

## D10_testability

status: PASS

证据：

- Membership 测试覆盖三本 query-ready 单书生成 membership、membership 不授予
  queryReady、自引用/closure digest 校验，以及缺 runtime gate fail closed；
  见 `test/graphrag-bookshelf-membership.test.ts:131` 至 `:303`。
- Graph 测试覆盖 membership handoff、query-ready graph publish、artifact
  sidecar、单书包隔离、capabilities、query、`llmCalls=0` 等价指标和 evidence
  lineage；见 `test/graphrag-bookshelf-graph.test.ts:21` 至 `:148`。
- Python bridge early-stop 测试覆盖 subprocess registry、进程组继承、dotenv
  provider env、旧日志 offset、early-stop 终止、redaction 和非 community stage；
  见 `test/integrations/python-bridge-early-stop.test.ts:44` 至 `:487`。
- CLI method helper 测试覆盖本轮修复；见
  `test/cli-graphrag-query-scope.test.ts:5` 至 `:27`。
- 主控已跑真实产物 build/query smoke、单书 validate 与 digest 非回归验证。

结论：当前切片具备足够自动化与真实产物验证。剩余建议是把真实
`qmd query --bookshelf-id` smoke 固化为 CLI 集成测试，降低后续回归风险。

## 总体结论

当前实现满足 bookshelf membership、materialized bookshelf graph build、
`--bookshelf-id` fixed-budget report search 和单书 hotplug 非回归的实施目标。
未发现阻断性 FAIL。

主要剩余风险为：GraphRAG semantic edge 仍偏浅、恢复能力以 atomic rebuild
为主、增量刷新 planner 未实现、敏感扫描尚未覆盖所有 parquet 文本内容。
这些风险不否定当前已发布 bookshelf 切片；应作为后续增强项进入下一轮实现。
