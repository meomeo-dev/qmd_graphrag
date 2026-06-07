# implementation-turn_010 agent-1 实施审计报告

overallStatus: PASS_WITH_RISK

审计日期：2026-06-06

审计范围：当前工作区中 design-turn_012 后的 bookshelf 与 library
package-root 硬化实现、相关 CLI 路由、目标测试与
`implementation-turn-009-summary.md`。

审计基准：固定 10 项实施审计维度。未新增、删除、重命名、重排或改写
基准项。

## 总体结论

当前实现已经把 bookshelf 权威根 (authority root) 固定在
`graph_vault/bookshelves/{bookshelfId}/`，把 library 权威根固定在
`graph_vault/library/{libraryId}/`。查询路径通过 package-local
`CURRENT.json`、manifest、quality gate、`PUBLISH_READY.json` 和 checksum
sidecar 判定 query-ready；legacy catalog-only 上层产物返回
`upper_package_migration_required`。未发现上层包闭包写入
`graph_vault/catalog/**` 或单书包闭包的实现反例。

本轮不判定为无风险 PASS，原因是目标 `test/graphrag-library-graph.test.ts`
全文件运行在当前机器上两次触发首个用例的显式 60 秒单测超时；同一首个
用例按 `-t` 过滤单独运行通过，且其余 4 个 library 用例在全文件运行中
通过。该现象属于测试稳定性 (test stability) 风险，不是已定位的 package-root
规范反例。

## 运行证据

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- 合并运行目标测试时，180 秒命令超时前已通过 upper fail-closed、library
  5 个用例和 CLI route 前 5 个用例；随后拆分重跑。
- `test/graphrag-bookshelf-graph.test.ts`：4 个测试通过。
- `test/graphrag-library-graph.test.ts`：全文件运行中 4 个测试通过，首个
  发布用例两次触发 60 秒显式单测超时；该首个用例按 `-t` 单独运行通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 个测试通过。
- `test/graphrag-bookshelf-membership.test.ts` 与
  `test/graphrag-library-membership.test.ts`：5 个测试通过。
- `test/cli-graphrag-route.test.ts`：15 个测试通过。
- `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`：
  1 个测试通过，51 个非目标测试跳过。

## 逐项判定

### 1. 单书包复制传播完整性不回归

判定：PASS_WITH_RISK。

证据：

- bookshelf graph 发布用例断言成员单书包中不存在
  `BOOKSHELF_MANIFEST.json` 或 `semantic_units.parquet`，防止上层产物污染
  `graph_vault/books/{bookId}` 闭包：
  `test/graphrag-bookshelf-graph.test.ts:257-270`。
- bookshelf 构建读取成员书 `BOOK_MANIFEST.json`、runtime gate 与包内
  GraphRAG artifacts，并要求成员 artifact 路径仍位于对应 book root：
  `src/graphrag/upper-index/bookshelf-graph.ts:296-351`。
- CLI GraphRAG route 的单书作用域回归仍通过，`--graph-book-id` 可限定单书
  GraphRAG 查询结果：
  `test/cli-graphrag-route.test.ts:1287-1313`。

剩余风险：

- 本轮未调用真实外部 provider 执行一次生产级单书 `--graph-book-id` 成功
  回答；覆盖主要来自 fake bridge、route 与 runtime gate 测试。

必须修复项：

- 无阻断性源码修复项。若要求无风险 PASS，应在可用 provider 环境补一次
  真实单书 GraphRAG 查询验收。

### 2. 书架/library 派生索引不污染单书包

判定：PASS。

证据：

- bookshelf package root 由 helper 固定为
  `graph_vault/bookshelves/{bookshelfId}`，library 固定为
  `graph_vault/library/{libraryId}`：
  `src/graphrag/upper-index/upper-package-paths.ts:57-65`。
- bookshelf graph 构建将 staging 与 generation 建在 bookshelf package root
  下：
  `src/graphrag/upper-index/bookshelf-graph.ts:489-490`、
  `src/graphrag/upper-index/bookshelf-graph.ts:810-845`。
- library graph 构建将 staging 与 generation 建在 library package root 下：
  `src/graphrag/upper-index/library-graph.ts:392-393`、
  `src/graphrag/upper-index/library-graph.ts:713-748`。
- bookshelf 测试断言上层 package root 存在，同时 catalog projection root
  不存在：
  `test/graphrag-bookshelf-graph.test.ts:212-236`。
- library 测试断言上层 package root 存在，同时 catalog projection root
  不存在：
  `test/graphrag-library-graph.test.ts:399-423`。

