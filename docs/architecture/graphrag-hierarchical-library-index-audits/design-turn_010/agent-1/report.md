# design-turn_010 agent-1 设计复审报告

overallStatus: PASS

## 审计范围

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计唯一规范设计：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮重点复核第 9 轮 agent-1 的 D05 阻断项：

- `bookshelf_membership_resolution.stateWrites` 是否显式列入
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 及
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256`。
- `handoffMatrix.rejectIf` 是否覆盖 `membersDigest`、`decisionsDigest` 和
  `splitPlanDigest` mismatch。

审计未修改固定基准、规范设计或实现代码。

## 总体结论

第 10 轮复审判定为 PASS。第 9 轮 agent-1 的 D05 阻断项已经修复：
`bookshelf_membership_resolution.stateWrites` 显式写入
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 和 `.sha256`；
membership 到 graph build 的 `handoffMatrix.rejectIf` 已拒绝 manifest checksum
错误、`queryReady` 非 false、`membersDigest` 与 `bookshelf_members.json`
不一致、`decisionsDigest` 与 `membership_decisions.jsonl` 不一致，以及 split
plan digest 缺失或 mismatch。

所有 D01-D10 固定维度均满足基准。剩余风险主要是实现阶段命名与测试细化：
split plan mismatch 以自然语言 `membership split plan digest missing or
mismatched` 表达，语义覆盖 `splitPlanDigest mismatch`，但字段级 schema 仍应在
实现合同中固定。

## 第 9 轮 D05 阻断项复核

status: PASS

证据：

- `bookshelf_membership_resolution.emittedOutputs` 已列出
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 和
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256`。
- 同一阶段 `stateWrites` 已显式列入
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 和
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256`，并与
  `state/membership-quality-gate.json`、diagnostics、events、status、
  checkpoints、recovery summary 同列为阶段持久写入。
- `materialized_bookshelf_graph_build.requiredInputs` 要求
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json with queryReady false`、
  checksum sidecar、passed membership quality gate，以及带
  `manifestSha256` 与 `packageGeneration` 的 `bookshelf_members.json`。
- handoff matrix 中 membership 到 graph build 的 handoff artifacts 包含
  membership manifest、checksum sidecar、membership quality gate、
  `bookshelf_members.json`、`membership_decisions.jsonl` 和 split plan。
- 同一 handoff 的 `rejectIf` 覆盖 manifest 缺失或 checksum mismatch、
  `queryReady` 非 false、membersDigest mismatch、decisionsDigest mismatch、
  split plan digest 缺失或 mismatch、quality gate 缺失或未通过、LLM suggestion
  未接受、超大成员数未 split、用户 lock 冲突未解决。

剩余风险：split plan 的 reject 条款没有逐字使用 `splitPlanDigest` 字段名，
而是写为 `membership split plan digest missing or mismatched`。语义上已经覆盖
第 9 轮阻断项，但实现 schema 应固定 digest 字段名，避免校验器各自解释。

结论：第 9 轮 D05 阻断项已修复。

## D01_authority_boundaries

status: PASS

