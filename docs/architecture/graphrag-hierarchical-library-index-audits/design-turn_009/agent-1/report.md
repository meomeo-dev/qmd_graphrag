# design-turn_009 agent-1 设计复审报告

overallStatus: FAIL

## 审计范围
固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计唯一规范设计：
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮重点复核第 8 轮 D05 失败项：
`BOOKSHELF_MEMBERSHIP_MANIFEST` 是否已纳入 membership emittedOutputs、
stateWrites、nextStageInputs、
`materialized_bookshelf_graph_build.requiredInputs`、handoffMatrix 和
rejectIf。审计未修改固定基准、规范设计或实现代码。

## 总体结论

第 9 轮复审判定为 FAIL。目标设计已经把
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 纳入
`bookshelf_membership_resolution.emittedOutputs`、`nextStageInputs`、
`materialized_bookshelf_graph_build.requiredInputs` 和从 membership 到
graph build 的 handoffMatrix，并在 rejectIf 中加入 manifest 缺失、
checksum mismatch、`queryReady` 非 false 和 membership quality gate
缺失或未通过。

剩余阻断缺口在 D05：`bookshelf_membership_resolution.stateWrites` 未显式
列入 `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 及其 checksum，不能证明该
membership-only handoff manifest 与 membership quality gate、events、
checkpoints 处于同一个持久状态闭环；handoffMatrix.rejectIf 也未拒绝
membership generation digest 与 `bookshelf_members.json`、
`membership_decisions.jsonl` 不一致的情况。该缺口仍影响中断恢复和
partial publish 防护，因此 D05 未达到固定基准。

## 第 8 轮 D05 修复点复核

status: FAIL

证据：

- `bookshelf_membership_resolution.emittedOutputs` 已列出
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 和
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256`。
- `bookshelf_membership_resolution.nextStageInputs` 已列出
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json with queryReady false`、
  checksum sidecar、`state/membership-quality-gate.json with status
  passed`、`bookshelf_members.json`、虚拟父到物化子书架映射和
  membership decisions generation digest。
- `materialized_bookshelf_graph_build.requiredInputs` 已要求
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json with queryReady false`、
  checksum sidecar、passed membership quality gate 和带
  `manifestSha256`、`packageGeneration` 的 `bookshelf_members.json`。
- handoffMatrix 中 `bookshelf_membership_resolution` 到
  `materialized_bookshelf_graph_build` 的 handoffArtifacts 已列出
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`、checksum sidecar、
  `state/membership-quality-gate.json`、`bookshelf_members.json`、
  `membership_decisions.jsonl` 和 split plan。
- 同一 handoffMatrix.rejectIf 已列出
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json missing or checksum mismatch`、
  `BOOKSHELF_MEMBERSHIP_MANIFEST queryReady is not false`、
  `membership quality gate missing or not passed`、未接受 LLM suggestion、
  未拆分超大成员数和未解决用户 lock 冲突。
- 但 `bookshelf_membership_resolution.stateWrites` 只列出
  `state/membership-quality-gate.json`、checksum、diagnostics、events、
  status、checkpoints 和 recovery summary，未列出
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 或其 checksum。
- handoffMatrix.rejectIf 未覆盖 membership generation digest 与
  `bookshelf_members.json`、`membership_decisions.jsonl` 或 split plan digest
  不一致。

剩余风险：membership manifest 可以作为 emitted output 出现，但未被
stateWrites 明确绑定到阶段状态写入、checkpoint 恢复和 publish marker。
中断恢复时实现者仍可能只依赖 `bookshelf_members.json` 与 quality gate，
绕过 membership manifest 的 generation envelope。若成员文件或决策文件与
manifest 摘要不一致，下游 graph build 缺少明确拒绝条件。

结论：第 8 轮 D05 的大部分结构性缺口已经修复，但 stateWrites 与 digest
一致性 rejectIf 未闭合，D05 仍失败。

## D01_authority_boundaries

status: PASS

证据：固定基准要求单书包 `BOOK_MANIFEST.json` 保持唯一包权威，书架和
library 只能作为可重建派生物。目标设计将
`graph_vault/books/{bookId}` 定为单书 authorityRoot，并在
`book_package_authority_preserved`、`derived_upper_indexes_only` 和
pipeline `package_first_authority`、`catalog_is_derivative` 中规定书架与
library 不改变单书包身份、文件闭包或单书 query_ready 判定。manifest schema
还区分 `BOOKSHELF_MANIFEST.json` 的
`graph_build_query_ready_manifest` 与
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 的
`membership_only_handoff_manifest`，后者 `queryReady` 必须为 false，不能授权
`--bookshelf-id` 查询。

剩余风险：实现若把 membership-only manifest 当成书架查询权威，会破坏
边界。当前规范已经用 `queryReady: false` 和 graph build 后置发布规则阻断
该误读。

结论：满足 D01。

## D02_fixed_query_budget

status: PASS

