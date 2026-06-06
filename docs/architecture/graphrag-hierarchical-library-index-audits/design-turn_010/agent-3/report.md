# design-turn_010 agent-3 设计复审报告

overallStatus: PASS

## 审计范围

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计规范设计：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮按固定 D01-D10 维度复审唯一规范性 Type DD。实现代码、测试代码和
可运行目标不作为本轮设计通过性的必要条件。本轮未修改 base 基准。

## 总体结论

D01-D10 全部 PASS。当前规范把 `BOOKSHELF_MEMBERSHIP_MANIFEST.json`
限定为 `membership_only_handoff_manifest`，并要求 `queryReady=false`，只能作为
`materialized_bookshelf_graph_build` 输入，不能授权 `--bookshelf-id` 查询。
该 membership-only manifest 没有引入 query-ready、budget、security 或
testability 漂移。

剩余风险集中在实现阶段：schema validator、membership gate、upper graph
builder、CLI typed error、固定预算模拟和安全扫描必须按规范落地，不能把
membership-only manifest 误读为 `BOOKSHELF_MANIFEST.json` 或可查询权威。

## D01_authority_boundaries

status: PASS

证据：

- hard invariant 保留单书包权威：单书状态只能来自
  `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd/GraphRAG/state 产物和
  质量门；书架与 library 不得改变单书包身份、文件闭包或 `query_ready`
  判定。
- 上层索引被定义为可重建派生物，缺失、损坏或过期不得让有效单书包变成
  `not_query_ready`。
- `BOOKSHELF_MANIFEST.json` 只能由物化书架 graph build 在上层 GraphRAG
  派生索引和 bookshelf 质量门通过后发布；membership 阶段不得用它表示可查询
  书架。
- `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 明确为 membership-only handoff，
  `queryReady=false`，不能授权 `--bookshelf-id` 查询。
- pipeline handoff 要求 membership manifest 的 `queryReady` 不是 false 时拒绝
  进入物化书架 graph build。

剩余风险：

- 实现若把 membership-only manifest 当成 query-ready manifest，会破坏权威
  边界；当前规范已通过 manifest authority、handoff reject 和 query gate
  阻断该路径。

## D02_fixed_query_budget

status: PASS

证据：

- `queryContract.interactiveBudget` 定义固定 `maxSemanticUnits`、
  `maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用
  上限、输入 token 上限和输出 token 上限。
- 预算规则要求候选证据无法放入 active budget 时 fail closed 或要求收窄
  scope，错误码为 `budget_exceeded_narrow_scope_required`。
- hard invariant 禁止交互查询把全部成员书的 `community_reports` 作为 prompt
  输入，禁止按成员书数量创建不受限 map 调用。
- retrieval first stage 只在上层 semantic units 上做固定候选检索，second stage
  以固定书本数、community ref 数和 deepening LLM call cap 下钻。
- scoped query execution 禁止 missing upper index auto-build、默认 stale read 和
  interactive all-books exhaustive scan。

剩余风险：

- 固定预算模拟必须由 bookshelf/library quality gate 实际执行；membership-only
  manifest 本身不承载查询预算，也不能绕过 graph build 的预算 gate。

## D03_graphrag_semantic_alignment

status: PASS

证据：

- bookshelf source inputs 包含成员 `community_reports.parquet`、
  `entities.parquet`、`relationships.parquet` 和受限的 `text_units.parquet`。
- library build 消费 bookshelf `semantic_units.parquet`、`semantic_edges.parquet`、
  `community_reports.parquet` 和 `evidence_map.parquet`。
- `semantic_edges.parquet` 要求 relation type、direction、weight、
  `sourceEntityTitles`、`sourceRelationshipIds` 和 `evidenceMapIds`，保留图结构。
- bookshelf build 从 member community reports 提取 semantic units，并从
  entities、relationships 和 membership 派生 semantic edges，再生成 bookshelf
  community reports。
- library build 从书架级 semantic units/community reports 派生 library 级
  semantic edges、communities 和 community reports。

剩余风险：

- 聚类算法仍是 open decision，但规范要求保留 GraphRAG community report、
  entity 和 relationship 语义，不允许退化为普通摘要检索。

## D04_evidence_traceability

status: PASS

证据：

- `evidence_map.parquet` 要求记录 `targetBookId`、`targetBookshelfId`、
  `targetSourceId`、`targetDocumentId`、`targetContentHash`、
  `targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。
