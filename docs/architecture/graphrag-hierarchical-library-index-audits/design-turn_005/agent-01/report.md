# GraphRAG 层级 Library 索引设计审计报告

审计对象：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`

固定基准：
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

审计轮次：`design-turn_005`

审计 agent：`agent-01`

overallStatus: pass

判定规则：逐项使用固定基准 D01-D10。任一维度为 `fail` 时总体为
`fail`；本轮未发现 `fail` 项。

## 审计重点结论

新增 pipeline I/O 合同已按阶段定义书包、书架、library 和查询执行链路的
`requiredInputs`、`forbiddenInputs`、`emittedOutputs`、`qualityGate`、
`stateWrites`、`failureOutputs` 与 `nextStageInputs`。合同覆盖
`book_package_publish`、`book_mount_projection`、
`bookshelf_membership_resolution`、`materialized_bookshelf_graph_build`、
`library_membership_resolution`、`library_graph_build` 和
`scoped_query_execution`。

合同明确保持单书 hotplug package 的权威边界（authority boundary）：单书
`BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd/GraphRAG 产物和包内质量门
仍是单书 query-ready 的来源；catalog 下的书架、library、projection 和 ledger
均为派生状态，不写回单书包闭包。

合同也明确交互查询只读取已发布且通过质量门的 scope，使用固定 top-K、固定候选
语义单元、固定 LLM 调用和 token 预算。缺索引、stale、质量门失败和超预算均以
typed error 快速失败，不触发查询路径全库扫描或隐式重建。

## D01_authority_boundaries：权威边界与热插包隔离

status: pass

设计保持单书包作为唯一包权威。主设计的 `book_package_authority_preserved`、
`derived_upper_indexes_only` 与 pipeline I/O 的 `package_first_authority`、
`catalog_is_derivative` 均规定书架和 library 只能读取已验证包产物或派生
projection，不得改变单书身份、文件闭包或直接单书查询的 `query_ready` 判定。
`compatibilityWithHotplugPackages` 进一步规定安装、删除或 catalog 损坏只影响上层
stale 状态，不破坏单书 hotplug 查询。

必须修订项：无。

## D02_fixed_query_budget：固定查询预算

status: pass

