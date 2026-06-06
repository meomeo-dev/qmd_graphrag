# design-turn_009 agent-2 设计复审报告

overallStatus: pass

## 审计范围

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计唯一规范设计：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮重点：

- membership 阶段状态闭环是否覆盖 manifest、checksum、gate、
  diagnostics、events、status、checkpoints 和 recovery-summary。
- `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 的 `queryReady=false` 是否明确不授权
  `--bookshelf-id` 查询。

## 总体结论

第 9 轮复审通过。规范设计已把第 8 轮 agent-2 指出的 membership handoff 缺口
补入 pipeline I/O 合同：`bookshelf_membership_resolution` 现在发布
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 与 checksum sidecar，写入
`state/membership-quality-gate.json`、`state/diagnostics.json`、
`runs/{runId}/events.jsonl`、`runs/{runId}/status.json`、
`runs/{runId}/checkpoints/{decisionId}.json` 和
`runs/{runId}/recovery-summary.json`。下游
`materialized_bookshelf_graph_build` 必须读取该 membership manifest、
checksum sidecar 和已通过的 membership quality gate。

查询授权边界也已闭合：`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 被定义为
`membership_only_handoff_manifest`，`queryReady` 必须为 `false`，只能作为
`materialized_bookshelf_graph_build` 的输入，不能授权 `--bookshelf-id`
查询。`BOOKSHELF_MANIFEST.json` 仍只能由书架图构建阶段在上层 GraphRAG 产物和
bookshelf 质量门通过后发布。

剩余风险均为实现落地风险：字段级 validator、CLI typed error 映射和专项测试
需要在实现阶段锁定，但不构成本轮固定 D01-D10 设计基准失败。

## D01_authority_boundaries

status: PASS

证据：`book_package_authority_preserved` 规定单书包权威只能来自单书
`BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd/GraphRAG/state 产物和质量门，
书架与 library 索引不得改变单书包身份、文件闭包或 `query_ready` 判定。
`derived_upper_indexes_only` 规定上层索引缺失、损坏或过期不得使有效单书包变成
`not_query_ready`。scope 排除项禁止把书架或 library 索引写入单书包闭包。

证据：membership manifest 位于
`graph_vault/catalog/bookshelves/{bookshelfId}` 派生边界内，authority 为
`membership_only_handoff_manifest`，规则明确其 `queryReady` 必须为 `false`，
不能授权 `--bookshelf-id` 查询。`BOOKSHELF_MANIFEST.json` 才是
`graph_build_query_ready_manifest`。

剩余风险：后续实现若错误地把 membership manifest 注册为 query-ready scope，会
破坏该边界。当前规范已用 manifest authority、`queryReady=false` 和查询禁用规则
阻断该误读。

结论：满足 D01。单书包权威边界与热插包隔离保持成立。

## D02_fixed_query_budget

status: PASS

证据：`fixed_interactive_query_cost` 禁止查询阶段把全部成员书
`community_reports` 作为 prompt 输入，也禁止按成员书数量创建不受限 map 调用。
`queryContract.interactiveBudget` 固定 `maxSemanticUnits`、`maxBookshelves`、
`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用数和 token 上限。
`routing.noImplicitFullVaultScan` 禁止查询路径重建或扫描全部书、书架和 library
索引。

证据：membership manifest 不包含可查询的上层 semantic units、community reports
或向量索引，且不授权 `--bookshelf-id` 查询。查询必须等待
`BOOKSHELF_MANIFEST.json` 与书架 GraphRAG artifacts 发布后，按固定预算读取上层
预计算语义单元。

剩余风险：如果 CLI 在只有 membership manifest 时临时遍历成员书，会绕过固定预算。
当前 `scoped_query_execution` 禁止 missing upper index auto-build 和 interactive
all-books scan，可用 `upper_index_missing` 或 `upper_quality_gate_failed` 快速失败。

结论：满足 D02。查询预算不随成员书数量线性增长。

## D03_graphrag_semantic_alignment

status: PASS

证据：书架图构建 required inputs 包含成员
`community_reports.parquet`、`entities.parquet`、`relationships.parquet` 和受界的
`text_units.parquet`。构建算法从 community reports 提取 semantic units，从
entities、relationships 与 membership 派生 semantic edges，聚类并生成书架级
community reports。library 图构建继续消费书架 semantic units、semantic edges、
community reports 和 evidence map。

证据：`semantic_edges.parquet` 保留 relation type、权重、方向、source entity
titles、source relationship ids、evidence map ids 和 generation，防止上层索引退化
为普通摘要检索。membership manifest 只负责成员闭环，不替代 GraphRAG 语义产物。

剩余风险：membership 阶段可产生 `bookshelf_membership` 关系线索，但不能被实现者当作
回答语义来源。规范已把回答语义留给后续 materialized bookshelf graph build。

结论：满足 D03。上层设计保持 GraphRAG community、entity、relationship 与预计算
语义单元对齐。

## D04_evidence_traceability

status: PASS

