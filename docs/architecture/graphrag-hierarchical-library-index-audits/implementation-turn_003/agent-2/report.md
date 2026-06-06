# implementation-turn_003 agent-2 实施审计报告

overallStatus: PASS_WITH_RISK

## 审计范围

审计对象：

- `src/graphrag/upper-index/**`
- `scripts/graphrag/build-bookshelf-*.mjs`
- `scripts/graphrag/bookshelf*_bridge*.py`
- `src/cli/qmd.ts` 的 `--bookshelf-id` 接入
- `src/cli/graphrag-query-scope.ts`
- `src/integrations/python-bridge.ts`
- `test/graphrag-bookshelf-*.test.ts`
- `test/cli-graphrag-query-scope.test.ts`
- `test/integrations/python-bridge-early-stop.test.ts`
- `graph_vault/catalog/bookshelves/software-architecture-core/current`

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/`
  `evaluation-dimensions.yaml`
- D01-D10 的 id、title、riskQuestion 与 passCriteria 未修改。

必读材料：

- 任务消息内提供的 `AGENTS.md` 指令已作为本轮写作和审计约束使用；仓库根
  目录未发现实体 `AGENTS.md` 文件。
- 唯一 Type DD：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `base/evaluation-dimensions.yaml`
- `reports/implementation-turn-002-summary.md`

阶段边界：

- Type DD 的 `currentImplementationStatus` 明确把
  `bookshelf_membership_resolution`、`materialized_bookshelf_graph_build` 和
  `bookshelf scoped_query_execution fixed-budget report search` 标为已实现目标。
- `library_membership_resolution`、`library_graph_build` 和
  `library scoped_query_execution` 仍列为 remainingNewCapabilities。library 未实现
  属于当前阶段边界，不作为失败。

已纳入验证事实：

- `test:types`、`py_compile`、bookshelf membership/graph/python bridge vitest、
  `npm run build` 均已通过。
- 真实 bookshelf graph build 的 `queryReady=true`。
- `--bookshelf-id` 查询 smoke 通过。
- 成员单书包 gates 通过，查询前后 digest 一致。
- 主控新增 `resolveGraphRagQueryMethod` 修复：显式 `--query-method` 优先；
  bookshelf 默认 `global`；单书默认配置值或 `local`。

## D01_authority_boundaries

status: PASS

证据：

- `buildBookshelfGraph` 和 `resolveBookshelfMembership` 的写入根均位于
  `graph_vault/catalog/bookshelves/{bookshelfId}`，不写入
  `graph_vault/books/{bookId}`。
- 成员输入通过单书包 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd
  与 GraphRAG output、包内 quality/runtime gate 校验。
- `test/graphrag-bookshelf-graph.test.ts` 断言构建后成员书包内不存在
  `BOOKSHELF_MANIFEST.json` 和 `semantic_units.parquet`。
- 真实 `software-architecture-core/current` 的上层产物只位于 catalog 书架根。

残余风险：

- `bookshelfId` 仍建议增加路径安全 schema，显式拒绝 `/`、`..`、URL scheme
  和盘符路径。可信 ID 下不影响本轮结论。

## D02_fixed_query_budget

status: PASS

证据：

- `BOOKSHELF_MANIFEST.json.fixedQueryBudget` 记录
  `maxSemanticUnits=32`、`maxBooksForDeepening=3`、
  `maxMemberCommunityRefs=24`、`maxInputTokens=64000`。
- `state/bookshelf-quality-gate.json.fixedQueryBudgetSimulation` 为 `passed`，
  真实产物选择 `selectedSemanticUnits=24`、估算输入 `15360` tokens，低于
  `maxInputTokens=64000`。
- `queryBookshelfGraph` 只读取已发布书架 `current` 下的
  `community_reports.parquet` 与 `evidence_map.parquet`，并把候选报告限制在
  `maxReports`。
- Python query bridge 返回 `llmCalls=0` 的固定预算 report search，不按成员书数量
  创建交互期 LLM map 调用。

残余风险：

- 查询桥接器会读取书架级 `community_reports.parquet` 全表后排序；这不是全量单书
  report 扫描，但超大书架的上层 report 数量仍需要后续通过分区和索引化检索收敛。

## D03_graphrag_semantic_alignment

status: PASS_WITH_RISK

证据：

- 书架 builder 输入包含成员 `community_reports.parquet`，并要求成员
  `entities.parquet`、`relationships.parquet`、`text_units.parquet` 存在。
- 真实产物包含 `semantic_units.parquet` 24 行、`semantic_edges.parquet` 96 行、
  `communities.parquet` 4 行、`community_reports.parquet` 4 行。
- `semantic_edges.parquet` 保留 `relationType`、`weight`、`direction`、
  `sourceEntityTitles`、`sourceRelationshipIds` 和 evidence 引用字段。
- 上层查询基于预计算的书架级 community reports 和 evidence map，而不是直接拼接
  全部单书原始报告。

残余风险：

- 当前 `bookshelf_graph_bridge_build.py` 的 edge 构造主要基于 report token overlap
  和同书 membership；它验证 entity/relationship 文件存在并记录 digest，但尚未真正
  消费 GraphRAG entity/relationship 行来生成跨书关系。该实现满足第一版可验证
  report search，但语义图质量仍偏保守。

## D04_evidence_traceability

status: PASS

证据：

- Type DD 和实现均定义 `evidence_map.parquet`，字段覆盖 `targetBookId`、
  `targetSourceId`、`targetDocumentId`、`targetContentHash`、
  `targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。
