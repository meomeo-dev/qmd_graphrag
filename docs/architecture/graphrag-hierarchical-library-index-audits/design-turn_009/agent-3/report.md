# design-turn_009 agent-3 设计复审报告

overallStatus: PASS

## 审计范围

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计规范设计：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

审计结论针对唯一规范性 Type DD 的设计充分性。实现代码、测试代码和
runnable target 不作为本轮 D01-D10 通过性的必要条件。

## 总体结论

第 9 轮把 `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 纳入 manifest schema、
membership 阶段输出、状态写入、下游输入和 handoff reject 条件，并明确
`queryReady` 必须为 `false`，只能作为 `materialized_bookshelf_graph_build`
输入。该修复消除了第 8 轮 membership-only manifest 与 pipeline I/O 脱节的
设计缺口。

按固定 D01-D10 基准复审，当前唯一 Type DD 能让 D01-D10 全部通过。未发现
membership-only manifest 引入新的设计 drift。剩余风险主要在实现落地：CLI、
builder、schema validator 和 durable run 产物仍需按本文档补齐，不能把
membership-only manifest 误读为 bookshelf query-ready 权威。

## D01_authority_boundaries

status: PASS

证据：

- 规范保留 `graph_vault/books/{bookId}` 为单书包权威根目录，并排除把书架或
  library 索引写入单书可复制包文件闭包。
- hard invariant 明确上层索引不得改变单书包身份、文件闭包或 `query_ready`
  判定；catalog 派生物损坏不得影响有效单书包。
- `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 是
  `membership_only_handoff_manifest`，`queryReady=false`，不能授权
  `--bookshelf-id` 查询。
- `compatibilityWithHotplugPackages` 明确安装或删除单书包不会自动修改 ready
  书架或 library generation，直接单书查询仍由单书包 gate 管理。

剩余风险：

- 后续 CLI 若错误接受 membership-only manifest 作为查询权威，会破坏边界；
  当前规范已用 manifest authority、handoff reject 和 query scope gate 阻断。

## D02_fixed_query_budget

status: PASS

证据：

