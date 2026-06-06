# Implementation Audit Turn 005 Agent-3 Report

overallVerdict: FAIL

审计基准为固定 `D01-D10` 评价维度与最新唯一 Type DD。审计边界按
Type DD 当前状态处理：`--bookshelf-id`、`--library-id` 的 fixed-budget
upper-index report search 已作为已交付目标；LLM synthesis、bounded
deepening 与完整 `qmd library` 管理命令仍为后续能力，未作为本轮失败项。

阻塞缺陷集中在上层 graph 语义合同与质量门覆盖：当前 library
`semantic_edges.parquet` 发布了 Type DD `allowedRelationTypes` 以外的
`library_same_shelf` 与 `cross_shelf_topic`，同时质量门仍标记通过，说明
语义枚举与敏感扫描等 required checks 未被充分执行。该问题需要修复后重建
并重新验证 current library index。

## D01_authority_boundaries

verdict: PASS

evidence:

- 单书包权威仍来自 `graph_vault/books/{bookId}/BOOK_MANIFEST.json`、
  `PUBLISH_READY.json` 与包内 state gates。`bookshelf-membership.ts` 读取并
  校验单书 manifest、publish marker、hotplug quality gate、runtime gate。
- 书架与 library 产物写入 `graph_vault/catalog/bookshelves/**/current` 与
  `graph_vault/catalog/library/**/current`。抽样 current 目录包含
  `BOOKSHELF_MANIFEST.json`、`LIBRARY_MANIFEST.json`、semantic parquet 与
  quality gate，未写入单书包根。
- `test/graphrag-bookshelf-graph.test.ts` 明确断言单书目录不存在
  `BOOKSHELF_MANIFEST.json` 与 `semantic_units.parquet`。
- 用户提供的单书回归命令仍走 `cli.invoke_graphrag_runtime`，说明 upper index
  未替代单书 GraphRAG 查询路径。

risks:

- 无阻塞风险。catalog upper indexes 损坏时仍需依赖查询路径 typed error
  与单书显式 scope 维持操作可恢复性。

requiredFixes:

- 无。

## D02_fixed_query_budget

verdict: PASS_WITH_RISK

evidence:

- `BOOKSHELF_MANIFEST.json` 与 `LIBRARY_MANIFEST.json` 均记录
  `fixedQueryBudget`。当前 library budget 为 `maxSemanticUnits=32`、
  `maxBookshelvesForDeepening=3`、`maxShelfCommunityRefs=24`、
  `maxInputTokens=64000`。
- `bookshelf_graph_bridge_query.py` 在查询阶段只读取已发布 upper
  `community_reports.parquet` 与 `evidence_map.parquet`，按 `maxReports`
  选择报告，并在 `estimatedInputTokens > maxInputTokens` 时返回
  `budget_exceeded_narrow_scope_required`。
- `queryBookshelfGraph` 与 `queryLibraryGraph` 的 provider metrics 设置
  `attemptedRequestCount=0`，与本轮 smoke 中 provider 未发起请求一致。
- 查询路径没有读取所有单书 `community_reports.parquet`，library 查询从
  已发布 library current 产物取证据。

risks:

- 查询 bridge 会对当前 upper `community_reports.parquet` 全量打分后再取
  top-K。它不违反“不得全量扫描所有单书 community_reports”的硬边界，但
  CPU 成本仍随 upper report 数增长。
- 未在已检查测试中发现 10、100、1000 本规模的 fixed budget 模拟用例。

requiredFixes:

- 无阻塞修复；建议补齐大规模 fixed budget 回归测试，并在 upper
  report 数增长时引入索引级候选裁剪。

## D03_graphrag_semantic_alignment

verdict: FAIL

evidence:

- 书架 builder 从成员书的 `community_reports.parquet` 生成
  `semantic_units.parquet`，`sourceKind=book_community_report`；书架
  `semantic_edges.parquet` 的实际 `relationType` 为
  `bookshelf_membership` 与 `co_clustered_topic`，属于 Type DD 允许值。
- Library builder 从已发布书架 `community_reports.parquet` 与
  `evidence_map.parquet` 生成 library `semantic_units.parquet`，
  `sourceKind=bookshelf_community_report`，符合 fixed-budget report search
  的当前实现边界。
- Type DD `upperGraphArtifactSchemas.semanticEdges.allowedRelationTypes`
  只允许 `shared_entity`、`source_relationship`、`co_clustered_topic`、
  `parent_child_community`、`bookshelf_membership`、`library_membership`。
