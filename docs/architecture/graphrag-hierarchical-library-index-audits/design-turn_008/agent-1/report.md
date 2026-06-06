# design-turn_008 agent-1 设计复审报告

overallStatus: PASS

## 审计范围

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计唯一规范设计：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮重点审计新增或澄清的
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 边界是否仍满足固定 D01-D10
维度。审计未修改固定基准、规范设计或实现代码。

## 总体结论

第 8 轮复审判定为 PASS。新增
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 被定义为
`membership_only_handoff_manifest`，只证明
`bookshelf_members.json`、`membership_decisions.jsonl`、split plan 和
membership quality gate 已闭环。其 `queryReady` 必须为 `false`，只能作为
`materialized_bookshelf_graph_build` 输入，不能授权 `--bookshelf-id` 查询。

该边界没有改变单书包 `BOOK_MANIFEST.json` 的包权威，没有把 membership
阶段误升级为 GraphRAG 查询索引，也没有破坏固定查询预算、证据可追溯、
状态恢复、质量门、安全隐私、CLI 降级或测试合同。

非阻断风险：pipeline I/O 的 `bookshelf_membership_resolution` 阶段输出与
交接矩阵仍主要列出成员文件和 split plan，未显式列入
`BOOKSHELF_MEMBERSHIP_MANIFEST.json`。由于 manifest schema 已明确
`queryReady: false` 且不能授权查询，该风险不构成 D01-D10 失败；实现前应
补充阶段矩阵一致性。

## D01_authority_boundaries

status: PASS

证据：固定基准要求单书包 `BOOK_MANIFEST.json` 保持唯一包权威。规范设计将
`graph_vault/books/{bookId}` 定为单书包权威根，排除把书架或 library 索引
写入单书可复制包闭包，并通过 `book_package_authority_preserved` 与
`derived_upper_indexes_only` 规定上层索引缺失、损坏或过期不得改变单书
`query_ready`。新增 manifest 位于书架 catalog 派生边界内，authority 为
`membership_only_handoff_manifest`，不授予 bookshelf query readiness。

风险：若实现者把 `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 误解为可查询书架
权威，会破坏单书包与上层索引边界。当前规范以 `queryReady: false` 和
“不能授权 `--bookshelf-id` 查询”阻断该误读。

结论：满足 D01。新增 membership handoff manifest 不改变单书包权威，不写入
单书文件闭包，也不影响 catalog 损坏或缺失时的单书挂载状态。

## D02_fixed_query_budget

status: PASS

证据：固定基准要求固定 top-K 或明确预算参数，并禁止交互查询全量扫描所有
单书 `community_reports`。规范设计的 `fixed_interactive_query_cost` 禁止
按成员书数量创建不受限 map 调用；`queryContract.interactiveBudget` 固定
`maxSemanticUnits: 32`、`maxBookshelves: 4`、`maxBooksForDeepening: 3`、
`maxMemberCommunityRefs: 24`、LLM 调用数和 token 上限。新增 manifest 只
作为图构建输入，不能授权查询。

风险：membership manifest 不包含上层 semantic units、community reports 或
向量索引。若 CLI 误以它执行 `--bookshelf-id` 查询，容易退化为成员全集
扫描。当前规范明确禁止这种查询授权。

结论：满足 D02。新增边界没有放宽固定预算；查询仍必须等待
`BOOKSHELF_MANIFEST.json` 和上层 GraphRAG artifacts 发布后执行。

## D03_graphrag_semantic_alignment

status: PASS

证据：固定基准要求保留 GraphRAG community report、entity、relationship
和 map-reduce 原理。书架构建输入包含成员书 `community_reports.parquet`、
`entities.parquet` 与 `relationships.parquet`；`semantic_edges.parquet`
保留 relation type、权重、方向、entity title、relationship id、evidence
map id 和 generation；书架构建步骤从 community reports 提取 semantic
units，派生 semantic edges，聚类并生成书架级 community reports。新增
membership manifest 不承载 GraphRAG 查询语义单元。

风险：membership 数据可形成 `bookshelf_membership` 关系，但不能替代
GraphRAG community report、entity 和 relationship 输入。当前设计把
membership-only manifest 与 `BOOKSHELF_MANIFEST.json` 分离。

结论：满足 D03。新增 manifest 没有把书架索引语义降级为成员清单；GraphRAG
语义仍由后续图构建产物提供。

## D04_evidence_traceability

status: PASS

证据：固定基准要求回答可追溯到 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report 或 text unit。规范设计定义
`evidence_map.parquet`，字段覆盖 `targetBookId`、`targetBookshelfId`、
`targetSourceId`、`targetDocumentId`、`targetContentHash`、
`targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。
每个上层 semantic unit、semantic edge、community 和 community report
至少有一条 evidence map 记录，纯 membership marker 且无可回答内容时例外。
新增 manifest 不授权回答生成。