- evidence map notes 要求每个上层 semantic unit、semantic edge、community 和
  community report 至少有一条证据映射；仅无 answerable content 的纯 membership
  marker 例外。
- bookshelf graph build 质量门要求每个 upper semantic unit 都有到 book
  artifacts 的 evidence lineage。
- library graph build 质量门要求 `evidence_map` 把每个 unit 连接到 shelf 和
  book evidence。
- query synthesis 要求最终回答包含 traceable evidence ids，并标明结果是否
  scoped 或 non-exhaustive。

剩余风险：

- membership-only manifest 只证明成员闭环，不生成可回答内容；回答证据必须来自
  后续 graph build 发布的 `evidence_map.parquet`。

## D05_state_recovery

status: PASS

证据：

- `stateAndRecovery.durableState` 定义 `manifest.json`、`status.json`、
  `events.jsonl`、`checkpoints/{unitId}.json` 和 `recovery-summary.json`。
- recovery rules 要求构建完成必须具备 checkpoint、manifest、quality gate 和
  publish marker；失败 semantic unit generation 不得发布 ready upper index；
  stale member manifests 在查询使用前标记 upper index stale。
- publish protocol 要求 staged artifacts、checksum sidecars、quality gate、
  diagnostics、原子 promote 和 publish marker last。
- membership resolution state writes 包含 membership manifest、membership quality
  gate、diagnostics、run events、status、decision checkpoints 和 recovery summary。
- membership failure outputs 明确不发布 affected materialized shelf 的
  `BOOKSHELF_MANIFEST.json`，suggestion-only shelves 保持 not query-ready。
- state closure 要求每个阶段可从 authority root、published manifest、quality gate、
  checksums、events 和 checkpoints 判断 ready、failed、stale、running 或 pending。

剩余风险：

- 实现必须真正持久化 membership run 状态和恢复摘要；只写 handoff manifest
  不足以满足本设计。

## D06_quality_gates

status: PASS

证据：

- bookshelf gate requiredChecks 覆盖 manifest schema、checksum sidecars、成员
  manifest sha256、member package gates、membership decisions、authority order、
  LLM suggestion 非 query-ready、semantic schemas、evidence map、embedding
  metadata、固定预算模拟、敏感扫描和 stale marker。
- library gate requiredChecks 覆盖 member bookshelf manifest sha256、member gates、
  virtual parent expansion、direct book limit、shelf count/partition、semantic
  schemas、evidence map、embedding metadata、固定预算模拟、敏感扫描和 stale
  marker。
- membershipChecks 定义 membership decision、authority order、user locks、LLM
  suggestion、accepted suggestion、oversized split、virtual parent、direct book
  limit 和 library partition 的 check ids。
- membership check failures 必须使用 `upper_quality_gate_failed`，并带
  `failedCheckId`、redacted locator 和 remediation command。
- failure diagnostics 必须 machine-readable、bounded，并用 digest 或
  package/scope-relative redacted locator 定位问题。

剩余风险：

- membership-quality-gate 通过只表示成员闭环通过，不等于 bookshelf graph quality
  gate 通过；实现和 CLI 需要保持两类 gate 的 readyState 分离。

## D07_incremental_scaling

status: PASS

证据：

- stable membership generation 要求记录成员集合、成员 manifest sha256、
  `packageGeneration`、构建配置和 index schema；成员变化必须生成新 generation
  或标记 stale。
- bookshelf generation 随成员集合、任一成员 manifest sha256、builder version、
  embedding fingerprint、clustering config、summary config 或 evidence schema
  变化。
- `bookshelf_members.json` required fields 包含 `manifestSha256` 和
  `packageGeneration`。
- bookshelf incremental refresh 允许 checksum 可证明不变时只重建 affected
  semantic units 和 derived communities；否则重建 shelf generation。
- library incremental refresh 可在成员 shelf checksum 证明不变时局部重建；无法
  定位图连通性变化时标记 stale 并创建 full library generation。
- 大库通过 materialized shelf count limit、directBookLimit、virtual parent 和
  nested partition 限制重建影响范围。

剩余风险：

- direct book membership 必须保持小库或 transitional repair 边界，避免绕开书架
  分层导致 library 重建范围扩大。

## D08_security_privacy

status: PASS

证据：

- hard invariant 禁止书架/library manifest、索引、质量门和诊断包含 provider
  payload、原始 prompt、原始 completion、密钥、用户绝对路径或运行期
  `query.log`。
- bookshelf build inputs 和 pipeline stages 的 forbidden inputs 禁止 provider
  payloads、raw prompts、raw completions、query logs、absolute paths、unvalidated
  damaged packages 和 runner ledger events 进入语义或分类输入。