- 真实 `evidence_map.parquet` 有 131 行；上述关键回链字段缺失计数均为 0。
- `queryBookshelfGraph` 把 evidence map 映射到查询响应 evidence，包含 bookId、
  sourceId、documentId、contentHash、graphTextUnitId、artifactId 和书架 locator。
- `test/graphrag-bookshelf-graph.test.ts` 断言查询 evidence 可回链到成员 book、
  source、document、content hash 和 graph text unit。

残余风险：

- 查询响应中的 `quote` 当前来自上层 report summary，不是逐字 text unit 引文。
  lineage 完整，但严格引用粒度后续可增强。

## D05_state_recovery

status: PASS_WITH_RISK

证据：

- 构建先写 `staging/{generation}`，验证 staged artifacts、checksum sidecar、quality
  gate 和 diagnostics 后，才将 staging 提升为 `current`。
- 真实 `CURRENT.json.manifestSha256` 与当前 `BOOKSHELF_MANIFEST.json` 实际 sha256
  一致：
  `c547a05beddb898ac8345a0cee3029c692db9697e9611c5bb0776410b1b4ab0d`。
- 真实 `BOOKSHELF_MANIFEST.json.sha256` 与 manifest 文件一致；manifest `files[]`
  共 21 项，所有条目的 sha256、bytes 与实际文件和 sidecar 均一致。
- 真实 run state 包含 events、status、recovery-summary 和 3 个 member checkpoint；
  status 为 `passed`、`readyState=bookshelf_query_ready`、`queryReady=true`。
- `validateBookshelfGraphAtRoot` 会在查询前重新校验 current manifest、质量门、
  sidecar、Parquet schema 和成员 manifest sha；成员 digest 变化会产生
  `member_manifest_stale:{bookId}`，查询层映射为 `upper_index_stale`。
- `graph_vault/catalog/bookshelves/software-architecture-core/staging` 当前无文件残留，
  未发现 failed/stale 产物进入 current。

残余风险：

- 失败路径主要抛出 typed 前缀错误，不会持久化 failed status、failed quality gate 或
  machine-readable failure diagnostics。中断恢复也未真正从旧 staging resume；同一
  generation 会先删除 staging 后重建。
- 发布完成的最后标记实际是根级 `CURRENT.json` 指针；未看到独立命名的 publish marker。

## D06_quality_gates

status: PASS_WITH_RISK

证据：

- 真实 `state/bookshelf-quality-gate.json` 存在且 `status=passed`、
  `readyState=bookshelf_query_ready`、`queryReady=true`。
- 质量门包含 12 个 check id，包括 member manifest sha、member package gate、
  semantic schema、evidence lineage、embedding fingerprint、固定预算模拟、
  sensitive payload scan 和 stale marker absent。
- membership handoff 被归档到 `current/membership/`，其
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 仍保持 `queryReady=false`。
- 查询前校验失败会在 `bookshelf-query.ts` 中映射为
  `upper_index_stale` 或 `upper_quality_gate_failed`。

残余风险：

- library 质量门尚未实现，但 Type DD 明确标为 remainingNewCapabilities，本轮不判
  FAIL。
- builder 失败时不会生成 failed gate；当前 gate schema 只接受 `passed`，失败诊断
  主要存在于查询校验和异常路径。
- sensitive payload scan 主要覆盖 manifest/gate 文本，未对 Parquet 文本列做完整扫描。

## D07_incremental_scaling

status: PASS_WITH_RISK

证据：

- 书架 manifest 记录 `membershipGeneration`、每个成员 `memberManifestSha256`、
  builder version、embedding fingerprint、summary fingerprint 和 evidence schema。
- graph generation 由 bookshelfId、membership generation、成员 manifest sha 和构建
  预算参数稳定派生。
- 成员 manifest sha 或 package generation 变化时，builder 抛出
  `upper_index_stale:*`，query validator 也会拒绝 stale current。
- Type DD 允许在不能证明局部不变时执行保守全量重建；当前实现符合保守重建策略。

残余风险：

