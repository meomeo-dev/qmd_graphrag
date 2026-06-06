# implementation-turn_008 / agent-3 审计报告

## 结论：PASS_WITH_RISK

当前实现已把书架与 library 作为 `graph_vault/catalog/**` 下的可重建派生索引接入，
并完成 membership、graph build、query、typed error、质量门、stale fail-closed、
fixed-budget 测试和真实 library smoke。未发现需要立即阻断书架/library 发布的合同
违背项。

保留风险是：单书 GraphRAG 真实查询目前是 external blocked/recoverable，短超时可
返回 retryable `provider_unavailable` 且无残留进程，但没有形成成功回答；此外敏感
信息扫描主要覆盖 manifest/gate 文本与字段策略，对 parquet 内容的显式反例测试仍
偏弱。

## D01 权威边界与热插包隔离：PASS

证据：书架构建从成员 `BOOK_MANIFEST.json`、包内 GraphRAG artifact 和 runtime gate
读取，不写回单书包；成员 artifact 还要求位于 book root 内。见
`src/graphrag/upper-index/bookshelf-graph.ts:340-358`、`:493-540`。实际发布物位于
`graph_vault/catalog/bookshelves/**/current` 与 `graph_vault/catalog/library/**/current`。

风险：无直接污染单书包证据；仍需在最终回归中保持单书包质量门重跑。

## D02 固定查询预算：PASS

证据：书架/library manifest 记录 `maxSemanticUnits`、`maxInputTokens`、deepening
上限；构建阶段预算 simulation 超限会抛
`budget_exceeded_narrow_scope_required`。见 `bookshelf-graph.ts:391-423`、
`library-graph.ts:298-330`。查询阶段从 manifest 读取固定
`maxReports/maxInputTokens`，library capability 只选 fixed deepening shelves。见
`library-query.ts:144-151`、`:198-202`。测试覆盖 10/100/1000 模拟规模，
`selectedReportCount=3` 且预算 fingerprint 不变，见
`test/graphrag-library-graph.test.ts:426-527`。

风险：当前 upper query 是 deterministic report search，LLM synthesis 尚未接入；
后续接入 LLM 时必须继承同一预算门。

## D03 GraphRAG 语义对齐 / batch-runs 排除：PASS

证据：书架构建读取 community_reports、entities、relationships、text_units；
library 构建读取已发布书架 community_reports/evidence_map。见
`bookshelf-graph.ts:527-540`、`library-graph.ts:422-441`。upper-index 代码未读取
`graph_vault/catalog/batch-runs/**`；`rg` 只发现自身 `runs/**/events.jsonl` 作为
局部 ledger，不作为 semantic input。

风险：当前 query synthesis 更接近预计算 community report 检索，尚不是完整
GraphRAG map-reduce LLM 综合；设计中已标为 remaining capability。

## D04 证据可追溯：PASS

证据：合同要求 evidence_map 包含 `targetBookId`、`targetSourceId`、
`targetDocumentId`、`targetContentHash`、`targetCommunityReportId`、
`targetTextUnitId`。见 `bookshelf-graph-contracts.ts:358-383`。查询响应把这些字段
映射到 evidence lineage，并附 upper report metadata。见
`bookshelf-query.ts:260-320`、`library-query.ts:300-360`。真实 library 产物
evidence rows=46。

风险：library 代表 capability 使用每个书架的第一个 book 作为 capability
representative，适合路由占位，但不是完整 lineage；真实 evidence 输出已覆盖具体
book。

## D05 状态闭环与恢复：PASS

证据：构建使用 staging root，生成 run status、events、recovery-summary、
checkpoints，再发布 current generation；library 和 bookshelf 都记录 generation 与
成员 manifest sha。见 `library-graph.ts:388-416`、`:501-530`、`:539-560`。查询前
validator 会重新校验成员 manifest sha，stale 时返回 `upper_index_stale`。见
`library-query.ts:88-130`。

风险：当前恢复记录是最小闭环，不是完整断点续建；但 partial build 不会被 current
查询路径当 ready 使用。

## D06 质量门：PASS_WITH_RISK

