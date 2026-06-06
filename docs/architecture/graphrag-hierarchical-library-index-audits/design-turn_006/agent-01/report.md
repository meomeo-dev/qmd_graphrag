# design-turn_006 agent-01 设计复审报告

## 审计结论

overallStatus: pass

本轮复审按固定基准
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
的 D01-D10 执行。复审对象为：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/final-summary.md`

结论：修正后的设计集满足 D01-D10。第五轮 D09 minor note 已闭环；
pipeline I/O 合同未再使用 `scope_not_found`，并在
`scoped_query_execution.failureOutputs` 中对齐主 typed query error 合同的
`missing_scope` 与 `ambiguous_scope`。pipeline I/O 仍满足固定基准要求。

## D01_authority_boundaries

status: pass

设计继续保持单书包 `BOOK_MANIFEST.json` 与 `PUBLISH_READY.json` 为单书包
权威。书架与 library 均位于 `graph_vault/catalog/**`，并被声明为可重建
派生物。pipeline I/O 的 `package_first_authority`、`catalog_is_derivative`
和各阶段 `forbiddenInputs` 明确禁止上层索引回写或改变单书包文件闭包。

## D02_fixed_query_budget

status: pass

主设计定义 `queryContract.interactiveBudget`，包含固定 `maxSemanticUnits`、
`maxBookshelves`、`maxBooksForDeepening`、`maxLlmCalls` 与 token 上限。
pipeline I/O 的 `scoped_query_execution` 禁止交互路径隐式全库扫描或自动构建，
并在超预算时输出 `budget_exceeded_narrow_scope_required`。

## D03_graphrag_semantic_alignment

status: pass

上层构建输入包含单书或书架 `community_reports.parquet`、`entities.parquet`
和 `relationships.parquet`。主设计定义 `semantic_units.parquet` 与
`semantic_edges.parquet`，保留实体、关系、社区和 membership 语义关系。
书架与 library 综合回答基于预计算社区报告和语义单元，而非普通摘要检索。

## D04_evidence_traceability

status: pass

主设计定义 `evidence_map.parquet`，要求上层 semantic unit、semantic edge、
community 和 community report 回链到 `bookId`、`sourceId`、`documentId`、
`contentHash`、community report 或 text unit。pipeline I/O 在书架构建、
library 构建和 scoped query 阶段均要求 evidence lineage 指向已发布下层产物。

## D05_state_recovery

status: pass

主设计定义 durable state、events、checkpoints、publish protocol、stale
behavior 和 recovery rules。pipeline I/O 每个构建阶段均定义 `stateWrites`、
`failureOutputs` 与 handoff reject 条件，且规定 failed staging generation
不得提升为 current，partial build 不会发布 query-ready 上层索引。

## D06_quality_gates

status: pass

主设计分别定义 `qualityGates.bookshelfGate` 与 `qualityGates.libraryGate`，
覆盖 schema、checksum、成员 manifest 一致性、membership 检查、固定预算
模拟、敏感信息扫描和 stale marker。pipeline I/O 每个阶段均声明
`qualityGate.requiredChecks`，失败时输出 typed diagnostic 或阻断下游。

## D07_incremental_scaling

status: pass

主设计在 bookshelf 与 library generation 规则中记录成员 manifest sha256、
package generation、builder/config/schema 指纹，并定义增量刷新规则。超大
书架通过虚拟父书架和物化子书架拆分，library 通过书架层级与 partition
限制重建影响范围。pipeline I/O handoff matrix 可阻断 stale 或 digest
变化的成员继续进入下游。

## D08_security_privacy

status: pass

主设计的 `diagnosticRedactionPolicy` 与 manifest `sensitivityPolicy` 禁止
provider payload、raw prompt、raw completion、密钥、绝对路径和 query log。
pipeline I/O 在硬不变量 `redacted_diagnostics_only`、阶段
`forbiddenInputs` 和质量门敏感扫描中保持同一边界，诊断只允许 digest、
schema id、check id、bounded summary 和 scope-relative locator。

## D09_cli_operability

status: pass

主设计定义 scope resolution order、typed query errors、CLI behavior matrix
和 timing fields，覆盖无 scope、scope 歧义、缺索引、stale、质量门失败与
超预算。pipeline I/O 的 `scoped_query_execution.failureOutputs` 已对齐主
typed error 合同，列出 `missing_scope`、`ambiguous_scope`、
`upper_index_missing`、`upper_index_stale`、
`upper_quality_gate_failed` 与
`budget_exceeded_narrow_scope_required`。未发现 `scope_not_found` 残留。

## D10_testability

status: pass

主设计 `testContracts.requiredCases` 超过 8 个必测案例，覆盖固定预算、
stale、缺索引、证据、敏感扫描、中断恢复和单书 hotplug 非回归。pipeline
I/O 另定义阶段级测试，包含 scoped query failure code 与主 typed query
error 合同一致性检查，并覆盖删除 catalog 上层产物不影响单书查询。

## 必须修订位置

无。
