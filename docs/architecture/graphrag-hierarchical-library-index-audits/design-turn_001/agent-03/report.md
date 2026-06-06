# GraphRAG 层级 Library 索引 Type DD 设计审计报告

auditAgent: agent-03
targetDocument: docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml
baselineDocument: docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml
overallStatus: pass_with_minor_notes

## 总体结论

未发现 `fail` 项。设计草稿满足固定基准 D01-D10 的核心要求，
总体为 `pass_with_minor_notes`。

设计对单书热插包非回归（hotplug non-regression）、安全隐私
（security and privacy）、固定查询预算（fixed query budget）、
CLI 降级行为（CLI degradation）、测试合同（test contract）和大型
library 增量扩展（incremental scaling）均给出了可审计约束。

轻微补强点集中在三个方面：质量门失败时的 CLI typed error 结构可更
明确；敏感信息扫描（sensitive scan）的规则编号与输出字段可进一步
固化；缺索引、超预算、歧义 scope 的命令输出矩阵可在后续实现规格中
细化。

## D01_authority_boundaries - 权威边界与热插包隔离

status: pass

设计保持 `BOOK_MANIFEST.json` 作为单书包唯一权威，并明确书架与
library 索引是可重建 catalog 派生物。`hardInvariants` 中的
`book_package_authority_preserved` 与 `derived_upper_indexes_only`
直接保护单书 `query_ready` 判定，不允许上层索引改变单书身份、文件闭包
或挂载状态。

热插包非回归覆盖充分：删除或安装书包只会使相关上层索引 stale 或触发
重建调度；直接单书查询仍由包内质量门治理。导出规则也排除了把书架或
library 索引写入单书包闭包的风险。

## D02_fixed_query_budget - 固定查询预算

status: pass

交互查询预算定义了固定的 `maxSemanticUnits`、`maxBookshelves`、
`maxBooksForDeepening`、`maxMemberCommunityRefs`、`maxLlmCalls`、
`maxInputTokens` 和 `maxOutputTokens`。查询路径先从上层预计算语义单元
召回，再按预算执行可选下钻，避免随书籍数量线性增长。

设计显式禁止查询时全量扫描所有单书 `community_reports`，并把
`exhaustive_report` 定义为后台作业模式。超预算时要求 fail-closed 或
请求收窄 scope，符合固定预算基准。

## D03_graphrag_semantic_alignment - GraphRAG 语义对齐

status: pass

上层构建输入包含单书 `community_reports`、`entities`、
`relationships` 和 qmd 元数据，并生成书架级与 library 级
`community_reports`。查询综合基于预计算 community reports、semantic
units 与可追溯 evidence，而不是普通摘要检索。

`openDecisions` 中仍保留聚类算法选择，但默认方案为 embedding-first 与
graph refinement 的混合路径，不影响当前设计对 GraphRAG 语义结构的
符合性。

## D04_evidence_traceability - 证据可追溯

status: pass

设计在书架和 library 两层均定义 `evidence_map.parquet`，并要求上层
语义单元回链到成员 report、书籍、`bookId`、`sourceId`、`documentId`、
`contentHash`、community report 或 `text_unit`。质量门要求
`evidence_map` 覆盖每个上层单元。

查询综合要求输出 traceable evidence ids，并说明 scoped 或
non-exhaustive 结果，满足回答侧 evidence lineage 暴露要求。

## D05_state_recovery - 状态闭环与恢复

status: pass

设计包含 durable ledger roots、`events.jsonl`、`status.json`、
`checkpoints/{unitId}.json` 与 `recovery-summary.json`。构建完成必须同时
具备 checkpoint、manifest、quality gate 和 publish marker。

partial publish 防护明确：失败的 semantic unit generation 不会发布 ready
上层索引；中断构建从已验证 checkpoint 恢复；成员 manifest 变化会在查询前
标记上层索引 stale。

## D06_quality_gates - 质量门

status: pass_with_minor_notes

书架与 library 均定义独立质量门和 `requiredChecks`，覆盖 manifest schema、
checksum sidecars、成员一致性、成员质量门、parquet schema、evidence map、
embedding fingerprint、固定预算模拟、敏感信息扫描和 stale marker。

质量门失败不会形成 query-ready 上层索引，因为构建完成要求 quality gate 和
publish marker 同时存在。诊断可通过 durable status、events 与 quality gate
路径定位。

建议后续实现规格明确质量门失败时的 typed error 名称、诊断字段和 CLI
退出码，使“查询不可用且诊断可见”形成稳定接口合同（interface contract）。

## D07_incremental_scaling - 增量扩展

status: pass

书架和 library 的 generation 规则记录成员 manifest sha256、
`packageGeneration`、builder version、embedding model fingerprint、
clustering config、summary config 与 evidence schema。成员集合或成员
manifest 变化会生成新 generation 或标记 stale。

增量刷新策略合理：当 checksum 可证明输入未变时，只重建受影响 semantic
units 和派生 communities；否则保守重建对应书架 generation。大型 library
要求通过书架组织成员，直接书籍成员只允许用于小 library 或过渡修复，
能够限制大库变更的重建影响范围。

## D08_security_privacy - 安全与隐私

status: pass_with_minor_notes

设计通过 `no_sensitive_payload_export`、`forbiddenInputs` 和
`sensitivityPolicy` 禁止 provider payload、原始 prompt、原始 completion、
密钥、用户绝对路径和运行期 query log 进入可发布上层 manifest 或索引。
书架与 library 质量门均包含 sensitive payload scan。

诊断与修复规则要求 bounded diagnostics 且不得修改书包；manifest schema
包含 `sensitivityPolicy`，可承载脱敏摘要或 digest 约束。

建议在实现规格中固定敏感扫描规则编号、允许字段、digest 格式和失败样例，
降低不同实现对“脱敏摘要（redacted summary）”的解释差异。

## D09_cli_operability - CLI 可操作性与降级

status: pass_with_minor_notes

设计定义 scope resolution order：显式 `bookId`、显式 `bookshelfId`、
显式 `libraryId`、默认 library、快速 ambiguity error。无 scope 时允许读取
当前 projection manifest 或默认 scope pointer，但禁止在查询路径中重建或
扫描全库。

stale、缺上层索引和超预算场景具备降级原则：默认拒绝 stale 上层索引并提供
rebuild/status 命令；上层索引不可用时快速返回 typed error、建议回退到单书
或 qmd 检索，或要求明确 scope；超预算时 fail-closed 或要求收窄 scope。
测试合同也要求 timing 拆分到 retrieval、synthesis、optional deepening 和
evidence merge。

建议后续补充 CLI 行为矩阵，固定无 scope、有 scope、stale、missing index、
over budget、ambiguity 的错误类型、退出码、stderr 摘要和 timing 字段。

## D10_testability - 可测试性

status: pass

`testContracts.requiredCases` 定义 10 个必测案例，超过基准要求的 8 个。测试
覆盖单书上层 catalog 删除后仍可查询、10/100/1000 本模拟下固定 top-K、
stale 默认拒绝、成员质量门失败 fail-closed、evidence map 链接、安全扫描、
中断恢复、防止 partial ready state、删除书籍后的上层 stale 标记，以及
交互查询与 exhaustive report 分离。

热插兼容测试明确验证删除书籍不会 mutate 单书，并且单书查询不依赖上层
catalog。这满足热插包非回归和大型 library 固定预算验证要求。