风险：membership manifest 可能包含成员、决策、split plan 和 quality gate
摘要。这些信息只能作为成员闭环证据或纯 membership marker，不能作为回答
内容的唯一语义证据。

结论：满足 D04。新增边界没有削弱证据追溯；可回答内容仍必须来自发布后的
上层 GraphRAG artifacts 与 evidence map。

## D05_state_recovery

status: PASS

证据：固定基准要求 durable checkpoints/events/status、partial build 不
发布 query-ready 上层索引、成员变更标记 stale 或生成新 generation。规范
定义 `runs/{runId}`、`status.json`、`events.jsonl`、checkpoints 与
`recovery-summary.json`，并要求 staging 校验通过后原子提升 current
generation，publish marker 最后写入。membership resolution 失败时不发布
`BOOKSHELF_MANIFEST.json`。新增 manifest 的 `queryReady` 必须为 `false`。

风险：pipeline 阶段 `emittedOutputs`、`nextStageInputs` 和 `handoffMatrix`
未显式列出新增 membership manifest，可能弱化其 handoff 作用。但这不会导致
partial query-ready，因为 `BOOKSHELF_MANIFEST.json` 仍只能由图构建阶段发布。

结论：满足 D05。membership 阶段新增 manifest 不会发布可查询上层索引；
中断、失败、恢复和 stale 边界仍由质量门、generation 与 publish protocol
闭合。

## D06_quality_gates

status: PASS

证据：固定基准要求书架和 library 均有独立质量门，覆盖 schema、checksum、
成员一致性、敏感信息和固定预算模拟。规范定义 `qualityGates.bookshelfGate`
与 `qualityGates.libraryGate`，覆盖成员 manifest sha256、成员 gate、
membership authority、用户 lock、LLM suggestion 接受状态、semantic schemas、
evidence map、固定预算模拟、敏感扫描和 stale marker。`membershipChecks`
定义成员相关稳定 check ids。新增 manifest 必须包含 `qualityGate` 与
`sensitivityPolicy`，且不能授权查询。

风险：membership handoff manifest 尚未细化字段级 required checks，例如
`queryReady == false`、`nextStage == materialized_bookshelf_graph_build`、
files digest 与 membership-quality-gate 的对应关系。当前规则足以通过 D06，
实现前应落实为 validator check ids。

结论：满足 D06。书架和 library 质量门完整；新增 membership manifest 受
membership quality gate 与 queryReady false 约束，不会绕过书架图质量门。

## D07_incremental_scaling

status: PASS

证据：固定基准要求记录成员 manifest sha256 和 generation，定义增量刷新或
保守全量重建条件，并通过书架分层限制大库影响范围。规范要求 bookshelf
generation 随成员集合、任一成员 manifest sha256、builder version、
embedding fingerprint、clustering config、summary config 或 evidence schema
变化而变化。`bookshelf_members.json` 字段包含 `manifestSha256`、
`packageGeneration`、`queryReady` 和 membership decision 信息。书架与
library 均定义 checksum 证明下的局部刷新，否则重建或标记 stale；超大书架
通过 virtual parent 与 materialized child shelves 分层。

风险：新增 manifest schema 段落只列 required sections，未逐字段展开
`manifestSha256` 与 `packageGeneration`。由于 `bookshelf_members.json` 已有
字段级合同，D07 仍满足；实现时应确保 manifest 的 `files` 与 `membership`
sections 固化这些 digest。

结论：满足 D07。新增 handoff manifest 保持成员 generation 可重建边界，不
要求每次成员变更都重建全库。