- 当前 `graph_vault/catalog/library/software-engineering-library/current/
  semantic_edges.parquet` 的实际 `relationType` 为 `library_same_shelf` 与
  `cross_shelf_topic`，不在上述枚举内。
- Python builder 代码 `scripts/graphrag/library_graph_bridge_build.py` 直接写入
  `library_same_shelf` 与 `cross_shelf_topic`。

risks:

- Published library graph artifact 与唯一 Type DD 的语义枚举不一致。下游
  读者无法依赖 Type DD 的 stable relation vocabulary。
- 质量门未拦截该枚举漂移，后续更丰富的 entity/relationship 语义扩展可能在
  未显式审计的情况下继续偏离合同。
- 当前 edge 构建主要基于 token overlap，`sourceRelationshipIds` 为空；这对
  “贴近 GraphRAG entity/relationship 原理”仍是弱实现。

requiredFixes:

- 将 library edge `relationType` 映射到 Type DD 允许值，例如
  `library_same_shelf -> library_membership`，
  `cross_shelf_topic -> co_clustered_topic`，或按合同生成
  `shared_entity`/`source_relationship`。
- 在 graph validator 与 quality gate 中校验 `relationType` 必须属于 Type DD
  allowed set。
- 修复后重建 `software-engineering-library` current library graph，并重新运行
  library graph 验证与 smoke query。

## D04_evidence_traceability

verdict: PASS

evidence:

- Type DD 要求的 `evidence_map.parquet` 列在当前书架与 library 产物中存在：
  `targetBookId`、`targetBookshelfId`、`targetSourceId`、
  `targetDocumentId`、`targetContentHash`、`targetCommunityReportId`、
  `targetTextUnitId`、`targetArtifactDigest`。
- 当前 library `evidence_map.parquet` 抽样行包含
  `ownerLevel=library`、`targetBookshelfId=delivery-devops-core`、book/source/
  document/content hash 与 text unit id。
- `queryLibraryGraph` 把 evidence 映射为 `bookId`、`sourceId`、
  `documentId`、`contentHash`、`graphTextUnitId`，并在 metadata 中暴露
  `scopeKind=library`、`libraryId`、`targetBookshelfId`、
  `targetCommunityReportId` 与 token budget 信息。
- 用户提供的 library smoke 已验证 evidence metadata 包含 `scopeKind`、
  `libraryId`、`targetBookshelfId`、`bookId`、`sourceId`、`documentId`、
  `contentHash`。

risks:

- 当前 query 只返回 selected upper reports 的 evidence 摘要，不做 LLM
  synthesis；这是最新 Type DD 明确的当前能力边界，不作为失败项。

requiredFixes:

- 无。

## D05_state_recovery

verdict: PASS_WITH_RISK

evidence:

- Membership、bookshelf graph、library membership、library graph 均先写入
  `staging/{generation}`，再以 rename 方式提升为 `current`，并写入
  `CURRENT.json` publish marker。
- 当前产物包含 `runs/{runId}/events.jsonl`、`status.json`、
  `recovery-summary.json` 与 checkpoints，满足 durable state 的基础记录。
- Library graph 发布后把 membership 产物归档到 `current/membership`；
  `readLibraryMembershipCurrent` 支持 membership-only current 与 graph current
  archive fallback。
- Query readiness validation 会比较成员书或成员书架 manifest sha，变化时
  返回 stale diagnostics 并映射为 `upper_index_stale`。

risks:

- 构建入口会删除同 generation 的 staging 后重新开始，尚未实现从 validated
  checkpoints resume 的完整恢复语义。
- Stale 状态主要在查询/验证时动态检测，未看到独立 stale marker 发布流程。
- `current` 原子提升依赖目录 rename；若进程在 previous/current 切换窗口崩溃，
  仍需要显式 repair 流程兜底。

requiredFixes:

- 无阻塞修复；建议后续补齐真正的 checkpoint resume、stale marker 与
  interrupted promote repair 测试。

## D06_quality_gates

verdict: FAIL

evidence:

- 当前书架与 library 均发布了独立 quality gate：
  `state/bookshelf-quality-gate.json` 与 `state/library-quality-gate.json`。
- Gate 中包含 schema、membership sha、evidence map、fixed budget、
  sensitive payload scan、stale marker 等 check id，且 current gate 状态为
  `passed`。
- `validateBookshelfGraphAtRoot` 与 `validateLibraryGraphAtRoot` 会验证 manifest
  schema、file closure、checksum sidecars、parquet required columns、
  evidence map row count 与 member manifest stale。
- 但 `validateLibraryGraphAtRoot` 未校验 `semantic_edges.parquet` 的
  `relationType` 枚举，导致 D03 中已确认的 disallowed relation types 仍通过
  quality gate。
