# GraphRAG 层级 Library 索引 Type DD 第三轮设计复审报告

auditAgent: agent-03
auditRound: design-turn_003
targetDocument: docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml
baselineDocument: docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml
overallStatus: pass

## 总体结论

本轮按固定基准 D01-D10 复审，未修改基准。`design-turn_003`
新增的书架组织策略、成员来源、LLM 建议门、虚拟书架、拆分规则和用户锁定
合同未破坏上一轮已通过的权威边界、固定预算、证据追溯、状态恢复、
质量门、安全隐私、CLI 降级和测试合同。

重点复核项结论如下：LLM suggestion gate 使用 `inputDigest`、
`promptTemplateId`、`modelFingerprint` 与 `sensitiveScanStatus`，未要求保存
原始 prompt、completion 或 provider payload；`membership_decisions.jsonl`
定义了可审计决策字段；用户显式锁定在冲突优先级中最高，低优先级策略不得
覆盖 resolved member set；测试合同覆盖用户覆盖、LLM 建议未接受不可查询、
接受建议生成新 generation、超大类拆分、虚拟书架查询和固定预算模拟。

未发现 `fail` 项，总体结论为 `pass`。

## D01_authority_boundaries - 权威边界与热插包隔离

status: pass

设计继续保持单书 `BOOK_MANIFEST.json` 作为单书包权威，书架和 library
位于 `graph_vault/catalog` 下并被定义为可重建派生索引。`hardInvariants`
中的 `book_package_authority_preserved` 与 `derived_upper_indexes_only`
禁止上层索引改变单书身份、文件闭包或 `query_ready` 判定。

`compatibilityWithHotplugPackages` 明确安装或删除 book package 不自动修改
ready 的书架或 library generation。受影响的上层索引只会被标记 stale 或
调度重建，直接单书查询仍由单书包质量门治理，满足热插包隔离要求。

## D02_fixed_query_budget - 固定查询预算

status: pass

`queryContract.interactiveBudget.default` 定义固定的 `maxSemanticUnits`、
`maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、
`maxLlmCalls`、`maxInputTokens` 和 `maxOutputTokens`。交互查询先在上层
预计算 semantic units 上召回，再按固定预算执行可选下钻。

设计禁止无 scope 查询在查询路径中重建或扫描全库，并把
`exhaustive_report` 限定为后台作业模式。超预算时返回
`budget_exceeded_narrow_scope_required`，符合 fail-closed 或收窄 scope
机制。

## D03_graphrag_semantic_alignment - GraphRAG 语义对齐

status: pass

上层构建输入包含成员书的 `community_reports`、`entities`、
`relationships` 和 qmd 元数据。书架与 library 构建分别生成
`semantic_units.parquet`、`semantic_edges.parquet`、`communities.parquet`
和 `community_reports.parquet`。

`semantic_edges` 合同要求保留关系方向、权重、来源 entity、relationship
和 `evidenceMapIds`。上层综合回答基于预计算 community reports 与
semantic units，并允许固定预算内的单书下钻，未退化为普通摘要检索。

## D04_evidence_traceability - 证据可追溯

status: pass

设计定义 `evidence_map.parquet`，列级合同覆盖 `targetBookId`、
`targetSourceId`、`targetDocumentId`、`targetContentHash`、
`targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。
每个上层 semantic unit、semantic edge、community 和 community report
必须有下层证据引用，纯 membership marker 例外。

`queryContract.retrieval.synthesis.rule` 要求最终回答包含 traceable
evidence ids，并标明结果是否 scoped 或 non-exhaustive。新增的
`membership_decisions.jsonl` 也通过 `decisionId`、`action`、`policyKind`、
`authority`、`evidenceRefs`、`decidedBy`、`decidedAt`、`llmRunId` 和
`userAcceptedAt` 支持成员归属决策审计。

## D05_state_recovery - 状态闭环与恢复

status: pass

`stateAndRecovery` 定义书架和 library build 的 run ledger 根，以及
`status.json`、`events.jsonl`、`checkpoints/{unitId}.json`、
`recovery-summary.json` 等 durable state。构建完成要求 checkpoint、
manifest、quality gate 和 publish marker 同时成立。

