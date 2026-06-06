# design-turn_010 agent-2 设计复审报告

overallStatus: PASS

## 审计范围

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计唯一规范设计：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮重点：确认 membership manifest、成员文件、decision jsonl、split plan、
quality gate、diagnostics、events、status、checkpoints、recovery-summary 的 I/O
和恢复闭环是否满足 D05。

## 总体结论

第 10 轮 agent-2 复审通过。唯一规范设计已将
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 限定为
`membership_only_handoff_manifest`，并要求 `queryReady=false`。membership
阶段的输出、状态写入、下游输入和 handoff reject 条件覆盖 membership manifest、
成员文件、`membership_decisions.jsonl`、split plan、质量门、diagnostics、
events、status、checkpoints 和 recovery-summary。

关键闭环已经形成：membership 阶段只证明成员 generation 已解析，不发布
`BOOKSHELF_MANIFEST.json`；materialized bookshelf graph build 必须读取已通过的
membership handoff 产物后，才能发布 query-ready 书架 manifest；查询阶段只读取
已发布且通过质量门的 scope，默认拒绝 stale、missing、running 或 failed 上层索引。

剩余风险均为实现落地风险：schema validator、digest 一致性校验、CLI typed error
映射、durable run artifacts 和专项 fixture 仍需在实现阶段按本文档完成。当前设计
合同本身满足固定 D01-D10 基准。

## D01_authority_boundaries

status: PASS

证据：`book_package_authority_preserved` 规定单书包权威只能来自
`BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd/GraphRAG/state 产物和质量门。
`derived_upper_indexes_only` 规定书架与 library 索引都是可重建派生物；上层索引
缺失、损坏或过期不得使有效单书包变成 `not_query_ready`。pipeline
`package_first_authority` 与 `catalog_is_derivative` 明确 catalog、书架和
library 不改变单书包身份、文件闭包或直接单书查询的 `query_ready` 判定。
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 是 `membership_only_handoff_manifest`，
`queryReady=false`，不能授权 `--bookshelf-id` 查询。

剩余风险：实现若错误地把 membership-only manifest 注册为查询权威，会破坏该边界。
规范已用 manifest authority、`queryReady=false`、query scope gate 和 handoff
reject 条件阻断该误读。

结论：满足 D01。

## D02_fixed_query_budget

status: PASS

证据：`queryContract.interactiveBudget` 固定 `maxSemanticUnits: 32`、
`maxBookshelves: 4`、`maxBooksForDeepening: 3`、`maxMemberCommunityRefs: 24`、
LLM 调用上限、输入 token 上限和输出 token 上限。`fixed_interactive_query_cost`
禁止查询阶段把全部成员书 `community_reports` 作为 prompt 输入，也禁止按成员书
数量创建不受限 map 调用。`routing.noImplicitFullVaultScan` 禁止查询路径重建或
扫描全部 books、shelves 或 library indexes。超预算路径定义
`budget_exceeded_narrow_scope_required`，要求 fail closed 或收窄 scope。

剩余风险：若 CLI 在只有 membership manifest 时临时遍历成员书，会绕过固定预算。
当前规范明确 membership manifest 不授权查询，missing upper index 必须快速返回
`upper_index_missing` 或质量门错误。

结论：满足 D02。

## D03_graphrag_semantic_alignment

status: PASS

证据：书架层级输入包含成员 `community_reports.parquet`、`entities.parquet`、
`relationships.parquet` 和受界的 `text_units.parquet`。`semantic_edges.parquet`
要求 `relationType`、`weight`、`direction`、`sourceEntityTitles`、
`sourceRelationshipIds`、`evidenceMapIds` 和 `generation`。书架构建从 member
community reports 抽取 semantic units，从 entities、relationships 和 membership
派生 semantic edges，聚类后生成书架级 community reports。library 构建继续消费书架
semantic units、semantic edges、community reports 和 evidence map。

剩余风险：membership 关系可形成 `bookshelf_membership` 边，但不能替代可回答的
GraphRAG 语义产物。规范已把 membership-only handoff 与 graph build query-ready
manifest 分离。

结论：满足 D03。

## D04_evidence_traceability

status: PASS

证据：`evidence_map.parquet` 必填 `targetBookId`、`targetBookshelfId`、
`targetSourceId`、`targetDocumentId`、`targetContentHash`、
`targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。规范要求
每个上层 semantic unit、semantic edge、community 和 community report 至少有一条
evidence map 记录，纯 membership marker 且无可回答内容时例外。bookshelf 和
library build 均要求写入从上层 reports 到下层 book 或 shelf/book evidence 的
`evidence_map.parquet`。query synthesis 要求最终回答包含 traceable evidence ids。

