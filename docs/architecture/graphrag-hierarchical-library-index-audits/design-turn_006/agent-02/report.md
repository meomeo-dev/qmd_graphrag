# design-turn_006 agent-02 设计复审报告

overallStatus: pass

## 审计范围

本报告按固定基准
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
的 D01-D10 复审以下设计集：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/final-summary.md`

重点从实现视角确认：

- 7 个 pipeline stage 的 I/O 字段仍完整。
- `handoffMatrix` 仍阻断 stale、running、failed 产物。
- pipeline scoped query 错误码与主 `queryContract.typedErrors` 一致。
- 状态和报告描述不存在“待审/已通过”矛盾。

## 总体结论

修正后的设计集通过本轮复审。主设计和 pipeline I/O 合同均标记为
`design_audit_passed`，final summary 记录第五轮 3 个 agent 均通过，并明确
`scope_not_found` 已修正为主查询合同中的 `missing_scope` 与
`ambiguous_scope`。设计集中未发现“待审/已通过”状态冲突；`pending` 仅作为
pipeline 运行态或用户接受等待态出现，不构成审计状态矛盾。

pipeline I/O 合同仍声明 7 个阶段，并通过 `stageFieldContract.requiredFields`
要求每个阶段具备 `stageId`、`authorityRoot`、`requiredInputs`、
`forbiddenInputs`、`emittedOutputs`、`qualityGate`、`stateWrites`、
`failureOutputs` 和 `nextStageInputs`。逐项核对后，7 个阶段均具备这些字段。

`stage_gate_handoff`、`publishSemantics`、`handoffMatrix` 和 `stateClosure`
共同形成 fail-closed 交接边界。staging、failed、running、pending 或 stale
产物不得作为下游 ready 输入；查询阶段也显式禁止 stale scope、failed 或
running staging generation，以及交互式全库扫描。

## D01_authority_boundaries

status: pass

设计继续保持单书包 `BOOK_MANIFEST.json` 和 `PUBLISH_READY.json` 为包权威，
书架与 library 索引限定在 `graph_vault/catalog/**` 下作为可重建派生物。
`package_first_authority` 与 `catalog_is_derivative` 明确 catalog 不改变单书
身份、文件闭包或单书 `query_ready` 判定。final summary 的结论也继续强调
单书包权威边界。

必须修订位置：无。

## D02_fixed_query_budget

status: pass

主 `queryContract.interactiveBudget` 定义固定 `maxSemanticUnits`、
`maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用
数和 token 上限。pipeline 的 `scoped_query_execution` 禁止缺索引时自动构建、
禁止交互式全书扫描，并在超预算时输出
`budget_exceeded_narrow_scope_required`。该路径不随书籍数量线性扩大查询
prompt、候选语义单元或下钻书本数。

必须修订位置：无。

## D03_graphrag_semantic_alignment

status: pass

书架构建输入仍包含成员 `community_reports.parquet`、`entities.parquet`、
`relationships.parquet` 和受界的 `text_units.parquet`；library 构建输入包含
书架语义单元、语义边、社区报告和证据图。上层输出包含
`semantic_units.parquet`、`semantic_edges.parquet`、`communities.parquet` 和
`community_reports.parquet`，保留 entity、relationship、community report 与
map-reduce 综合的 GraphRAG 语义结构。

必须修订位置：无。

## D04_evidence_traceability

status: pass

主设计定义 `evidence_map.parquet`，必需字段覆盖 `bookId`、`sourceId`、
`documentId`、`contentHash`、`communityReportId`、`textUnitId`、artifact digest
和 generation。书架与 library 质量门均要求每个上层语义单元或报告回链到
下层证据；pipeline 查询输出要求提供 evidence lineage 和下层 artifact
references。证据追溯链满足实现验证要求。

必须修订位置：无。

## D05_state_recovery

status: pass

设计覆盖 durable checkpoints、events、status、recovery summary、staging、
quality gate、diagnostics 和 publish marker。`publishSemantics` 要求 staged
artifacts 通过 schema、checksum、敏感扫描、质量门和固定预算模拟后才能原子
提升为 current generation，publish marker 为最后写入。`stateClosure` 要求
从 authority root、manifest、quality gate、checksums、events 和 checkpoints
判断 ready、failed、stale、running 或 pending，避免 partial publish 被误用。

必须修订位置：无。

## D06_quality_gates

status: pass

书架和 library 均保留独立质量门。书架门覆盖 manifest schema、成员 sha256、
包 gate、membership 决策、用户 lock、LLM suggestion 接受状态、超大类拆分、
虚拟父书架不直接索引、语义 schema、evidence_map、embedding metadata、
固定预算模拟、敏感扫描和 stale marker。library 门覆盖成员书架 checksum、
成员书架 gate、虚拟父展开、direct book limit、分区、语义 schema、证据图、
固定预算模拟、敏感扫描和 stale marker。失败时使用
`upper_quality_gate_failed` 诊断，不发布 query-ready 上层索引。

必须修订位置：无。

## D07_incremental_scaling

status: pass

设计继续记录成员 `manifestSha256`、`packageGeneration`、书架 generation 和
library generation。书架有 soft/hard limit，超大类别必须拆分为虚拟父书架和
多个物化子书架。书架与 library 均定义基于 checksum 的增量刷新；无法证明
局部不变时，保守标记 stale 或创建新全量 generation。大库通过书架分层、
direct book limit 和 partition 限制重建影响范围。

必须修订位置：无。

## D08_security_privacy

status: pass

主设计和 pipeline I/O 均禁止 provider payload、raw prompt、raw completion、
credential、绝对本地路径和 query log 进入可发布 manifest、索引、质量门或
诊断。`redacted_diagnostics_only` 与 `diagnosticRedactionPolicy` 要求诊断只
包含 digest、schema id、check id、bounded summary 和 scope-relative locator。
pipeline 还禁止 runner ledger 作为语义检索、成员推断或社区生成输入。

必须修订位置：无。

## D09_cli_operability

status: pass

主 `queryContract.typedErrors` 定义 `missing_scope`、`ambiguous_scope`、
`upper_index_missing`、`upper_index_stale`、`upper_quality_gate_failed`、
`budget_exceeded_narrow_scope_required` 和 `upper_index_runtime_error`。
pipeline `scoped_query_execution.failureOutputs` 使用
`upper_index_missing`、`upper_index_stale`、`upper_quality_gate_failed`、
`budget_exceeded_narrow_scope_required`、`missing_scope` 和 `ambiguous_scope`，
未发现 `scope_not_found` 残留。CLI 行为矩阵覆盖无 scope、scope 歧义、
缺索引、stale、质量门失败和超预算，并提供分阶段 timing fields。

必须修订位置：无。

## D10_testability

status: pass

主设计和 pipeline I/O 均提供超过 8 个必测案例。测试覆盖固定预算在
10/100/1000 书规模下验证、单书 hotplug 非回归、catalog 删除不影响单书查询、
stale 默认拒绝、缺上层索引不隐式构建、质量门失败、证据图、语义边、安全
扫描、中断恢复、LLM suggestion gate、membership 权威、超大分类拆分和
direct book limit。pipeline 还新增 scoped query failure code 与主 typed
query error 合同一致性检查。

必须修订位置：无。

## Pipeline I/O 专项复核

7 个 stage 的 I/O 字段完整性：通过。`pipelineStages` 中
`book_package_publish`、`book_mount_projection`、
`bookshelf_membership_resolution`、`materialized_bookshelf_graph_build`、
`library_membership_resolution`、`library_graph_build` 和
`scoped_query_execution` 均具备 `stageFieldContract.requiredFields` 所列字段。

handoff 阻断能力：通过。`stage_gate_handoff` 明确 staging、failed、running、
pending 或 stale 产物不得被下游当作 ready 输入；`handoffMatrix` 在各阶段
交接处校验 publish marker、checksum、质量门、成员 digest、stale marker 和
预算模拟。`stateClosure` 规定 failed staging generation 不会成为 current，
stale 上层索引默认查询拒绝。

错误码一致性：通过。主查询合同和 pipeline scoped query 对共享失败场景使用
一致错误码。final summary 也记录第五轮 D09 minor note 已通过把
`scope_not_found` 收敛为 `missing_scope` 与 `ambiguous_scope` 完成闭环。

状态与报告一致性：通过。主设计、companion pipeline 文档和 final summary 均
表示审计已通过。未发现“待审”审计状态与“已通过”结论并存的问题。

## 必须修订项

无。
