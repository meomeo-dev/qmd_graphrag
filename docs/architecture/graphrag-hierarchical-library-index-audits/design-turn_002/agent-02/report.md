# GraphRAG 层级 Library 索引设计复审报告

## 审计范围

- 审计轮次：design-turn_002
- 审计 agent：agent-02
- 审计对象：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 基准维度：D01-D10
- 总体结论：pass

## 重点结论

修订后的设计满足固定查询成本（fixed query cost）要求。交互查询预算
定义了固定的语义单元、书架、下钻书本、成员 community 引用、LLM 调用和
token 上限，并要求超预算时 fail-closed 或收窄 scope。查询路径明确禁止
隐式全库扫描和交互式重建。

GraphRAG 语义结构因 `semantic_edges.parquet` 得到明确保障。设计定义了
`semanticEdge` 术语、schema、关系类型、证据引用和 generation，并在书架与
library 构建算法、质量门、测试合同中要求保留实体或关系证据。

CLI 错误已足够机器可读（machine-readable）。`typed_query_error_v1`
包含稳定 code、exitCode、route、stage、retryable、scope、redactedMessage、
remediationCommand 和 timingAvailable 字段；常见场景矩阵覆盖无 scope、
歧义、缺索引、stale、质量门失败和超预算。

## 逐项结论

### D01_authority_boundaries

- title：权威边界与热插包隔离
- status：pass

单书包权威仍限定为 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内
qmd/GraphRAG/state 产物和质量门。书架与 library 被定义为可重建 catalog
派生物，缺失、损坏或过期不得改变单书 `query_ready`。导出规则也明确
单书导出排除书架和 library 索引。

依据：目标文档第 24-39 行、第 70-79 行、第 646-659 行。

### D02_fixed_query_budget

- title：固定查询预算
- status：pass

交互查询预算给出固定默认值：`maxSemanticUnits: 32`、`maxBookshelves: 4`、
`maxBooksForDeepening: 3`、`maxMemberCommunityRefs: 24`、固定 LLM 调用上限
和 token 上限。设计禁止查询时把全部成员书 `community_reports` 放入 prompt，
也禁止按成员书数量创建不受限 map 调用。超预算时返回
`budget_exceeded_narrow_scope_required` 或要求收窄 scope。

依据：目标文档第 80-84 行、第 343-361 行、第 369-372 行、第 479-510 行。

### D03_graphrag_semantic_alignment

- title：GraphRAG 语义对齐
- status：pass

上层索引输入包含单书 community reports、entities、relationships。设计定义
`semantic_edges.parquet` 作为上层图结构的最低持久合同，并要求保留方向、
权重、来源实体、来源 relationship、证据引用和 generation。书架和 library
构建算法都要求从实体、关系、社区成员或跨书架共聚类派生 semantic edges，
综合回答基于预计算 community reports 或 semantic units。

依据：目标文档第 31-33 行、第 59-63 行、第 135-171 行、第 195-221 行、
第 287-298 行、第 324-334 行、第 492-506 行。

### D04_evidence_traceability

- title：证据可追溯
- status：pass

设计定义 `evidence_map.parquet`，字段覆盖 `bookId`、`sourceId`、
`documentId`、`contentHash`、community report、text unit 和 artifact digest。
每个上层 semantic unit、semantic edge、community 与 community report 均要求
至少一条 evidence_map 记录，除非仅为无可回答内容的 membership marker。
回答合成规则要求包含 traceable evidence ids。

依据：目标文档第 89-93 行、第 222-244 行、第 492-497 行。

### D05_state_recovery

- title：状态闭环与恢复
- status：pass

设计定义了 build run ledger、`status.json`、`events.jsonl`、checkpoint 和
recovery summary。恢复规则要求失败 semantic unit generation 不发布 ready
上层索引，中断构建从已验证 checkpoint 恢复，成员 manifest stale 会在查询
前标记。发布协议要求 staging 校验后原子提升，并最后写 publish marker。

依据：目标文档第 566-588 行。

### D06_quality_gates

- title：质量门
- status：pass

书架和 library 均有独立质量门与 `requiredChecks`。检查项覆盖 manifest
schema、checksum sidecars、成员 manifest sha256、一致性、semantic unit/edge
schema、community reports、evidence map、embedding/vector 元数据、固定预算
模拟、敏感信息扫描和 stale marker。失败诊断要求机器可读、限界并使用
digest 或脱敏 locator。

依据：目标文档第 512-564 行。

### D07_incremental_scaling

- title：增量扩展
- status：pass

成员记录包含 manifest sha256 和 generation。书架增量刷新允许在 checksum
证明未变时只重建受影响 semantic units 与 communities，否则重建书架
generation。library 增量刷新允许局部重建 semantic units、semantic edges 和
communities；若图连通性无法局部化，则标记 stale 并创建全量新 generation。
大库要求通过书架分层组织，限制 library 直接书本成员。

依据：目标文档第 98-102 行、第 252-271 行、第 299-303 行、第 310-323 行、
第 335-341 行。

### D08_security_privacy

- title：安全与隐私
- status：pass

设计定义 forbidden inputs，禁止 provider payload、query logs、本地绝对路径和
未验证损坏包进入构建输入；硬不变量禁止上层 manifest、索引、质量门和诊断
包含 provider payload、原始 prompt/completion、密钥、绝对路径或 query.log。
质量门包含敏感信息扫描，诊断和 manifest 只能记录 digest、schema id、限界摘要
和脱敏 locator。

依据：目标文档第 94-97 行、第 272-286 行、第 512-540 行、第 589-614 行、
第 616-644 行。

### D09_cli_operability

- title：CLI 可操作性与降级
- status：pass

设计定义 scope resolution order：显式 book、显式 bookshelf、显式 library、
默认 library、快速歧义错误。`typed_query_error_v1` 提供稳定字段，错误码覆盖
missing scope、ambiguous scope、missing index、stale、quality gate failed、
budget exceeded 和 runtime error。CLI 行为矩阵给出各场景 outcome、code、
fallbackAllowed 与 timingFields，满足快速 typed error 和层级阶段 timing/cost
观测要求。

依据：目标文档第 103-106 行、第 362-478 行、第 670-676 行、第 699-700 行。

### D10_testability

- title：可测试性
- status：pass

测试合同定义 13 个必测案例，超过固定基准要求的 8 个。测试覆盖不同规模库
10、100、1000 本时的固定预算验证、超预算 typed error、stale 拒绝、缺索引不
重建、构建失败闭环、evidence map、semantic edges、安全扫描、中断恢复、
hotplug 非回归、交互查询与 exhaustive report 分离，以及查询 timing 报告。

依据：目标文档第 685-700 行。

## 剩余说明

未发现 fixed baseline D01-D10 下的 fail 项。后续实现阶段仍应把
`typed_query_error_v1` 和质量门诊断固化为 JSON schema，并为预算模拟加入
可重复的大规模 fixture；这些属于实现验证建议，不影响本轮设计通过结论。