证据：固定基准要求查询阶段使用固定 top-K 或预算参数，禁止查询时全量扫描
所有单书 community_reports，并在超预算时 fail closed 或收窄 scope。目标设计
的 `queryContract.interactiveBudget` 固定 `maxSemanticUnits: 32`、
`maxBookshelves: 4`、`maxBooksForDeepening: 3`、
`maxMemberCommunityRefs: 24`、LLM 调用数、输入 token 和输出 token。
`fixed_interactive_query_cost` 与 pipeline `fixed_query_budget` 禁止按成员书
数量创建不受限 map 调用，`budget_exceeded_narrow_scope_required` 覆盖
超预算降级。

剩余风险：只有 membership manifest 时若错误进入查询路径，可能诱发全成员
扫描。设计声明 membership manifest 不授权查询，scoped query 只能读取已发布
且 query-ready 的 scope。

结论：满足 D02。

## D03_graphrag_semantic_alignment

status: PASS

证据：固定基准要求上层索引输入包含 community reports，保留 entity、
relationship 或等价语义关系，并基于预计算社区报告或语义单元综合回答。
目标设计的 bookshelf sourceInputs 和 pipeline requiredInputs 包含成员书
`community_reports.parquet`、`entities.parquet`、`relationships.parquet`。
`semantic_edges.parquet` 保留 relation type、weight、direction、
`sourceEntityTitles`、`sourceRelationshipIds` 和 evidence map ids。构建步骤
包括从 community reports 抽取 semantic units、派生 semantic edges、聚类并
生成书架级 community reports。

剩余风险：membership 关系只能补充 `bookshelf_membership` 边，不能替代
GraphRAG 语义产物。目标设计已把 membership-only handoff 和 graph build
query-ready manifest 分离。

结论：满足 D03。

## D04_evidence_traceability

status: PASS

证据：固定基准要求回答可追溯到 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report 或 text_unit。目标设计定义
`evidence_map.parquet`，字段包含 `targetBookId`、`targetBookshelfId`、
`targetSourceId`、`targetDocumentId`、`targetContentHash`、
`targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。
设计规定每个上层 semantic unit、semantic edge、community 和 community
report 至少有一条 evidence_map 记录，纯 membership marker 且无可回答内容
时例外。查询合成必须包含 traceable evidence ids。

剩余风险：membership manifest 可能包含成员和决策摘要，但不能作为可回答
内容的唯一证据来源。目标设计已经将其限定为 handoff manifest。

结论：满足 D04。

## D05_state_recovery

status: FAIL

证据：固定基准要求 durable checkpoints/events/status、partial build 不发布
query-ready 上层索引，成员变更标记 stale 或生成新 generation。目标设计在
`stateAndRecovery` 中定义 runs、`status.json`、`events.jsonl`、checkpoints
和 recovery summary，并要求 staged artifacts 校验后原子提升，publish marker
最后写入。pipeline stage gate 也要求阶段输出只有在质量门通过并写入 publish
marker 后才能作为下游权威输入。成员变化由 generation、manifest sha256 和
stale_not_query_ready 规则覆盖。

阻断证据：本轮重点项未全部闭合。membership manifest 已纳入
emittedOutputs、nextStageInputs、graph build requiredInputs 和 handoff
artifacts，也已有基本 rejectIf；但
`bookshelf_membership_resolution.stateWrites` 未写入
`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 和
`BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256`。这使 membership manifest 与
membership quality gate、events、checkpoints、recovery summary 的同阶段
持久状态关系不够明确。handoffMatrix.rejectIf 也未拒绝 membership generation
digest 与 `bookshelf_members.json`、`membership_decisions.jsonl` 或 split plan
digest 不一致。

剩余风险：partial build 虽不会发布 `BOOKSHELF_MANIFEST.json`，但
membership handoff manifest 本身的 staged write、checksum、quality gate 和
恢复闭环仍可被实现成松散输出。下游 graph build 仍可能在成员决策 digest 与
manifest 摘要不一致时继续构建。

结论：不满足 D05。

## D06_quality_gates

status: PASS

证据：固定基准要求书架和 library 定义独立质量门，并覆盖 schema、
checksum、成员一致性、敏感信息和固定预算模拟。目标设计定义
`qualityGates.bookshelfGate` 与 `qualityGates.libraryGate`。bookshelf gate
包含 manifest schema/checksum sidecars、成员 manifest sha256、成员 package
gates、membership decisions schema、authority order、用户锁、LLM suggestion
接受状态、semantic schemas、evidence map、embedding metadata、固定预算模拟、
敏感扫描和 stale marker。library gate 覆盖成员 bookshelf manifest sha256、
成员书架 gate、虚拟父展开、direct book limit、semantic schemas、evidence
map、固定预算模拟、敏感扫描和 stale marker。失败诊断通过
`upper_quality_gate_failed` 暴露。

剩余风险：membership quality gate 已定义 check ids，但 membership manifest
字段级校验与 stateWrites 的绑定仍受 D05 影响。该风险不推翻固定 D06 的
书架和 library 质量门存在性。