证据：`upperGraphArtifactSchemas.evidenceMap` 定义 `evidence_map.parquet`，字段覆盖
`targetBookId`、`targetBookshelfId`、`targetSourceId`、`targetDocumentId`、
`targetContentHash`、`targetCommunityReportId`、`targetTextUnitId` 和
`targetArtifactDigest`。规范要求每个上层 semantic unit、semantic edge、community
和 community report 至少有一条 evidence map 记录，纯 membership marker 且无可回答
内容时例外。

证据：查询输出必须提供 evidence lineage，且
`scoped_query_execution.qualityGate.requiredChecks` 要求 answer evidence 只引用已发布
artifacts。membership manifest 不授权回答生成，因此不会成为绕过 evidence map 的回答
来源。

剩余风险：membership decision 的 evidenceRefs 只能证明成员资格和包 readiness，不能替代
回答级证据 lineage。该风险已由 `BOOKSHELF_MANIFEST.json` 与 `evidence_map.parquet`
发布门控隔离。

结论：满足 D04。上层回答可追溯合同完整。

## D05_state_recovery

status: PASS

证据：固定基准要求 durable checkpoints/events/status、partial publish 防护和成员变更
stale/generation 处理。规范的 `stateAndRecovery.durableState` 覆盖 manifest、
status、events、checkpoints 和 recovery-summary；publish protocol 要求先写
`staging/{runId}`，校验 schema、checksum sidecars、质量门和诊断后再原子提升，publish
marker 最后写入。

证据：`bookshelf_membership_resolution.emittedOutputs` 现在列出
`BOOKSHELF_MEMBERSHIP_MANIFEST.json`、`BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256`、
`membership_decisions.jsonl`、`bookshelf_members.json`、`bookshelf_split_plan.json`
及各自 checksum sidecars。`stateWrites` 覆盖
`state/membership-quality-gate.json`、其 checksum、`state/diagnostics.json`、
`runs/{runId}/events.jsonl`、`runs/{runId}/status.json`、
`runs/{runId}/checkpoints/{decisionId}.json` 和
`runs/{runId}/recovery-summary.json`。

证据：`nextStageInputs` 要求
`BOOKSHELF_MEMBERSHIP_MANIFEST.json with queryReady false`、checksum sidecar、已通过的
`state/membership-quality-gate.json`、`bookshelf_members.json` 和 membership decisions
generation digest。`materialized_bookshelf_graph_build.requiredInputs` 也要求这些
membership handoff 产物。`handoffMatrix` 在 membership 到 graph build 的交接中拒绝
membership manifest 缺失、checksum mismatch、`queryReady` 非 false、membership
quality gate 缺失或失败。

证据：`BOOKSHELF_MANIFEST.json` 只能由 `materialized_bookshelf_graph_build` 在书架
GraphRAG artifacts 与 bookshelf quality gate 通过后发布。membership 失败输出明确
不发布 `BOOKSHELF_MANIFEST`，因此 partial membership build 不会发布 query-ready 上层
索引。

剩余风险：规范已闭合设计合同；实现阶段仍需确保事件、状态、checkpoint 与
recovery-summary 的字段 schema 可由 validator 独立判定 ready、failed、running、
pending 或 stale。

结论：满足 D05。membership 阶段状态闭环覆盖 manifest、checksum、gate、
diagnostics、events、status、checkpoints 和 recovery-summary。

## D06_quality_gates

status: PASS

证据：`qualityGates.bookshelfGate.requiredChecks` 覆盖 manifest schema、checksum
sidecars、成员 manifest sha256、成员包 gates、membership authority、用户 lock、LLM
suggestion 接受状态、semantic schemas、evidence map、embedding metadata、固定预算模拟、
敏感扫描和 stale marker。`libraryGate.requiredChecks` 覆盖 library manifest、成员
bookshelf manifest sha256、成员 bookshelf gates、虚拟父书架展开、direct book limit、
分区、semantic schemas、evidence map、固定预算模拟、敏感扫描和 stale marker。

证据：`membershipChecks` 定义 membership 专项 check ids，失败诊断必须使用
`upper_quality_gate_failed` 并带 `failedCheckId`。membership stage 的 `qualityGate`
readyState 为 `membership_resolved`，下游 graph build 必须读取已通过的
`state/membership-quality-gate.json`。

剩余风险：membership manifest 的字段级检查，例如 `queryReady == false`、files digest
与 quality gate digest 的一致性，需要实现为稳定 validator check ids。当前设计层面已把
质量门与 handoff 绑定。

结论：满足 D06。书架与 library 独立质量门完整，membership gate 也已纳入阶段交接。

## D07_incremental_scaling

status: PASS

证据：`stable_membership_generation` 要求记录成员集合、成员 manifest sha256、
`packageGeneration`、构建配置和索引 schema，成员变化必须生成新 generation 或标记
stale。`bookshelfContract.identity.generationRule` 要求成员集合、任一成员 manifest
sha256、builder version、embedding fingerprint、clustering config、summary config 或
evidence schema 变化都会改变 bookshelf generation。

证据：`bookshelf_members.json` 字段包含 `manifestSha256`、`packageGeneration`、
`queryReady`、membership source、decision id 和 split group。书架与 library 均定义基于
checksum 证明的增量刷新；无法局部证明时重建当前 scope 或标记 stale。大库通过物化书架
成员上限、虚拟父书架、direct book limit 与 library partition 限制影响范围。

