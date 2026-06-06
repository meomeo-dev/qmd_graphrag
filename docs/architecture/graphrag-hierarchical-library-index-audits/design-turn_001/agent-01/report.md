# GraphRAG 层级 Library 索引设计审计报告

审计对象：`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
固定基准：`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
审计轮次：`design-turn_001`
审计 agent：`agent-01`
总体结论：pass

判定规则：逐项使用固定基准 D01-D10。任一维度为 `fail` 时总体为
`fail`；本轮未发现 `fail` 项。

## D01_authority_boundaries：权威边界与热插包隔离

status: pass

证据：
- `scope.excluded` 明确排除把书架或 library 索引写入单书可复制包文件闭包，
  并排除以全局 catalog 替代单书 `BOOK_MANIFEST.json` 的包权威。
- `hardInvariants.book_package_authority_preserved` 规定单书包权威只能来自
  单书包内 manifest、publish-ready、qmd/GraphRAG/state 产物和质量门，
  书架与 library 索引不得改变单书包身份、文件闭包或 `query_ready` 判定。
- `hardInvariants.derived_upper_indexes_only` 规定书架与 library 索引是可重建
  派生物，缺失、损坏或过期不得使有效单书包变成 `not_query_ready`。
- `compatibilityWithHotplugPackages` 规定安装或删除单书包不会自动 mutate 已就绪
  的书架或 library generation，单书查询仍由单书包质量门治理。

问题：
- 未发现阻断性问题。

建议修订：
- 可在后续 schema 合同中把“catalog 不写入单书闭包”的约束转换为文件路径
  allowlist/denylist，以便质量门自动验证。

## D02_fixed_query_budget：固定查询预算

status: pass

证据：
- `terms.fixedQueryBudget` 定义最大 LLM 调用数、输入 token、输出 token、候选
  语义单元数、下钻书本数和执行时间，且不得随书籍总量线性增长。
- `hardInvariants.fixed_interactive_query_cost` 禁止把全部成员书
  `community_reports` 作为 prompt 输入，也禁止按成员书数量创建不受限 map 调用。
- `queryContract.interactiveBudget.default` 设置固定预算参数，包括
  `maxSemanticUnits: 32`、`maxBookshelves: 4`、`maxBooksForDeepening: 3`、
  `maxMemberCommunityRefs: 24`、`maxLlmCalls.synthesize: 1`、
  `maxLlmCalls.optionalDeepening: 3`、`maxInputTokens: 64000`。
- `queryContract.interactiveBudget.rule` 规定证据不能放入 active budget 时必须
  fail closed 或要求收窄 scope。
- `queryContract.retrieval` 的 first stage 与 second stage 均受固定预算字段约束。
- `queryContract.modes.exhaustive_report` 将可全量扫描的报告模式限定为后台任务，
  明确不是交互查询路径。

问题：

- 未发现阻断性问题。

建议修订：

- 可补充预算耗尽时的 typed error 名称和返回字段，例如
  `budget_exceeded_narrow_scope_required`，使 CLI 与测试合同更直接对齐。

## D03_graphrag_semantic_alignment：GraphRAG 语义对齐

status: pass

证据：

- `scope.included` 明确基于单书 GraphRAG `community_reports`、`entities`、
  `relationships` 与 qmd 索引派生上层索引。
- `hierarchyModel.levels.book.sourceInputs` 包含 `community_reports.parquet`、
  `entities.parquet`、`relationships.parquet` 和 `text_units.parquet`。
- `bookshelfContract.buildInputs.graphInputs` 包含 community report title、summary、
  rank、level、size，entity titles/descriptions，以及 relationship summaries，
  用于跨书主题对齐。
- `bookshelfContract.buildAlgorithm.steps` 规定从 `community_reports` 抽取语义单元、
  聚类成书架 communities，并用 map-reduce 或等价机制生成书架 community
  reports。
- `libraryContract.buildAlgorithm.steps` 规定消费书架 semantic units 与 community
  reports，聚类成 library-level communities，并生成 library-level community
  reports。
- `queryContract.synthesis.rule` 规定最终回答来自选中的上层 community reports 与
  可选单书下钻证据。

问题：

- 未发现阻断性问题。

建议修订：

- `openDecisions.clustering_algorithm` 仍保留聚类算法选择。建议在进入实现前固定
  GraphRAG community detection、embedding clustering 或 hybrid 的最小合同，
  避免实现阶段退化为普通摘要向量检索。

## D04_evidence_traceability：证据可追溯

status: pass

证据：