主设计和 pipeline I/O 均定义固定交互预算，包括 `maxSemanticUnits`、
`maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、
`maxLlmCalls`、`maxInputTokens` 和 `maxOutputTokens`。交互查询禁止全量扫描所有单书
或所有书架，禁止在 query path 中隐式构建上层索引；超预算时返回
`budget_exceeded_narrow_scope_required` 或要求收窄 scope。该合同满足查询成本不随
书籍数量线性增长的基准要求。

必须修订项：无。

## D03_graphrag_semantic_alignment：GraphRAG 语义对齐

status: pass

书架构建输入包含成员单书 `community_reports.parquet`、`entities.parquet`、
`relationships.parquet` 和受控的 `text_units.parquet`；library 构建输入包含书架
`semantic_units.parquet`、`semantic_edges.parquet`、`community_reports.parquet`
和 `evidence_map.parquet`。上层输出继续包含 `communities.parquet`、
`community_reports.parquet` 和保留 entity/relationship 证据的
`semantic_edges.parquet`，未退化为普通摘要检索。

必须修订项：无。

## D04_evidence_traceability：证据可追溯

status: pass

主设计定义 `evidence_map.parquet` 的必备字段，覆盖 `bookId`、`sourceId`、
`documentId`、`contentHash`、community report、text unit、artifact digest 和
generation。pipeline I/O 要求书架和 library 构建均产出 `evidence_map.parquet`，
质量门检查每个上层语义单元到书架和单书证据的 lineage。查询输出也要求提供带
bookId 和下层 artifact 引用的 evidence lineage。

必须修订项：无。

## D05_state_recovery：状态闭环与恢复

status: pass

pipeline I/O 定义每个写产物阶段先进入 `staging/{runId}`，完成 schema、checksum、
敏感扫描、质量门和固定预算模拟后再原子提升为 current generation，publish marker
最后写入。`stateClosure`、`stateAndRecovery` 和各阶段 `stateWrites` 覆盖
`status.json`、`events.jsonl`、checkpoints、diagnostics、recovery summary、
ready、failed、stale、running、pending 和 quarantine 状态。partial build 不会发布
query-ready 上层索引，成员 digest 变化会标记 stale 或触发新 generation。

必须修订项：无。

## D06_quality_gates：质量门

status: pass

书架和 library 均有独立质量门。书架质量门覆盖成员 manifest sha256、成员包 gate、
成员决策 schema、authority 顺序、用户 lock、LLM suggestion 接受状态、超大类别
拆分、虚拟父书架无直接语义索引、semantic schema、evidence map、embedding/vector
元数据、固定预算模拟、敏感扫描和 stale marker。library 质量门覆盖成员书架
checksum、成员书架 gate、虚拟父书架展开、direct book limit、partition 限制、
semantic schema、evidence map、预算模拟、敏感扫描和 stale marker。失败诊断使用
`upper_quality_gate_failed` 和机器可读 `failedCheckId`。

必须修订项：无。

## D07_incremental_scaling：增量扩展

status: pass

主设计要求书架 generation 随成员集合、成员 manifest sha256、builder version、
embedding fingerprint、clustering config、summary config 或 evidence schema 变化。
library generation 随 shelf membership、成员 shelf manifest sha256 和构建配置变化。
书架和 library 均允许在 checksum 能证明输入未变时局部刷新；无法局部化时保守重建
或标记 stale。大库通过物化书架、虚拟父书架、partition 和 direct book limit 控制
重建范围。

必须修订项：无。

## D08_security_privacy：安全与隐私

status: pass

设计通过 `forbiddenInputs`、`redacted_diagnostics_only`、
`diagnosticRedactionPolicy`、manifest `sensitivityPolicy` 和质量门敏感扫描，禁止
provider payload、raw prompt、raw completion、credential、绝对本地路径和
query log 进入可发布上层 manifest、索引、质量门或诊断。runner ledger 也被明确
限制为观测、恢复和诊断用途，不得作为语义输入。

必须修订项：无。

## D09_cli_operability：CLI 可操作性与降级

status: pass

查询合同定义 scope resolution order：explicit book、explicit bookshelf、
explicit library、configured default library，最后快速返回 ambiguity error。
typed errors 覆盖 `missing_scope`、`ambiguous_scope`、`upper_index_missing`、
`upper_index_stale`、`upper_quality_gate_failed`、
`budget_exceeded_narrow_scope_required` 和 runtime error。CLI 行为矩阵定义各场景
的 fallback、remediation command 和 timing fields，避免无 scope、stale、缺索引
或超预算时长时间无输出。

必须修订项：无。

## D10_testability：可测试性

status: pass

主设计和 pipeline I/O 均定义超过 8 个必测案例。测试覆盖单书 hotplug 非回归、
缺失 `PUBLISH_READY`、qmd projection 不可替代包内 qmd index、成员权限优先级、
LLM suggestion 未接受不可 query-ready、接受建议生成新 generation、超大类别拆分、
虚拟父书架无直接语义单元、成员 digest 改变拒绝构建、质量门后发布、direct book
limit、stale 成员拒绝、缺索引查询不隐式构建、超预算 typed error、catalog 删除不
破坏单书查询、敏感诊断和中断恢复。固定预算测试覆盖 10、100、1000 本模拟规模。

必须修订项：无。

## 非阻断实现注意事项

- 实现 `publish marker` 时，应把 marker 写入作为唯一完成信号，避免 CLI 误读已
  通过局部检查但尚未原子发布的 staging 目录。
- `scope_not_found` 在 pipeline I/O 的查询失败产物中出现，但 typed error code 列表
  使用 `missing_scope` 和 `ambiguous_scope`。实现时应将其映射为稳定 typed error，
  避免 CLI 出现未注册错误码。
- 固定预算模拟应同时记录实际候选数、token 估算、LLM call 计数和是否触发 deepening，
  以便后续回归测试确认预算不随书籍数量线性增长。
- runner ledger、events 和 recovery summary 虽可用于恢复，但实现中不得把其中的
  bounded summary 作为语义索引输入。
