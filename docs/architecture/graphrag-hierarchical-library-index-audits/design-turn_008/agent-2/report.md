# design-turn_008 agent-2 设计复审报告

overallStatus: fail

## 审计范围

本报告按固定基准
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
的 D01-D10 复审唯一规范设计：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

复审重点为 membership 阶段只发布
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 且 `queryReady=false`、
`BOOKSHELF_MANIFEST.json` 留给
`materialized_bookshelf_graph_build` 阶段的设计是否闭环。

## 总体结论

设计未通过本轮复审。规范已经在 `manifestSchemas` 中明确区分
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 与 `BOOKSHELF_MANIFEST.json`：
前者是 membership-only handoff manifest，`queryReady` 必须为 false，
只能作为书架图构建输入；后者只能由
`materialized_bookshelf_graph_build` 在上层 GraphRAG 产物和书架质量门通过后
发布。

但 pipeline I/O 合同尚未把该区分贯穿到底：
`bookshelf_membership_resolution.emittedOutputs` 未列出
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 或其 checksum sidecar；
`stateWrites` 只列出 `state/membership-quality-gate.json`、诊断和 run state；
`nextStageInputs` 也未要求书架图构建读取 membership manifest。对应
`handoffMatrix` 从 membership 到 graph build 的交接产物只列出
`bookshelf_members.json`、`membership_decisions.jsonl` 和 split plan，未把
membership manifest、checksum sidecar、`queryReady=false` 或
membership-quality-gate 作为交接条件。

该缺口使 membership-only manifest 的发布、校验、恢复和下游消费缺少完整
阶段合同，属于 D05 状态闭环与恢复失败。由于 D05 是 partial publish 防护
维度，整体结论为 FAIL。其余维度按固定基准可判定为 PASS，但 D06、D07、
D09、D10 保留与该缺口相关的非阻断风险。

## D01_authority_boundaries

status: PASS

证据：`hardInvariants.book_package_authority_preserved` 规定单书包权威只能来自
单书 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd/GraphRAG/state 产物
和质量门，书架与 library 索引不得改变单书包身份、文件闭包或
`query_ready` 判定。`derived_upper_indexes_only` 进一步规定上层索引缺失、
损坏或过期不得使有效单书包变成 `not_query_ready`。scope 排除项也禁止把
书架或 library 索引写入单书可复制包文件闭包。

风险：membership handoff manifest 的阶段合同缺口不直接破坏单书包权威。
但若实现者误把 membership 阶段产物当成书架 query-ready manifest，可能造成
上层查询授权混淆。

结论：单书包权威边界保持成立，D01 通过。

## D02_fixed_query_budget

status: PASS

证据：`queryContract.interactiveBudget` 定义固定 `maxSemanticUnits`、
`maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用数和
token 上限，并要求证据无法放入预算时 fail closed 或要求收窄 scope。
`routing.noImplicitFullVaultScan` 禁止查询路径重建所有书、书架或 library
索引。`retrieval.firstStage` 和 `secondStage` 均受固定预算约束。

风险：membership-only manifest 缺少 handoff 闭环不改变查询预算本身；风险在于
缺失 query-ready 图产物时必须由 D09 typed error 拒绝，而不是从 membership
产物临时扫描成员。

结论：固定查询预算合同完整，D02 通过。

## D03_graphrag_semantic_alignment

status: PASS

证据：书架构建输入包含成员 `community_reports.parquet`、`entities.parquet`、
`relationships.parquet` 和受界的 `text_units.parquet`；书架构建步骤包括从
community reports 抽取 semantic units、从 entities/relationships 和 membership
派生 semantic edges、聚类并生成 bookshelf community reports。library 构建读取
物化书架 `BOOKSHELF_MANIFEST.json`、书架 semantic units、semantic edges、
community reports 和 evidence map，再生成 library 级 GraphRAG 产物。

风险：membership 阶段本身不生成语义单元或社区报告。该边界正确，但必须通过
阶段 I/O 明确 membership manifest 只是 graph build 输入，不能替代
GraphRAG semantic artifacts。

结论：GraphRAG 语义对齐成立，D03 通过。

## D04_evidence_traceability

status: PASS

证据：`upperGraphArtifactSchemas.evidenceMap` 定义 `evidence_map.parquet`，
字段覆盖 `targetBookId`、`targetSourceId`、`targetDocumentId`、
`targetContentHash`、`targetCommunityReportId`、`targetTextUnitId` 和
`targetArtifactDigest`。设计要求每个上层 semantic unit、semantic edge、
community 和 community report 具备 evidence map 行，除非只是无可回答内容的
纯 membership marker。查询输出要求提供 evidence lineage。

风险：membership-only manifest 不承载 answerable content，因此可以不提供完整
answer evidence lineage。风险在于若 query path 错读 membership-only manifest，
就会绕过 evidence map 要求。

结论：证据追溯合同完整，D04 通过。

## D05_state_recovery

status: FAIL

证据：设计在 `manifestSchemas.bookshelfManifest` 中规定
`BOOKSHELF_MANIFEST.json` 只能由 `materialized_bookshelf_graph_build` 在上层
GraphRAG 派生索引和 bookshelf 质量门通过后发布，membership 阶段不得用它表示
可查询书架。`manifestSchemas.bookshelfMembershipManifest` 规定 membership
阶段可以发布 `BOOKSHELF_MEMBERSHIP_MANIFEST.json`，证明
`bookshelf_members.json`、`membership_decisions.jsonl`、split plan 和
membership-quality-gate 已形成闭环；该 manifest 的 `queryReady` 必须为 false，
只能作为 `materialized_bookshelf_graph_build` 的输入，不能授权
`--bookshelf-id` 查询。

证据：pipeline stage 合同没有把上述规则落为完整 I/O。
`bookshelf_membership_resolution.emittedOutputs` 只列出
`membership_decisions.jsonl`、`bookshelf_members.json`、
`bookshelf_split_plan.json`、可选 `VIRTUAL_BOOKSHELF_MANIFEST.json` 和
membership diagnostics，未列出 `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 或
checksum sidecar。该 stage 的 `stateWrites` 只列出
`state/membership-quality-gate.json`、`state/diagnostics.json`、events 和
checkpoints；`nextStageInputs` 只列出 `bookshelf_members.json`、虚拟父到物化
子书架映射和 membership decisions generation digest。