证据：固定基准要求单书包 `BOOK_MANIFEST.json` 保持唯一包权威，书架和
library 只能作为可重建派生物。目标设计的 hard invariants 明确
`book_package_authority_preserved` 和 `derived_upper_indexes_only`，规定书架与
library 不得改变单书包身份、文件闭包或 `query_ready` 判定，且上层索引缺失、
损坏或过期不得使有效单书包变成 not query-ready。层级模型将 book authority
root 定为 `graph_vault/books/{bookId}`，书架和 library authority root 位于
catalog。manifest schema 又区分 `BOOKSHELF_MANIFEST.json` 的
query-ready graph build authority 与 `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 的
membership-only handoff authority，后者 `queryReady` 必须为 false，不能授权
`--bookshelf-id` 查询。

剩余风险：实现若把 membership-only manifest 当成可查询书架 manifest，会破坏
权威边界。当前规范已经通过 `queryReady: false`、后置 graph build manifest 和
handoff reject 条件降低该风险。

结论：满足 D01。

## D02_fixed_query_budget

status: PASS

证据：固定基准要求查询阶段使用固定 top-K 或预算参数，禁止查询时全量扫描所有
单书 community reports，并在超预算时 fail closed 或收窄 scope。目标设计在
`queryContract.interactiveBudget` 中固定 `maxSemanticUnits: 32`、
`maxBookshelves: 4`、`maxBooksForDeepening: 3`、
`maxMemberCommunityRefs: 24`、LLM 调用数、输入 token 和输出 token。routing 禁止
query path 中 rebuild all books/shelves/library indexes。retrieval first stage
受 semantic units、bookshelves、input tokens 限制，second stage 受下钻书本数、
community refs 和 LLM call cap 限制。超预算错误码固定为
`budget_exceeded_narrow_scope_required`。

剩余风险：实现阶段需要确保配置只能向下收紧预算，不能把 top-K 扩展成按书籍数
线性增长。当前设计合同满足固定基准。

结论：满足 D02。

## D03_graphrag_semantic_alignment

status: PASS

证据：固定基准要求上层索引输入包含 community reports，保留 entity、
relationship 或等价语义关系，并基于预计算社区报告或语义单元综合回答。目标
设计中 book、bookshelf、library 层级输入和输出均包含 community reports；
bookshelf source inputs 包含成员 `community_reports.parquet`、`entities.parquet`
和 `relationships.parquet`。`semantic_edges.parquet` 保留 relation type、
weight、direction、source entity titles、source relationship ids 和
evidence map ids。构建算法从 community reports 抽取 semantic units，并从
entities、relationships 和 membership 派生 semantic edges，再生成书架级和
library 级 community reports。

剩余风险：membership 边只能补充 GraphRAG 结构，不能替代 community reports、
entities 和 relationships。当前规范已经把 membership handoff 与 graph build
query-ready manifest 分离。

结论：满足 D03。

## D04_evidence_traceability

status: PASS

证据：固定基准要求回答可追溯到 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report 或 text unit。目标设计定义
`evidence_map.parquet`，字段包含 `targetBookId`、`targetBookshelfId`、
`targetSourceId`、`targetDocumentId`、`targetContentHash`、
`targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。规范要求
每个上层 semantic unit、semantic edge、community 和 community report 至少有
一条 evidence map 记录，纯 membership marker 且无可回答内容时例外。查询合成
必须包含 traceable evidence ids。

剩余风险：实现应避免把 bounded summary 当作不可追溯的最终证据。当前设计已用
evidence map 和 answer evidence references 约束该行为。

结论：满足 D04。

## D05_state_recovery

status: PASS

