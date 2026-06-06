# GraphRAG 层级 Library 索引 Type DD 第四轮设计复审报告

auditAgent: agent-03
auditRound: design-turn_004
targetDocument: docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml
baselineDocument: docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml
overallStatus: pass

## 总体结论

按固定基准 D01-D10 复审，未修改基准。`design-turn_004` 修订未破坏
单书热插包权威、固定交互查询预算、GraphRAG 语义对齐、证据可追溯、
状态恢复、质量门、安全隐私、CLI 降级、增量扩展和可测试性合同。

重点复核项结论如下：`membership_decisions.jsonl` 能记录成员决策
(membership decision) 的来源、权威、证据、分类法版本、LLM run 和用户接受
时间；LLM 建议门 (LLM suggestion gate) 禁止建议书架直接
`query_ready`，接受后生成新的物化书架 generation；成员相关质量门
(quality gate) 已给出稳定 check ids；诊断使用 digest 与 redacted locator；
测试合同包含用户显式成员、分类法、LLM 聚类建议和冲突 fixture。

未发现 `fail` 项，总体结论为 `pass`。

## D01_authority_boundaries - 权威边界与热插包隔离

status: pass

设计继续保持单书 `BOOK_MANIFEST.json` 作为单书包权威。书架与 library
索引位于 `graph_vault/catalog`，并被定义为可重建派生物。硬不变量禁止
上层索引改变单书包身份、文件闭包或 `query_ready` 判定。

热插兼容合同说明安装、删除单书包只会标记受影响的上层索引 stale 或触发
重建调度；直接单书查询仍由单书包质量门治理。该设计满足单书包隔离和
catalog 损坏不反向影响单书挂载状态的基准要求。

## D02_fixed_query_budget - 固定查询预算

status: pass

交互预算定义固定的 `maxSemanticUnits`、`maxBookshelves`、
`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用数、输入 token
和输出 token。查询先从上层预计算 semantic units 召回，再在固定预算内
执行可选下钻。

设计禁止查询路径全量扫描所有单书 `community_reports`，并把
`exhaustive_report` 限定为后台作业模式。超预算时返回
`budget_exceeded_narrow_scope_required`，符合 fail-closed 或收窄 scope
机制。

## D03_graphrag_semantic_alignment - GraphRAG 语义对齐

status: pass

上层构建输入包含成员书的 `community_reports`、`entities` 和
`relationships`。书架与 library 输出 `semantic_units.parquet`、
`semantic_edges.parquet`、`communities.parquet` 和
`community_reports.parquet`。

`semantic_edges` 合同保留关系方向、权重、来源 entity、relationship 和
`evidenceMapIds`。上层回答基于预计算 community reports 与 semantic
units，并可在固定预算内下钻到单书，未退化为普通摘要检索。

## D04_evidence_traceability - 证据可追溯

status: pass

设计定义 `evidence_map.parquet`，字段覆盖 `targetBookId`、
`targetSourceId`、`targetDocumentId`、`targetContentHash`、
`targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。
每个上层 semantic unit、semantic edge、community 和 community report
必须有下层证据引用，纯 membership marker 例外。

本轮重点关注的 `membership_decisions.jsonl` 定义 `decisionId`、`bookId`、
`action`、`policyKind`、`authority`、`evidenceRefs`、`taxonomyId`、
`taxonomyVersion`、`llmRunId` 和 `userAcceptedAt`。这些字段足以审计用户
显式成员、分类法归类和 LLM 聚类建议之间的成员归属冲突。查询综合合同也
要求最终回答包含 traceable evidence ids，并标注 scoped 或
non-exhaustive 状态。

## D05_state_recovery - 状态闭环与恢复

status: pass

状态与恢复合同定义书架和 library build 的 run ledger 根，以及
`status.json`、`events.jsonl`、`checkpoints/{unitId}.json` 和
`recovery-summary.json`。构建完成要求 checkpoint、manifest、质量门和
publish marker 同时成立。

发布协议先写入 `staging/{runId}`，验证 staged artifacts 与 checksum
sidecars，写入质量门和诊断后再原子提升，并最后写入 publish marker。
失败或中断的构建不会发布 query-ready 上层索引；成员 manifest 变化会在
查询前标记 stale。

## D06_quality_gates - 质量门

status: pass