- diagnostic redaction policy 只允许 schema/check ids、typed error code、scope
  id、member id、artifact digest、bounded summary、redacted locator 和 remediation
  command，并禁止 provider request/response、raw prompt/completion、credential、
  absolute path 和 query log content。
- bookshelf 和 library quality gates 均包含 sensitive payload scan。
- bookshelf graph manifest、membership-only manifest 和 library manifest 的
  required sections 均包含 `sensitivityPolicy`。
- LLM suggestion gate 的 `proposedRationale` 必须是 bounded redacted summary，
  不得包含 raw prompts、raw completions、provider payloads、absolute local paths
  或 reversible request material。

剩余风险：

- 真实 provider 接入后需要测试 prompt/completion、payload 和 query log 不落入
  membership manifest、upper manifests、diagnostics 或 semantic artifacts。

## D09_cli_operability

status: PASS

证据：

- scope resolution order 定义 explicit bookId、explicit bookshelfId、explicit
  libraryId、configured default library 和 fast ambiguity error with candidates。
- typed query errors 覆盖 `missing_scope`、`ambiguous_scope`、
  `upper_index_missing`、`upper_index_stale`、`upper_quality_gate_failed`、
  `budget_exceeded_narrow_scope_required` 和 `upper_index_runtime_error`。
- CLI behavior matrix 覆盖 no scope、ambiguous scope、missing index、stale、
  quality gate failed 和 over budget，并列出 route/timing fields。
- scoped query execution 只读取已发布且质量门通过的 scope，不在交互路径创建或
  修复上层索引；失败时输出 typed error。
- bounded degradation invariant 要求上层索引不可用时 CLI 快速返回 typed error、
  回退建议或要求明确 scope，不得长时间全库扫描后失败。

剩余风险：

- 当前 implementation grounding review 明确 `--bookshelf-id`、`--library-id`、
  upper typed error mapping 和 fixed-budget upper retrieval 仍是待实现能力；实现
  不得把文档设计误报为现有 CLI 行为。

## D10_testability

status: PASS

证据：

- 主 `testContracts.requiredCases` 超过 8 项，覆盖单书 query 非回归、membership
  authority、LLM suggestion 非 query-ready、accepted suggestion generation、
  oversized category、virtual parent 路由、10/100/1000 books 固定 top-K、预算
  超限、stale、missing upper index、member package gate failure、evidence map、
  semantic edge evidence、安全扫描、partial publish、删除单书 stale、exhaustive
  report 分离和 timing。
- `pipelineIoContract.testContracts.requiredCases` 超过 8 项，覆盖 package
  projection、qmd bundled index、user lock、LLM suggestion-only、accepted
  generation、oversized split、virtual parent no semantic artifacts、member
  manifestSha256 变化、publish marker、directBookLimit、stale shelf、missing upper
  index no-build、typed errors、over-budget、删除 catalog 不影响单书 query 和
  redacted diagnostics。
- 测试合同明确包含不同规模库的固定预算验证。
- 测试合同明确包含删除上层 catalog 或 upper indexes 后单书 query 仍成功的
  hotplug 非回归。
- 安全测试覆盖 provider payloads 和 query logs 不进入 upper manifests。

剩余风险：

- 测试合同充分，但 fixture、schema validators、CLI tests 和 builder recovery
  tests 仍需后续实现；membership-only manifest 需要单独 fixture 验证
  `queryReady=false` 和 handoff reject 条件。

## membership-only manifest 漂移复核

status: PASS

复核结论：

- query-ready：无漂移。membership-only manifest 的 authority 是
  `membership_only_handoff_manifest`，`queryReady=false`，不能授权
  `--bookshelf-id` 查询；`BOOKSHELF_MANIFEST.json` 仍由 graph build 和 bookshelf
  quality gate 通过后发布。
- budget：无漂移。membership-only manifest 不承载 query path；固定预算仍在
  graph build readiness、quality gate simulation 和 scoped query budget 中校验。
- security：无漂移。membership-only manifest required sections 包含
  `sensitivityPolicy`；membership resolution 禁止 raw LLM prompt/completion 和
  runner ledger events 作为输入，诊断使用 redaction policy。
- testability：无漂移。主测试合同和 pipeline I/O 测试合同均覆盖 membership
  suggestion-only、accepted generation、query-ready 隔离、missing upper index
  no-build、fixed budget、安全扫描和 hotplug 非回归。