- `queryContract.interactiveBudget` 定义固定 `maxSemanticUnits`、
  `maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM call
  cap、token cap 和 `budget_exceeded_narrow_scope_required`。
- `routing.noImplicitFullVaultScan` 禁止 query path 内重建全部 books、shelves
  或 library indexes。
- retrieval first/second stage 均受固定候选数、token 和 deepening LLM call cap
  约束。
- `scoped_query_execution` 禁止 missing upper index auto-build、stale scope
  默认读取和 interactive all-books exhaustive scan。

剩余风险：

- 固定预算模拟仍需在后续 bookshelf/library graph build 和 query 实现中兑现。

## D03_graphrag_semantic_alignment

status: PASS

证据：

- bookshelf 输入包含成员 `community_reports.parquet`、`entities.parquet` 和
  `relationships.parquet`；library 输入包含 bookshelf community reports 和
  evidence map。
- `semantic_edges.parquet` 定义 `sourceEntityTitles`、`sourceRelationshipIds`、
  direction、weight 和 relation type，保留图语义结构。
- bookshelf build 从 member community reports 提取 semantic units，从 entities、
  relationships 和 membership 派生 semantic edges，并生成 bookshelf community
  reports。
- library build 消费 bookshelf semantic units/community reports，并派生
  library-level semantic edges 和 community reports。

剩余风险：

- 具体聚类算法仍为 open decision，但默认方向已保持 GraphRAG 语义结构。

## D04_evidence_traceability

status: PASS

证据：

- `evidence_map.parquet` 要求 `targetBookId`、`targetSourceId`、
  `targetDocumentId`、`targetContentHash`、`targetCommunityReportId`、
  `targetTextUnitId` 和 `targetArtifactDigest`。
- notes 要求每个上层 semantic unit、semantic edge、community 和 community
  report 至少有一条证据映射；纯 membership marker 例外。
- bookshelf 和 library build 均要求写入从上层 reports 到下层 book 或
  shelf/book evidence 的 evidence map。
- query synthesis 要求最终回答包含 traceable evidence ids，并标明 scoped 或
  non-exhaustive 状态。

剩余风险：

- membership-only manifest 不承载 answerable content；回答证据必须来自后续
  graph build 产出的 `evidence_map.parquet`。

## D05_state_recovery

status: PASS

证据：

- `stateAndRecovery.durableState` 定义 `status.json`、`events.jsonl`、
  `checkpoints/{unitId}.json` 和 `recovery-summary.json`。
- publish protocol 要求 staging、checksum 校验、quality gate/diagnostics、原子
  promote 和 publish marker last。
- 第 9 轮 pipeline I/O 已把 membership state writes 扩展为
  `state/membership-quality-gate.json`、checksum、`state/diagnostics.json`、
  `runs/{runId}/events.jsonl`、`runs/{runId}/status.json`、
  `runs/{runId}/checkpoints/{decisionId}.json` 和
  `runs/{runId}/recovery-summary.json`。
- membership failure outputs 明确不发布 affected materialized shelf 的
  `BOOKSHELF_MANIFEST.json`；graph build failure outputs 明确 failed staging
  generation 不提升，成员 digest 变化时进入 `stale_not_query_ready`。
- bookshelf/library generation 均随成员集合或成员 manifest sha256 等输入变化；
  stale upper index 默认拒绝查询。

剩余风险：

- 实现侧必须实际写入 membership run events、status、checkpoints 和
  recovery-summary；仅写 current handoff 文件不足以满足本设计。

## D06_quality_gates

status: PASS

证据：

- bookshelf gate requiredChecks 覆盖 manifest schema、checksum sidecars、member
  manifest sha256、member package gates、membership decisions、semantic schemas、
  evidence map、embedding metadata、固定预算模拟、敏感扫描和 stale marker。
- library gate requiredChecks 覆盖 member bookshelf manifest sha256、member gates、
  virtual parent expansion、direct book limit、semantic schemas、evidence map、
  固定预算模拟、敏感扫描和 stale marker。
- `membershipChecks` 定义 membership decision、authority order、user locks、LLM
  suggestion、accepted suggestion、oversized category、virtual parent、direct
  book limit 和 library partition 的 check ids。
- failure diagnostics 要求 machine-readable、bounded，并通过 digest 和 redacted
  locator 定位问题。

剩余风险：

- membership-quality-gate 与 bookshelf graph quality gate 是不同层级；实现必须
  避免把 membership gate 通过误解为 bookshelf graph gate 通过。

## D07_incremental_scaling

status: PASS

证据：

- `stable_membership_generation` 要求记录成员集合、成员 manifest sha256、
  `packageGeneration`、构建配置和 index schema。
- bookshelf generation 随成员集合、任一成员 manifest sha256、builder version、
  embedding fingerprint、聚类配置、summary config 或 evidence schema 变化。
- `bookshelf_members.json` required fields 包含 `manifestSha256` 和
  `packageGeneration`。
- bookshelf incremental refresh 允许 checksum 可证明不变时只重建 affected units；
  否则重建 shelf generation。
- library 通过 materialized shelves、directBookLimit、shelf count limit 和
  partition policy 限制大库重建范围。

剩余风险：

- direct book membership 必须严格限制在小库或 transitional repair 场景，避免
  绕开书架分层。

## D08_security_privacy

status: PASS

证据：

- hard invariant 禁止书架/library manifest、索引、质量门和诊断包含 provider
  payload、原始 prompt/completion、密钥、用户绝对路径或运行期 `query.log`。
- bookshelf build inputs 和 pipeline forbidden inputs 禁止 provider payload、
  raw prompts、raw completions、query logs、absolute paths 和 runner ledger events
  作为语义或分类证据。
- `diagnosticRedactionPolicy` 只允许 schema/check ids、typed error code、scope
  或 member id、artifact digest、bounded summary、redacted locator 和
  remediation command。
- bookshelf 和 library quality gates 均包含 sensitive payload scan。
- `BOOKSHELF_MEMBERSHIP_MANIFEST.json` required sections 包含 `sensitivityPolicy`。

剩余风险：

- LLM suggestion 的 `proposedRationale` 必须保持 bounded redacted summary；接入
  真实 provider 时需测试 raw prompt/completion 不落盘。

## D09_cli_operability

status: PASS

证据：

- scope resolution order 定义 explicit bookId、bookshelfId、libraryId、
  configured default library 和 fast ambiguity error with candidates。
- typed errors 覆盖 `missing_scope`、`ambiguous_scope`、`upper_index_missing`、
  `upper_index_stale`、`upper_quality_gate_failed`、
  `budget_exceeded_narrow_scope_required` 和 runtime error。
- CLI behavior matrix 覆盖 no scope、ambiguous scope、missing upper index、stale、
  quality gate failed 和 over budget，并列出 timing fields。
- scoped query 禁止 auto-build 或 exhaustive all-books scan，并要求输出 bounded
  timing breakdown 或 typed error。
- grounding review 明确当前只有单书 `--graph-book-id`，bookshelf/library CLI
  scope 和 upper typed error mapping 仍为待实现能力。

剩余风险：

- `designAudit.currentRunDirectory` 仍指向 `design-turn_007`，属于审计元数据
  stale；不影响 CLI 合同本身。

## D10_testability

status: PASS

证据：

- 主 `testContracts.requiredCases` 超过 8 项，覆盖单书 query 非回归、membership
  authority、LLM suggestion、oversized category、虚拟父书架路由、10/100/1000
  books 固定 top-K、预算超限、stale、missing upper index、member package gate
  failure、evidence map、安全扫描、partial publish、删除单书 stale 和 timing。
- `pipelineIoContract.testContracts.requiredCases` 超过 8 项，覆盖 package
  projection、membership resolution、suggestion-only、accepted suggestion、
  oversized taxonomy、virtual parent、manifest sha256 drift、publish marker、
  library direct book limit、stale member shelf、scoped query typed errors、预算
  错误、删除上层 catalog 不破坏单书 query 和 redacted diagnostics。
- membership-only handoff 可由 `BOOKSHELF_MEMBERSHIP_MANIFEST queryReady false`、
  handoff checksum、missing upper index 和 scoped query refuses missing upper
  index 等场景覆盖。

剩余风险：

- 当前文档定义的是测试合同，不代表测试已经实现；后续需补齐 negative query
  cases、durable run artifacts 和 sensitive diagnostics fixture。

## membership-only manifest drift 检查

未发现新的设计 drift。

确认点：

- `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 与 `BOOKSHELF_MANIFEST.json` 的 authority
  已分离：前者是 membership-only handoff，后者是 graph build query-ready
  manifest。
