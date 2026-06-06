# GraphRAG 层级 Library 索引 Type DD 第二轮设计复审报告

auditAgent: agent-03
auditRound: design-turn_002
targetDocument: docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml
baselineDocument: docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml
overallStatus: pass

## 总体结论

本轮仅使用固定基准 D01-D10 进行判定，未修改基准。修订后的设计文档
未发现 `fail` 项，总体结论为 `pass`。

重点复核的安全隐私（security and privacy）、质量门失败诊断
（quality gate failure diagnostics）、热插包非回归（hotplug
non-regression）、状态恢复（state recovery）和测试合同（test
contract）均已形成可审计合同。少量建议属于实现期细化，不影响本轮通过。

## D01_authority_boundaries - 权威边界与热插包隔离

status: pass

修订稿保持单书 `BOOK_MANIFEST.json` 作为单书包权威，并把书架与
library 索引限定为 catalog 下的可重建派生物。`hardInvariants` 中的
`book_package_authority_preserved` 与 `derived_upper_indexes_only`
明确禁止上层索引改变单书身份、文件闭包或 `query_ready` 判定。

热插包非回归覆盖充分。`compatibilityWithHotplugPackages` 规定安装或删除
book package 不自动修改 ready 的书架或 library generation；受影响的上层
索引只会被标记 stale 或调度重建，直接单书查询仍由单书包质量门治理。
导出规则也排除了把上层索引写入单书包闭包的风险。

## D02_fixed_query_budget - 固定查询预算

status: pass

