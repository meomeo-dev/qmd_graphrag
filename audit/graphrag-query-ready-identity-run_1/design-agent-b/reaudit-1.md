# Design Agent B 复审报告：状态仓库与恢复设计

固定基准：
`audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md`

复审范围：只读复审状态仓库（state repository）与恢复语义（recovery
semantics）设计。复审输入状态显示本轮设计修复已完成并进入复审：
`audit/graphrag-query-ready-identity-run_1/status.yaml:4`、
`audit/graphrag-query-ready-identity-run_1/status.yaml:41-48`。

本报告只判断设计补丁是否补齐初审 FAIL/UNCLEAR 项。运行代码修改、测试实现
和测试执行属于后续实施验收，不作为本次设计复审的失败条件。

## 逐条结论

### 1. 记录 GraphRAG text-unit identity 的单一清晰操作

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:6-7`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:444-452`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:464-472`
- `catalog/data-bus.catalog.yaml:177-185`
- `catalog/data-bus.catalog.yaml:214-222`

判断：设计仍以
`FileBookJobStateRepository.recordGraphTextUnitIdentity` 作为
`graph_text_unit_identity_map` 写入 `DocumentIdentityMap` 的明确仓库入口。
其他 producer 只负责 qmd/source/chunk/corpus registration 投影，没有新增并行的
graph identity 发布入口。

剩余缺口：无设计缺口。

### 2. 已有 qmd corpus row、缺失 graph 字段、graph 字段陈旧时安全

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:8-9`
- `docs/architecture/unified-retrieval-plane.md:349-372`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:458-463`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:481-491`
- `catalog/data-bus.catalog.yaml:193-201`
- `catalog/data-bus.catalog.yaml:229-236`

判断：设计补丁补上了初审缺口。同一
`canonicalBookId/sourceHash/documentId/contentHash` 的 upsert 必须非破坏性合并，
并保留已验证的 qmd metadata、`chunkIds`、`graphDocumentId` 和
`graphTextUnitIds`。graph identity 只有在 content identity 变化，或 validated
repair evidence 证明旧投影陈旧时才可清除。缺失或陈旧字段通过 sidecar 或
validated parquet 修复，并对 source/content mismatch、混书 output、空 text
units、无效 output locator、producer lineage mismatch 和多文档歧义执行
fail-closed。

剩余缺口：无设计缺口；非破坏性合并仍需在后续代码阶段实现。

### 3. `query_ready` 读取能观察同一 resume pass 写入的 identity

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:10-11`
- `docs/architecture/unified-retrieval-plane.md:341-347`
- `docs/architecture/unified-retrieval-plane.md:355-361`
- `docs/architecture/unified-retrieval-plane.md:717-724`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1644-1659`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1732-1741`
- `docs/operations/graphrag-epub-batch-runbook.md:118-122`

判断：设计明确 `DocumentIdentityMap` 是 `query_ready` capability 发布和查询路由
读取的 catalog projection。`query_ready` 发布前必须要求
`graphDocumentId` 与非空 `graphTextUnitIds` 已写入 catalog；当 sidecar 已存在而
catalog 缺失或陈旧时，resume 必须先修复 catalog projection，再重试
`query_ready`。sidecar 只能修复投影，不能替代 catalog gate。

剩余缺口：无设计缺口；同 pass 写入后读取的一致性需要后续实现和测试验证。

### 4. 仅当有效 outputs 存在时将失败呈现为可修复本地状态

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:12-13`
- `docs/architecture/unified-retrieval-plane.md:717-724`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1628-1638`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1651-1659`
- `docs/operations/graphrag-epub-batch-runbook.md:118-122`
- `docs/operations/graphrag-epub-batch-runbook.md:195-204`
- `catalog/data-bus.catalog.yaml:114-119`

判断：设计定义了 `graph_identity_projection_missing` 本地 catalog projection
状态，并限定只有 book-scoped GraphRAG outputs、producer lineage、qmd corpus
registration 与 sidecar 或 parquet evidence 有效时才可使用。否则校验失败会按
artifact、lineage、content、locator 或 ambiguity 的真实失败处理，不被投影为可修复
本地状态。

剩余缺口：无设计缺口。

### 5. 避免把 identity contract failure 重标为 provider transient

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:14-15`
- `docs/architecture/unified-retrieval-plane.md:709-720`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1708-1716`
- `docs/operations/graphrag-epub-batch-runbook.md:124-134`
- `docs/operations/graphrag-epub-batch-runbook.md:146-181`
- `docs/operations/graphrag-epub-batch-runbook.md:198-204`
- `catalog/data-bus.catalog.yaml:91-99`
- `catalog/data-bus.catalog.yaml:114-119`

判断：provider transient 仍限定为 DNS/TLS/connect/reset/timeout/rate-limit/5xx
等 provider 或 gateway 可用性问题。identity 缺失被单独归类为
`graph_identity_projection_missing` 本地 projection failure，不进入 provider
recovery wait，也不被重标为 transient provider failure。

剩余缺口：无设计缺口。

