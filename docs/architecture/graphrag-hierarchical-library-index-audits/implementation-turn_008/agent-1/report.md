# implementation-turn_008 / agent-1 审计报告

## 结论：PASS_WITH_RISK

当前实现已满足【书-书架-Library 层级 GraphRAG 索引改造】的主要合同：
书架与 library 作为 `graph_vault/catalog/**` 派生物发布；查询读取已发布
且质量门通过的 upper index；固定预算查询、evidence lineage、stale
fail-closed、CLI typed error 和 timing 均有实现与测试证据。

保留风险是：单书 GraphRAG 真实查询目前不是成功回答，而是外部
provider/runtime 短超时后返回 retryable typed `provider_unavailable`。这符合
fail-closed 与恢复观测要求，但不能计为单书 GraphRAG 查询成功回归。另有若干
upper-index 模块超过项目建议行数，属于后续可维护性风险，不构成本轮阻断。

## D01 权威边界与热插包隔离：PASS

证据：

- 设计明确单书包权威仍为 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内
  qmd/GraphRAG output 与包内质量门；书架/library 只能位于 catalog 派生根。
- `bookshelf-query.ts` 只读取
  `graph_vault/catalog/bookshelves/{bookshelfId}/current`，不写单书包。
- `library-query.ts` 只读取
  `graph_vault/catalog/library/{libraryId}/current` 与成员书架 manifest。
- membership 阶段读取单书包 manifest/gate，并在成员质量门失败时拒绝加入。

判定：上层索引损坏不会改变单书包挂载状态；未发现 upper-index 写回单书包闭包。

## D02 固定查询预算：PASS

证据：

- `bookshelf-query.ts` 和 `library-query.ts` 使用 manifest 中的
  `fixedQueryBudget.maxSemanticUnits` 与 `maxInputTokens`。
- Python query bridge 使用 `maxReports`、`maxInputTokens` 做固定预算 report
  search，LLM 调用数为 0。
- `test/graphrag-library-graph.test.ts` 覆盖 10、100、1000 本模拟规模下
  selected report 固定为 3，并覆盖 `budget_exceeded_narrow_scope_required`。
- 已发布 library quality gate 显示：
  `selectedSemanticUnits=8`、`maxSemanticUnits=32`、`estimatedInputTokens=5120`。

判定：交互查询未随书籍数量线性扩张。

## D03 GraphRAG 语义对齐与 batch-runs 隔离：PASS

证据：

- 书架/library 派生索引产物包含 `semantic_units.parquet`、
  `semantic_edges.parquet`、`community_reports.parquet`、`evidence_map.parquet`。
- query bridge 基于 `community_reports.parquet` 做 fixed-budget report search。
- 只读搜索未发现 `src/graphrag/upper-index/**` 或新增 build/query 脚本读取
  `catalog/batch-runs/**` 作为语义输入。
- `batch-runs` 仍只在 runner 相关旧模块/测试中出现，未进入 upper-index
  membership/build/query 路径。

判定：未退化成全量摘要拼接，且 runner ledger 未参与语义检索。

## D04 证据可追溯：PASS

证据：

- 书架查询输出 evidence 映射 `bookId`、`sourceId`、`documentId`、
  `contentHash`、`graphTextUnitId`、`artifactId`。
- library 查询输出相同证据字段，并在 metadata 中包含 `targetBookshelfId`、
  `upperCommunityReportId`、`targetCommunityReportId`、`targetArtifactDigest`。
- `test/graphrag-bookshelf-graph.test.ts` 和
  `test/graphrag-library-graph.test.ts` 对 evidence lineage 字段有断言。
- 已发布质量门包含 `evidence_map_lineage_valid` 或
  `evidence_map_links_shelf_and_book_evidence` passed。

判定：回答证据可以回链到下层 book/report/text-unit 级证据。

## D05 状态闭环与恢复：PASS_WITH_RISK

证据：

- build 采用 staging 到 current 的发布语义，quality gate passed 后才 query-ready。
- query 前调用 validator，发现 stale 诊断时返回 `upper_index_stale`。
- `test/graphrag-library-graph.test.ts` 覆盖成员 bookshelf manifest stale 后
  library 查询 fail-closed。
- Python bridge 新增 timeout 与 process group 终止逻辑，超时不再卡死或遗留子进程。

风险：

- 单书真实 GraphRAG provider/runtime 当前只达到 recoverable typed failure，
  不是成功回答。
- 对 interrupted upper-index build 的真实恢复路径仍主要依赖测试与合同，建议后续
  增加端到端中断恢复 smoke。

