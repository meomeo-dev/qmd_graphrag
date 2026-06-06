overallVerdict: PASS_WITH_RISK

# implementation-turn_005 agent-2 审计报告

## 审计边界

本审计按固定基准
`base/evaluation-dimensions.yaml` 的 D01-D10 逐项评估，并以唯一 Type DD
`graphrag-hierarchical-library-index.type-dd.yaml` 的最新状态为准。

当前实现状态按 Type DD 解释为：

- 已交付：bookshelf membership、bookshelf graph build、bookshelf
  fixed-budget report search、library membership、library graph build、library
  fixed-budget report search、upper typed errors。
- 未交付且不作为本轮阻断：`qmd library list/build/status/rebuild` 管理命令、
  selected upper semantic units 上的 LLM synthesis、bounded deepening into
  selected single-book GraphRAG。

主控提供的已跑通结果作为本轮验证输入，包括 `npm run build`、真实 catalog
验证、library smoke、单书 GraphRAG 回归和 `contracts.test.ts` 75 项通过。
本 agent 另做只读源码、发布产物和测试合同检查，未复跑会产生临时产物的测试。

## D01_authority_boundaries: 权威边界与热插包隔离

verdict: PASS

evidence:

- 书架与 library 产物均发布在 `graph_vault/catalog/**/current`，构建代码未向
  `graph_vault/books/{bookId}` 写入 `BOOKSHELF_MANIFEST.json`、
  `LIBRARY_MANIFEST.json` 或 upper semantic artifacts。
- `buildBookshelfGraph` 只读取单书 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
  包内 GraphRAG artifact 和 hotplug gates，并把上层 artifacts 写入 catalog。
- `test/graphrag-bookshelf-graph.test.ts` 明确断言单书目录下不存在
  `BOOKSHELF_MANIFEST.json` 和 `semantic_units.parquet`。
- 主控提供的单书回归命令仍走 `cli.invoke_graphrag_runtime`，说明
  `--graph-book-id` 路径未被 library 上层索引污染。

risks:

- upper index 通过 catalog 当前代引用成员书包；如果后续增加自动 rebuild 或
  管理命令，需要继续保持 book package authority（包权威）不被 catalog 反写。

requiredFixes:

- 无阻塞修复项。

## D02_fixed_query_budget: 固定查询预算

verdict: PASS_WITH_RISK

evidence:

- `LibraryGraphManifestSchema` 记录 `maxSemanticUnits`、
  `maxBookshelvesForDeepening`、`maxShelfCommunityRefs` 和 `maxInputTokens`。
- `queryLibraryGraph` 从 manifest 读取 `maxReports` 与 `maxInputTokens`，调用
  `runBookshelfGraphQueryBridge`，超 token 时返回
  `budget_exceeded_narrow_scope_required`。
- `bookshelf_graph_bridge_query.py` 只选择 `maxReports` 个 upper
  `community_reports.parquet` 行，并在 `estimated_tokens > max_input_tokens`
  时 fail closed。
- 主控提供的 library smoke 中 provider `attemptedRequestCount=0`，
  prompt/estimated tokens 为 923，未发生随书籍数量增长的 LLM 调用。

risks:

- 当前 fixed-budget report search 会读取并按词面分数排序 scope 内全部 upper
  `community_reports.parquet` 行。它没有扫描所有单书 community reports，也没有
  扩大 prompt，但大规模 library 下仍可能出现本地 CPU/IO 随 upper report 数增长。
- 不同规模库的 10、100、1000 本固定预算测试未在本 agent 检查到专门覆盖。

requiredFixes:

- 无本轮阻塞修复项。后续应补充大规模 fixed-budget 回归，并在必要时为 upper
  reports 增加预索引或分页候选限制。

## D03_graphrag_semantic_alignment: GraphRAG 语义对齐

verdict: PASS_WITH_RISK

evidence:

- 书架构建输入包含成员单书 `community_reports.parquet`，library 构建输入包含成员
  bookshelf `community_reports.parquet` 和 `evidence_map.parquet`。