剩余风险：`membership_decisions.jsonl` 的 `evidenceRefs` 只能证明成员资格、用户接受
和 policy 决策，不能替代回答级 evidence lineage。当前设计已将回答证据绑定到 graph
build 产出的 `evidence_map.parquet`。

结论：满足 D04。

## D05_state_recovery

status: PASS

证据：固定基准要求 durable checkpoints/events/status、partial build 不发布
query-ready 上层索引、成员变更 stale 或新 generation。规范的
`stateAndRecovery.durableState` 覆盖 `status.json`、`events.jsonl`、
`checkpoints/{unitId}.json` 和 `recovery-summary.json`。`publishProtocol` 要求先写
`staging/{runId}`，校验 staged artifacts 和 checksum sidecars，写入 quality gate 与
diagnostics 后再原子提升 current generation，publish marker 最后写入。

证据：`bookshelf_membership_resolution.emittedOutputs` 覆盖
`BOOKSHELF_MEMBERSHIP_MANIFEST.json`、checksum sidecar、
`membership_decisions.jsonl`、checksum sidecar、`bookshelf_members.json`、
checksum sidecar、`bookshelf_split_plan.json`、checksum sidecar、可选
`VIRTUAL_BOOKSHELF_MANIFEST.json` 和 membership diagnostics。该阶段
`stateWrites` 覆盖 membership manifest、checksum sidecar、
`state/membership-quality-gate.json`、checksum sidecar、`state/diagnostics.json`、
`runs/{runId}/events.jsonl`、`runs/{runId}/status.json`、
`runs/{runId}/checkpoints/{decisionId}.json` 和
`runs/{runId}/recovery-summary.json`。

证据：`nextStageInputs` 要求 `BOOKSHELF_MEMBERSHIP_MANIFEST.json with queryReady
false`、checksum sidecar、passed membership quality gate、`bookshelf_members.json`、
虚拟父到物化子书架映射，以及 accepted membership decisions generation digest。
`materialized_bookshelf_graph_build.requiredInputs` 再次要求 membership manifest、
checksum sidecar、passed membership gate，以及带 `manifestSha256` 和
`packageGeneration` 的 `bookshelf_members.json`。

证据：handoff matrix 从 membership 到 graph build 的 reject 条件覆盖 membership
manifest 缺失或 checksum mismatch、`queryReady` 非 false、members digest 与
`bookshelf_members.json` 不一致、decisions digest 与 `membership_decisions.jsonl`
不一致、split plan digest 缺失或不匹配、membership quality gate 缺失或未通过、
LLM suggestion 未接受、超大成员未拆分和用户 lock 冲突未解决。membership failure
outputs 明确不发布 affected materialized shelf 的 `BOOKSHELF_MANIFEST.json`；
graph build failure outputs 明确 failed staging generation 不提升，成员 digest 变化时
输出 `stale_not_query_ready`。

证据：`stateClosure` 要求每个阶段都能从 authority root、published manifest、
quality gate、checksums、events 和 checkpoints 判断 `query_ready`、
`not_query_ready`、`stale_not_query_ready`、`failed`、`running`、
`pending_user_acceptance` 或 `quarantined`，恢复逻辑不得依赖调用者内存状态。

