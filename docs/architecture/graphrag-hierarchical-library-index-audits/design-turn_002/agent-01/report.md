# GraphRAG 层级 Library 索引设计复审报告

审计对象：`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

固定基准：`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

审计轮次：`design-turn_002`

审计 agent：`agent-01`

总体结论：pass

判定规则：逐项使用固定基准 D01-D10。任一维度为 `fail` 时总体为
`fail`；本轮未发现 `fail` 项。

## 重点补齐项确认

- `semantic_edges/schema`：已补齐。`upperGraphArtifactSchemas.semanticEdges`
  定义 `semantic_edges.parquet`、必需列、允许关系类型和保留图结构的合同。
- `quality gate diagnostics`：已补齐。`qualityGates.failureDiagnostics`
  定义诊断路径、必需字段和 digest/相对 locator 规则。
- `diagnostic redaction`：已补齐。`stateAndRecovery.diagnosticRedactionPolicy`
  定义允许字段、禁止字段和 digest 记录规则。
- `CLI typed errors/matrix`：已补齐。`queryContract.typedErrors` 定义稳定错误码、
  退出码、通用字段和修复命令；`cliBehaviorMatrix` 覆盖无 scope、歧义、
  缺索引、stale、质量门失败和超预算。
- `library incremental refresh`：已补齐。`libraryContract.buildAlgorithm`
  增加 library 级 `incrementalRefresh`，允许 checksum 可证明时局部刷新，
  否则标记 stale 并创建全量 generation。

## D01_authority_boundaries：权威边界与热插包隔离

status: pass

设计仍保持单书 `BOOK_MANIFEST.json` 作为包权威（package authority），并把
bookshelf/library 限定为可重建 catalog 派生物。`scope.excluded` 排除把上层
索引写入单书可复制包闭包，也排除以全局 catalog 替代单书 manifest。
`hardInvariants.book_package_authority_preserved` 和
`derived_upper_indexes_only` 直接规定上层索引不得改变单书身份、文件闭包或
`query_ready` 判定。`compatibilityWithHotplugPackages` 进一步说明安装或删除
书包只影响上层 stale 状态，不影响直接单书查询。

## D02_fixed_query_budget：固定查询预算

status: pass

`queryContract.interactiveBudget.default` 定义固定 `maxSemanticUnits`、
`maxBookshelves`、`maxBooksForDeepening`、`maxMemberCommunityRefs`、
`maxLlmCalls`、输入 token、输出 token 和交互延迟类别。设计禁止交互查询把
全部成员书 `community_reports` 放入 prompt，也禁止按成员书数量创建不受限
map 调用。`retrieval.firstStage` 与 `secondStage` 受预算字段约束，超预算时
使用 `budget_exceeded_narrow_scope_required` fail closed 或要求收窄 scope。

## D03_graphrag_semantic_alignment：GraphRAG 语义对齐

status: pass

上层索引输入包含单书 `community_reports`、`entities`、`relationships` 和 qmd
元数据。修订版新增明确的 `semantic_edges.parquet` schema，要求保留关系方向、
权重、来源 entity/relationship id、证据映射和 generation。bookshelf 与
library 构建步骤均生成上层 communities 和 community reports，查询综合基于
预计算 community reports、semantic units 与可追溯 evidence，而不是普通摘要
检索。

## D04_evidence_traceability：证据可追溯

status: pass

设计定义 `evidence_map.parquet`，并列出 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report、text unit、artifact digest、rank 和
generation 等追溯字段。每个上层 semantic unit、semantic edge、community 和
community report 都必须有下层证据引用，除非只是无可回答内容的纯 membership
marker。查询综合要求输出 traceable evidence ids，并说明 scoped 或
non-exhaustive 结果。

## D05_state_recovery：状态闭环与恢复

status: pass

`stateAndRecovery` 定义 bookshelf/library run ledger、`status.json`、
`events.jsonl`、checkpoint 和 recovery summary。构建完成需要 checkpoint、
manifest、quality gate 与 publish marker；失败 semantic unit generation 不会
发布 query-ready 上层索引。发布协议采用 staging、校验、原子 promote 和最后
写 publish marker 的顺序，覆盖 partial publish 防护。成员 manifest 变化会在
查询使用前标记 stale。

## D06_quality_gates：质量门

status: pass

bookshelf 与 library 均有独立质量门路径和 `requiredChecks`。检查覆盖 manifest
schema、checksum sidecars、成员 manifest sha256、一致性、成员质量门、schema
校验、`semantic_edges.parquet`、`evidence_map.parquet`、embedding/vector 元数据、
固定预算模拟、敏感 payload 扫描和 stale marker absence。修订版新增
`failureDiagnostics`，以机器可读字段公开失败 check、severity、typed error、
artifact digest、期望/观测 digest、脱敏 locator 和 remediation command，满足
“查询不可用且诊断可见”的基准要求。

## D07_incremental_scaling：增量扩展

status: pass

成员 manifest sha256、package/shelf generation、builder version、embedding model
fingerprint、clustering config、summary config 和 evidence schema 均纳入
generation 规则。bookshelf 层允许在 checksum 可证明时只重建受影响 semantic
units 与 communities，否则保守重建 shelf generation。修订版已补齐 library 层
增量刷新：成员 shelf 变化时可局部重建受影响 library semantic units、
semantic edges 和 communities；若图连通性变化不能局部化，则标记当前 library
generation stale 并创建新的全量 generation。大库通过书架分层限制重建影响范围。

## D08_security_privacy：安全与隐私

status: pass

`no_sensitive_payload_export`、`forbiddenInputs`、`sensitivityPolicy` 和质量门
敏感扫描共同禁止 provider payload、原始 prompt、原始 completion、密钥、
绝对路径和运行期 `query.log` 进入可发布上层 manifest 或索引。修订版新增
`diagnosticRedactionPolicy`，明确诊断与 manifest 只能记录 sha256 digest、
schema id、bounded summary、check id 和 redacted locator，禁止记录可逆请求材料、
原始敏感 payload 或用户本地路径。

## D09_cli_operability：CLI 可操作性与降级

status: pass

`scopeResolutionOrder` 定义显式 book、显式 bookshelf、显式 library、默认
library、快速 ambiguity error 的解析顺序。`noImplicitFullVaultScan` 禁止无
scope 查询在 query path 中全库扫描或重建。修订版新增 `typedErrors` 和
`cliBehaviorMatrix`，覆盖 `missing_scope`、`ambiguous_scope`、
`upper_index_missing`、`upper_index_stale`、`upper_quality_gate_failed`、
`budget_exceeded_narrow_scope_required` 和 runtime error。矩阵对无 scope、歧义、
缺索引、stale、质量门失败、超预算场景给出 outcome、fallback policy 和
timing fields，满足快速 typed error 与分阶段观测要求。

## D10_testability：可测试性

status: pass

`testContracts.requiredCases` 定义 13 个必测案例，超过至少 8 个的基准要求。
测试覆盖 10、100、1000 本书模拟下的固定 top-K，覆盖上层 catalog 删除后单书
查询仍成功，覆盖 stale 默认拒绝、缺索引不在查询路径重建、成员质量门失败
fail closed、evidence map、semantic edge schema、敏感扫描、中断恢复、
partial ready 防护、删除书只标记上层 stale、交互查询与 exhaustive report 分离，
以及 retrieval、synthesis、optional deepening、evidence merge 的 timing 报告。