- `semantic_units.parquet` 的 `sourceKind` 分别记录
  `book_community_report` 与 `bookshelf_community_report`。
- 书架与 library 均生成 `semantic_edges.parquet`、`communities.parquet` 和
  `community_reports.parquet`，查询回答来自预计算 upper community reports。
- `RequiredParquetColumns` 覆盖 semantic units、semantic edges、community
  reports 和 evidence map 的必需列。

risks:

- 当前 edge 生成主要基于 token overlap（词项重叠）和同书架/同书关系，
  `sourceRelationshipIds` 为空，未实质消费单书 `entities.parquet` 与
  `relationships.parquet` 的关系内容。
- 当前回答是 fixed-budget report search 文本，不是 Type DD 中仍待实现的
  LLM synthesis；该点按最新 Type DD 不构成本轮失败。

requiredFixes:

- 无本轮阻塞修复项。后续 GraphRAG semantic alignment 应把 entity 和
  relationship 证据纳入 edge 生成与质量门校验。

## D04_evidence_traceability: 证据可追溯

verdict: PASS_WITH_RISK

evidence:

- `evidence_map.parquet` schema 包含 `targetBookId`、`targetBookshelfId`、
  `targetSourceId`、`targetDocumentId`、`targetContentHash`、
  `targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。
- library bridge 通过成员 bookshelf evidence map 生成 library evidence，
  保留 `targetBookshelfId` 并回链到 book 级字段。
- `queryLibraryGraph` 输出 evidence metadata 包含 `scopeKind=library`、
  `libraryId`、`targetBookshelfId`、upper report id 和 token budget 信息。
- 主控提供的 library smoke 确认 evidence metadata 包含 `scopeKind=library`、
  `libraryId`、`targetBookshelfId`、`bookId`、`sourceId`、`documentId`、
  `contentHash`。

risks:

- validator 主要校验 schema、row count、checksum 和成员 manifest sha；
  对每一条 evidence 是否真实解析到存在的下层 report/text unit 的引用校验仍偏浅。
- library bridge 在下层 evidence 缺失时可写入 `unknown-*` fallback；虽然 zod 可防
  空值，但不能证明真实 lineage 完整。

requiredFixes:

- 无本轮阻塞修复项。后续应增加逐行 referential integrity（引用完整性）质量门。

## D05_state_recovery: 状态闭环与恢复

verdict: PASS_WITH_RISK

evidence:

- membership 与 graph build 均先写 `staging/{generation}`，再 rename 到
  `current`，并写 `CURRENT.json`。
- 当前产物包含 `runs/{runId}/events.jsonl`、`status.json`、
  `recovery-summary.json` 和 `checkpoints/*.json` 及 checksum sidecar。
- `readLibraryMembershipCurrent` 支持从 membership-only current 或 graph current
  下的 `membership/` archive 读取，覆盖 staging/current/membership handoff。
- stale 检测通过成员 manifest sha 对比实现；library validator 可返回
  `upper_index_stale`。

risks:

- interrupted build 的真实断点恢复（resume from checkpoints）尚未实现为增量恢复；
  当前更接近删除旧 staging 后重建。
- failed staging quarantine/repair 工作流不完整，主要依赖不 promote staging 来避免
  partial publish。

requiredFixes:

- 无本轮阻塞修复项。后续实现增量刷新和管理命令时应补齐显式 resume、quarantine
  与 repair 语义。

## D06_quality_gates: 质量门

verdict: PASS_WITH_RISK

evidence:

- 书架质量门包含 manifest/member gates、semantic schema、evidence lineage、
  embedding fingerprint、fixed budget simulation、sensitive scan 和 stale marker
  checks。
- library 质量门包含 member bookshelf manifest sha、member gates、membership gate、
  schema、evidence map、budget simulation、sensitive scan 和 stale marker checks。
- 当前真实 `software-engineering-library` quality gate 为 `library_query_ready`、
  `queryReady=true`、`status=passed`，budget simulation 为 8 个 selected semantic
  units、5120 estimated input tokens、64000 max input tokens。
- 查询路径在 manifest/gate 缺失、stale 或 quality gate failed 时返回 typed error。

risks:

- 若干 quality gate check 当前以构建前置校验和 schema inspect 间接支撑；
  对 parquet 内容中的敏感信息、逐行 evidence 引用和 edge 语义质量尚未深度扫描。
- `sensitive_payload_scan_passed` 当前主要覆盖 manifest/quality gate JSON 文本，
  不是完整 artifact 内容扫描。

requiredFixes:

- 无本轮阻塞修复项。后续应把质量门从 schema/checksum 扩展到 artifact 内容级扫描。

## D07_incremental_scaling: 增量扩展

verdict: PASS_WITH_RISK

evidence:

- membership 和 graph manifest 记录成员集合、成员 manifest sha、membership
  generation、builder version、budget config、embedding fingerprint 和 evidence
  schema。
- generation 由成员 manifest sha、membership generation 和构建配置共同派生；
  成员变化会导致新 generation 或 stale 检测。
- library membership 有 shelf limit、direct book limit 和 partition plan；当前真实
  library 使用两个 materialized bookshelves，direct book count 为 0。

risks:

- 当前实现支持保守全量重建与 generation 变更，但没有局部 semantic unit 或 community
  的增量刷新。
- partition plan 已存在，但多 partition interactive query 与完整管理命令仍未交付。

requiredFixes:

- 无本轮阻塞修复项。后续应在 phase3 增加局部刷新合同测试。

## D08_security_privacy: 安全与隐私

verdict: PASS_WITH_RISK

evidence:

- manifest 的 `sensitivityPolicy.forbiddenFields` 覆盖 provider payload、raw
  prompt、raw completion、api key、credential、absolute local path 和
  query log content。
- `normalizeScopeRelativePath` 拒绝绝对路径、`..` 和 URI-like path，manifest
  files 使用 scope-relative locator。
- 本 agent 对真实 library 和两个 bookshelf current JSON/JSONL 做只读扫描，未发现
  `/Users/`、`file://`、`query.log` 或 forbidden field key。
- Python bridge 使用绝对 artifact path 仅作为进程内 build payload；发布 manifest
  与 checked JSON 产物未记录这些绝对路径。

risks:

- 敏感扫描没有覆盖 parquet 文本列、embedding sidecar 内容或从下层 community report
  汇总进入 upper report 的文本。
- bridge payload 中存在绝对路径作为本地执行输入，应确保未来诊断和错误输出继续不回显。

requiredFixes:

- 无本轮阻塞修复项。后续应加入 parquet 内容级敏感扫描和错误消息 redaction 测试。

## D09_cli_operability: CLI 可操作性与降级

verdict: PASS_WITH_RISK

evidence:

- `qmd query` 支持 `--bookshelf-id` 和 `--library-id`，并将 upper scope 默认 query
  method 解析为 `global`。
- book/bookshelf/library scope 互斥，冲突时返回 `ambiguous_scope` typed error。
- missing upper index 返回 `upper_index_missing` 和 exit code 66；runtime error 返回
  exit code 70；scope、remediation、retryable、timingAvailable 均进入 payload。
- `graphRagQuerySearch` 分别记录 `cli.query_bookshelf_upper_index`、
  `cli.query_library_upper_index` 和单书 `cli.invoke_graphrag_runtime` timing。
- 主控提供的 library smoke 确认 selectedRoute 为 `graphrag`，timing 包含
  `cli.query_library_upper_index`。

risks:

- typed error remediation command 指向 `qmd library list/build/status/rebuild`，
  但这些管理命令按最新 Type DD 仍属于 remaining capabilities。
- 无 scope/default library 的完整 CLI 行为未在本 agent 检查到端到端覆盖；当前重点是
  explicit bookshelf/library scope。

requiredFixes:

- 无本轮阻塞修复项。后续交付管理命令时应消除 remediation command 与实际 CLI 的差距。

## D10_testability: 可测试性

verdict: PASS_WITH_RISK

evidence:

- 已有 `test/graphrag-bookshelf-membership.test.ts`、
  `test/graphrag-bookshelf-graph.test.ts`、
  `test/graphrag-library-membership.test.ts`、
  `test/graphrag-library-graph.test.ts`、`test/cli-graphrag-query-scope.test.ts`
  和 `test/cli-graphrag-route.test.ts` 覆盖主要实现路径。
- 主控提供 `test/integrations/contracts.test.ts` 75 tests passed，覆盖统一合同字段。
- 测试覆盖单书 hotplug 非回归、书架不写入单书目录、library query provider
  attempted request 为 0、typed error exit code、evidence metadata 和 checksum
  sidecars。

risks:

- 固定预算在 10、100、1000 本规模下的专门测试未见完整覆盖。
- stale library query、parquet 内容敏感扫描、逐行 evidence referential integrity、
  interrupted build resume 的端到端测试仍不足。

requiredFixes:

- 无本轮阻塞修复项。后续应补齐大规模预算、stale、敏感内容和恢复类测试。

## 实际检查的命令与文件

实际检查的命令：

- `sed -n` 读取固定基准与 Type DD 多个区段。
- `rg --files`、`rg -n` 定位 upper-index、CLI、测试和 Type DD 状态段。
- `find docs/architecture/graphrag-hierarchical-library-index-audits ...` 查看审计目录。
- `git status --short` 确认工作区存在并行改动，仅作只读审计。
- `wc -l src/graphrag/upper-index/*.ts scripts/graphrag/*library* ...` 查看模块规模。
- `find graph_vault/catalog/library/software-engineering-library/current ...` 查看真实发布产物。
- `node -e` 只读抽取真实 `LIBRARY_MANIFEST.json`、library quality gate 和 membership
  manifest 摘要。
- `node <<'NODE' ...` 只读扫描真实 library/bookshelf current JSON/JSONL 中的绝对路径、
  query log token 和 forbidden field keys。

实际检查的主要文件：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `src/cli/qmd.ts`
- `src/cli/graphrag-query-scope.ts`
- `src/graphrag/upper-index/bookshelf-membership.ts`
- `src/graphrag/upper-index/bookshelf-graph.ts`
- `src/graphrag/upper-index/bookshelf-graph-contracts.ts`
- `src/graphrag/upper-index/bookshelf-graph-validator.ts`
- `src/graphrag/upper-index/bookshelf-query.ts`
- `src/graphrag/upper-index/library-membership.ts`
- `src/graphrag/upper-index/library-graph.ts`
- `src/graphrag/upper-index/library-graph-contracts.ts`
- `src/graphrag/upper-index/library-graph-validator.ts`
- `src/graphrag/upper-index/library-query.ts`
- `scripts/graphrag/bookshelf_graph_bridge_build.py`
- `scripts/graphrag/library_graph_bridge_build.py`
- `scripts/graphrag/bookshelf_graph_bridge_query.py`
- `scripts/graphrag/bookshelf_graph_bridge_contracts.py`
- `scripts/graphrag/bookshelf_graph_bridge_io.py`
- `scripts/graphrag/build-library-membership.mjs`
- `scripts/graphrag/build-library-graph.mjs`
- `test/graphrag-bookshelf-membership.test.ts`
- `test/graphrag-bookshelf-graph.test.ts`
- `test/graphrag-library-membership.test.ts`
- `test/graphrag-library-graph.test.ts`
- `test/cli-graphrag-query-scope.test.ts`
- `test/cli-graphrag-route.test.ts`
- `test/integrations/contracts.test.ts`
- `graph_vault/catalog/library/software-engineering-library/current/LIBRARY_MANIFEST.json`
- `graph_vault/catalog/library/software-engineering-library/current/state/library-quality-gate.json`
- `graph_vault/catalog/library/software-engineering-library/current/membership/LIBRARY_MEMBERSHIP_MANIFEST.json`