书架与 library 均有独立质量门路径和 `requiredChecks`。检查覆盖 manifest
schema、checksum sidecars、成员 manifest sha256、成员质量门、semantic
units、semantic edges、community reports、evidence map、embedding/vector
metadata、固定预算模拟、敏感信息扫描和 stale marker。

成员治理相关 check ids 覆盖 `membership_decisions_schema_valid`、
`membership_authority_order_valid`、`membership_user_locks_preserved`、
`membership_llm_suggestion_not_query_ready`、
`membership_llm_acceptance_recorded`、超大类别拆分、虚拟父书架、direct
book limit 和 library partition。质量门失败使用
`upper_quality_gate_failed`，并在诊断中写入 `failedCheckId`、
`typedErrorCode`、artifact digest、redacted locator 和修复命令。

非阻断观察：非成员类 required checks 仍以文本标签表达，未在本设计中展开
完整 check-id catalog。固定基准 D06 已满足；实现规格宜为所有 required
checks 分配稳定 id，以便自动化诊断和测试断言。

## D07_incremental_scaling - 增量扩展

status: pass

书架 generation 记录 membership set、成员 manifest sha256、builder
version、embedding model fingerprint、clustering config、summary config 和
evidence schema。library generation 同样记录 shelf membership、成员 shelf
manifest sha256 和构建配置。

增量刷新允许在 checksum 可证明输入未变时只重建受影响 semantic units、
semantic edges 和 communities；无法局部化 graph connectivity 变化时，
library 必须标记当前 generation stale 并创建新的全量 generation。物化
书架规模上限、虚拟父书架和拆分策略限制了大库刷新影响范围。

## D08_security_privacy - 安全与隐私

status: pass

安全合同通过 `no_sensitive_payload_export`、`forbiddenInputs`、
`sensitivityPolicy` 和 `diagnosticRedactionPolicy` 禁止 provider payload、
原始 prompt、原始 completion、密钥、凭据、绝对本地路径和 `query.log`
内容进入可发布上层 manifest、索引、质量门或诊断。

LLM 建议门只要求持久化 `modelFingerprint`、`promptTemplateId`、
`inputDigest`、候选 book ids、证据引用、置信度和 `sensitiveScanStatus`；
没有要求保存原始请求、原始响应或 provider payload。质量门包含 sensitive
payload scan，诊断只能使用 digest、bounded summary、check id 和 redacted
locator，满足脱敏诊断 (redacted diagnostics) 要求。

## D09_cli_operability - CLI 可操作性与降级

status: pass

CLI scope resolution order 依次处理 explicit book、explicit bookshelf、
explicit library、configured default library 和 fast ambiguity error。
无 scope 查询可以读取 current projection manifest 或 default scope pointer，
但不得在查询路径中重建全库索引。

行为矩阵覆盖 no scope、ambiguous scope、missing index、stale、quality gate
failed 和 over budget。每类场景都有 typed error、fallback 策略和 timing
fields，查询观测可分解到 scope resolution、upper index validation、
generation validation、retrieval 和 budget application 等阶段。

## D10_testability - 可测试性

status: pass

`testContracts.requiredCases` 定义 19 个必测案例，超过基准要求的 8 个。
测试覆盖固定 top-K 在 10、100、1000 本书规模下的预算验证、超预算
fail-closed、stale 拒绝、缺上层索引不在查询路径重建、成员包质量门失败、
证据链、semantic edges、敏感扫描、中断恢复和 partial ready 防护。

本轮关注的测试 fixture 足以审计用户自定义、分类法和 LLM 聚类冲突：测试
明确要求用户显式成员覆盖 taxonomy 与 LLM suggestions，并要求
`membership_decisions` fixture 校验 user lock、accepted suggestion、LLM
rerun 和 taxonomy conflict 字段。另有测试覆盖 LLM 建议未接受前不可
query-ready、接受建议创建新物化 generation、超大类别转虚拟父书架、虚拟
父书架查询固定 top-K 路由，以及删除上层 catalog 后单书查询仍成功。

## 非阻断观察

- 目标文档的 `designAudit.currentRunDirectory` 与 `activeRevision.run` 仍指向
  `design-turn_003`。该问题属于审计元数据卫生，不属于固定基准 D01-D10 的
  失败项。
- `llmSuggestionGate.requiredFields.proposedRationale` 应在实现规格中明确为
  bounded redacted summary，避免被误实现为原始 completion 片段。
