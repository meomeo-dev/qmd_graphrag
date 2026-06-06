overallVerdict: PASS_WITH_RISK

# implementation-turn_007 agent-1 修复后实施审计报告

审计对象：书-书架-Library 层级 GraphRAG 索引改造。

固定审计基准：
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

唯一规范设计入口：
`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

结论：implementation-turn_006 的两个问题已闭环。当前发布态
`CURRENT.json`、manifest、quality gate、成员 manifest sha256 与 validator
状态一致，旧 library current stale 已消除。Type DD、源码合同、当前三个
quality gate 与 validator fail-closed 路径均包含并校验
`semantic_edges_relation_types_allowed`。未发现阻塞性 required fix。

整体判定为 `PASS_WITH_RISK`。风险来自未在本次审计中完整重演真实中断恢复、
10/100/1000 本固定预算回归，以及更强 entity/relationship 语义边生成。

## 关键抽查

- `software-architecture-core`: generation=`bookshelf-dab8e0be24c6a06c`，
  manifest sha256=`0f77042b52124756300616e48776d7a9848a02e630f325ed6f8ca0e93b55d00c`。
  实际 `shasum -a 256` 匹配；validator 返回 `ok=true`、
  `semanticUnitCount=24`、`evidenceMapCount=131`。
- `delivery-devops-core`: generation=`bookshelf-42d5c276a8ad099d`，
  manifest sha256=`d34b5a89df87f97ad192c149526b3554f192ed28c38b600a47a9ebbd26f178ae`。
  实际 `shasum -a 256` 匹配；validator 返回 `ok=true`、
  `semanticUnitCount=24`、`evidenceMapCount=131`。
- `software-engineering-library`: generation=`library-b5e16d8a55a6a930`，
  manifest sha256=`422b32192bc518eb018fac46e5af5c9f76b226ff079af83b953904b1a49f339d`。
  实际 `shasum -a 256` 匹配；validator 返回 `ok=true`、
  `semanticUnitCount=8`、`evidenceMapCount=46`。
- library manifest 记录的两个成员书架 manifest sha256 与当前书架实际
  manifest sha256 一致，未再出现 `member_bookshelf_manifest_stale:*`。
- 三个 current quality gate 均为 `status=passed`、`queryReady=true`、
  `diagnostics=[]`，checks 均包含
  `semantic_edges_relation_types_allowed`。
- relationType 抽查：两个 bookshelf 只有 `bookshelf_membership` 与
  `co_clustered_topic`；library 只有 `library_membership` 与
  `co_clustered_topic`。
- 当前三个上层索引目录下未发现 stale marker；`CURRENT.json.sha256` 与
  quality gate sidecar 均与实际文件 sha256 匹配。

## 验证记录

- validator 抽查：
  `npx tsx -e "void (async () => { ...validateBookshelfGraph/validateLibraryGraph... })();"`
  结果：两个 bookshelf 与一个 library 均 `ok=true`，diagnostics 为空。
- 上层 graph/membership 测试：
  `npx vitest run --reporter=verbose --testTimeout 60000
  test/graphrag-bookshelf-membership.test.ts
  test/graphrag-bookshelf-graph.test.ts
  test/graphrag-library-membership.test.ts
  test/graphrag-library-graph.test.ts`
  结果：4 个测试文件通过，7 项测试通过。
- CLI scope/route 测试：
  `npx vitest run --reporter=verbose --testTimeout 60000
  test/cli-graphrag-query-scope.test.ts test/cli-graphrag-route.test.ts`
  结果：2 个测试文件通过，19 项测试通过。
- 合同测试：
  `npx vitest run --reporter=verbose --testTimeout 60000
  test/integrations/contracts.test.ts`
  结果：1 个测试文件通过，75 项测试通过。
- 本次审计未重跑 `npm run build`，以避免对共享工作区产生非必要副作用；
  任务背景提供的最终本地快照已声明 build 通过。

## D01_authority_boundaries

verdict: PASS

evidence:
- Type DD 规定单书包权威只能来自 `graph_vault/books/{bookId}` 下的
  `BOOK_MANIFEST.json`、`PUBLISH_READY.json` 和包内质量门。
- 当前上层产物只位于 `graph_vault/catalog/bookshelves/{bookshelfId}/current`
  与 `graph_vault/catalog/library/software-engineering-library/current`。
- 上层 manifest file closure 只记录 catalog 内 scope-relative 文件；测试覆盖
  成员书包目录不得出现 `BOOKSHELF_MANIFEST.json` 与
  `semantic_units.parquet`。

risks: 未重跑全量单书 hotplug 套件。

requiredFixes: 无。

## D02_fixed_query_budget

verdict: PASS

evidence:
- 两个 bookshelf manifest 均记录 `maxSemanticUnits=32`、
  `maxBooksForDeepening=3`、`maxMemberCommunityRefs=24`、
  `maxInputTokens=64000`。
- library manifest 记录 `maxSemanticUnits=32`、
  `maxBookshelvesForDeepening=3`、`maxShelfCommunityRefs=24`、
  `maxInputTokens=64000`。
- 三个 quality gate 的 fixed budget simulation 均为 `passed`；library 选择
  8 个 semantic units、2 个 bookshelves，估算输入 token 为 5120。
- 上层查询测试断言 fixed-budget report search 不发起 LLM 请求，
  `attemptedRequestCount=0`；预算超限路径返回
  `budget_exceeded_narrow_scope_required`。

risks: 当前仍会在已发布 upper reports 内做本地候选选择，upper report 数
增长后的 CPU 成本需后续回归跟踪。

requiredFixes: 无。

## D03_graphrag_semantic_alignment

verdict: PASS_WITH_RISK

evidence:
- Type DD 规定上层输入和产物包含 `community_reports.parquet`、
  `semantic_units.parquet`、`semantic_edges.parquet` 和
  `evidence_map.parquet`。
- 当前 bookshelf semantic units 来自成员书 community reports；library
  semantic units 来自成员书架 community reports。
- `semantic_edges.parquet` 保留 `relationType`、方向、权重、来源实体标题、
  lower relationship id 列和 evidence map id 列。
- 当前 relationType 全部属于 allowed set；旧的 `library_same_shelf` 与
  `cross_shelf_topic` 未再出现。

risks: 当前 edge 主要为 membership 与 co-clustered topic；`shared_entity`
和 `source_relationship` 生成仍需增强。

requiredFixes: 无。

## D04_evidence_traceability

verdict: PASS

evidence:
- Type DD 要求 `evidence_map.parquet` 回链到 book、source、document、
  content hash、community report、text unit 和 artifact digest。
- 当前两个 bookshelf evidence map 各 131 行，library 为 46 行；validator 对
  schema 与 row count 均通过。
- bookshelf/library 查询测试断言 evidence 暴露 book、source、document、
  content hash、text unit、scope metadata 和 upper artifact locator。
- manifest 记录 `evidenceSchema=upper-evidence-map-v1`，并将 evidence map
  纳入 file closure 和 checksum sidecar。

risks: 后续若加入 LLM synthesis，仍需逐句或逐段引用策略测试。

requiredFixes: 无。

## D05_state_recovery

verdict: PASS

evidence:
- 当前两个 bookshelf 和一个 library 均包含 `runs/{runId}/events.jsonl`、
  `status.json`、`recovery-summary.json` 与 checkpoints。
- `CURRENT.json`、manifest、quality gate、file closure 与 sidecar sha256 抽查
  均一致，未发现 partial publish。
- library `memberBookshelfManifestSha256` 与当前两个 bookshelf manifest 实际
  sha256 一致；`validateLibraryGraph` 返回 `ok=true`、`diagnostics=[]`。
- validator 在成员 manifest sha 不一致时产生 stale diagnostics；查询路径对
  stale upper index fail-closed，而不是继续使用 stale query-ready 产物。

risks: 未人为中断正在运行的 build 来验证 checkpoint 精确 resume。

requiredFixes: 无。

## D06_quality_gates

verdict: PASS

evidence:
- Type DD 的 `bookshelfGate.checkIds` 与 `libraryGate.checkIds` 均包含
  `semantic_edges_relation_types_allowed`；requiredChecks 要求 relationType
  值属于 allowedRelationTypes。
- `BookshelfGraphChecks` 与 `LibraryGraphChecks` 均包含该 checkId。
- validators 会按 required check 集合检查 gate；缺失项使 `ok=false`，并返回
  `quality_gate_missing_check:*` 或
  `{scope}_quality_gate_missing_check:*`。
- 当前三个 current gate 均包含该 checkId，且 `status=passed`、
  `queryReady=true`、`diagnostics=[]`。
- 负例测试覆盖删除该 checkId 后 fail-closed；library 测试覆盖将
  relationType 改为 `cross_shelf_topic` 后返回
  `disallowed_relation_type:semantic_edges.parquet:cross_shelf_topic`。

risks: allowed relation type 集合横跨 Type DD、TypeScript、Python inspect 和
测试；后续新增枚举时需同步维护。

requiredFixes: 无。

## D07_incremental_scaling

verdict: PASS_WITH_RISK

evidence:
- bookshelf manifest 记录成员书 manifest sha256、membership generation、
  members digest、decisions digest、split plan digest 和构建配置。
- library manifest 记录成员书架 manifest sha256、membership generation、
  members digest、partition plan digest 和构建配置。
- 当前 library 引用的两个成员书架 sha256 与实际 current manifest sha256
  一致，成员变更后的新 generation 闭环已完成。
- validator 会对成员书或成员书架 manifest sha 变化返回 stale diagnostics；
  默认查询路径拒绝过期上层索引。

risks: 当前实现偏保守重建，尚未证明 partition-aware 或单书架变更的局部
增量刷新。

requiredFixes: 无。

## D08_security_privacy

verdict: PASS

evidence:
- Type DD 禁止 provider payload、原始 prompt/completion、密钥、绝对路径和
  `query.log` 进入可发布上层 manifest 或索引。
- 当前 manifest 均记录 `sensitivityPolicy.forbiddenFields` 与
  graph_vault-relative locator rule；validator 禁止绝对路径、`../` 和 URI
  scheme。
- 对当前三个上层索引 JSON/JSONL 与 parquet 字符串列只读抽查：命中项为
  `sensitivityPolicy.forbiddenFields` 策略声明，或普通文本
  `risk-relevant` 中的 `sk-` 子串；未发现真实密钥、provider payload、
  原始 prompt/completion、`/Users/jin` 绝对路径或 `queryLogContent` 泄露。
- CLI route 测试覆盖 JSON 输出不得暴露 graph vault 绝对路径。

risks: 朴素字符串扫描会命中策略声明或普通英文子串，扫描器需继续区分
policy declaration 与真实 payload 泄露。

requiredFixes: 无。

## D09_cli_operability

verdict: PASS

evidence:
- Type DD 定义 missing、stale、quality gate failed、budget exceeded 和 runtime
  error 的 upper typed error 行为。
- CLI scope 测试覆盖 bookshelf/library 默认 global scope、missing upper index
  error fields、scope ambiguity 和 runtime error exit code 映射。
- `test/cli-graphrag-route.test.ts` 覆盖 `--bookshelf-id` 与 `--library-id`
  缺索引 typed error，查询路径不会自动构建上层索引。
- remediation 指向已实现的 `scripts/graphrag/build-bookshelf-graph.mjs` 与
  `scripts/graphrag/build-library-graph.mjs`，不再指向未实现的
  `qmd library build/status/rebuild`。

risks: 后续加入 `qmd library list/build/status/rebuild` 后，需要保持
remediation 与实际命令同步。

requiredFixes: 无。

## D10_testability

verdict: PASS_WITH_RISK

evidence:
- Type DD `testContracts.requiredCases` 定义超过 8 个必测案例，覆盖固定预算、
  stale、missing upper index、evidence map、安全扫描、恢复、hotplug 非回归、
  虚拟书架和 exhaustive report 边界。
- 本次重跑 6 个上层相关测试文件，共 26 项通过；重跑
  `test/integrations/contracts.test.ts`，75 项通过。
- 现有测试覆盖 bookshelf/library membership、graph build、quality gate
  required check、非法 relationType 负例、CLI typed error、scope ambiguity 和
  query evidence 输出。

risks: 本次未发现已实现的 10/100/1000 本规模固定预算回归测试；未重跑全量
仓库测试，也未人为制造 interrupted build 场景。

requiredFixes: 无本轮阻塞修复。建议后续补齐多规模 fixed-budget regression 与
interrupted build recovery 测试。

## 最终结论

- 旧 library current stale 已消除。当前 library generation
  `library-b5e16d8a55a6a930` 引用的两个 bookshelf manifest sha256 与当前发布
  书架一致，validator 返回 `ok=true`。
- relationType 质量门已从自然语言描述升级为可校验合同。Type DD、源码合同、
  当前 gate、validator 和负例测试均包含
  `semantic_edges_relation_types_allowed`，并会在缺失 required check 或出现
  非法 relationType 时 fail-closed。
- 当前实现满足固定 D01-D10 基准的核心发布与查询安全要求；剩余项属于长期
  测试深度和语义增强风险，不构成本轮阻塞。
