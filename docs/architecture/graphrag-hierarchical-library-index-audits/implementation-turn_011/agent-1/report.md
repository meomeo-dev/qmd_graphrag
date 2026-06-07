overallStatus: PASS_WITH_RISK

# implementation-turn_011 agent-1 实施审计报告

## 审计结论

本轮只读复审未发现阻断项。implementation-turn_010 后的三项主控修复已经
形成可验证闭环：

- F-001：`upper-package-paths.ts` 已在通用路径层统一拒绝非法
  bookshelf/library scope id。
- F-002：library bridge 与 upper parquet inspect 已对缺失或 `unknown-*`
  lower evidence lineage fail closed。
- runtime metrics：bookshelf/library 上层查询已使用真实 bridge elapsed time，
  不再固定写入 `0`。

结论保持 `PASS_WITH_RISK`，原因是本地复审无法确认真实外部 provider 条件下的
单书 `--graph-book-id` 成功回答；failed/staging 全状态枚举的独立 CLI fixture
覆盖仍不完整。上述风险不阻断本轮 F-001/F-002/runtimeMetrics 修复闭环，但仍
应保留在总收敛清单中。

## 必须修复项

无。

## 审计范围

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定设计审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 主控 turn_010 汇总：
  `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-010-summary.md`
- 核查重点：
  `src/graphrag/upper-index/upper-package-paths.ts`
  `scripts/graphrag/library_graph_bridge_build.py`
  `scripts/graphrag/bookshelf_graph_bridge_inspect.py`
  `src/graphrag/upper-index/bookshelf-query.ts`
  `src/graphrag/upper-index/library-query.ts`

## 本轮验证

- `yaml.parse` Type DD：通过。
- `test/cli-graphrag-query-scope.test.ts`：8 个测试通过。
- `test/graphrag-library-graph.test.ts`：7 个测试通过。
- `test/graphrag-bookshelf-graph.test.ts`
  与 `test/cli-graphrag-upper-index-failclosed.test.ts`：5 个测试通过。

## 1. 单书包复制传播完整性不回归

判定：`PASS_WITH_RISK`。

证据：

- 上层 package root 明确位于 `graph_vault/bookshelves/{bookshelfId}` 与
  `graph_vault/library/{libraryId}`，不进入 `graph_vault/books/{bookId}`。
- bookshelf graph 测试断言成员单书包内不存在 `BOOKSHELF_MANIFEST.json`
  或 `semantic_units.parquet` 等上层产物。
- 主控送审前已通过 book hotplug runtime/capability 与 qmd vsearch 目标回归。

剩余风险：

- 本轮未连接真实外部 provider 执行生产级单书 `--graph-book-id` 成功回答，
  因此该项不能升级为无风险 `PASS`。

## 2. 书架/library 派生索引不污染单书包

判定：`PASS`。

证据：

- bookshelf graph build 与 library graph build 均写入各自上层包闭包。
- `readQueryReadyPackage()` 只校验 package-local `CURRENT.json`、
  manifest、quality gate、`PUBLISH_READY.json` 与 sidecar。
- bookshelf 测试覆盖成员单书包未被写入上层 manifest 或 parquet。

剩余风险：

- 未发现与本维度相关的阻断风险。

## 3. 上层包闭包不写入 catalog，删除 catalog projection 不影响显式查询

判定：`PASS`。

证据：

- Type DD 与 final summary 均保持 catalog 为 projection、routing、
  observability，而非 package authority。
- `upper-package-paths.ts` 的 package root 指向 `bookshelves` 与 `library`，
  legacy catalog root 只用于检测 catalog-only 旧产物并返回迁移错误。
- bookshelf/library 测试均覆盖删除 catalog projection 后显式 package 查询
  仍返回 evidence。
- legacy catalog-only 上层产物映射为
  `upper_package_migration_required` typed error。

剩余风险：

- 从上层包反向生成 catalog projection 仍标为后续能力，不影响显式
  package-root 查询闭环。

## 4. runner ledger 不参与语义检索

判定：`PASS`。

证据：

- 上层查询路径读取 package-local manifest、quality gate、
  `community_reports.parquet`、`evidence_map.parquet` 和相关 parquet
  语义产物。
- 搜索未发现 upper-index 查询路径读取
  `graph_vault/catalog/batch-runs/**` 作为语义输入。
- Type DD 继续约束 runner ledger 只能作为 observability state。

剩余风险：

- 未发现与本维度相关的阻断风险。

## 5. 查询预算不随书籍数量线性增长

判定：`PASS`。

证据：