- `hardInvariants.evidence_traceability` 规定上层回答中的每个证据必须能回链到
  `bookId`、`sourceId`、`documentId`、`contentHash`、单书 community report id
  或 text unit id。
- 书架与 library 层级输出均包含 `evidence_map.parquet`。
- `bookshelfContract.buildAlgorithm.steps` 规定从书架 reports 写入
  `evidence_map`，回链到成员 reports 与 books。
- `libraryContract.buildAlgorithm.steps` 规定从 library reports 写入
  `evidence_map`，回链到 shelf reports 与 book reports。
- `queryContract.synthesis.rule` 规定最终回答必须包含可追溯 evidence ids，并标明
  scoped 或 non-exhaustive 结果。
- `qualityGates` 要求书架 `evidence_map.parquet` 将每个上层 unit 链接到成员证据，
  library `evidence_map.parquet` 将每个 unit 链接到 shelf 与 book evidence。

问题：

- 未发现阻断性问题。

建议修订：

- 可增加 `evidence_map.parquet` 的列级 schema，例如 source level、target type、
  evidence id、content hash、rank、generation，以减少实现歧义。

## D05_state_recovery：状态闭环与恢复

status: pass

证据：

- `hardInvariants.build_cost_may_scale` 要求构建和刷新具备状态闭环、断点恢复、
  增量刷新、质量门和可观测成本记录。
- `stateAndRecovery.ledgerRoots` 为 bookshelf 与 library 构建定义 run ledger 根。
- `stateAndRecovery.durableState` 定义 `manifest.json`、`status.json`、
  `events.jsonl`、`checkpoints/{unitId}.json` 和 `recovery-summary.json`。
- `stateAndRecovery.recoveryRules` 规定构建完成需要 checkpoint、manifest、
  quality gate 和 publish marker；失败的语义单元生成不得发布 ready 上层索引；
  中断构建从已验证 checkpoint 恢复。
- `stateAndRecovery.recoveryRules` 与 `compatibilityWithHotplugPackages.staleBehavior`
  规定成员 manifest stale 时，上层索引在查询前标记 stale，并默认拒绝 stale
  上层查询。
- 书架和 library build steps 均以原子发布 manifest 与质量门作为完成条件。

问题：

- 未发现阻断性问题。

建议修订：

- 可补充 partial publish 的文件级原子性协议，例如 staging 目录、publish marker
  顺序和 checksum sidecar 写入顺序。

## D06_quality_gates：质量门

status: pass

证据：

- `qualityGates.bookshelfGate` 定义独立书架质量门路径和 `requiredChecks`。
- `qualityGates.libraryGate` 定义独立 library 质量门路径和 `requiredChecks`。
- 两个质量门均覆盖 manifest schema、checksum sidecars、成员 manifest sha256
  一致性、成员质量门、semantic units schema、community reports schema、
  evidence map、embedding/vector 元数据、固定预算模拟、敏感 payload 扫描与
  stale marker absence。
- `stateAndRecovery.recoveryRules` 要求构建完成必须具备 quality gate 与 publish
  marker，失败构建不得发布 ready 上层索引。
- `compatibilityWithHotplugPackages.staleBehavior` 规定 stale 上层索引表现为
  `stale_not_query_ready`，默认查询拒绝 stale 上层索引并提供 rebuild/status
  命令。

问题：

- 未发现阻断性问题。

建议修订：

- 可明确质量门失败诊断文件的最小字段，例如 failed check id、severity、
  affected artifact digest 和 suggested command。

## D07_incremental_scaling：增量扩展

status: pass

证据：

- `hardInvariants.stable_membership_generation` 要求记录成员集合、成员 manifest
  sha256、`packageGeneration`、构建配置和索引 schema，成员变化必须生成新
  generation 或标记 stale。
- `bookshelfContract.membership.explicitMembers.requiredFields` 包含 `bookId`、
  `manifestSha256`、`packageGeneration`、`queryReady`、`qmdReadyState` 和
  `graphRagReadyState`。
- `bookshelfContract.identity.generationRule` 规定成员集合、成员 manifest sha256、
  builder version、embedding model fingerprint、clustering config、summary config
  或 evidence schema 变化时改变 `bookshelfGeneration`。
- `libraryContract.identity.generationRule` 规定 shelf membership、shelf manifest
  sha256、builder/config/schema 变化时改变 `libraryGeneration`。
- `bookshelfContract.buildAlgorithm.incrementalRefresh.rule` 允许只重建受影响语义单元
  与派生 communities；无法用 checksum 证明未变时保守重建 shelf generation。
- `libraryContract.membership.directBookRule` 要求大库通过 bookshelves 分组，以保持
  层级可理解和可刷新。