剩余风险：

- 继续扩展构建器时，`bookshelf-membership.ts` 与 `library-membership.ts`
  已接近或超过项目建议行数，后续新增行为应拆分，避免边界逻辑继续堆叠。

必须修复项：

- 无。

### 3. 上层包闭包不写入 graph_vault/catalog/** 且删除 catalog projection 不影响显式查询

判定：PASS。

证据：

- legacy catalog root 仅用于识别迁移需求，非查询权威：
  `src/graphrag/upper-index/upper-package-paths.ts:68-99`、
  `src/graphrag/upper-index/upper-package-paths.ts:225-239`。
- 缺少 package root 但存在 legacy catalog-only artifact 时，
  `readQueryReadyPackage()` 返回
  `upper_package_migration_required:legacy_catalog_only`：
  `src/graphrag/upper-index/upper-package-paths.ts:250-269`。
- bookshelf 显式查询在手动创建并删除
  `graph_vault/catalog/bookshelves/{bookshelfId}` projection 后仍成功：
  `test/graphrag-bookshelf-graph.test.ts:303-318`。
- library 显式查询在手动创建并删除
  `graph_vault/catalog/library/{libraryId}` projection 后仍成功：
  `test/graphrag-library-graph.test.ts:483-498`。
- CLI legacy catalog-only bookshelf 与 library 分别返回
  `upper_package_migration_required`：
  `test/cli-graphrag-route.test.ts:999-1055`、
  `test/cli-graphrag-route.test.ts:1095-1152`。

剩余风险：

- 若未来增加 catalog projection 生成器，必须保持 projection 只承载
  routing/observability，不得把 manifest、quality gate 或 generation 闭包
  写入 catalog。

必须修复项：

- 无。

### 4. runner ledger 不参与语义检索

判定：PASS。

证据：

- bookshelf 查询入口先读取 package-local readiness，再把 generation root
  传给 parquet query bridge：
  `src/graphrag/upper-index/bookshelf-query.ts:80-117`、
  `src/graphrag/upper-index/bookshelf-query.ts:232-256`。
- library 查询入口同样只读取 package-local readiness 与 generation root：
  `src/graphrag/upper-index/library-query.ts:83-120`、
  `src/graphrag/upper-index/library-query.ts:272-296`。
- query bridge 只读取 generation root 下的 `community_reports.parquet` 和
  `evidence_map.parquet`：
  `scripts/graphrag/bookshelf_graph_bridge_query.py:96-112`。
- build-time `runs/{runId}`、events、status、checkpoints 写入 package root
  作为观测状态；查询路径不读取这些 ledger 文件：
  `src/graphrag/upper-index/bookshelf-graph.ts:647-716`、
  `src/graphrag/upper-index/library-graph.ts:542-617`。

剩余风险：

- 后续若增加 routed deepening 或 runner-aware retry，不得把 runner ledger
  当作 semantic unit 或 evidence 输入。

必须修复项：

- 无。

### 5. 查询预算不随书籍数量线性增长

判定：PASS。

证据：

- bookshelf 查询使用 manifest 内固定 `maxSemanticUnits` 与 `maxInputTokens`
  作为 `maxReports` 和 token 预算：
  `src/graphrag/upper-index/bookshelf-query.ts:169-176`、
  `src/graphrag/upper-index/bookshelf-query.ts:243-256`。
- library 查询使用 manifest 内固定 `maxSemanticUnits` 与 `maxInputTokens`：
  `src/graphrag/upper-index/library-query.ts:168-175`、
  `src/graphrag/upper-index/library-query.ts:283-296`。
- query bridge 对 reports 做固定 `maxReports` 截断，超 token 预算时返回
  `budget_exceeded_narrow_scope_required`：
  `scripts/graphrag/bookshelf_graph_bridge_query.py:96-128`。
- library 10、100、1000 book scale 模拟验证 selected reports、token 指纹与
  evidence 数量保持固定：
  `test/graphrag-library-graph.test.ts:625-727`。

剩余风险：

- 当前实现是固定预算 report search，尚未实现 LLM synthesis 或受控下钻；
  新增这些能力时必须继续保持固定 top-K、固定下钻数和 fail-closed 超预算。

必须修复项：

- 无。

### 6. evidence lineage 可追溯到 bookId/sourceId/documentId/contentHash/community report 或 text_unit

判定：PASS。

证据：

- 上层 evidence schema 要求 `targetBookId`、`targetSourceId`、
  `targetDocumentId`、`targetContentHash`、`targetCommunityReportId` 与
  `targetTextUnitId`：
  `src/graphrag/upper-index/bookshelf-graph-contracts.ts:260-272`。
