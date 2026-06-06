# GraphRAG 层级 Library 索引设计复审报告

审计对象：`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

固定基准：
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

审计轮次：`design-turn_003`

审计 agent：`agent-01`

总体结论：pass_with_minor_notes

判定规则：逐项使用固定基准 D01-D10。任一维度为 `fail` 时总体为
`fail`；本轮未发现 `fail` 项。

## 重点挑战结论

- 用户单书包处理：单书 `query_ready` 仍只由单书包权威决定。用户可在
  小库中使用 direct book membership，也可显式创建书架；小于最小有效规模的
  书架可保持虚拟、合并到父书架，或按用户请求构建。
- 成员权威关系：成员规则明确为用户显式成员关系、用户接受建议、确定性规则、
  图书馆分类法、LLM 建议的降序权威。用户锁定 include/exclude 始终优先。
- LLM 建议污染：LLM 自动聚类只能产生 suggestion-only 书架，不能直接成为
  query-ready 物化书架。用户接受后才创建新的物化书架 generation。
- 规模上限和拆分：单个物化书架有默认、软、硬成员上限，并以成员数、
  语义单元预算、主题离散度和候选支配度触发拆分。超大分类必须成为虚拟父
  书架，并拆成物化子书架。
- 虚拟书架预算：虚拟父书架不生成 `community_reports` 或 `semantic_units`，
  交互查询只能固定 top-K 路由到子物化书架，或要求收窄 scope。因此不会把
  虚拟层本身变成无界查询输入。

## D01_authority_boundaries：权威边界与热插包隔离

status: pass

设计继续保持单书 `BOOK_MANIFEST.json` 作为包权威（package authority），
书架和 library 均为 catalog 下的可重建派生物。`hardInvariants` 明确规定
上层索引不得改变单书身份、文件闭包或 `query_ready` 判定；上层索引缺失、
损坏或过期也不得使有效单书包变成 `not_query_ready`。新增的成员组织策略
没有突破该边界：direct book membership 只属于 library/书架成员解析，不写回
单书包闭包。

## D02_fixed_query_budget：固定查询预算

status: pass

`queryContract.interactiveBudget.default` 定义固定的 semantic unit、bookshelf、
deepening book、member community reference、LLM 调用、输入 token 和输出
token 上限。`retrieval.firstStage` 与 `secondStage` 均受这些预算约束，超预算
时使用 `budget_exceeded_narrow_scope_required` fail closed 或要求收窄 scope。
虚拟父书架只可固定 top-K 路由到子物化书架，或返回 scope refinement，未引入
随书籍数量线性增长的交互扫描路径。

## D03_graphrag_semantic_alignment：GraphRAG 语义对齐

status: pass

上层构建输入包含单书 `community_reports`、`entities`、`relationships` 和 qmd
元数据。`semantic_edges.parquet` 保留方向、权重、关系类型、来源实体、
来源关系、证据映射和 generation，避免上层索引退化为普通摘要检索。书架与
library 构建均生成 communities 和 community reports，查询综合基于预计算
semantic units、community reports 和 evidence，而不是查询时全量摘要拼接。

## D04_evidence_traceability：证据可追溯

status: pass

`evidence_map.parquet` 定义了 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report、text unit、artifact digest、rank 和
generation 等追溯字段。每个上层 semantic unit、semantic edge、community 和
community report 必须至少有一条下层证据引用，纯 membership marker 除外。
查询综合要求暴露 traceable evidence ids，并说明结果是否 scoped 或
non-exhaustive。

## D05_state_recovery：状态闭环与恢复

status: pass

`stateAndRecovery` 定义 bookshelf/library build ledger、`status.json`、
`events.jsonl`、checkpoints 和 recovery summary。构建完成需要 checkpoint、
manifest、quality gate 与 publish marker；失败的 semantic unit generation 不会
发布 query-ready 上层索引。发布协议采用 staging、校验、写质量门、原子
promote、最后写 publish marker 的顺序。成员 manifest 变化会在查询使用前把
依赖的上层索引标记为 stale。

## D06_quality_gates：质量门

status: pass_with_minor_notes

书架与 library 均有独立质量门路径和 `requiredChecks`。检查覆盖 manifest
schema、checksum sidecars、成员 manifest sha256、一致性、成员质量门、schema
校验、`semantic_edges.parquet`、`evidence_map.parquet`、embedding/vector 元数据、
固定预算模拟、敏感 payload 扫描和 stale marker absence。质量门失败通过
`failureDiagnostics` 暴露机器可读诊断，CLI 会返回
`upper_quality_gate_failed`，满足查询不可用且诊断可见的基准要求。

minor note：LLM suggestion 的 query-ready 禁止规则已在
`bookshelfContract.membership.policyKinds` 和 `llmSuggestionGate.promotionRules`
中定义，但 `qualityGates.bookshelfGate.requiredChecks` 未单独命名
membership authority/queryReadyAllowed 校验项。该缺口不构成本轮 fail，因为
manifest schema、成员一致性和 suggestion gate 合同已形成约束；后续实现应把
该校验作为显式 check id 落地，便于诊断定位。

## D07_incremental_scaling：增量扩展

status: pass

bookshelf generation 记录成员集合、成员 manifest sha256、builder version、
embedding model fingerprint、clustering config、summary config 和 evidence
schema。library generation 也记录成员 shelf manifest sha256 及对应构建配置。
bookshelf 与 library 均允许 checksum 可证明时局部刷新；不能局部化时保守重建
或标记 stale 并创建新 generation。大库通过物化书架、虚拟父书架和 nested
library partitions 限制重建影响范围。

## D08_security_privacy：安全与隐私

status: pass

`no_sensitive_payload_export`、`buildInputs.forbiddenInputs`、
manifest `sensitivityPolicy` 和敏感扫描共同禁止 provider payload、原始 prompt、
原始 completion、密钥、用户绝对路径和运行期 `query.log` 进入可发布上层
manifest 或索引。`diagnosticRedactionPolicy` 进一步要求诊断和 manifest 只记录
sha256 digest、schema id、bounded summary、check id 和 redacted locator，禁止
记录可逆请求材料或用户本地路径。

## D09_cli_operability：CLI 可操作性与降级

status: pass

`scopeResolutionOrder` 定义显式 book、显式 bookshelf、显式 library、默认
library、快速 ambiguity error 的解析顺序。`noImplicitFullVaultScan` 禁止无
scope 查询在 query path 中全库扫描或重建。`typedErrors` 与
`cliBehaviorMatrix` 覆盖缺 scope、歧义、缺索引、stale、质量门失败、超预算和
runtime error。虚拟父书架过宽时要求 scope refinement，避免长时间无输出或
隐式全库扫描。

## D10_testability：可测试性

status: pass

`testContracts.requiredCases` 定义 18 个必测案例，超过固定基准要求的 8 个。
测试覆盖单书 hotplug 非回归、用户成员关系优先、LLM suggestion 未接受前不可
query-ready、接受建议创建新 generation、超大分类拆分为虚拟父书架和物化子
书架、虚拟父书架固定路由或收窄、10/100/1000 本书固定 top-K、超预算错误、
stale 默认拒绝、缺索引不查询时重建、成员质量门失败 fail closed、证据映射、
semantic edge schema、敏感扫描、中断恢复、删除书只标记上层 stale、
exhaustive report 与交互查询分离，以及分层 timing 观测。