`queryContract.interactiveBudget.default` 定义固定的 `maxSemanticUnits`、
`maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、
`maxLlmCalls`、`maxInputTokens` 和 `maxOutputTokens`。交互查询先在上层
预计算 semantic units 上召回，再按固定预算执行可选下钻。

设计明确禁止查询时全量扫描所有单书 `community_reports`，并把
`exhaustive_report` 限定为后台作业模式。超预算时使用
`budget_exceeded_narrow_scope_required` 快速失败并要求收窄 scope，符合
fail-closed 要求。

## D03_graphrag_semantic_alignment - GraphRAG 语义对齐

status: pass

上层索引输入包含单书 `community_reports`、`entities`、`relationships`
和 qmd 元数据；书架与 library 构建会生成各自的 `community_reports`。
修订稿新增或强化了 `semantic_edges.parquet` 合同，要求保留方向、权重、
来源 entity、relationship 和 evidence 引用，避免上层索引退化为普通摘要
检索（summary retrieval）。

查询综合基于预计算的上层 community reports、semantic units 和可选单书
下钻证据，仍贴近 GraphRAG 的社区报告与 map-reduce 查询原则。

## D04_evidence_traceability - 证据可追溯

status: pass

`evidence_map.parquet` 已定义为书架和 library 的共同输出合同，并给出列级
required columns。每个上层 semantic unit、semantic edge、community 和
community report 都必须至少有下层证据引用，除非只是无可回答内容的纯成员
标记。

证据链可回到 `bookId`、`sourceId`、`documentId`、`contentHash`、
community report 或 `text_unit`。`queryContract.synthesis.rule` 要求回答
包含 traceable evidence ids，并标明结果是否 scoped 或 non-exhaustive。

## D05_state_recovery - 状态闭环与恢复

status: pass

修订稿定义了书架和 library build 的 run ledger 根，以及 `status.json`、
`events.jsonl`、`checkpoints/{unitId}.json`、`recovery-summary.json` 等
durable state。构建完成必须同时具备 checkpoint、manifest、quality gate
和 publish marker。

partial publish 防护明确。构建先写入 `staging/{runId}`，验证 staged
artifacts 与 checksum sidecars 后再原子提升到 current generation，并最后写入
publish marker。失败的 semantic unit generation 不会发布 ready 上层索引；
中断构建从 validated checkpoints 恢复；成员 manifest 变化会在查询前标记
上层索引 stale。

## D06_quality_gates - 质量门

status: pass

书架和 library 均有独立质量门路径与 `requiredChecks`。检查项覆盖 manifest
schema、checksum sidecars、成员 manifest sha256、成员质量门、semantic units
schema、semantic edges schema、community reports schema、evidence map、
embedding/vector 元数据、固定预算模拟、敏感信息扫描和 stale marker absence。

质量门失败诊断已经合同化。`qualityGates.failureDiagnostics` 定义了诊断路径
和必需字段，包括 `failedCheckId`、`typedErrorCode`、`affectedArtifactDigest`、
`expectedDigest`、`observedDigest`、`redactedLocator` 和
`remediationCommand`。查询侧也定义 `upper_quality_gate_failed` typed error，
因此质量门失败时查询不可用且诊断可见。

## D07_incremental_scaling - 增量扩展

status: pass

书架与 library generation 规则记录成员 manifest sha256、成员 generation、
builder version、embedding model fingerprint、clustering config、summary
config 和 evidence schema。成员集合或成员 manifest 变化会产生新 generation
或标记 stale。

增量刷新策略满足基准。书架层在 checksum 可证明输入未变时只重建受影响的
semantic units 和派生 communities；否则保守重建 shelf generation。library
层同样允许局部重建受影响的 semantic units、semantic edges 和 communities；
当 graph connectivity 无法局部化时，必须标记当前 generation stale 并创建全量
新 generation。大库通过 bookshelves 分层限制重建影响范围。

## D08_security_privacy - 安全与隐私

status: pass

设计通过 `no_sensitive_payload_export`、`forbiddenInputs`、
`sensitivityPolicy` 和 `diagnosticRedactionPolicy` 禁止 provider payload、
原始 prompt、原始 completion、密钥、凭据、绝对本地路径和 `query.log`
内容进入可发布上层 manifest、索引、质量门或诊断。

书架和 library 质量门均包含 sensitive payload scan。诊断与 manifest 只能记录
sha256 digest、schema id、bounded summary、check id 和 redacted locator，
不得记录可逆请求材料、原始敏感 payload 或用户本地路径。该约束覆盖了可发布
产物和失败诊断两个风险面。

## D09_cli_operability - CLI 可操作性与降级

status: pass

`queryContract.routing.scopeResolutionOrder` 定义 explicit book、explicit
bookshelf、explicit library、configured default library、fast ambiguity error
with candidates 的解析顺序。无 scope 时可读取当前 projection manifest 或默认
scope pointer，但不得在查询路径中重建或全库扫描。

修订稿新增 typed error schema 和 CLI 行为矩阵，覆盖 missing scope、
ambiguous scope、missing index、stale、quality gate failed 和 over budget。
每类错误均有 exit code、retryable、stage、redacted message 和 remediation
command 约束。timing 字段可分解到 scope resolution、upper index validation、
generation validation、retrieval 和 budget application 等层级阶段。

## D10_testability - 可测试性

status: pass

`testContracts.requiredCases` 定义 13 个必测案例，超过基准要求的 8 个。测试
覆盖 10、100、1000 本规模下固定 top-K 验证、超预算 fail-closed、stale 默认
拒绝、缺上层索引不在查询路径重建、成员包质量门失败 fail-closed、evidence
map 链接、semantic edges 保留关系证据、敏感扫描、中断恢复和 partial ready
防护。

热插兼容测试覆盖两条关键非回归路径：删除上层 catalog 后单书查询仍成功；
删除 book 只标记依赖 shelf/library stale，且不修改单书包。测试合同与 D01、
D05、D08 的核心不变量保持一致。

## 非阻断建议

- 在实现规格中给 sensitive payload scan 规则分配稳定规则编号
  （stable rule id），便于诊断、测试快照和用户文档引用同一检查项。
- 在 CLI 测试中加入一个质量门诊断输出 fixture，校验 `redactedLocator`、
  digest 字段和 `remediationCommand`，防止实现阶段泄露绝对路径或原始内容。