剩余风险：membership manifest 是统一 generation envelope；实现阶段应确保 `files` 与
`membership` sections 固化所有成员 digest，避免增量刷新逻辑分散读取多个文件后产生
不一致判定。

结论：满足 D07。设计支持增量刷新和大库分层，不要求每次成员变更重建全库。

## D08_security_privacy

status: PASS

证据：`no_sensitive_payload_export` 禁止 provider payload、原始 prompt、原始
completion、密钥、用户绝对路径和运行期 query.log 进入书架/library manifest、索引、
质量门和诊断。`pipelineIoContract.redacted_diagnostics_only` 也要求所有阶段诊断只记录
digest、schema id、check id、bounded summary 和 scope-relative locator。

证据：`bookshelfContract.buildInputs.forbiddenInputs` 禁止 provider request/response
payloads、query logs、local absolute paths 和未校验损坏包。membership stage
`forbiddenInputs` 禁止 raw LLM prompt/completion 和 runner ledger events 作为分类证据。
`diagnosticRedactionPolicy` 明确 allowed/forbidden fields，membership manifest required
sections 包含 `sensitivityPolicy`。

剩余风险：membership 阶段可能接触 LLM suggestion records。实现者必须保持
`proposedRationale` 为 bounded redacted summary，并由敏感扫描拒绝 raw prompt、completion
或 provider payload。

结论：满足 D08。membership manifest、诊断和上层 manifest 均受脱敏和敏感扫描约束。

## D09_cli_operability

status: PASS

证据：`queryContract.routing.scopeResolutionOrder` 定义 explicit bookId、explicit
bookshelfId、explicit libraryId、configured default library 和 fast ambiguity error 的解析
顺序。typed errors 覆盖 `missing_scope`、`ambiguous_scope`、`upper_index_missing`、
`upper_index_stale`、`upper_quality_gate_failed`、
`budget_exceeded_narrow_scope_required` 和 `upper_index_runtime_error`。CLI behavior
matrix 覆盖无 scope、scope 歧义、缺上层索引、stale、质量门失败和超预算。

证据：`scoped_query_execution.requiredInputs` 要求 selected scope manifest、selected
scope quality gate、selected scope semantic units 或单书查询 artifacts。对 bookshelf
scope 而言，membership manifest 不满足这些 query-ready 输入。`manifestSchemas` 明确
membership manifest 不能授权 `--bookshelf-id` 查询；缺少 `BOOKSHELF_MANIFEST.json` 时应
快速返回 typed error，而不是自动构建或全书扫描。

剩余风险：规范未新增专用错误码
`membership_only_manifest_not_query_ready`。现有 `upper_index_missing` 或
`upper_quality_gate_failed` 足以覆盖，但实现阶段应固定映射，避免不同 CLI 路径输出不一致。

结论：满足 D09。只有 membership manifest 时不授权 `--bookshelf-id` 查询，CLI 应快速
typed error 并提供 status/build/rebuild remediation。

## D10_testability

status: PASS

证据：主 `testContracts.requiredCases` 超过 8 项，覆盖单书 hotplug 非回归、membership
权威顺序、LLM suggestion 未接受不 query-ready、accepted suggestion 新 generation、
超大书架拆分、虚拟父书架路由、10/100/1000 书固定预算、超预算 typed error、stale
library 拒绝、缺上层索引不隐式构建、成员 gate 失败、evidence map、semantic edges、
敏感扫描、中断恢复、删除书标记 stale、exhaustive report 与 interactive query 分离、
timing breakdown。

证据：pipeline I/O 的 `testContracts.requiredCases` 也覆盖 copied book 缺
`PUBLISH_READY` 不投影、qmd projection 缺包内 qmd index 被拒绝、membership user lock、
LLM suggestion-only 不能 feed shelf build、accepted suggestion 新 membership
generation、oversized taxonomy split、virtual parent 无 semantic artifacts、manifestSha256
变化拒绝、bookshelf 只在质量门和 publish marker 后发布、缺上层索引不构建、错误码一致、
诊断脱敏等。

剩余风险：建议在实现阶段新增或强化专项案例：membership 阶段必须发布
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 与 checksum；该 manifest `queryReady=false`；
graph build 必须把它作为 required input；只有 membership manifest 而无
`BOOKSHELF_MANIFEST.json` 时 `qmd query --bookshelf-id` 必须快速拒绝。该风险不构成 D10
基准失败，因为现有测试合同数量、固定预算和单书 hotplug 非回归覆盖已满足。

结论：满足 D10。测试合同足以支撑当前设计复审，membership handoff 专项测试应在实现阶段
落地。

## 最终判定

overallStatus: pass

D01-D10 均为 PASS。membership 阶段状态闭环已覆盖 manifest、checksum、gate、
diagnostics、events、status、checkpoints 和 recovery-summary；membership manifest
`queryReady=false` 不授权 `--bookshelf-id` 查询。未发现需要修改固定基准或实现代码的阻断
设计缺陷。