- `implementationPlan.phase3` 包含 incremental rebuild checkpoints 与 stale index
  repair workflow。

问题：

- 未发现阻断性问题。

建议修订：

- 可补充 library 级增量刷新规则，与 bookshelf 级 `incrementalRefresh` 对称，
  明确 shelf 变化时只重建受影响的 library communities 或保守重建 library
  generation。

## D08_security_privacy：安全与隐私

status: pass_with_minor_notes

证据：

- `hardInvariants.no_sensitive_payload_export` 禁止书架/library manifest、索引、质量门
  和诊断包含 provider payload、原始 prompt、原始 completion、密钥、用户绝对路径
  或运行期 `query.log`。
- `bookshelfContract.buildInputs.forbiddenInputs` 禁止 provider request/response
  payloads、query logs、local absolute paths 和 unvalidated damaged book packages。
- `qualityGates` 的书架与 library 质量门均包含 sensitive payload scan。
- `manifestSchemas` 的书架和 library manifest 均要求包含 `sensitivityPolicy`。
- `stateAndRecovery.recoveryRules` 规定 repair operations 写入 bounded diagnostics，
  且不得 mutate book packages。

问题：

- 基准要求“诊断和 manifest 使用脱敏摘要或 digest”。当前设计明确禁止敏感内容进入
  manifest、索引、质量门和诊断，但尚未明确诊断中可记录字段必须采用 redacted
  summary 或 digest 形式。

建议修订：

- 在 `manifestSchemas` 或 `stateAndRecovery` 中补充 `diagnosticRedactionPolicy`，
  明确 manifest 与 diagnostics 只能记录 artifact digest、成员 id、check id、
  bounded summary 和 redacted path label，不记录绝对路径、原始请求、原始响应、
  prompt、completion、密钥或 query log 内容。

## D09_cli_operability：CLI 可操作性与降级

status: pass_with_minor_notes

证据：

- `hardInvariants.bounded_degradation` 规定上层索引不可用时 CLI 必须快速返回 typed
  error、回退到单书或 qmd 检索建议，或要求明确 scope，且不得长时间全库扫描后才
  失败。
- `queryContract.routing.scopeResolutionOrder` 定义解析顺序：显式 `bookId`、显式
  `bookshelfId`、显式 `libraryId`、配置默认 library、带候选项的快速 ambiguity
  error。
- `queryContract.routing.noImplicitFullVaultScan` 规定无显式 scope 时只能读取 current
  projection manifest 或 default scope pointer，不得在查询路径中 rebuild 全部书、
  书架或 library 索引。
- `queryContract.interactiveBudget.rule` 规定预算不足时 fail closed 或要求收窄 scope。
- `compatibilityWithHotplugPackages.staleBehavior` 规定 stale 上层索引对上层查询显示为
  `stale_not_query_ready`，默认拒绝并提供 rebuild/status 命令。
- `implementationPlan.phase2` 包含按层级阶段记录 timing 与 cost accounting。
- `testContracts.requiredCases` 包含 query timing reports retrieval、synthesis、
  optional deepening 和 evidence merge。

问题：

- 基准要求覆盖无 scope、有 scope、stale、缺索引、超预算等 CLI 行为。当前设计覆盖
  scope resolution、stale 与超预算，但“缺索引”的 typed error 名称、诊断字段和降级
  建议尚未单独列出。

建议修订：

- 增加 CLI error taxonomy，例如 `upper_index_missing`、`upper_index_stale`、
  `scope_ambiguous`、`budget_exceeded`，并为每类错误定义 exit code、用户可见建议、
  status command 和是否允许单书 fallback。

## D10_testability：可测试性

status: pass

证据：

- `testContracts.requiredCases` 定义 10 个必测案例，超过基准要求的至少 8 个。
- 测试覆盖固定预算规模验证：10、100 和 1000 本书模拟时，library 查询使用固定
  top-K。
- 测试覆盖单书 hotplug 非回归：catalog 上层索引删除后单书查询仍成功，删除一本书
  仅标记依赖 shelf/library stale 且不 mutate book。
- 测试覆盖 stale 默认拒绝、成员包质量门失败 fail closed、evidence_map 回链、敏感
  payload/query log 拒绝、中断构建恢复且不发布 partial ready state、交互查询与
  exhaustive report 分离、查询 timing 分解。

问题：

- 未发现阻断性问题。

建议修订：

- 可把 10 个 required cases 进一步拆成 contract id、fixture shape、expected status
  和 asserted artifacts，方便后续 Test DD 直接引用。