证据：bookshelf/library quality gate 均有 13 项 required checks，包括 schema、edge
relation、evidence、embedding、fixed budget、sensitive scan、stale marker。见
`bookshelf-graph-contracts.ts:358-372`、`library-graph-contracts.ts:136-150`。
validator 校验 manifest/gate、checksum、file closure、parquet schema、成员 gate 和
stale。实际 `software-architecture-core`、`delivery-devops-core`、
`software-engineering-library` 的 gate 均 passed。

风险：`sensitive_payload_scan_passed` 当前主要通过 manifest/gate 文本扫描和
forbidden field policy 支撑；建议增加 parquet artifact 污染反例测试。

## D07 增量扩展：PASS_WITH_RISK

证据：generation hash 包含 builderVersion、membershipGeneration、
memberManifestSha256 和预算参数；成员变更会生成新 generation 或 stale。见
`bookshelf-graph.ts:374-388`、`library-graph.ts:281-295`。library 以已发布 bookshelf
为输入，限制重建影响范围。

风险：实现已支持保守重建和 stale 检测；尚未实现更细粒度增量刷新管理命令。

## D08 安全与隐私：PASS_WITH_RISK

证据：ForbiddenFields 包含 provider payload、raw prompt/completion、apiKey、
credential、absoluteLocalPath、queryLogContent。见
`bookshelf-graph-contracts.ts:374-383`。manifest 写入前对 redacted sensitivity
policy、quality gate 做 forbidden text scan，见 `bookshelf-graph.ts:425-445`、
`:781-787`，library 同理见 `library-graph.ts:336-353`、`:685-691`。

风险：缺少对 parquet 内容和 evidence quote 的独立敏感污染测试；当前依赖输入包
闭包安全与构建输入边界。

## D09 CLI 可操作性与 typed error/timing：PASS

证据：CLI 新增 `--bookshelf-id`、`--library-id`，并强制与 `--graph-book-id` 互斥；
missing/stale/gate/budget/runtime 映射为 typed error、exitCode、retryable 和
remediationCommand。见 `src/cli/graphrag-query-scope.ts:15-147`、
`src/cli/qmd.ts:3501-3718`。上层查询 timing stage 为
`cli.query_bookshelf_upper_index` / `cli.query_library_upper_index`。timeout 测试覆盖
provider_unavailable typed JSON。

风险：upper query 的 providerDetail runtime duration 目前为 0，真实 wall timing
依赖 CLI timing recorder；建议后续让 parquet bridge 返回实际阶段耗时。

## D10 可测试性与单书非回归：PASS_WITH_RISK

证据：主线程验证结果包括 `npm run build`、相关 44 tests、contracts 75 tests、
library query smoke、qmd vsearch 成功。新增测试覆盖 stale fail-closed、budget
error、10/100/1000 fixed budget、CLI missing upper index、provider timeout 不重试和
子进程清理。短超时后进程检查未发现残留 GraphRAG query bridge。

风险：单书 qmd vsearch 已通过；单书 GraphRAG 真实回答未通过，当前状态是
external blocked/recoverable typed failure，不应计为成功回答。最终完成声明前需要
在 provider/runtime 可用时重跑一次单书 `--graph-book-id` 成功回答，或明确保留
外部阻塞状态。

## 必须修复项

无代码级阻断修复项。

最终完成签收前的运行条件：单书 GraphRAG 真实 provider/runtime 需要成功回答一次；
若外部仍不可用，应继续标记为 blocked/recoverable，而不是通过。

## 建议

1. 增加 upper parquet 敏感污染反例：在 semantic_units/community_reports/evidence_map
   注入 forbidden field 或绝对路径，验证 gate/query fail-closed。
2. 为 bookshelf 也补一个与 library 对称的 stale member manifest query fail-closed
   测试。
3. 让 upper query bridge 返回真实 bridge duration 和 stage timing，替代
   providerDetail 中的 0ms 占位。
4. 后续实现 LLM synthesis 或 bounded deepening 时，先扩展 Type DD 与测试预算合同，
   再接入代码。