- membership 阶段 emitted outputs、state writes、next stage inputs 和 handoff
  matrix 均包含 membership manifest、checksum、quality gate 和 recovery
  artifacts。
- materialized bookshelf graph build 必须读取 membership manifest 且确认
  `queryReady=false`，然后才可发布 `BOOKSHELF_MANIFEST.json`。
- query path 只接受已发布且通过质量门的 scope manifest，不允许 missing upper
  index auto-build、stale 默认读取或交互式全库扫描。
- grounding review 将 membership resolver 标为 direct extension，将
  bookshelf/library builder 和 scoped upper query 标为 new capability，未把
  membership-only runnable target 误标为完整 GraphRAG 查询能力。

剩余风险：

- implementation sequencing 的 phase1 仍未显式列出
  `BOOKSHELF_MEMBERSHIP_MANIFEST` validator；建议后续实现计划补充。
- 实现侧若先交付 membership-only runnable target，必须同步实现 durable
  events/status/checkpoints/recovery-summary，否则会重新出现第 8 轮 D05 风险。

## 最终判定

D01_authority_boundaries: PASS  
D02_fixed_query_budget: PASS  
D03_graphrag_semantic_alignment: PASS  
D04_evidence_traceability: PASS  
D05_state_recovery: PASS  
D06_quality_gates: PASS  
D07_incremental_scaling: PASS  
D08_security_privacy: PASS  
D09_cli_operability: PASS  
D10_testability: PASS

overallStatus: PASS