结论：满足 D06。

## D07_incremental_scaling

status: PASS

证据：固定基准要求记录成员 manifest sha256 和 generation，定义增量刷新或
保守全量重建条件，并通过书架分层限制大库影响范围。目标设计要求
bookshelf generation 随成员集合、任一成员 manifest sha256、builder version、
embedding fingerprint、clustering config、summary config 或 evidence schema
变化。`bookshelf_members.json` 必填 `manifestSha256` 和
`packageGeneration`。书架和 library 均定义 checksum 可证明的局部刷新，否则
重建或标记 stale。超大书架通过 virtual parent 和 materialized child
bookshelves 拆分。

剩余风险：handoff rejectIf 尚未明确成员 generation digest 与成员文件 digest
不一致时拒绝，可能降低增量判定的实现一致性。由于 generation 和 checksum
要求已在主体合同中存在，D07 固定条件仍满足。

结论：满足 D07。

## D08_security_privacy

status: PASS

证据：固定基准要求禁止 provider payload、密钥、原始 prompt/completion、
绝对路径和 query.log 进入可发布上层 manifest 或索引。目标设计的
`no_sensitive_payload_export`、`bookshelfContract.buildInputs.forbiddenInputs`、
pipeline `redacted_diagnostics_only` 和 `diagnosticRedactionPolicy` 禁止
provider request/response payload、raw prompt、raw completion、api key、
credential、absolute local path 和 query log。membership 阶段 forbiddenInputs
也禁止 raw LLM prompt 或 completion，manifest schemas 要求
`sensitivityPolicy`。

剩余风险：membership 阶段会接触 LLM suggestion records，必须保持 bounded
redacted summary。目标设计已有 sensitivity policy 和敏感扫描要求。

结论：满足 D08。

## D09_cli_operability

status: PASS

证据：固定基准要求定义 scope resolution order，stale 或 ambiguity 快速
typed error，并将 timing/cost 观测分解到层级阶段。目标设计定义 explicit
bookId、explicit bookshelfId、explicit libraryId、configured default library
和 fast ambiguity error 的解析顺序。typed errors 覆盖 `missing_scope`、
`ambiguous_scope`、`upper_index_missing`、`upper_index_stale`、
`upper_quality_gate_failed`、`budget_exceeded_narrow_scope_required` 和
`upper_index_runtime_error`。CLI behavior matrix 覆盖无 scope、scope 歧义、
缺上层索引、stale、quality gate failed 和 over budget。scoped query 禁止
missing upper index auto-build、stale scope 和交互式 exhaustive scan。

剩余风险：行为矩阵未专门列出“只有
`BOOKSHELF_MEMBERSHIP_MANIFEST.json`、没有 `BOOKSHELF_MANIFEST.json`”的 case。
现有 `upper_index_missing` 或 `upper_quality_gate_failed` 可覆盖，但建议后续
新增显式场景以降低实现歧义。

结论：满足 D09。

## D10_testability

status: PASS

证据：固定基准要求至少 8 个必测案例，覆盖不同规模库固定预算验证和单书
hotplug 非回归。目标设计的 `testContracts.requiredCases` 超过 8 项，覆盖
单书查询在删除上层索引后仍成功、membership 权威顺序、LLM suggestion 不
query-ready、accepted suggestion 生成新 generation、超大分类拆分、虚拟父
路由、10/100/1000 书固定 top-K、超预算 typed error、stale 拒绝、缺上层
索引不隐式构建、成员 package gate 失败 fail closed、evidence map、
semantic edges、安全扫描、中断恢复、删除书标记 stale 和 timing。pipeline
testContracts 也覆盖无 `PUBLISH_READY` 拒绝、成员 manifestSha256 变化时
bookshelf build 拒绝、publish marker 后发布、缺上层索引不构建和诊断脱敏。

剩余风险：测试合同尚未显式锁定本轮 D05 的两个剩余缺口：membership manifest
必须作为 state write 进入同一 staged 状态闭环，以及 membership generation
digest 与成员/决策文件 digest 不一致时 graph build 必须拒绝。固定 D10 的
数量、规模和 hotplug 非回归条件已满足，但 D05 修复后应补充专项测试。

结论：满足 D10。

- 必须修订：在 `bookshelf_membership_resolution.stateWrites` 中加入
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 和
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json.sha256`，并明确它们与
  `state/membership-quality-gate.json`、events、checkpoints 和 publish marker
  属于同一个 staged membership generation 状态闭环。
- 在 handoffMatrix 中从 membership 到 graph build 的 `rejectIf` 加入
  membership generation digest 与 `bookshelf_members.json`、
  `membership_decisions.jsonl`、`bookshelf_split_plan.json` digest 不一致时拒绝。
- 建议在 CLI 行为矩阵或测试合同中增加：只有
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 且缺少 `BOOKSHELF_MANIFEST.json` 时，
  `--bookshelf-id` 必须快速返回稳定 typed error，不能隐式构建或全书扫描。