- query bridge 从 `evidence_map.parquet` 输出上述 lineage 字段：
  `scripts/graphrag/bookshelf_graph_bridge_query.py:130-163`。
- bookshelf 查询响应把 evidence 映射到统一 GraphRAG response，并生成
  package-root locator：
  `src/graphrag/upper-index/bookshelf-query.ts:292-328`。
- library 查询响应同样保留 book/source/document/content/text-unit lineage
  和 library package-root locator：
  `src/graphrag/upper-index/library-query.ts:332-369`。
- bookshelf 测试断言 evidence 包含 bookId、sourceId、documentId、
  contentHash、graphTextUnitId 与 `bookshelves/.../generations/...` locator：
  `test/graphrag-bookshelf-graph.test.ts:292-301`。
- library 测试断言 evidence 指向 library generation locator 且保留
  target bookshelf metadata：
  `test/graphrag-library-graph.test.ts:474-481`。

剩余风险：

- 当前 answer text 是 deterministic report search summary；未来接入 LLM
  synthesis 时必须保证引用仍从 evidence map 回链，不得只输出孤立摘要。

必须修复项：

- 无。

### 7. staging/failed/running/pending/stale 产物不能被查询路径当 ready

判定：PASS_WITH_RISK。

证据：

- `readQueryReadyPackage()` 要求 `CURRENT.json` 和 sidecar 存在且匹配，
  `current.current` 必须等于 `generations/{generation}`，manifest 必须位于
  current generation 下：
  `src/graphrag/upper-index/upper-package-paths.ts:158-217`。
- 查询前要求 `current.queryReady === true` 且 readyState 等于 scope 对应的
  `bookshelf_query_ready` 或 `library_query_ready`：
  `src/graphrag/upper-index/upper-package-paths.ts:270-276`。
- package-local manifest、root manifest、generation/root quality gate、
  `PUBLISH_READY.json` 与所有 sidecar 均纳入 readiness 校验：
  `src/graphrag/upper-index/upper-package-paths.ts:277-346`。
- bookshelf `CURRENT.readyState = "running"` 时 validator 与 query 均
  fail closed：
  `test/graphrag-bookshelf-graph.test.ts:345-405`。
- library `CURRENT.readyState = "pending"` 时 validator 与 query 均
  fail closed：
  `test/graphrag-library-graph.test.ts:555-623`。
- stale member book 与 stale member bookshelf 均返回 `upper_index_stale`：
  `test/graphrag-bookshelf-graph.test.ts:407-470`、
  `test/graphrag-library-graph.test.ts:734-812`。

剩余风险：

- 测试覆盖了 running、pending 和 stale，尚未对 failed 与 staging 状态分别
  建立 CLI 级 fixture。实现的 readyState 等值检查应能拒绝这些状态，但测试
  证据仍不完整。

必须修复项：

- 增加 failed 与 staging 状态的显式 validator/query/CLI fail-closed fixture，
  使第 7 项具备完整状态枚举证据。

### 8. manifest/quality gate/publish marker 状态闭环完整

判定：PASS。

证据：

- bookshelf graph 在 staging 内写 gate、diagnostics、events、status、
  recovery summary、checkpoints 与 manifest，验证通过后才 promote 到
  `generations/{generation}`，再写 root `CURRENT.json`、root manifest、
  root quality gate 与 `PUBLISH_READY.json`：
  `src/graphrag/upper-index/bookshelf-graph.ts:639-845`。
- library graph 采用同样闭环：
  `src/graphrag/upper-index/library-graph.ts:534-748`。
- query-ready helper 校验 root manifest 与 generation manifest 内容一致，
  root/generation gate 内容一致，`PUBLISH_READY` 的 scope、generation、
  readyState、manifestPath、qualityGatePath、currentPath 与 manifest sha
  一致：
  `src/graphrag/upper-index/upper-package-paths.ts:295-346`。
- 缺少 required quality-gate check 时 bookshelf 与 library validator 均失败：
  `test/graphrag-bookshelf-graph.test.ts:320-339`、
  `test/graphrag-library-graph.test.ts:527-547`。

剩余风险：

- 当前 build-time failure recovery 以 passed path 为主；中断恢复、失败重试和
  partial publish 防护已有结构性状态文件，但还不是完整管理命令体验。

必须修复项：

- 无。

### 9. CLI typed error 与 timing 可观测

判定：PASS_WITH_RISK。

证据：

