overallVerdict: FAIL

# Implementation Turn 006 Agent-3 Audit

固定审计基准为
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`。
唯一规范设计入口为
`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`。

本工作区未存在 `graph_vault/catalog/current` 目录。审计按实际发布布局检查：
`graph_vault/catalog/bookshelves/{bookshelfId}/current` 与
`graph_vault/catalog/library/{libraryId}/current`。

上一轮 implementation-turn_005 agent-3 的核心 FAIL 已部分收敛：当前
library `semantic_edges.parquet` 不再包含 `library_same_shelf` 或
`cross_shelf_topic`，质量门和测试也已加入
`semantic_edges_relation_types_allowed`。但最终快照中两个 bookshelf current
在 `2026-06-06T12:51` 左右重新发布，library current 仍引用旧 bookshelf
manifest sha256。`validateLibraryGraph` 返回
`member_bookshelf_manifest_stale:*`，`queryLibraryGraph` fail-closed 返回
`upper_index_stale`，而 `LIBRARY_MANIFEST.json`、`CURRENT.json` 与
`state/library-quality-gate.json` 仍声明 `queryReady: true`、`status:
passed`。因此发布态质量门可信度不满足本轮要求。

## D01_authority_boundaries

verdict: PASS

evidence:

- 单书包权威仍来自 `graph_vault/books/{bookId}/BOOK_MANIFEST.json`、
  `PUBLISH_READY.json` 和 `state/hotplug-quality-gate.json`。
- 抽样 `book-356ff4920cdf-0bbd8bdb` 与
  `book-00474fb29e5e-59d02d41` 均为 `graphrag.queryReady: true`，
  hotplug gate `status: passed`、`queryReady: true`。
- 对上述单书包执行 upper artifact 抽查，未发现
  `BOOKSHELF_MANIFEST.json`、`LIBRARY_MANIFEST.json`、
  `semantic_units.parquet`、`semantic_edges.parquet` 或
  `evidence_map.parquet` 写入单书包闭包。
- `src/cli/qmd.ts` 中 `--graph-book-id` 路径仍解析单书 GraphRAG data dir，
  并调用 `cli.invoke_graphrag_runtime`，未被 upper index 替代。

risks:

- 无阻塞风险。library stale 只影响上层派生索引，不改变单书包 query-ready
  判定。

requiredFixes:

- 无。

## D02_fixed_query_budget

verdict: PASS_WITH_RISK

evidence:

- Bookshelf manifest 记录 `maxSemanticUnits: 32`、
  `maxBooksForDeepening: 3`、`maxMemberCommunityRefs: 24`、
  `maxInputTokens: 64000`，quality gate 固定预算模拟通过。
- Library manifest 记录 `maxSemanticUnits: 32`、
  `maxBookshelvesForDeepening: 3`、`maxShelfCommunityRefs: 24`、
  `maxInputTokens: 64000`。
- Bookshelf query smoke 对 `delivery-devops-core` 返回 11 条 evidence，
  provider attempted request count 为 0，说明当前路径是固定预算 report
  search，不触发 LLM 调用。
- Library query 当前因 stale fail-closed，不会退化为全库扫描。

risks:

- 上层查询 bridge 仍会读取当前 upper `community_reports.parquet` 后再裁剪
  top-K；这不扫描所有单书报告，但 CPU 成本会随已发布 upper report 数增长。
- 未发现 10、100、1000 本级别的固定预算规模回归测试。

requiredFixes:

- 补充多规模 fixed-budget regression（固定预算回归）测试。
- 在 upper report 数继续增长时，引入索引级候选裁剪或向量召回前置。

## D03_graphrag_semantic_alignment

verdict: PASS_WITH_RISK

evidence:

- 两个 bookshelf current 的 `semantic_units.parquet` 均以
  `sourceKind: book_community_report` 消费成员书 community reports。
- Library current 的 `semantic_units.parquet` 以
  `sourceKind: bookshelf_community_report` 消费书架 community reports。
- 当前 relationType 抽查结果为：
  `bookshelf_membership`、`co_clustered_topic`、`library_membership`，
  均属于 Type DD 允许枚举。
- Targeted test `test/graphrag-library-graph.test.ts` 覆盖
  `cross_shelf_topic` 注入负例，并断言 validator 返回
  `disallowed_relation_type:semantic_edges.parquet:cross_shelf_topic`。

risks:

- 当前 edge 语义主要表现为 membership 与 topic co-clustering，
  `sourceRelationshipIds` 仍偏弱；与完整 GraphRAG entity/relationship
  语义相比仍是保守实现。
- Library current stale 导致 library 语义产物不能作为 query-ready 产物消费。

requiredFixes:

- 重建 stale library current，使其引用最新 bookshelf manifest sha256。
- 后续增强 `shared_entity` 与 `source_relationship` 生成，并保留可追溯
  relationship evidence。

## D04_evidence_traceability

verdict: PASS

evidence:

- Bookshelf 与 library `evidence_map.parquet` 均包含 Type DD 要求列：
  `targetBookId`、`targetBookshelfId`、`targetSourceId`、
  `targetDocumentId`、`targetContentHash`、`targetCommunityReportId`、
  `targetTextUnitId`、`targetArtifactDigest`。
- Bookshelf evidence 抽样能回链到 book、source、document、content hash、
  community report 与 text unit。
- Library evidence 抽样包含 `ownerLevel: library`、
  `targetBookshelfId: delivery-devops-core`、`targetBookId`、`targetSourceId`、
  `targetDocumentId`、`targetContentHash` 与 `targetTextUnitId`。
- Bookshelf query smoke 返回的首条 evidence 暴露 `bookId`、`sourceId`、
  `documentId`、`contentHash` 与 `metadata.scopeKind: bookshelf`。

risks:

- Library stale 期间 evidence lineage 只能作为历史产物检查，不能作为
  query-ready library 回答依据。

requiredFixes:

- 重建 library 后重新抽查 library query evidence metadata。

## D05_state_recovery

verdict: PASS_WITH_RISK

evidence:

- Bookshelf 与 library current 均包含 `runs/{runId}/events.jsonl`、
  `status.json`、`recovery-summary.json` 与 checkpoints。
- 发布采用 `staging/{generation}` 到 `current` 的提升模式，并写入
  `CURRENT.json`。
- 当前 stale 场景中，validator 和 query path 能根据成员 manifest sha256
  发现 library 过期，并返回 `upper_index_stale`。

risks:

- 成员 bookshelf 重新发布后，library 未自动生成新 generation，也未写入
  durable stale marker；只有查询或 validator 动态发现 stale。
- `CURRENT.json` 与 manifest 仍声明 query-ready，状态闭环没有把 stale
  传播回发布态 marker。

requiredFixes:

- 当成员 bookshelf manifest sha256 变化时，生成 library 新 generation，
  或写入 durable stale marker 并撤销 current query-ready 声明。
- 增加 interrupted promote repair 与 stale propagation（过期传播）测试。

## D06_quality_gates

verdict: FAIL

evidence:

- 当前 bookshelf gates 已包含 `semantic_edges_relation_types_allowed`，
  `validateBookshelfGraph` 对 `delivery-devops-core` 与
  `software-architecture-core` 返回 `ok: true`。
- 当前 library gate 也包含 `semantic_edges_relation_types_allowed`，且
  `semantic_edges.parquet` relationType 抽查均在允许集合内。
- 但是 library manifest 记录的成员 bookshelf sha256 为
  `620f1637...` 与 `c547a05b...`，而当前两个 bookshelf manifest 实际 sha256
  为 `d34b5a89...` 与 `0f77042b...`。
- `validateLibraryGraph` 返回 `ok: false`，diagnostics 为
  `member_bookshelf_manifest_stale:delivery-devops-core` 与
  `member_bookshelf_manifest_stale:software-architecture-core`。
- `graph_vault/catalog/library/software-engineering-library/CURRENT.json`、
  `LIBRARY_MANIFEST.json` 与 `state/library-quality-gate.json` 仍声明
  `readyState: library_query_ready`、`queryReady: true`、`status: passed`。

risks:

- 发布态 gate 与真实 readiness 不一致，会误导任何只读取 `CURRENT.json`、
  manifest 或 gate 的上游工具。
- Query path 能 fail-closed，但质量门本身不是可信的 current truth
  source（当前事实源）。

requiredFixes:

- 立即重建 `software-engineering-library` library graph，使
  `memberBookshelfManifestSha256` 与当前 bookshelf manifest sha256 一致。
- 发布 library 前必须重新运行 member bookshelf freshness validation；失败时
  不得写出或保留 `queryReady: true` 的 `CURRENT.json`、manifest 或 gate。
- 在成员 bookshelf current 变化时，自动标记依赖 library stale，或触发
  conservative rebuild。

## D07_incremental_scaling

verdict: PASS_WITH_RISK

evidence:

- Bookshelf manifest 记录成员 `manifestSha256`、membership generation、
  build config 与 fixed budget。
- Library manifest 记录成员 bookshelf manifest sha256、membership
  generation、partition plan digest 与 fixed budget。
- Library stale 能由 sha256 比对发现，说明增量刷新边界有基础输入记录。

risks:

- 当前实际状态证明 stale propagation 未闭环：bookshelf current 已更新，
  library current 未同步重建或标记 stale。
- 当前实现仍偏 conservative rebuild；未看到完整 incremental refresh planner
  或大库分区压力测试。

requiredFixes:

- 实现依赖图驱动的 stale propagation 或 rebuild queue。
- 补充大库分层、成员变更影响范围和分区边界测试。

## D08_security_privacy

verdict: PASS_WITH_RISK

evidence:

- Manifest 中声明 `sensitivityPolicy.forbiddenFields`，文件 locator 采用
  scope-relative 或 graph-vault-relative 形式。
- 对当前 upper JSON/JSONL 执行敏感字段抽查，命中项均为 manifest 中的
  forbidden field 策略声明，不是 provider payload。
- 对当前 upper parquet 字符串列抽查，未发现 `/Users/jin`、
  `providerRequestPayload`、`providerResponsePayload`、`rawPrompt`、
  `rawCompletion`、`apiKey`、`credential`、`absoluteLocalPath`、
  `queryLogContent` 或 `OPENAI_API_KEY`。

risks:

- 构建代码中的 `assertNoForbiddenText` 主要覆盖 manifest 与 gate 文本；
  parquet、membership json/jsonl 与 diagnostics 的全闭包敏感扫描仍偏弱。
- Naive grep 会命中 sensitivity policy 自身字段名，需要扫描器区分 policy
  declaration 与 leaked payload。

requiredFixes:

- 将 sensitive payload scan 扩展到 manifest file closure 中的 JSON、JSONL
  与 parquet 文本列。
- 为 policy declaration 增加 allowlist，避免误报同时保持泄露检测有效。

## D09_cli_operability

verdict: PASS_WITH_RISK

evidence:

- `src/cli/qmd.ts` 明确互斥 `--graph-book-id`、`--bookshelf-id` 与
  `--library-id`，冲突时返回 `ambiguous_scope` typed error。
- `src/cli/graphrag-query-scope.ts` 将 `upper_index_missing`、
  `upper_index_stale`、`upper_quality_gate_failed` 与
  `budget_exceeded_narrow_scope_required` 映射到稳定 exit code 和修复命令。
- Library query smoke 在当前 stale 状态返回
  `LibraryQueryScopeError.code: upper_index_stale`，没有长时间全库扫描。
- Bookshelf query smoke 能返回固定预算 answer/evidence，provider attempted
  request count 为 0。

risks:

- Library `CURRENT.json`/manifest/gate 仍宣称 query-ready，但真实查询返回
  stale；用户体验会表现为 catalog 状态与查询结果矛盾。
- 本轮未运行完整 CLI 端到端命令以观察最终 JSON typed error 形态，仅检查
  query layer 与 CLI 映射代码。

requiredFixes:

- 修复 library current stale 后补跑 `qmd query --library-id ... --json`
  smoke，确认 typed error 或 query result 与 catalog readiness 一致。
- 在 status/list 类命令中优先使用 validator 结果，而不是只信任 manifest
  `queryReady` 字段。

## D10_testability

verdict: PASS_WITH_RISK

evidence:

- 已运行 targeted tests：
  `test/graphrag-library-graph.test.ts`、
  `test/graphrag-bookshelf-graph.test.ts`、
  `test/cli-graphrag-query-scope.test.ts`，共 3 个文件 8 个用例通过。
- 测试覆盖 library relationType allowed set、disallowed relation type 负例、
  缺失 `semantic_edges_relation_types_allowed` gate check 负例、bookshelf
  query evidence、library query evidence、scope method 默认值和 upper typed
  error 映射。
- 现有 hotplug tests 覆盖单书包 gate、runtime report 排除、stale sidecar、
  provider payload 拒绝与 `--graph-book-id` scope 非回归。

risks:

- 未发现不同规模库的固定预算验证测试。
- 未发现“成员 bookshelf 重建后 library current 必须 stale 或自动重建”的
  端到端回归测试；本轮真实 current 正暴露该缺口。

requiredFixes:

- 增加 dependency stale propagation 测试：重建 bookshelf 后，library
  `CURRENT.json`/manifest/gate 不得继续声明 query-ready，除非 library 已重建。
- 增加 10、100、1000 本级别固定预算模拟测试，并断言查询阶段 LLM 调用数、
  selected semantic units 与 selected bookshelves 不随书籍总数线性增长。