发布协议先写入 `staging/{runId}`，验证 staged artifacts 和 checksum
sidecars 后再原子提升，并最后写入 publish marker。失败的 semantic unit
generation 不会发布 ready 上层索引；成员 manifest 变化会在查询前标记
上层索引 stale。

## D06_quality_gates - 质量门

status: pass

书架和 library 均定义独立质量门路径与 `requiredChecks`。检查项覆盖
manifest schema、checksum sidecars、成员 manifest sha256、成员质量门、
semantic units schema、semantic edges schema、community reports schema、
evidence map、embedding/vector 元数据、固定预算模拟、敏感信息扫描和
stale marker absence。

`qualityGates.failureDiagnostics` 定义机器可读诊断，字段包括
`failedCheckId`、`typedErrorCode`、`affectedArtifactDigest`、
`expectedDigest`、`observedDigest`、`redactedLocator` 和
`remediationCommand`。质量门失败时查询返回 `upper_quality_gate_failed`，
满足查询不可用且诊断可见的要求。

## D07_incremental_scaling - 增量扩展

status: pass

书架 generation 规则记录 membership set、成员 manifest sha256、
builder version、embedding model fingerprint、clustering config、summary
config 和 evidence schema。library generation 规则记录 shelf membership、
成员 shelf manifest sha256 及同类构建配置。

增量刷新规则允许在 checksum 可证明输入未变时只重建受影响 semantic units
和派生 communities；无法局部化 graph connectivity 变化时，library 必须
标记当前 generation stale 并创建新的全量 generation。新增的物化书架规模
上限、虚拟父书架和拆分策略也限制了大库重建影响范围。

## D08_security_privacy - 安全与隐私

status: pass

设计通过 `no_sensitive_payload_export`、`forbiddenInputs`、
`sensitivityPolicy` 和 `diagnosticRedactionPolicy` 禁止 provider payload、
原始 prompt、原始 completion、密钥、凭据、绝对本地路径和 `query.log`
内容进入可发布上层 manifest、索引、质量门或诊断。

LLM suggestion gate 的持久字段使用 `inputDigest`、`promptTemplateId`、
`modelFingerprint`、`candidateBookIds`、`evidenceRefs` 和
`sensitiveScanStatus`，未要求记录原始请求或响应。质量门包含
`sensitive payload scan passes`，诊断只能使用 digest、bounded summary
和 redacted locator，满足脱敏摘要或 digest 要求。

## D09_cli_operability - CLI 可操作性与降级

status: pass

`queryContract.routing.scopeResolutionOrder` 定义 explicit book、explicit
bookshelf、explicit library、configured default library、fast ambiguity
error with candidates 的解析顺序。无 scope 时可读取 current projection
manifest 或 default scope pointer，但不得在查询路径中重建全库索引。

CLI 行为矩阵覆盖 no scope、ambiguous scope、missing index、stale、
quality gate failed 和 over budget。每类场景都有 typed error code、
fallback 策略和 timing fields，查询观测可分解到 scope resolution、
upper index validation、generation validation、retrieval 和 budget
application 等阶段。

## D10_testability - 可测试性

status: pass

`testContracts.requiredCases` 定义 18 个必测案例，超过基准要求的 8 个。
测试覆盖不同规模库的固定 top-K 验证、超预算 fail-closed、stale 默认拒绝、
缺上层索引不在查询路径重建、成员包质量门失败、evidence map 链接、
semantic edges 关系证据、敏感扫描、中断恢复和 partial ready 防护。

书架组织挑战覆盖充分：测试包括用户显式成员覆盖 taxonomy 和 LLM 建议、
LLM suggested bookshelf 未接受前不可 query-ready、接受建议创建新
materialized bookshelf generation、超大类别转为 virtual parent 与物化子书架、
查询 virtual parent 时固定 top-K 路由或要求收窄 scope。热插兼容测试也覆盖
删除上层 catalog 后单书查询仍成功，以及删除 book 只标记依赖上层索引 stale。

## 非阻断建议

- 在实现规格中明确 `proposedRationale` 必须是 bounded redacted summary，
  并为 LLM suggestion artifact 增加专门的敏感扫描规则编号。
- 为 `membership_decisions.jsonl` 增加测试 fixture，校验用户 lock、
  accepted suggestion、LLM rerun 与 taxonomy conflict 的审计字段完整性。
