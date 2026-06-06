overallVerdict: PASS_WITH_RISK

# Implementation Turn 007 Agent-3 Audit

固定审计基准：
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`。

唯一规范设计入口：
`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`。

审计对象为书-书架-Library 层级 GraphRAG 索引的修复后发布态
（release state）与运行态（runtime state）。本轮重点复核
implementation-turn_006 agent-3 的 library stale FAIL、三层质量门
（quality gate）完整性、semantic_edges relationType 合规性、单书
hotplug 非回归，以及 D05/D06 的 fail-closed 可信度。

## 发布态快照

- Library `software-engineering-library` 当前 generation 为
  `library-b5e16d8a55a6a930`。
- `CURRENT.json` 指向 `current/LIBRARY_MANIFEST.json`，记录
  `queryReady: true`、`readyState: library_query_ready`，manifest sha256 为
  `422b32192bc518eb018fac46e5af5c9f76b226ff079af83b953904b1a49f339d`。
- `validateLibraryGraph` 返回 `ok: true`、`diagnostics: []`、
  `semanticUnitCount: 8`、`evidenceMapCount: 46`。
- Library membership 引用两个当前书架：
  `delivery-devops-core` 为 `bookshelf-42d5c276a8ad099d`，manifest sha256 为
  `d34b5a89df87f97ad192c149526b3554f192ed28c38b600a47a9ebbd26f178ae`；
  `software-architecture-core` 为 `bookshelf-dab8e0be24c6a06c`，
  manifest sha256 为
  `0f77042b52124756300616e48776d7a9848a02e630f325ed6f8ca0e93b55d00c`。
- 两个书架 `CURRENT.json`、`BOOKSHELF_MANIFEST.json`、质量门与 validator
  一致，`validateBookshelfGraph` 均返回 `ok: true`、`diagnostics: []`、
  `semanticUnitCount: 24`、`evidenceMapCount: 131`。
- Library 固定预算 query smoke 返回 10 条 evidence，选择 3 个上层 report，
  `estimatedInputTokens: 923`，provider `attemptedRequestCount: 0`。
- Bookshelf query smoke 对两个书架均返回 11 条 evidence，provider
  `attemptedRequestCount: 0`。
- `staging` 目录为空；未发现 `running`、`failed` 或 `stale` 目录下可被
  query 误读的发布产物。

implementation-turn_006 agent-3 的核心 FAIL 已修复：library current 不再引用
旧书架 manifest sha256；`CURRENT.json`、`LIBRARY_MANIFEST.json`、
`state/library-quality-gate.json`、validator 与 query-readiness 结果一致。

## D01_authority_boundaries

verdict: PASS

evidence:

- 单书包权威仍来自 `graph_vault/books/{bookId}/BOOK_MANIFEST.json`、
  `PUBLISH_READY.json`、包内 GraphRAG output 与 hotplug gates。
- 代表单书 `book-00474fb29e5e-59d02d41` 与
  `book-356ff4920cdf-0bbd8bdb` 的 published package validator 均返回
  `ok: true`，runtime gate 均返回 `ok: true`、`diagnostics: []`。
- 两个代表单书 manifest 均为 `graphrag.queryReady: true`，且 runtime
  producer run lineage 包含 `graph_extract`、`community_report`、`embed`、
  `query_ready`。
- 对两个代表单书递归抽查，未发现 `BOOKSHELF_MANIFEST.json`、
  `LIBRARY_MANIFEST.json`、`semantic_units.parquet`、
  `semantic_edges.parquet`、`evidence_map.parquet`、
  `library_members.json` 或 `bookshelf_members.json` 写入单书包闭包。
- 上层索引产物位于 `graph_vault/catalog/bookshelves/*/current` 与
  `graph_vault/catalog/library/*/current`，保持可重建派生物边界。

risks:

- 无发布阻塞风险。上层 catalog 可用性不参与单书包 query-ready 判定。

requiredFixes:

- 无。

## D02_fixed_query_budget

verdict: PASS_WITH_RISK

evidence:

- Library manifest 记录 `maxSemanticUnits: 32`、
  `maxBookshelvesForDeepening: 3`、`maxShelfCommunityRefs: 24`、
  `maxInputTokens: 64000`，质量门 fixed-budget simulation 为 `passed`。
- 两个 bookshelf manifest 均记录 `maxSemanticUnits: 32`、
  `maxBooksForDeepening: 3`、`maxMemberCommunityRefs: 24`、
  `maxInputTokens: 64000`，质量门 fixed-budget simulation 为 `passed`。
- Library query smoke 只消费 3 个上层 community reports，估算输入 token 为
  923，LLM 调用数为 0。
- 两个 bookshelf query smoke 均只消费 4 个上层 community reports，估算输入
  token 分别为 1184 与 1185，LLM 调用数为 0。
- Query path 使用已发布 upper community reports，不扫描所有单书
  `community_reports.parquet`。

risks:

- 当前 query bridge 仍先读取已发布 upper reports 再裁剪候选；这不是单书全量
  扫描，但 upper report 数很大时 CPU 与 I/O 成本仍可能增长。
- 本轮未发现或运行 10、100、1000 本规模的固定预算回归测试。

requiredFixes:

- 补充多规模 fixed-budget regression（固定预算回归）测试，至少覆盖
  Type DD 要求的 10、100、1000 本模拟。
- 当 upper report 规模增长时，引入索引级候选裁剪或向量召回前置。

## D03_graphrag_semantic_alignment

verdict: PASS_WITH_RISK

evidence:

- Bookshelf semantic units 来源为成员书 community reports；library semantic
  units 来源为 bookshelf community reports。
- 三层 query 均基于预计算 community reports 与 evidence map 返回结果，
  未退化为普通摘要文本的无证据检索。
- semantic_edges 抽查结果：
  `software-architecture-core` 为 `bookshelf_membership`、
  `co_clustered_topic`；`delivery-devops-core` 为
  `bookshelf_membership`、`co_clustered_topic`；
  `software-engineering-library` 为 `library_membership`、
  `co_clustered_topic`。
- 上述 relationType 均属于 Type DD `allowedRelationTypes`：`shared_entity`、
  `source_relationship`、`co_clustered_topic`、
  `parent_child_community`、`bookshelf_membership`、`library_membership`。
- 未发现 implementation-turn_006 关注的 `library_same_shelf` 或
  `cross_shelf_topic`。

risks:

- 当前边语义主要是 membership 与 topic co-clustering，`shared_entity` 与
  `source_relationship` 覆盖仍偏弱。
- 若后续需要更强 GraphRAG relationship 语义，上层 edge 生成应增加
  `sourceRelationshipIds` 的真实关系证据密度。

requiredFixes:

- 无发布阻塞修复。
- 后续增强 `shared_entity` 与 `source_relationship` 生成，并把 relationship
  evidence 纳入质量门抽样。

## D04_evidence_traceability

verdict: PASS

evidence:

- Library `evidence_map.parquet` 行数为 46，包含 Type DD 要求的
  `targetBookId`、`targetBookshelfId`、`targetSourceId`、
  `targetDocumentId`、`targetContentHash`、`targetCommunityReportId`、
  `targetTextUnitId`、`targetArtifactDigest`。
- 两个 bookshelf `evidence_map.parquet` 行数均为 131，样本均可回链到
  book、source、document、content hash、community report 与 text unit。
- Library evidence 样本包含 `ownerLevel: library`、
  `ownerId: software-engineering-library`、`targetBookshelfId:
  delivery-devops-core`、`targetBookId: book-4b123cabe204-4df8bccf` 与
  `targetTextUnitId`。
- Library query smoke 返回的首条 evidence 暴露 `bookId`、`sourceId`、
  `documentId`、`contentHash`、`graphTextUnitId`、`artifactId`，
  metadata 包含 library generation 与 target bookshelf。

risks:

- 无发布阻塞风险。当前证据回链覆盖书架与 library 两层查询输出。

requiredFixes:

- 无。

## D05_state_recovery

verdict: PASS_WITH_RISK

evidence:

- 三个 current run 均包含 `events.jsonl`、`status.json`、
  `recovery-summary.json` 与 checkpoints。
- Current run 状态均为 `status: passed`、`queryReady: true`，并记录
  `currentGenerationPublished: true`、`recoveryDecision: not_required`。
- 事件流均从 build started 的 `running` 事件结束于 published 的 `passed`
  事件，未保留 running/failed/stale 产物作为 current。
- `staging` 目录存在但为空；未发现 `running`、`failed`、`stale` 目录下
  可被 query path 读取的发布文件。
- Bookshelf 与 library 构建代码在 `stagingRoot` 运行 validator，通过后才
  rename 到 `current` 并写 `CURRENT.json`。
- Library validator 会重新计算成员 bookshelf manifest sha256；query path
  进入查询前调用 validator，stale 诊断会映射为 `upper_index_stale`。
- 本次修复已通过生成新 library generation 解决成员书架 sha256 变化后的
  stale current 问题。

risks:

- 当前快照已闭环，但本轮未验证成员书架再次变化时是否会自动写入 durable
  stale marker 或自动入 rebuild queue。
- 若外部工具只读静态 `CURRENT.json` 而不调用 validator，未来成员变化后的
  stale 传播仍依赖发布流程和查询前校验共同保障。

requiredFixes:

- 无当前发布阻塞修复。
- 后续补强成员变化后的 stale propagation（过期传播）自动化测试，要求
  durable stale marker 或新 generation 至少一种机制被验证。

## D06_quality_gates

verdict: PASS

evidence:

- 三层 graph quality gate 均包含
  `semantic_edges_relation_types_allowed`。
- 两个 bookshelf gate 的实际 checkId 集合与实现侧
  `BookshelfGraphChecks` 完全一致，缺失集合为空。
- Library gate 的实际 checkId 集合与实现侧 `LibraryGraphChecks` 完全一致，
  缺失集合为空。
- Library gate 包含并通过：
  `member_bookshelf_manifest_sha256_matches`、
  `member_bookshelf_gates_passed`、`library_membership_gate_passed`、
  `semantic_units_schema_valid`、`semantic_edges_schema_valid`、
  `semantic_edges_relation_types_allowed`、
  `evidence_map_links_shelf_and_book_evidence`、
  `fixed_query_budget_simulation_passed`、`sensitive_payload_scan_passed`、
  `stale_marker_absent`。
- Validator 不是只信任 `status: passed`：它会校验 manifest/gate schema、
  checksum sidecars、manifest file closure、parquet required columns、
  evidence map row count、成员 manifest sha256，以及 required check 是否存在。
- 当前 `validateLibraryGraph` 返回 `ok: true`，不再出现
  `member_bookshelf_manifest_stale:*`。

risks:

- 无发布阻塞风险。质量门已满足“不得只声明 passed 而缺少 required check”
  的本轮要求。

requiredFixes:

- 无。

## D07_incremental_scaling

verdict: PASS_WITH_RISK

evidence:

- Bookshelf manifest 记录成员 `manifestSha256`、`packageGeneration`、
  membership generation、成员数量、构建配置和 fixed budget。
- Library manifest 记录成员 bookshelf manifest sha256、bookshelf generation、
  membership generation、partition plan digest、成员书架数量与 fixed budget。
- Library generation `library-b5e16d8a55a6a930` 基于两个当前书架 sha256
  生成，证明本轮修复已按成员变化刷新上层 generation。
- 层级结构把大库影响范围限制在 bookshelf 与 library 派生层，不修改单书包。

risks:

- 当前实现更接近 conservative rebuild（保守重建）；未见完整 incremental
  refresh planner 或大库分区压力测试结果。
- 自动依赖图传播、队列化 rebuild 与多分区 library 的运行态证据仍不足。

requiredFixes:

- 补充依赖图驱动的 stale propagation 或 rebuild queue 证据。
- 增加大库分层、成员变更影响范围和 partition boundary 的回归测试。

## D08_security_privacy

verdict: PASS_WITH_RISK

evidence:

- Upper manifest 与 membership manifest 均声明 `sensitivityPolicy`，禁止
  `providerRequestPayload`、`providerResponsePayload`、`rawPrompt`、
  `rawCompletion`、`apiKey`、`credential`、`absoluteLocalPath`、
  `queryLogContent`。
- 对当前两个 bookshelf 与 library 的 JSON/JSONL/parquet 文本列做敏感字段
  抽查，排除 sensitivity policy 声明后，未发现上述字段、`OPENAI_API_KEY`
  或 `/Users/jin` 泄露。
- `assertNoForbiddenText` 会在写出 upper graph manifest 和 quality gate 前
  执行敏感字段检查。
- Graph-vault locator 使用相对路径或 scope-relative 路径，未在 upper
  evidence/query 输出中暴露用户绝对路径。

risks:

- 实现侧敏感扫描对 parquet 与所有 membership JSON/JSONL 的闭包覆盖仍需
  长期保持；本轮使用额外抽查确认当前快照无泄露。
- 扫描器必须持续区分 policy declaration（策略声明）与真实 payload 泄露，
  避免误报或漏报。

requiredFixes:

- 无当前发布阻塞修复。
- 后续把闭包级敏感扫描纳入正式 gate 或 CI，并保留 policy declaration
  allowlist。

## D09_cli_operability

verdict: PASS

evidence:

- CLI scope 解析支持 `--graph-book-id`、`--bookshelf-id`、`--library-id`，
  并对缺失或冲突 scope 返回 typed error。
- `resolveUpperTypedQueryErrorDetails` 明确映射 `upper_index_missing`、
  `upper_index_stale`、`upper_quality_gate_failed`、
  `budget_exceeded_narrow_scope_required` 与 `upper_index_runtime_error`，
  并给出 exit code、retryability、remediation command 与 timing 标记。
- Bookshelf 与 library query path 在读取能力和执行 query 前均调用 validator；
  stale 或 gate failure 不会进入普通 ready 查询。
- Query smoke 的 runtime metrics 分层记录
  `library.fixed_budget_report_search` 或
  `bookshelf.fixed_budget_report_search`，并记录 token 估算与 provider
  aggregate。

risks:

- 未在本轮直接执行 CLI 端 stale/missing/budget typed error fixture；
  证据来自源码路径、现有测试定位与 query smoke。

requiredFixes:

- 无当前发布阻塞修复。
- 建议在 CI 中持续运行 CLI typed error fixtures，尤其是 stale 与
  budget-exceeded 场景。

## D10_testability

verdict: PASS_WITH_RISK

evidence:

- Type DD 定义的必测案例超过 8 个，覆盖单书 hotplug 非回归、固定预算、
  stale refusal、missing upper index、quality gate、evidence map、敏感扫描、
  interrupted build 与 CLI typed errors。
- 本轮运行：
  `npm run test:node -- test/graphrag-bookshelf-graph.test.ts
  test/graphrag-library-graph.test.ts`，结果为 2 个 test files、2 个 tests
  全部通过。
- 通过的 bookshelf/library graph 测试覆盖 query-ready 发布、
  `semantic_edges_relation_types_allowed` gate、缺失 required check 负例与
  固定预算 query smoke。
- 现有 hotplug 相关测试覆盖 creation gate、catalog projection、refresh
  existing、runtime gate、package validator 与 package closure 非回归。
- 单书代表样本在本轮只读 validator 中确认 quality/runtime gate 均 `ok: true`。

risks:

- 本轮未运行全量测试套件。
- 未发现已运行的 10、100、1000 本多规模 fixed-budget regression 测试；
  该项仍是 D02/D10 的主要残余风险。
- Stale 自动传播、durable stale marker 与大库 partition 压力测试证据仍偏少。

requiredFixes:

- 补充并持续运行 10、100、1000 本固定预算模拟测试。
- 将 stale propagation、missing upper index、budget exceeded、interrupted
  promote repair、sensitive closure scan 纳入稳定 CI 子集。

## 验证记录

- `validateLibraryGraph({ libraryId: "software-engineering-library" })`：
  `ok: true`、`diagnostics: []`、`semanticUnitCount: 8`、
  `evidenceMapCount: 46`。
- `validateBookshelfGraph` 对 `software-architecture-core` 与
  `delivery-devops-core` 均返回 `ok: true`、`diagnostics: []`、
  `semanticUnitCount: 24`、`evidenceMapCount: 131`。
- Library fixed-budget query smoke：10 条 evidence，3 个 selected reports，
  `estimatedInputTokens: 923`，provider attempted request count 为 0。
- Bookshelf fixed-budget query smoke：两个书架均返回 11 条 evidence，
  provider attempted request count 为 0。
- Parquet 抽查确认三层 `semantic_edges.parquet` 未包含
  `library_same_shelf` 或 `cross_shelf_topic`。
- 目标测试命令通过：`npm run test:node --
  test/graphrag-bookshelf-graph.test.ts test/graphrag-library-graph.test.ts`。
