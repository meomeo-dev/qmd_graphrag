# design-turn_005 agent-02 设计审计报告

overallStatus: pass

## 审计范围

本报告按固定基准
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
的 D01-D10 审计以下设计集：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`

审计重点为 pipeline I/O 的实现可落地性（implementation feasibility）：
阶段输入输出合同、质量门、状态写入、失败产物、下游交接、防 stale/running/
failed 产物污染、batch-runs ledger 非语义输入约束，以及用户按单书包处理后
再组织书架和 library 的能力。

## 总体结论

设计通过本轮审计。pipeline I/O 合同已经为每个声明阶段提供
`requiredInputs`、`forbiddenInputs`、`emittedOutputs`、`qualityGate`、
`stateWrites`、`failureOutputs` 和 `nextStageInputs`，并通过
`stage_gate_handoff`、`handoffMatrix`、`stateClosure` 与查询阶段
`forbiddenInputs` 形成 fail-closed 交接边界。设计明确禁止把
`graph_vault/catalog/batch-runs/**`、`runs/**`、`events.jsonl` 和
`recovery-summary` 作为语义检索、成员推断或 GraphRAG 社区生成输入，能够
阻断 runner ledger 被误用为语义事实来源。

用户以单书包为基本处理单位的路径可落地：单书包先由
`BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd/GraphRAG 产物和包内
gate 达到 query-ready；随后 mount projection 只派生 catalog 候选集；
书架成员解析保留用户显式成员权威；物化书架和 library 再从已发布、已验证
的下层产物派生上层索引。该路径不要求上层 catalog 反写或改变单书包闭包。

## D01_authority_boundaries

status: pass

设计保持单书包 `BOOK_MANIFEST.json` 与 `PUBLISH_READY.json` 为包权威，并将
书架/library 明确限定为 `graph_vault/catalog/**` 下的可重建派生物。
pipeline I/O 的 `package_first_authority`、`catalog_is_derivative` 以及
`book_mount_projection` 阶段均声明 catalog projection 不改变单书包。
`compatibilityWithHotplugPackages` 进一步规定删除或安装书包只会让上层索引
stale，不会改变单书 query-ready 判定。

必须修订字段或章节：无。

## D02_fixed_query_budget

status: pass

查询合同定义固定预算：`maxSemanticUnits: 32`、`maxBookshelves: 4`、
`maxBooksForDeepening: 3`、`maxMemberCommunityRefs: 24`、固定 LLM 调用上限
和 token 上限。`scoped_query_execution` 禁止交互查询隐式构建、全书扫描和
读取 failed/running staging generation；超预算返回
`budget_exceeded_narrow_scope_required`。上层检索先消费已发布的
semantic units，不随书籍总数线性扫描所有 community reports。

必须修订字段或章节：无。

## D03_graphrag_semantic_alignment

status: pass

上层构建输入包含单书或书架 `community_reports.parquet`、`entities.parquet`
和 `relationships.parquet`，并产出 `semantic_units.parquet`、
`semantic_edges.parquet`、`communities.parquet` 与
`community_reports.parquet`。`semantic_edges` 保留 shared entity、
source relationship、parent-child community 等关系类型，使上层索引不退化
为普通摘要向量检索。library 构建同样从书架语义单元、语义边、社区报告和
证据图派生上层 GraphRAG 索引。

必须修订字段或章节：无。

## D04_evidence_traceability

status: pass

设计定义 `evidence_map.parquet`，要求上层 semantic unit、semantic edge、
community 和 community report 回链到 book、bookshelf、source、document、
content hash、community report 或 text unit。书架和 library 的质量门均
要求 evidence_map 链接每个上层语义单元到下层证据，查询输出要求返回
evidence lineage。该合同足以支持回答证据血缘（evidence lineage）暴露或
摘要。

必须修订字段或章节：无。

## D05_state_recovery

status: pass

pipeline I/O 定义 staging、publish marker、运行状态、events、checkpoints、
recovery summary、quality gate 与 diagnostics。`publishSemantics` 要求先写
`staging/{runId}`，通过 schema、checksum、敏感扫描、质量门和固定预算模拟
后再原子提升为 current generation，publish marker 最后写入。
`stateClosure` 要求从 authority root、published manifest、quality gate、
checksum、events 和 checkpoints 判定 ready、failed、stale、running 或
pending，避免依赖内存状态。成员 digest 变化会产生 stale_not_query_ready
或新 generation。

必须修订字段或章节：无。

## D06_quality_gates

status: pass

书架和 library 均有独立质量门。书架门覆盖 manifest schema、成员 manifest
sha256、包 gate、成员决策、用户 lock、LLM suggestion 未接受不可 query-ready、
oversized split、虚拟父书架不拥有语义产物、语义 schema、evidence_map、
embedding fingerprint、固定预算模拟、敏感扫描和 stale marker。library 门
覆盖成员书架 checksum、书架 gate、虚拟父展开、direct book limit、分区、
语义 schema、evidence_map、固定预算模拟、敏感扫描和 stale marker。失败
时通过 typed diagnostics 暴露，不发布 query-ready 上层索引。

必须修订字段或章节：无。

## D07_incremental_scaling

status: pass

设计记录成员 manifest sha256、package generation、书架 generation 和
library generation。书架大小有 soft/hard limit，超限分类必须拆成虚拟父
书架和多个物化子书架。书架与 library 均定义基于 checksum 的增量刷新；
不能局部证明时保守标记 stale 并创建新全量 generation。library 的
`directBookLimit` 与 shelf count limit 约束防止大库直接吞入全部单书。

必须修订字段或章节：无。

## D08_security_privacy

status: pass

pipeline I/O 在不变量、阶段 `forbiddenInputs`、质量门和 redaction policy
中禁止 provider payload、raw prompt、raw completion、query log、credential
和绝对本地路径进入 manifest、索引、质量门和诊断。`no_runner_ledger_as_
semantic_input` 明确把 batch-runs ledger、runs、events 和 recovery summaries
限定为观测、恢复和诊断输入，禁止作为语义输入。诊断只允许 digest、schema
id、check id、bounded summary 和 scope-relative locator。

必须修订字段或章节：无。

## D09_cli_operability

status: pass

查询合同定义 scope resolution order：显式 book、显式 bookshelf、显式
library、默认 library、快速 ambiguity error。typed errors 覆盖 missing
scope、ambiguous scope、upper index missing、upper index stale、quality gate
failed、budget exceeded 和 runtime error，并给出 exit code 与 remediation
command。CLI 行为矩阵分解无 scope、歧义、缺索引、stale、质量门失败和超
预算场景；timing fields 可分解到 scope resolution、upper index validation、
generation validation、retrieval 和 budget application。

必须修订字段或章节：无。

## D10_testability

status: pass

主设计与 pipeline I/O 均提供超过 8 个必测案例，覆盖单书热插非回归、用户
成员权威、LLM suggestion gate、oversized split、虚拟父书架、固定预算在
10/100/1000 书规模下验证、stale 默认拒绝、缺上层索引不隐式重建、证据图、
语义边、安全扫描、中断恢复、删除 catalog 不影响单书查询和 timing 输出。
pipeline I/O 额外覆盖无 `PUBLISH_READY` 的 copied package、qmd projection
误作 readiness proof、manifestSha256 变化、library direct book limit、
stale member bookshelf 和缺索引查询拒绝。

必须修订字段或章节：无。

## Pipeline I/O 专项结论

每个 stage 的字段完备性：通过。`stageFieldContract.requiredFields` 声明
完整字段集，`pipelineStages` 中 7 个阶段均具备 required inputs、forbidden
inputs、emitted outputs、quality gate、state writes、failure outputs 和
next stage inputs。字段粒度足以映射到实现中的 validator、builder、publisher
和 query router。

handoffMatrix 防污染能力：通过。矩阵覆盖 book publish 到 mount projection、
mount projection 到 membership、membership 到 shelf build、shelf build 到
library membership、library membership 到 library build、library build 到
query execution。结合全局 `stage_gate_handoff` 和 `stateClosure`，staging、
failed、running、pending、stale 产物不能作为 ready 下游输入。查询阶段还
显式禁止 failed/running staging generation 和默认 stale scope。

batch-runs ledger 误用风险：通过。设计在 hard invariant 中禁止 ledger 作为
语义检索、成员推断或社区生成输入，并在 mount projection、membership
resolution、library graph build 的 `forbiddenInputs` 中重复约束。该限制可
阻断 batch-runs ledger 被实现误作 package readiness proof、classification
evidence 或 semantic input。

单书包到书架/library 组织能力：通过。用户可先处理或复制单书包；mount
projection 从包内权威产物派生候选；membership resolution 支持用户显式
include/exclude/lock、规则、taxonomy 与 LLM suggestion；用户显式成员关系
权威最高；建议书架必须接受后才可物化。library 支持物化书架、虚拟父书架
展开和小规模 direct book 成员，能支撑“先处理单书包，再组织书架/library”
的工作流。

## 非阻断实现注意事项

- 建议在实现时把 `stage_gate_handoff` 抽成统一 ready-state validator
  （ready-state validator），由所有 builder 和 query router 调用，避免各
  命令分别解释 stale、running、failed 和 publish marker。
- `handoffMatrix` 对 bookshelf 到 library 查询路径覆盖充分，但查询书架
  scope 时也应复用同一 gate：校验 `BOOKSHELF_MANIFEST.json`、bookshelf
  quality gate、stale marker、semantic units、community reports 和
  evidence map 后再允许查询。
- optional direct book members 是必要降级能力，但实现时应补齐同等的单书
  gate、manifest sha256、packageGeneration 与 directBookLimit 校验，避免
  direct book 路径绕过书架层级质量门。
- `stateClosure.rule` 中英文混写的 “from its authorityRoot” 不影响设计
  判定，但后续可在文档整理时统一为正式中文表述。