证据：`materialized_bookshelf_graph_build.requiredInputs` 要求
`bookshelf_members.json`、成员 `BOOK_MANIFEST.json` 和成员 GraphRAG 产物，但未
要求 `BOOKSHELF_MEMBERSHIP_MANIFEST.json`、其 checksum、`queryReady=false` 断言
或 membership-quality-gate。`handoffMatrix` 从 membership 到 graph build 的
`handoffArtifacts` 也只列出 `bookshelf_members.json`、
`membership_decisions.jsonl` 和 split plan，`rejectIf` 未包含 membership
manifest 缺失、checksum mismatch、`queryReady` 非 false、membership quality
gate 缺失或失败。

风险：membership-only manifest 的规范性定义与 pipeline I/O 脱节，导致四类
状态闭环风险。第一，membership 阶段是否必须发布该 manifest 不可判定，因为
schema 说“可以发布”，stage outputs 却不列出。第二，恢复逻辑无法只依赖
published manifest、quality gate、checksums、events 和 checkpoints 判定
membership generation 是否可交给 graph build。第三，下游 graph build 可绕过
membership manifest，直接读取成员文件，削弱 `queryReady=false` 的防误用边界。
第四，partial publish 防护无法覆盖 membership manifest 本身的 staged write、
checksum、quality gate 和 publish marker。

结论：membership 阶段只发布
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 且 `queryReady=false`、
`BOOKSHELF_MANIFEST.json` 留给 graph build 的方向正确，但阶段合同没有闭环。
D05 不通过。

## D06_quality_gates

status: PASS

证据：`qualityGates.bookshelfGate.requiredChecks` 覆盖 manifest schema、
checksum sidecar、成员 manifest sha256、包 gate、membership decision schema、
authority order、用户 lock、LLM suggestion acceptance、超大类拆分、虚拟父
书架不直接拥有 semantic units、semantic schema、evidence map、embedding
metadata、固定预算模拟、敏感扫描和 stale marker。`membershipChecks` 定义
membership 专项 check ids，失败诊断必须使用 `upper_quality_gate_failed` 并带
`failedCheckId`。

风险：membership-quality-gate 存在，但未在 membership stage emitted outputs、
handoff artifacts 和 graph build required inputs 中与
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 绑定。因此 D06 本身满足“质量门存在”的固定
基准，但对本轮重点场景存在执行闭环风险。

结论：质量门定义满足基准，D06 通过；其闭环依赖 D05 修复。

## D07_incremental_scaling

status: PASS

证据：`stable_membership_generation` 要求记录成员集合、成员 manifest
sha256、`packageGeneration`、构建配置和索引 schema，成员变化必须生成新
generation 或标记 stale。`bookshelfContract.identity.generationRule` 要求成员
集合、成员 manifest sha256、builder version、embedding fingerprint、
clustering config、summary config 或 evidence schema 变化都会改变
`bookshelfGeneration`。书架与 library 均定义 checksum-based incremental
refresh，大库通过物化书架上限、虚拟父书架和 library partition 控制影响范围。