剩余风险：设计闭环已满足 D05；实现阶段仍需把 membership manifest 的文件摘要、成员
摘要、decisions 摘要、split plan 摘要和 quality gate 摘要做成机器可验证 schema。
library membership 阶段当前只列出 `runs/{runId}/events.jsonl`，没有像 bookshelf
membership 一样显式列出 status、checkpoints 和 recovery-summary；但全局
`stateAndRecovery` 与 `stateClosure` 已覆盖全部构建阶段，且本轮重点的 bookshelf
membership handoff 已闭合。实现时建议对 library membership stateWrites 采用同等显式度。

结论：满足 D05。membership manifest、成员文件、decision jsonl、split plan、
quality gate、diagnostics、events、status、checkpoints 和 recovery-summary 的 I/O
与恢复闭环已经形成，partial build 不会发布 query-ready 上层索引。

## D06_quality_gates

status: PASS

证据：`qualityGates.bookshelfGate.requiredChecks` 覆盖 manifest schema、checksum
sidecars、成员 manifest sha256、成员 package gates、membership decisions schema、
authority order、用户 lock、LLM suggestion 接受状态、oversized split、virtual parent、
semantic schemas、evidence map、embedding metadata、固定预算模拟、sensitive payload
scan 和 stale marker。`qualityGates.libraryGate.requiredChecks` 覆盖 library manifest
schema、checksum sidecars、成员 bookshelf manifest sha256、成员 bookshelf gates、
virtual parent expansion、direct book limit、partition、semantic schemas、evidence map、
embedding metadata、固定预算模拟、sensitive payload scan 和 stale marker。
`membershipChecks` 定义 membership 专项 check ids，失败诊断必须使用
`upper_quality_gate_failed` 并设置 `failedCheckId`。

剩余风险：membership gate 通过不等于 bookshelf graph gate 通过。实现必须保持
`membership_resolved` 与 `bookshelf_query_ready` 的 ready state 分离。

结论：满足 D06。

## D07_incremental_scaling

status: PASS

证据：`stable_membership_generation` 要求记录成员集合、成员 manifest sha256、
`packageGeneration`、构建配置和索引 schema；成员变化必须生成新 generation 或标记
stale。bookshelf generation 随成员集合、任一成员 manifest sha256、builder version、
embedding fingerprint、clustering config、summary config 或 evidence schema 变化。
`bookshelf_members.json` 必填 `manifestSha256` 和 `packageGeneration`。bookshelf 与
library 均定义 checksum 可证明的局部刷新，否则重建或标记 stale。大库通过
materialized shelf book limit、virtual parent、directBookLimit、shelf count limit 和
partition policy 限制重建影响范围。

剩余风险：direct book membership 需要严格限制在 small libraries 或 transitional
repair 场景，否则可能绕开书架分层。规范已有 directBookLimit 和 library gate。

结论：满足 D07。

## D08_security_privacy

status: PASS

证据：`no_sensitive_payload_export` 禁止 provider payload、原始 prompt、原始
completion、密钥、用户绝对路径和运行期 `query.log` 进入书架/library manifest、索引、
质量门和诊断。bookshelf build `forbiddenInputs` 禁止 provider request/response
payloads、query logs、local absolute paths 和 unvalidated damaged book packages。
membership stage `forbiddenInputs` 禁止 raw LLM prompt/completion 和 runner ledger
events as classification evidence。`diagnosticRedactionPolicy` 只允许 schema/check
ids、typed error、scope/member id、artifact digest、bounded summary、redacted locator
和 remediation command，并禁止 provider payload、raw prompt/completion、api key、
credential、absolute local path 和 query log content。

剩余风险：LLM suggestion records 的 `proposedRationale` 必须保持 bounded redacted
summary。实现需用 fixture 覆盖 raw prompt、raw completion 和 provider payload 不落盘。

结论：满足 D08。

## D09_cli_operability

status: PASS