### 6. 指明既有 failed checkpoints 的重新打开方式

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:16-17`
- `docs/architecture/unified-retrieval-plane.md:683-699`
- `docs/architecture/unified-retrieval-plane.md:717-724`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1589-1605`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1651-1659`
- `docs/operations/graphrag-epub-batch-runbook.md:60-74`
- `docs/operations/graphrag-epub-batch-runbook.md:240-260`
- `catalog/data-bus.catalog.yaml:1070-1086`

判断：设计补丁明确重新打开方式为正常 resume（normal resume）。批量恢复读取
item checkpoint 后委托单书 `BookResumePlan.nextStage`；当 reason 为
`graph_identity_projection_missing` 时，只重新打开 catalog/query_ready projection
work，不重跑 `graph_extract`、`community_report` 或 `embed`。`--status-json` 是
只读投影，不写 checkpoint、event 或 manifest；`--migrate-only` 只做 schema/状态
迁移，不执行 EPUB、GraphRAG、provider 或 qmd CLI 子命令。

剩余缺口：无设计缺口。

### 7. 不要求编辑生成的 GraphRAG parquet artifacts

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:18`
- `docs/architecture/unified-retrieval-plane.md:353-356`
- `docs/architecture/unified-retrieval-plane.md:368-372`
- `docs/architecture/unified-retrieval-plane.md:754-766`
- `docs/operations/graphrag-epub-batch-runbook.md:195-204`
- `catalog/data-bus.catalog.yaml:225-236`

判断：设计把 `documents.parquet` 与 `text_units.parquet` 定义为只读 source
tables 或 validator 输入。repair 从 sidecar 或 validated parquet extraction
重建 catalog projection，不要求编辑 GraphRAG 生成的 parquet artifact。

剩余缺口：无设计缺口。

### 8. 保持 artifact lineage、producer run ids、fingerprints 与 provider boundary

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:19-20`
- `docs/architecture/unified-retrieval-plane.md:362-364`
- `docs/architecture/unified-retrieval-plane.md:374-382`
- `docs/architecture/unified-retrieval-plane.md:700-703`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1624-1638`
- `docs/operations/graphrag-epub-batch-runbook.md:108-117`
- `docs/operations/graphrag-epub-batch-runbook.md:183-191`
- `catalog/data-bus.catalog.yaml:1011-1016`
- `catalog/data-bus.catalog.yaml:1043-1053`

判断：repair 前置校验必须覆盖 `qmd_output_manifest.json`、producer
checkpoints、artifact manifests、stage fingerprints、provider fingerprint 和
`metadata.corpusContentHash`。producer manifest 持有 `stageProducerRunIds`，且
high-cost stage checkpoint/artifact 的 run id、stage fingerprint、provider
fingerprint 与 book job identity 必须一致。设计未通过改写 producer manifest、
fingerprint 或 provider boundary 绕过 identity repair。

剩余缺口：无设计缺口。

### 9. 测试证明 identity repair 后可复用 completed graph_extract artifacts

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:21-22`
- `docs/architecture/unified-retrieval-plane.md:815-818`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1928-1936`
- `docs/operations/graphrag-epub-batch-runbook.md:118-122`
- `docs/operations/graphrag-epub-batch-runbook.md:195-204`

判断：设计补丁新增真实失败回归验收要求：当
`qmd_graph_text_unit_identity.json` 已存在而 catalog 缺 graph fields 时，resume
必须补齐 `DocumentIdentityMap`、完成 `query_ready`，且 `graph_extract`、
`community_report` 和 `embed` 的 producer run ids 不变。负向验收还要求拒绝多文档
歧义、source/content mismatch、空 text unit ids 和 text unit id 不存在等路径。

剩余缺口：无设计缺口；实际回归测试代码和执行结果仍需后续实施验收确认。

### 10. operator-visible status 显示修复后 qmd/GraphRAG/query 状态并解释可恢复原因

状态：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:23-24`
- `docs/architecture/unified-retrieval-plane.md:717-724`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1602-1605`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1701-1707`
- `docs/operations/graphrag-epub-batch-runbook.md:32-34`
- `docs/operations/graphrag-epub-batch-runbook.md:257-266`
- `catalog/data-bus.catalog.yaml:88-120`

判断：operator-visible projection 包括 `qmdBuildStatus`、`graphBuildStatus`、
`graphQueryStatus`、失败分类、恢复决策和 retry 信息。identity repair 还必须在
event 或 recovery summary evidence 中暴露 sidecar locator、graph text unit count、
复用的 producer run ids、reopened checkpoint 或 next stage，从而解释为何可在不重跑
高成本 stage 的情况下 resume。

剩余缺口：无设计缺口。

## 初审缺口复审结果

初审 FAIL/UNCLEAR 项已在设计层面补齐：

- 基准 2：补齐非破坏性 merge、陈旧 graph fields 清除条件和 fail-closed repair。
- 基准 3：补齐 resume 先修复 catalog projection 再重试 `query_ready` 的顺序。
- 基准 4：补齐 `graph_identity_projection_missing` 本地状态及有效 evidence gate。
- 基准 6：补齐既有 failed checkpoint 由 normal resume 重新打开的路径。
- 基准 9：补齐真实失败回归验收和 producer run id 不变要求。
- 基准 10：补齐 operator-visible recovery summary evidence 要求。

## 总体结论

DESIGN PASS

原因：10 条固定基准全部 PASS。设计补丁已把真实失败从 provider transient 与
高成本 stage failure 中分离出来，定义为有严格 evidence gate 的本地 catalog
projection repair；同时明确 `DocumentIdentityMap` 是 `query_ready` 发布事实源，
sidecar/parquet 只作为修复证据，resume 只重建 projection 并重试 `query_ready`，
不得重跑高成本 GraphRAG stage 或编辑 generated artifacts。