风险：如果 membership manifest 不作为 graph build handoff 的必需输入，
incremental refresh 仍能依靠 `bookshelf_members.json` 和 digest 工作，但缺少一个
统一、可校验的 membership generation envelope，增加 stale 判定分散实现的风险。

结论：增量扩展设计满足固定基准，D07 通过。

## D08_security_privacy

status: PASS

证据：`hardInvariants.no_sensitive_payload_export` 禁止 provider payload、原始
prompt、原始 completion、密钥、用户绝对路径和运行期 query.log 进入书架/library
manifest、索引、质量门和诊断。书架 `buildInputs.forbiddenInputs` 禁止 provider
request/response payloads、query logs、local absolute paths 和未校验损坏包。
`diagnosticRedactionPolicy` 明确 allowed/forbidden fields，并要求 manifest 与
diagnostics 只能记录 digest、schema id、bounded summary、check id 和 redacted
locator。

风险：membership manifest 未被 pipeline I/O 正式列为产物，会使敏感扫描的执行点
不够明确。不过 sensitivity policy 与质量门敏感扫描本身已经覆盖上层 manifest
类别。

结论：安全与隐私合同满足基准，D08 通过。

## D09_cli_operability

status: PASS

证据：`queryContract.routing.scopeResolutionOrder` 定义 explicit book、explicit
bookshelf、explicit library、configured default library 和 ambiguity error 的顺序。
typed errors 覆盖 `missing_scope`、`ambiguous_scope`、`upper_index_missing`、
`upper_index_stale`、`upper_quality_gate_failed`、
`budget_exceeded_narrow_scope_required` 和 `upper_index_runtime_error`。CLI 行为矩阵
覆盖缺 scope、scope 歧义、缺上层索引、stale、质量门失败和超预算。scoped query
阶段要求 selected scope exists and is query-ready，并禁止 query path 中
auto-build、stale scope、交互式全书扫描和 failed/running staging generation。

风险：typed error contract 能拒绝 membership-only manifest，但未显式列出
“仅存在 `BOOKSHELF_MEMBERSHIP_MANIFEST.json`、不存在
`BOOKSHELF_MANIFEST.json`”的专用场景。该场景可落到 `upper_index_missing` 或
`upper_quality_gate_failed`，但建议修复 D05 后在行为矩阵中明确，降低实现歧义。

结论：CLI 可操作性满足固定基准，D09 通过。

## D10_testability

status: PASS

证据：`testContracts.requiredCases` 超过 8 项，覆盖无 `PUBLISH_READY` 的书不被
投影、qmd projection 但缺包内 qmd index 的书被拒绝、membership 权威顺序、
LLM suggestion 不能进入 shelf build、accepted suggestion 生成新 membership
generation、超大分类拆分、虚拟父无 semantic units/community reports、
成员 `manifestSha256` 变化时 bookshelf build 拒绝、bookshelf build 只在质量门
和 publish marker 后发布、library direct book limit、stale member bookshelf
拒绝、缺上层索引不隐式构建、错误码一致、超预算 typed error、删除上层 catalog
不影响单书查询、诊断脱敏等。

风险：当前测试合同未直接覆盖本轮重点断言：membership 阶段应发布
`BOOKSHELF_MEMBERSHIP_MANIFEST.json`，该 manifest 的 `queryReady=false`，graph
build 必须把它作为输入，而 query 在只有 membership manifest 时必须拒绝
`--bookshelf-id`。这不是 D10 固定基准的数量性失败，但会降低 D05 修复后的可测性。

结论：测试合同满足固定基准，D10 通过；建议新增 membership manifest handoff
专项测试以锁定本轮修复。

## 必须修订项

- 在 `bookshelf_membership_resolution.emittedOutputs` 中加入
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 和
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256`，并声明该阶段不得发布
  `BOOKSHELF_MANIFEST.json`。
- 在 `bookshelf_membership_resolution.qualityGate` 或 `stateWrites` 中把
  membership manifest schema、checksum、`queryReady=false`、敏感扫描和
  membership-quality-gate 绑定为同一 staged publish 闭环。
- 在 `bookshelf_membership_resolution.nextStageInputs`、
  `materialized_bookshelf_graph_build.requiredInputs` 和从 membership 到 graph
  build 的 `handoffMatrix.handoffArtifacts` 中加入
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`、checksum sidecar 和
  `state/membership-quality-gate.json`。
- 在对应 `rejectIf` 中加入 membership manifest 缺失、checksum mismatch、
  `queryReady` 非 false、membership quality gate failed、membership generation
  digest 与 `bookshelf_members.json`/`membership_decisions.jsonl` 不一致。
- 在 query 行为或测试合同中增加“只有
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 而没有 `BOOKSHELF_MANIFEST.json` 时，
  `--bookshelf-id` 必须快速返回 typed error”的专项场景。