- 尚无真正的增量刷新 planner，也没有大书架分区、虚拟父书架和多规模预算测试。
  当前真实目标为 3 本书的小型物化书架。

## D08_security_privacy

status: PASS_WITH_RISK

证据：

- 书架 manifest 和 membership manifest 的 `sensitivityPolicy.forbiddenFields` 明确列出
  provider payload、raw prompt/completion、api key、credential、absolute local path
  和 query log。
- 真实 JSON/JSONL 可发布产物中，相关敏感词只作为禁止字段名出现；未发现
  `/Users/jin`、`OPENAI`、`JINA`、`Bearer` 或 `sk-` 等敏感值。
- diagnostics 使用 scope-relative locator，例如 `current/BOOKSHELF_MANIFEST.json`。
- `src/integrations/python-bridge.ts` 的 early-stop 错误会截断、脱敏日志证据和 locator，
  并由测试覆盖旧日志忽略、当前 child 终止和路径/secret redaction。

残余风险：

- 上层 Parquet 的 summary/full_content 来自下层 community reports。当前实现没有对
  Parquet 文本列执行同等级敏感扫描；如果下层报告已经污染，上层索引可能继承污染。

## D09_cli_operability

status: PASS_WITH_RISK

证据：

- `src/cli/qmd.ts` 接入 `--bookshelf-id`，并禁止与 `--graph-book-id` 同时使用；
  冲突返回 `ambiguous_scope` typed error。
- `src/cli/graphrag-query-scope.ts` 新增 `resolveGraphRagQueryMethod`，修复 method
  解析优先级：显式 `--query-method` 优先；bookshelf 默认 `global`；单书默认配置值
  或 `local`。
- `test/cli-graphrag-query-scope.test.ts` 覆盖 bookshelf 默认 global、显式 method
  覆盖 bookshelf 默认、单书使用配置默认 method。
- `BookshelfQueryScopeError` 覆盖 `upper_index_missing`、`upper_index_stale`、
  `upper_quality_gate_failed` 和 `budget_exceeded_narrow_scope_required`。
- CLI 捕获 `BookshelfQueryScopeError` 后创建 typed query error；budget 超限标记为
  `graphrag_query` stage，其余上层索引问题标记为 `graph_capability` stage。
- `--bookshelf-id` 查询 timing 增加 `cli.query_bookshelf_upper_index` 阶段。

残余风险：

- `upper_index_runtime_error` 尚未纳入 `BookshelfQueryScopeError` union。Parquet bridge
  spawn/运行失败会以普通 Error 冒泡，CLI 未统一包装成 Type DD 中的 runtime typed
  error。
- `--library-id` 和 `qmd library list/build/status/rebuild` 未实现；这是当前阶段边界。
- stale、missing、budget typed error 的 CLI 集成测试仍不足，主要由源码路径和图构建
  测试间接覆盖。

## D10_testability

status: PASS_WITH_RISK

证据：

- `test/graphrag-bookshelf-membership.test.ts` 覆盖 3 本 ready 包生成 membership、
  manifest closure digest mismatch、成员 runtime gate 缺失时 fail closed。
- `test/graphrag-bookshelf-graph.test.ts` 覆盖从 membership handoff 发布
  query-ready 书架图、文件 sidecar、单书包不污染、query capability、固定预算查询
  和 evidence lineage。
- `test/cli-graphrag-query-scope.test.ts` 覆盖本轮新增 method 解析修复。
- `test/integrations/python-bridge-early-stop.test.ts` 覆盖 runner subprocess ledger、
  provider env overlay、partial-output early stop 和 redaction。
- 已跑验证事实确认类型检查、Python 编译、相关 vitest、真实 build、真实
  `--bookshelf-id` smoke 和成员单书 gate 均通过。

残余风险：

- 尚缺直接测试：`upper_index_missing`、`upper_index_stale`、
  `budget_exceeded_narrow_scope_required` 的 CLI 端到端输出；Parquet bridge runtime
  failure 的 typed error；10/100/1000 本模拟下固定预算；library 层测试。
- library 未实现是当前边界，不作为失败；但后续进入 library 阶段前必须补齐对应
  manifest、质量门、stale 和多规模测试。

## 结论

implementation-turn_003 的当前实现满足书架 membership、书架图构建、
manifest/checksum 闭包、staging/current 发布、固定预算书架查询和 evidence lineage
的第一版目标。真实 `software-architecture-core/current` 产物闭包完整，runner ledger
未作为语义输入，新增 method 解析修复已纳入审计并通过。

本轮不判定 FAIL。主要残余风险集中在失败状态持久化、runtime typed error 包装、
Parquet 文本敏感扫描、增量刷新和多规模测试。library 未实现与 Type DD
`remainingNewCapabilities` 一致，不构成失败。