- bookshelf/library 查询输入使用固定 `maxReports` 与 `maxInputTokens`。
- library graph 测试覆盖 10、100、1000 book scale，断言
  `selectedReportCount`、semantic unit 数和 evidence 数不随成员书数量线性增长。
- 预算过小时返回 `budget_exceeded_narrow_scope_required`。

剩余风险：

- 当前实现是固定预算 community report 检索闭环，LLM synthesis 与受控下钻
  仍属后续能力。

## 6. evidence lineage 可追溯

判定：`PASS`。

证据：

- `library_graph_bridge_build.py` 中 `_required_lower_lineage()` 要求
  `targetBookId`、`targetSourceId`、`targetDocumentId`、
  `targetContentHash`、`targetCommunityReportId`、`targetTextUnitId`
  与 `targetArtifactDigest` 非空且不以 `unknown-` 开头。
- 找不到下层 evidence 时，library bridge 返回
  `{ ok: false, diagnostics: [...] }`，不生成可发布占位 lineage。
- `bookshelf_graph_bridge_inspect.py` 对 `evidence_map.parquet` 执行同一组
  lineage 字段诊断，拒绝缺失或 `unknown-*` 值。
- library graph 测试覆盖 build-time 缺失下层 evidence fail closed，
  以及 published artifact 中 `unknown-book` fail closed。

剩余风险：

- 未发现与 F-002 相关的残留阻断项。

## 7. staging/failed/running/pending/stale 不能被查询路径当作 ready

判定：`PASS_WITH_RISK`。

证据：

- `readQueryReadyPackage()` 要求 `queryReady=true` 且 readyState 匹配
  `bookshelf_query_ready` 或 `library_query_ready`。
- `CURRENT.json.sha256`、generation/root manifest、generation/root quality gate、
  `PUBLISH_READY.json` 及各 sidecar 均纳入查询前校验。
- bookshelf `CURRENT.readyState=running` 与 library
  `CURRENT.readyState=pending` 均被测试为 fail closed。
- bookshelf member stale 与 library member bookshelf stale 均被测试为
  fail closed。

剩余风险：

- failed/staging 全状态枚举的独立 CLI fixture 覆盖仍不完整，因此保持风险。

## 8. manifest、quality gate、publish marker 状态闭环完整

判定：`PASS`。

证据：

- package-local root 与 generation manifest sha256 必须一致。
- root 与 generation quality gate sha256 必须一致。
- `PUBLISH_READY.json` 必须与 scope kind/id、generation、manifest sha256、
  readyState、manifest path、quality gate path 和 `CURRENT.json` 指针一致。
- manifest file closure 会校验路径合法性、文件存在性、bytes、sha256 与
  sidecar。

剩余风险：

- 未发现与本维度相关的阻断风险。

## 9. CLI typed error 与 timing 可观测

判定：`PASS`。

证据：

- CLI typed error 覆盖 missing scope、ambiguous scope、missing upper index、
  legacy migration、stale、quality gate failure、budget exceeded 与 runtime error。
- `bookshelf-query.ts` 记录 bridge 调用前时间，并把 elapsed time 写入
  `totalDurationMs`、stage `durationMs` 和 `loggedComputeDurationMs`。
- `library-query.ts` 同步使用真实 bridge elapsed time。
- `rg` 未在 upper-index 查询实现中发现 `totalDurationMs: 0`、
  `durationMs: 0` 或 `loggedComputeDurationMs: 0` 固定写法。

剩余风险：

- 本轮测试确认 runtime metrics 不再是固定 `0` 写法；未发现阻断风险。

## 10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归

判定：`PASS_WITH_RISK`。

证据：

- `bookshelf_graph_bridge_inspect.py` 对 provider payload、raw prompt、
  raw completion、credential、bearer token、query.log 和绝对路径进行敏感
  信息扫描。
- bookshelf 与 library 测试均覆盖 polluted upper parquet fail closed。
- 主控送审前已通过 qmd vsearch 目标回归、book hotplug runtime gate 与
  capability scope 测试。

剩余风险：

- 真实外部 provider 条件下的单书 `--graph-book-id` 成功回答仍未执行。
- 完整 CLI failed/staging fixture 覆盖仍需补齐。

## 总体剩余风险

- implementation-turn_010 的正式三代理报告仍是 `PASS_WITH_RISK`，本轮仅确认
  其后 F-001、F-002 与 runtimeMetrics 修复在 agent-1 视角已闭环。
- 真实 provider 环境下单书 GraphRAG 查询成功回归未验证。
- failed/staging 全状态枚举的独立 CLI fixture 仍不完整。
- catalog projection 生成、LLM synthesis、受控下钻和 library 管理命令仍是
  后续能力，不应被误标为已完成。
