# design-turn_012 agent-1 设计审计报告

overallStatus: PASS

## 审计范围

被审计 Type DD：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

只读输入：

- `docs/task_kickoff_prompt/书架-Library层级索引改造_UNDO.prompt.md`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/design-turn_011/agent-*/report.md`

审计基准：固定 D01-D10。

## 总体结论

修订后的 Type DD 已满足新的上层包目录权威要求。设计明确将
bookshelf 权威根限定为 `graph_vault/bookshelves/{bookshelfId}`，将
library 权威根限定为 `graph_vault/library/{libraryId}`，并把
`graph_vault/catalog/**` 限定为 projection、capability、默认 scope、
routing 与 observability state。

上一轮阻塞点已被设计层面解除：`BOOKSHELF_MANIFEST.json`、
`LIBRARY_MANIFEST.json`、`PUBLISH_READY.json`、`CURRENT.json`、
package-local quality gates、generations、staging 与 runs 均被要求位于
各自上层包闭包内。查询路径必须先验证 package-local manifest、CURRENT、
PUBLISH_READY 与质量门；legacy catalog-only 上层产物必须 fail closed，并返回
`upper_package_migration_required`。

旧 `graph_vault/catalog/bookshelves/**` 与 `graph_vault/catalog/library/**`
路径仍出现在 `implementationGrounding` 和 `implementationGroundingReview`
中，但其语义已被限定为历史实现状态、迁移前实现证据或可重建 projection
根，不再作为规范性 package authority。因此这些引用不构成本轮设计阻塞。

## D01_authority_boundaries

status: PASS

Type DD 已明确单书包权威仍来自
`graph_vault/books/{bookId}/BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
包内 qmd/GraphRAG/state 产物与质量门。书架与 library 不得改变单书包身份、
文件闭包或 query_ready 判定。

上层包权威已迁移到：

- bookshelf: `graph_vault/bookshelves/{bookshelfId}`
- library: `graph_vault/library/{libraryId}`

`catalog_projection_only` 不变量明确 catalog 不拥有 bookshelf/library 包闭包，
不得作为上层 manifest、quality gate 或 publish marker 的权威来源。Type DD
还要求 catalog projection 可删除并从 package-local authority 重建，因此 catalog
损坏不改变已发布上层包的 query-ready 判定。

## D02_fixed_query_budget

status: PASS

设计定义固定交互查询预算，包括 `maxSemanticUnits`、`maxBookshelves`、
`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用上限、
`maxInputTokens` 与 `maxOutputTokens`。查询超预算时必须 fail closed 或要求
收窄 scope，并返回 `budget_exceeded_narrow_scope_required`。

查询路径禁止隐式全库扫描、禁止在交互路径中重建所有 book/shelf/library
索引，也禁止把所有单书 community reports 作为 prompt 输入。查询先从已发布
上层 semantic units 与 community reports 中召回固定数量候选，再按固定上限
执行可选下钻。

## D03_graphrag_semantic_alignment

status: PASS

上层索引输入包含成员书或成员书架的 `community_reports.parquet`、
`entities.parquet`、`relationships.parquet`、`text_units.parquet` 或等价
上层语义产物。输出包含 `semantic_units.parquet`、
`semantic_edges.parquet`、`communities.parquet`、`community_reports.parquet`
与 `evidence_map.parquet`。

`semantic_edges` 合同保留 entity、relationship、co-clustered topic、
parent-child community、bookshelf membership 与 library membership 等关系，
避免上层索引退化为普通摘要检索。library 构建以已发布 bookshelf 包为主要输入，
不把大量单书直接塞入交互查询。

## D04_evidence_traceability

status: PASS

Type DD 定义了 `evidence_map.parquet`，要求每个可回答的上层 semantic unit、
semantic edge、community 与 community report 至少有一条证据回链。字段覆盖
`bookId`、`bookshelfId`、`sourceId`、`documentId`、`contentHash`、
community report、text unit、artifact digest、generation 与 rank。

查询输出必须包含 evidence lineage，并且只引用已发布 artifact。诊断和 locator
必须使用 digest、package-relative 或 scope-relative redacted locator，不得使用
本机绝对路径或 catalog projection path 作为 evidence authority。

## D05_state_recovery

status: PASS

状态闭环已迁移到 package root。`ledgerRoots` 指向
`graph_vault/bookshelves/{bookshelfId}/runs/{runId}` 与
`graph_vault/library/{libraryId}/runs/{runId}`，`packageStateRoots` 指向各自上层
包根。publish protocol 要求先写 package-local `staging/{runId}`，通过 schema、
checksum、敏感扫描、质量门和固定预算模拟后，原子提升到
`generations/{generationId}`，更新 `CURRENT.json`，最后写入 package-root
manifest 与 `PUBLISH_READY`。

partial build、failed staging、running、pending 和 stale 产物不得成为下游 ready
输入。成员 manifest 变化会标记 stale 或生成新 generation。catalog projection
只能从 package-local authority 重建，legacy catalog-only 上层产物保持
not query-ready，直到迁移。

## D06_quality_gates

status: PASS

bookshelf 与 library 均有独立质量门，且路径位于各自上层包闭包：

- `graph_vault/bookshelves/{bookshelfId}/state/bookshelf-quality-gate.json`
- `graph_vault/library/{libraryId}/state/library-quality-gate.json`

requiredChecks 覆盖 schema、checksum sidecar、成员 manifest sha256、
成员质量门、membership 一致性、semantic units、semantic edges、
community reports、evidence map、embedding fingerprint、固定预算模拟、
敏感信息扫描和 stale marker。质量门失败时返回 `upper_quality_gate_failed`，
诊断写入 package-local `state/diagnostics.json`，不会发布 query-ready 上层索引。

## D07_incremental_scaling

status: PASS

设计记录成员 manifest sha256、packageGeneration、构建配置、索引 schema 与
generation。bookshelf generation 会在成员集合、成员 manifest sha256、builder
version、embedding model fingerprint、clustering config、summary config 或
evidence schema 变化时更新。library generation 同理以成员 bookshelf manifest
sha256 和构建配置为边界。

增量刷新允许在 checksum 可证明未变时只重建受影响 semantic units、semantic
edges 和 communities；无法局部证明时保守重建当前 generation。大规模 library
必须通过物化 bookshelf、虚拟父书架和 partition 限制影响范围，catalog projection
刷新与 package generation refresh 被区分。

## D08_security_privacy

status: PASS

Type DD 定义 forbidden inputs 和 redaction policy，禁止 provider request/response
payload、raw prompt、raw completion、credential、apiKey、query log content、
local absolute paths 进入上层 manifest、索引、质量门和诊断。

敏感扫描已纳入 bookshelf/library 质量门，并适用于可复制传播的上层包闭包。
diagnostics 与 manifests 只能记录 sha256 digest、schema id、check id、
bounded summary 与 redacted locator。catalog projection 不得复制敏感 payload，
也不得成为 package readiness proof。

## D09_cli_operability

status: PASS

CLI scope resolution 已明确区分显式 package root lookup 与 catalog projection
lookup。显式 `--bookshelf-id` 与 `--library-id` 必须先解析
`graph_vault/bookshelves/{bookshelfId}` 或 `graph_vault/library/{libraryId}`，
再校验 package-local `CURRENT.json`、manifest、`PUBLISH_READY` 与质量门。
catalog 仅可辅助 discovery、default scope routing 或 projection lookup。

Type DD 覆盖 no scope、ambiguous scope、missing index、legacy catalog-only
artifact、stale、quality gate failed 和 over budget 等场景，均要求快速 typed
error。包存在且质量门通过时，显式上层 scope 查询不得因 catalog projection
缺失或 stale 而失败；只有 legacy catalog 上层产物且缺少新包根时，返回
`upper_package_migration_required`。

## D10_testability

status: PASS

测试合同数量超过固定基准要求，且覆盖正确性、成本边界、恢复、证据、安全、
热插兼容和新目录权威。关键新增用例包括：

- 复制 `graph_vault/bookshelves/{bookshelfId}` 到 fresh vault 后，显式
  `--bookshelf-id` 可凭 package-local gate 查询。
- 复制 `graph_vault/library/{libraryId}` 到 fresh vault 后，显式
  `--library-id` 可凭 package-local gate 查询。
- 删除 catalog bookshelf/library projection 不破坏显式上层 package 查询。
- legacy catalog-only 上层产物无 package root 时 fail closed，并返回
  `upper_package_migration_required`。
- 不同规模 library 模拟下固定 top-K 查询预算不随图书数量线性增长。
- 单书 `--graph-book-id` 与单书 hotplug 行为在删除上层 catalog projection 后不回归。

## 非阻塞观察

Type DD 顶层状态仍为 `design_reopened_for_upper_package_layout`，且
`designAudit.currentRunDirectory` 仍指向 `design-turn_011`。这反映当前文件尚未由
主控更新为最终审计通过状态，不影响 D01-D10 的实质合同判定。后续汇总报告可以
在三名 agent 均完成 design-turn_012 审计后统一更新状态。

implementation grounding 段落明确指出 package-root builder、package-root query、
catalog projection from upper packages 等仍是待实现能力。本报告仅判定 Type DD
设计合同是否满足新的上层包目录要求，不判定代码实现已经完成。

## Blocking Findings

无。