判定：状态闭环满足本轮通过，但外部 runtime 阻塞需保留风险标注。

## D06 质量门：PASS

证据：

- 已发布 bookshelf gate 状态：
  `status=passed`、`queryReady=true`、`readyState=bookshelf_query_ready`。
- 已发布 library gate 状态：
  `status=passed`、`queryReady=true`、`readyState=library_query_ready`。
- bookshelf gate checks 包含 schema、成员 manifest sha256、成员 package gate、
  evidence lineage、embedding fingerprint、fixed budget、sensitive scan、stale marker。
- library gate checks 包含成员 bookshelf manifest sha256、成员 gate、library
  membership gate、schema、evidence map、fixed budget、sensitive scan、stale marker。

判定：书架与 library 独立质量门已形成查询准入边界。

## D07 增量扩展：PASS_WITH_RISK

证据：

- manifest/membership 记录成员 manifest sha256、generation、成员集合。
- library membership 通过书架组织 library，避免把大量单书直接塞入交互查询。
- library stale 检测基于成员 bookshelf manifest sha256 失配 fail-closed。

风险：

- 当前实现更偏保守全量重建，增量刷新/局部 rebuild 策略尚未完整产品化。
- oversized shelf 的拆分策略已有设计与部分 membership 约束，但需要更多真实规模样本验证。

判定：满足本轮分层扩展基础要求，增量刷新属于后续增强风险。

## D08 安全与隐私：PASS

证据：

- quality gate checks 包含 `sensitive_payload_scan_passed`。
- Python bridge 对 provider payload、secret、Bearer token、`sk-*`、绝对路径做脱敏。
- published manifest 包含 `sensitivityPolicy`，未发现 raw provider payload 或
  prompt/completion 作为 upper-index 产物字段。
- `graph_vault/catalog/batch-runs/**` 未进入 upper-index 语义输入路径。

判定：可发布 upper index 的敏感信息隔离满足本轮标准。

## D09 CLI 可操作性与降级：PASS

证据：

- CLI 支持 `--bookshelf-id`、`--library-id`，并与 `--graph-book-id` 互斥。
- missing/stale/gate failed/budget/runtime 均映射为 typed error，包含 exitCode、
  retryable、scopeKind、scopeId、remediationCommand。
- `test/cli-graphrag-route.test.ts` 覆盖 missing index 和 ambiguous scope。
- `test/cli-graphrag-timeout.test.ts` 覆盖 GraphRAG provider timeout 返回 typed JSON
  `provider_unavailable`、`retryable=true`。
- library smoke 输出 timing stage `cli.query_library_upper_index`，provider metrics
  中 attempted request count 为 0。

判定：CLI 不再长时间无输出，失败路径可观测。

## D10 可测试性与非回归：PASS_WITH_RISK

证据：

- 主线程已验证：`npm run build` 通过。
- 主线程已验证：9 个相关回归文件 44 tests 通过，contracts 75 tests 通过。
- 主线程已验证：library query smoke 成功，qmd `vsearch` 成功。
- 新增测试覆盖 membership、bookshelf graph、library graph、CLI scope、timeout、
  stale fail-closed、固定预算 10/100/1000 规模。
- 单书 qmd vsearch 非回归已通过。

风险：

- 单书 GraphRAG 真实查询当前因外部 provider/runtime 超时，只能标记为
  external blocked/recoverable，不能计为成功回答。
- `src/cli/qmd.ts` 超过 6000 行，虽然新增核心能力已放入 upper-index 模块，
  但 CLI 接线继续增加了超长文件维护压力。
- `src/graphrag/upper-index/library-membership.ts`、`bookshelf-membership.ts` 等文件
  超过项目建议模块行数，后续应拆分 validator、writer、planner。

判定：测试合同充分，本轮通过但带可维护性与外部 runtime 风险。

## 必须修复项

无本轮阻断级必须修复项。

不能把单书 GraphRAG 短超时 typed failure 宣称为“成功查询”。审计结论必须保持
external blocked/recoverable 表述。

## 建议

- 后续将 `src/cli/qmd.ts` 的 upper scope 查询接线继续下沉到独立 CLI 子模块，避免
  超长文件继续增长。
- 拆分 `library-membership.ts`、`bookshelf-membership.ts` 中的 planner、schema、
  writer、validator 职责。
- 增加一次真实 interrupted upper-index build 恢复 smoke test，覆盖 staging 未发布、
  failed gate、重新 build 后 atomic publish。
- 在外部 provider/runtime 恢复后，重跑单书 `--graph-book-id` 真实查询，把当前
  recoverable blocked 风险关闭。