- `sensitive_payload_scan_passed` 目前主要表现为 manifest/quality gate 文本
  扫描；未看到对 semantic parquet、membership json/jsonl 与 diagnostics 全
  closure 的实质性敏感内容扫描。

risks:

- Quality gate 目前会对部分未真实验证的检查写入 `passed`，降低
  requiredChecks 的可信度。
- Query path 会信任 current quality gate；若 artifact 语义值漂移但列结构有效，
  仍可能被视为 query-ready。

requiredFixes:

- 在 bookshelf/library validators 中加入 `semantic_edges.relationType` allowed
  set 校验，并使质量门失败时拒绝发布或拒绝查询。
- 将 sensitive payload scan 扩展到 manifest files closure 中的 json/jsonl 与
  parquet 文本列，且避免把 `sensitivityPolicy.forbiddenFields` 自身误判为泄露。
- 增加质量门负例测试，覆盖 disallowed relation type、parquet 内 provider
  payload/absolute path/raw prompt 泄露与 gate-failed query refusal。

## D07_incremental_scaling

verdict: PASS_WITH_RISK

evidence:

- Membership 与 graph manifests 记录成员 manifest sha、generation、
  membership generation、builder config 与 fixed budget。
- 书架层限制每个 materialized bookshelf 的成员集合，library membership 支持
  `shelfLimit`、`directBookLimit` 与 partition plan。
- 当前实现采用 conservative generation rebuild；成员 manifest sha 或
  bookshelf manifest sha 变化会在 build/query validation 中触发 stale。

risks:

- Type DD 中更完整的 incremental refresh planner 尚未实现；当前成本主要通过
  书架分层与保守重建控制。
- 未在已检查测试中发现大库分层与多规模重建影响范围的完整压力测试。

requiredFixes:

- 无阻塞修复；建议后续实现 incremental refresh planner，并补充大库 partition
  与 stale propagation 测试。

## D08_security_privacy

verdict: PASS_WITH_RISK

evidence:

- Manifest 中声明 `sensitivityPolicy.forbiddenFields`，并使用 scope-relative 或
  graph-vault-relative locators；`files` 记录相对路径、sha256 与 bytes。
- 结构化只读扫描在跳过 `sensitivityPolicy.forbiddenFields` 策略字段名后，未在
  current 书架/library json/jsonl/parquet 产物中发现 provider payload、绝对
  `/Users/jin` 路径、API key 字段或 raw prompt/completion 字段。
- 当前 diagnostics 使用 digest 与 relative locator，例如
  `current/LIBRARY_MANIFEST.json`，未看到绝对本地路径。

risks:

- 简单字符串扫描在 semantic summaries 中命中 `sk-` 子串，属于自然语言误报
  风险；真实 secret pattern 需要更精细规则。
- 构建代码未显示对全部 parquet 文本列执行敏感扫描，因此若源报告包含敏感
  provider payload 或绝对路径，quality gate 可能无法拦截。
- Manifest 中列出 forbidden field 名称会使 naive grep 出现命中，需要扫描器
  明确区分 policy declaration 与 leaked payload。

requiredFixes:

- 无独立阻塞修复；D06 的质量门修复应同时扩大敏感扫描范围，并加入误报过滤
  与泄露负例测试。

## D09_cli_operability

verdict: PASS_WITH_RISK

evidence:

- `src/cli/qmd.ts` 支持 `--graph-book-id`、`--bookshelf-id`、
  `--library-id` 互斥解析；显式 upper scope 走 fixed-budget upper query。
- `resolveUpperTypedQueryErrorDetails` 映射 `upper_index_missing`、
  `upper_index_stale`、`upper_quality_gate_failed`、
  `budget_exceeded_narrow_scope_required` 与 `upper_index_runtime_error`。
- `queryBookshelfGraph` 和 `queryLibraryGraph` 在 runtime 或 gate 失败时抛出
  typed scope errors；CLI 将其转换为统一 typed query error payload。
- Timing stage 已分解为 `cli.query_bookshelf_upper_index` 与
  `cli.query_library_upper_index`；单书路径仍保留 `cli.invoke_graphrag_runtime`。

risks:

- Typed error remediation command 指向 `qmd library build/status/rebuild`，
  但最新 Type DD 明确完整 library 管理命令仍是后续能力。因此当前错误可操作性
  依赖用户知道使用脚本或后续命令。
- Upper query 当前不执行 LLM synthesis 或 bounded deepening；这是当前能力边界，
  但 CLI 输出文案需要持续避免暗示完整 GraphRAG synthesis 已完成。