证据：scope resolution order 定义 explicit `bookId`、explicit `bookshelfId`、
explicit `libraryId`、configured default library、fast ambiguity error with
candidates。typed errors 覆盖 `missing_scope`、`ambiguous_scope`、
`upper_index_missing`、`upper_index_stale`、`upper_quality_gate_failed`、
`budget_exceeded_narrow_scope_required` 和 `upper_index_runtime_error`。CLI behavior
matrix 覆盖无 scope、scope 歧义、缺上层索引、stale、quality gate failed 和
over budget，并列出 timing fields。`scoped_query_execution` 禁止 missing upper
index auto-build、默认读取 stale scope、interactive exhaustive all-books scan 和
failed/running staging generation。

剩余风险：grounding review 明确 bookshelf/library CLI scope 和 upper typed error
mapping 仍是待实现能力。实现前应先补 explicit CLI scope contract tests。

结论：满足 D09。

## D10_testability

status: PASS

证据：主 `testContracts.requiredCases` 超过 8 项，覆盖单书 query 非回归、membership
authority、LLM suggestion、accepted suggestion、oversized category、virtual parent、
10/100/1000 books 固定 top-K、预算超限、stale、missing upper index、member package
gate failure、evidence map、安全扫描、partial publish、删除单书 stale 和 timing。
pipeline `testContracts.requiredCases` 超过 8 项，覆盖 package projection、
membership resolution、suggestion-only、accepted suggestion、oversized taxonomy、
virtual parent、manifest sha256 drift、publish marker、library direct book limit、
stale member shelf、scoped query typed errors、预算错误、删除上层 catalog 不破坏单书
query 和 redacted diagnostics。测试合同明确包含不同规模库的固定预算验证和
single-book hotplug 非回归。

剩余风险：当前是设计测试合同，不代表测试已经实现。后续实现必须补齐 membership
handoff negative cases、durable run artifacts、digest mismatch、sensitive diagnostics
和 CLI typed error fixtures。

结论：满足 D10。

## D05 重点产物闭环复核表

| 产物 | 判定 | 证据 |
| --- | --- | --- |
| `BOOKSHELF_MEMBERSHIP_MANIFEST.json` | PASS | emittedOutputs、stateWrites、nextStageInputs、graph build requiredInputs 和 handoff artifacts 均列出；authority 为 `membership_only_handoff_manifest`，`queryReady=false`。 |
| `bookshelf_members.json` | PASS | emittedOutputs、nextStageInputs、graph build requiredInputs 和 handoff artifacts 均列出；required fields 包含 `manifestSha256` 与 `packageGeneration`。 |
| `membership_decisions.jsonl` | PASS | membership schema 定义 required fields；emittedOutputs、handoff artifacts 和 bookshelf gate requiredChecks 均覆盖。 |
| `bookshelf_split_plan.json` | PASS | emittedOutputs 包含 split plan 与 checksum；handoff artifacts 包含 split plan；rejectIf 覆盖 split plan digest 缺失或 mismatch。 |
| membership quality gate | PASS | stateWrites 包含 `state/membership-quality-gate.json` 与 checksum；nextStageInputs 要求 status passed；handoff rejectIf 覆盖缺失或未通过。 |
| diagnostics | PASS | stateWrites 包含 `state/diagnostics.json`；quality gate failure diagnostics 定义 bounded fields 和 redaction rule。 |
| events | PASS | stateWrites 包含 `runs/{runId}/events.jsonl`；全局 durableState 要求 append-only events。 |
| status | PASS | stateWrites 包含 `runs/{runId}/status.json`；stateClosure 要求从状态产物判断阶段状态。 |
| checkpoints | PASS | stateWrites 包含 `runs/{runId}/checkpoints/{decisionId}.json`；恢复规则要求从 validated checkpoints 恢复。 |
| recovery-summary | PASS | stateWrites 包含 `runs/{runId}/recovery-summary.json`；全局 durableState 和 recovery rules 覆盖恢复摘要。 |

## overallStatus

PASS