## D08_security_privacy

status: PASS

证据：固定基准要求禁止 provider payload、密钥、raw prompt/completion、
绝对路径和 `query.log` 进入可发布上层 manifest 或索引。规范的
`no_sensitive_payload_export`、`bookshelfContract.buildInputs.forbiddenInputs`
和 `diagnosticRedactionPolicy` 禁止 provider request/response payloads、
raw prompt、raw completion、api key、credential、absolute local path 与
query log。新增 manifest required sections 包含 `sensitivityPolicy`，LLM
suggestion rationale 只能是 bounded redacted summary。

风险：membership 阶段可能接触 LLM suggestion records。若实现者把 raw LLM
prompt、completion 或 provider payload 写入 membership manifest，会违反
D08。当前设计通过 forbidden inputs、redaction policy、sensitivity policy 和
敏感扫描禁止该路径。

结论：满足 D08。新增 membership manifest 属于可发布上层 manifest，因此
同样受脱敏和敏感扫描约束；规范已覆盖该安全边界。

## D09_cli_operability

status: PASS

证据：固定基准要求定义 scope resolution order，stale 或 ambiguity 快速
typed error，并提供分层 timing/cost 观测。规范定义 explicit bookId、
explicit bookshelfId、explicit libraryId、configured default library 和 fast
ambiguity error 的解析顺序；typed errors 覆盖 `missing_scope`、
`ambiguous_scope`、`upper_index_missing`、`upper_index_stale`、
`upper_quality_gate_failed`、`budget_exceeded_narrow_scope_required` 和
`upper_index_runtime_error`。CLI behavior matrix 覆盖 no scope、ambiguous
scope、missing upper index、stale、quality gate failed 和 over budget。
新增 manifest 明确不能授权 `--bookshelf-id` 查询。

风险：typed error 合同没有专门命名
`membership_only_manifest_not_query_ready`。现有 `upper_index_missing` 与
`upper_quality_gate_failed` 可覆盖该场景，但实现前应选择稳定映射，避免 CLI
对只有 membership manifest 的书架尝试构建或扫描。

结论：满足 D09。新增 manifest 不改变 CLI 降级要求；它不能成为
`--bookshelf-id` 查询 scope，异常应快速 typed error。

## D10_testability

status: PASS

证据：固定基准要求至少 8 个必测案例，包含不同规模库固定预算验证和单书
hotplug 非回归。主设计与 pipeline I/O 的 `testContracts.requiredCases` 均
超过 8 个，覆盖单书查询在 catalog 上层索引删除后仍成功、用户显式
membership 优先、LLM suggestion 不可 query-ready、接受建议生成新
generation、超大类别拆分、虚拟父书架固定路由、10/100/1000 书固定 top-K、
超预算错误、stale 拒绝、缺上层索引不隐式构建、证据图、安全扫描、中断
恢复和删除书后 stale 行为。新增 manifest 的 `queryReady: false` 边界可由
这些测试覆盖。

风险：测试合同尚未显式命名
`BOOKSHELF_MEMBERSHIP_MANIFEST.json queryReady false cannot authorize
--bookshelf-id query` 案例。现有测试覆盖足以满足 D10 基准，但实现前应加入
专门 fixture，防止 membership handoff manifest 被误读为查询 manifest。

结论：满足 D10。测试合同数量和覆盖面符合固定基准；新增边界建议补充显式
membership manifest 反例测试，但不构成当前设计失败。

## 必须修订位置

无。

## 建议实现前澄清项

- 在 pipeline I/O 的 `bookshelf_membership_resolution.emittedOutputs`、
  `nextStageInputs` 和 `handoffMatrix` 中显式列入
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`。
- 为 membership manifest validator 增加稳定检查：`queryReady == false`、
  `authority == membership_only_handoff_manifest`、`nextStage ==
  materialized_bookshelf_graph_build`、files digest valid、sensitivity scan
  passed。
- 在测试合同中增加显式反例：只有
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 而没有 `BOOKSHELF_MANIFEST.json`
  时，`--bookshelf-id` 查询必须快速返回 typed error，不得扫描成员书或隐式
  构建上层索引。