- 上层 typed error code 集合覆盖 missing、ambiguous、migration required、
  stale、quality gate failed、budget exceeded 和 runtime error：
  `src/cli/graphrag-query-scope.ts:15-23`。
- error detail 映射提供 exitCode、retryable、remediationCommand 与
  timingAvailable：
  `src/cli/graphrag-query-scope.ts:100-182`。
- CLI 对 book/bookshelf/library 互斥 scope 返回 typed error：
  `src/cli/qmd.ts:3507-3531`。
- CLI 在 capability 与 query 阶段捕获 bookshelf/library scope errors，并
  保留 timing label：
  `src/cli/qmd.ts:3571-3636`、
  `src/cli/qmd.ts:3653-3729`。
- CLI route 测试覆盖 missing upper index、legacy catalog-only migration
  required、scope ambiguity、timingAvailable 与 remediation command：
  `test/cli-graphrag-route.test.ts:980-1224`。
- polluted parquet CLI fail-closed 测试验证 exit code 65、JSON typed error、
  timingAvailable 与 redacted diagnostics：
  `test/cli-graphrag-upper-index-failclosed.test.ts:247-288`。

剩余风险：

- 上层 query response 内部 `runtimeMetrics` 的 stage duration 仍为 0，
  主要表达 fixed-budget logical stage；CLI timing wrapper 已有真实阶段标签。

必须修复项：

- 若要求无风险 PASS，应把上层 query response runtime metrics 改为真实测量值，
  或在 schema/文档中明确它是 logical fixed-budget metric。

### 10. 敏感信息、绝对路径、provider payload、raw prompt/completion 不进入可发布索引，现有单书 GraphRAG 查询和 qmd vsearch 不回归

判定：PASS_WITH_RISK。

证据：

- bookshelf/library manifest 均包含 sensitivityPolicy 与 forbidden fields；
  build 时对 manifest 与 quality gate 做 forbidden text 扫描：
  `src/graphrag/upper-index/bookshelf-graph.ts:785-791`、
  `src/graphrag/upper-index/library-graph.ts:688-694`。
- parquet inspect bridge 扫描 provider payload、raw prompt/completion、
  credential、Bearer token、query.log 和绝对路径：
  `scripts/graphrag/bookshelf_graph_bridge_inspect.py:15-56`、
  `scripts/graphrag/bookshelf_graph_bridge_inspect.py:116-164`。
- bookshelf 与 library parquet 被注入 provider payload、Bearer token 和
  `/Users/.../query.log` 后，validator 与 query 均 fail closed：
  `test/graphrag-bookshelf-graph.test.ts:472-545`、
  `test/graphrag-library-graph.test.ts:814-895`。
- CLI fail-closed 测试验证 stderr 不泄漏 token 或绝对路径：
  `test/cli-graphrag-upper-index-failclosed.test.ts:218-288`。
- qmd vsearch 轻量回归测试通过：
  `test/cli/basic.test.ts:747-760`。

剩余风险：

- 单书 GraphRAG 真实 provider 成功回答未在本轮执行；已有覆盖主要来自
  fake bridge route、scope、timeout 与 hotplug runtime gate。

必须修复项：

- 无阻断性源码修复项。若要求无风险 PASS，应补真实 provider 条件下的单书
  GraphRAG 成功查询验收。

## 必须修复项汇总

1. 稳定 `test/graphrag-library-graph.test.ts` 全文件运行。建议拆分首个发布
   用例的重型 fixture、减少重复构建，或提高该用例内联 60 秒 timeout，使
   目标测试套件可在当前机器上稳定一次性通过。
2. 增加 failed 与 staging 状态的 validator/query/CLI fail-closed fixture，
   补齐第 7 项状态枚举证据。
3. 若目标是无风险 PASS，补充上层 query response runtime metrics 的真实
   duration，或将其明确标注为 logical fixed-budget metric。
4. 若目标是无风险 PASS，在 provider/runtime 可用环境补一次真实单书
   `--graph-book-id` 成功查询验收。

## 剩余风险汇总

- `test/graphrag-library-graph.test.ts` 全文件当前存在运行时长波动，削弱
  implementation-turn_010 的一次性目标测试证据。
- failed/staging 状态缺少独立 CLI fixture，虽然 readyState 等值检查已能
  fail closed。
- runtime metrics 对内仍是 logical marker，对外 CLI timing 已可观测。
- 后续 LLM synthesis、routed deepening、catalog projection 生成和 library
  管理命令尚未纳入本轮实现；新增这些能力时必须保持 package-root 权威、
  固定查询预算和 evidence lineage。