证据：固定基准要求 durable checkpoints/events/status、partial build 不发布
query-ready 上层索引，成员变更标记 stale 或生成新 generation。目标设计的
`stateAndRecovery` 定义 durable status、events、checkpoints 和 recovery
summary；publish protocol 要求 staged artifacts 校验后原子提升，并最后写入
publish marker。`stage_gate_handoff` 不变量规定 staging、failed、running、
pending 或 stale 产物不得被下游当作 ready 输入。membership 阶段
`stateWrites` 已包含 `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 与 `.sha256`，并与
membership quality gate、events、status、checkpoints、recovery summary 同列。
membership 到 graph build 的 `rejectIf` 已覆盖 manifest checksum、
`queryReady`、members digest、decisions digest 和 split plan digest 的拒绝条件。
成员变化由 stable membership generation、manifest sha256、packageGeneration、
stale marker 和新 generation 规则覆盖。

剩余风险：split plan digest 条款语义明确，但字段名仍需在实现 schema 中固定为
机器可校验字段。当前设计层面的状态闭环已经满足固定基准。

结论：满足 D05。

## D06_quality_gates

status: PASS

证据：固定基准要求书架和 library 定义独立质量门，并覆盖 schema、checksum、
成员一致性、敏感信息和固定预算模拟。目标设计定义 `qualityGates.bookshelfGate`
和 `qualityGates.libraryGate`。bookshelf gate 包含 manifest schema/checksum、
成员 manifest sha256、成员 package gate、membership decisions schema、authority
order、用户 lock、LLM suggestion 接受状态、semantic schemas、evidence map、
embedding metadata、固定预算模拟、敏感扫描和 stale marker。library gate 包含
member bookshelf manifest sha256、member gate、virtual parent 展开、direct book
limit、semantic schemas、evidence map、embedding metadata、固定预算模拟、敏感
扫描和 stale marker。failure diagnostics 提供 typed error、failed check、
expected/observed digest 和 redacted locator。

剩余风险：membership quality gate 作为成员解析阶段质量门存在，但未来实现仍需把
字段级 schema、digest 字段和诊断字段落到独立 validator。固定 D06 的书架与
library gate 条件已满足。

结论：满足 D06。

## D07_incremental_scaling

status: PASS

证据：固定基准要求记录成员 manifest sha256 和 generation，定义增量刷新或保守
全量重建条件，并通过书架分层限制大库影响范围。目标设计的
`bookshelfContract.identity.generationRule` 要求 membership set、任一 member
manifest sha256、builder version、embedding fingerprint、clustering config、
summary config 或 evidence schema 变化时变更 bookshelf generation。
`bookshelf_members.json` 必填 `manifestSha256` 与 `packageGeneration`。bookshelf
和 library incremental refresh 均要求能以 checksum 证明未变输入，否则重建或标记
stale。超大书架由 virtual parent 和 materialized child shelves 拆分，library
通过 shelf count limit、directBookLimit 和 partitions 限制影响范围。

剩余风险：局部刷新算法的可定位性仍是实现风险；设计已提供保守全量重建和
stale_not_query_ready 出路。

结论：满足 D07。

## D08_security_privacy

status: PASS

证据：固定基准要求禁止 provider payload、密钥、原始 prompt/completion、绝对
路径和 query.log 进入可发布上层 manifest 或索引。目标设计的
`no_sensitive_payload_export` 不变量禁止这些内容进入书架/library manifest、索引、
质量门和诊断。bookshelf build、membership stage、library graph build 和 scoped
query 均列出 forbidden inputs。diagnostic redaction policy 只允许 schema、check
id、typed error、scope、member、artifact digest、bounded summary、redacted locator
和 remediation command，并禁止 provider request/response payload、raw prompt、
raw completion、api key、credential、absolute local path 和 query log content。
质量门包含 sensitive payload scan。

剩余风险：LLM suggestion rationale 必须保持 bounded redacted summary。当前设计
已有 suggestion gate 和 sensitive scan 约束。

结论：满足 D08。

## D09_cli_operability

status: PASS

证据：固定基准要求定义 scope resolution order，stale 或 ambiguity 快速 typed
error，并将 timing/cost 观测分解到层级阶段。目标设计定义 scope resolution order：
explicit bookId、explicit bookshelfId、explicit libraryId、configured default
library、fast ambiguity error。typed errors 覆盖 `missing_scope`、
`ambiguous_scope`、`upper_index_missing`、`upper_index_stale`、
`upper_quality_gate_failed`、`budget_exceeded_narrow_scope_required` 和
`upper_index_runtime_error`。CLI behavior matrix 覆盖 no scope、ambiguity、
missing index、stale、quality gate failed 和 over budget，并给出 timing fields。
scoped query execution 禁止 missing upper index auto-build、stale scope、
interactive exhaustive scan 和 failed/running staging generations。

剩余风险：行为矩阵仍未单独列出“只有
`BOOKSHELF_MEMBERSHIP_MANIFEST.json`、缺少 `BOOKSHELF_MANIFEST.json`”的 case。
现有 `upper_index_missing` 和 `upper_quality_gate_failed` 可覆盖；实现测试应增加该
显式用例。

结论：满足 D09。

## D10_testability

status: PASS

证据：固定基准要求至少 8 个必测案例，覆盖不同规模库固定预算验证和单书
hotplug 非回归。目标设计的主 `testContracts.requiredCases` 超过 8 项，覆盖
deleted upper indexes 后 single-book query 仍成功、用户显式 membership 权威、
LLM suggestion 不 query-ready、accepted suggestion 新 generation、oversized
category split、virtual parent routing、10/100/1000 books 固定 top-K、超预算
typed error、stale 拒绝、missing upper index 不重建、成员 package gate 失败
fail closed、evidence map、semantic edges、安全扫描、中断恢复、删除书标记
stale、exhaustive report 与 interactive query 分离、timing 分解。pipeline
testContracts 还覆盖缺 PUBLISH_READY、不合格 qmd projection、member
manifestSha256 变化时拒绝、publish marker 后发布和单书 query 非回归。

剩余风险：建议新增针对本轮 D05 修复的专项测试：membership manifest 必须作为
state write 进入 staged membership generation，以及 members/decisions/split plan
digest mismatch 必须使 graph build handoff fail closed。固定 D10 的数量、规模和
hotplug 非回归条件已满足。

结论：满足 D10。

## 最终判定

overallStatus: PASS

所有固定维度 D01-D10 均通过。第 9 轮 agent-1 的 D05 阻断项已在唯一规范设计中
闭合；本轮未发现新的设计阻断项。