requiredFixes:

- 无阻塞修复；在管理命令交付前，建议 error metadata 或文档提供现有脚本级
  rebuild/status 替代路径。

## D10_testability

verdict: PASS_WITH_RISK

evidence:

- 已检查测试覆盖：
  `test/graphrag-bookshelf-membership.test.ts`、
  `test/graphrag-bookshelf-graph.test.ts`、
  `test/graphrag-library-membership.test.ts`、
  `test/graphrag-library-graph.test.ts`、
  `test/cli-graphrag-query-scope.test.ts`、
  `test/cli-graphrag-route.test.ts`。
- 用户提供的本轮真实验证包括 `npm run build`、dist catalog 验证、library
  smoke、单书回归与 `test/integrations/contracts.test.ts` 75 tests passed。
- 测试覆盖 membership handoff queryReady=false、书架 graph queryReady=true、
  library membership directBookLimit、library graph fixed-budget query、
  missing upper index typed error 与 scope ambiguity。

risks:

- 未看到覆盖 Type DD `allowedRelationTypes` 的负例测试，导致 D03 漂移未被发现。
- 未看到 upper parquet 全 closure sensitive scan 的负例测试。
- 未看到 10、100、1000 本规模 library fixed budget 回归测试。
- 单书 hotplug 非回归由本轮真实命令验证，但专门删除 catalog upper artifacts 后
  再验证单书查询的自动化用例仍应补齐。

requiredFixes:

- 为 D03/D06 的修复增加回归测试：relation enum 校验、gate-failed query
  refusal、parquet 敏感 payload 扫描。
- 增加 library 10/100/1000 books fixed budget 测试与 catalog upper artifacts
  删除后的单书查询非回归测试。

## 实际检查的命令与文件

只读检查命令：

- `sed -n '1,260p' docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `sed -n '1,260p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '1010,1068p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '1538,1565p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `sed -n '1710,1752p' docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `find src/graphrag/upper-index -maxdepth 3 -type f | sort`
- `find graph_vault/catalog/bookshelves graph_vault/catalog/library -maxdepth 6 -type f | sort`
- `find dist/graphrag/upper-index dist/cli -maxdepth 3 -type f`
- `jq` 抽样读取 `BOOKSHELF_MANIFEST.json`、`LIBRARY_MANIFEST.json`、
  `BOOKSHELF_MEMBERSHIP_MANIFEST.json`、`LIBRARY_MEMBERSHIP_MANIFEST.json`
  与 quality gate。
- `python3` + `pyarrow.parquet` 只读抽样读取 current
  `semantic_units.parquet`、`semantic_edges.parquet`、
  `community_reports.parquet`、`evidence_map.parquet`。
- `python3 scripts/graphrag/bookshelf-graph-parquet-bridge.py inspect` 只读检查
  library current parquet schema。
- `rg -n` 扫描 upper-index 源码、脚本、测试、typed errors、timing、
  forbidden fields 与 runner ledger 相关引用。

重点检查文件：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `src/graphrag/upper-index/bookshelf-membership.ts`
- `src/graphrag/upper-index/bookshelf-graph.ts`
- `src/graphrag/upper-index/bookshelf-graph-validator.ts`
- `src/graphrag/upper-index/bookshelf-query.ts`
- `src/graphrag/upper-index/library-membership.ts`
- `src/graphrag/upper-index/library-graph.ts`
- `src/graphrag/upper-index/library-graph-validator.ts`
- `src/graphrag/upper-index/library-query.ts`
- `src/cli/qmd.ts`
- `src/cli/graphrag-query-scope.ts`
- `scripts/graphrag/bookshelf_graph_bridge_build.py`
- `scripts/graphrag/library_graph_bridge_build.py`
- `scripts/graphrag/bookshelf_graph_bridge_query.py`
- `scripts/graphrag/bookshelf_graph_bridge_inspect.py`
- `test/graphrag-bookshelf-membership.test.ts`
- `test/graphrag-bookshelf-graph.test.ts`
- `test/graphrag-library-membership.test.ts`
- `test/graphrag-library-graph.test.ts`
- `test/cli-graphrag-query-scope.test.ts`
- `test/cli-graphrag-route.test.ts`
- `graph_vault/catalog/bookshelves/software-architecture-core/current/**`
- `graph_vault/catalog/bookshelves/delivery-devops-core/current/**`
- `graph_vault/catalog/library/software-engineering-library/current/**`

未重新运行会写入 query report、staging、coverage 或构建产物的命令；本报告采用
用户提供的本轮已跑通结果作为执行基线，并用只读命令核对源码、dist 与 current
产物。
