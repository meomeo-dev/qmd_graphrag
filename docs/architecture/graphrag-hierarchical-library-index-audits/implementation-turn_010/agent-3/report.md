# implementation-turn_010 agent-3 实施审计报告

overallStatus: `PASS_WITH_RISK`

审计结论：当前实现已满足 design-turn_012 后 package-root 规范的核心
不变量：bookshelf 权威根为 `graph_vault/bookshelves/{bookshelfId}/`，
library 权威根为 `graph_vault/library/{libraryId}/`，`graph_vault/catalog/**`
仅作为 projection、routing 与 observability 视图。legacy catalog-only
上层产物在查询路径返回 `upper_package_migration_required`，未被当作
query-ready authority。

保留 `PASS_WITH_RISK` 的原因不是 package-root 合规失败，而是实施证据仍
存在外部与覆盖风险：真实外部 provider 条件下的单书 `--graph-book-id`
成功查询未执行，failed/staging 全状态枚举缺少独立 CLI fixture，上层查询
response 内部 runtimeMetrics 仍是 fixed-budget logical marker。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定维度：用户指定的 10 项实施审计维度。
- 重点规范：
  - bookshelf package root:
    `graph_vault/bookshelves/{bookshelfId}/`
  - library package root:
    `graph_vault/library/{libraryId}/`
  - catalog 仅为 projection/routing/observability。
  - legacy catalog-only 必须 fail closed 为
    `upper_package_migration_required`。
- 工作区状态：审计期间检测到多处既有未提交修改。本报告未回退、未覆盖
  其它修改；写入范围仅限本文件。

## 验证命令

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-bookshelf-graph.test.ts`
  通过，4 个测试通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-library-graph.test.ts`
  在首个用例的 60 秒单测阈值处超时；同文件其余 4 个测试通过。
  该首个用例随后以 120 秒单测阈值单独复跑通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-library-graph.test.ts -t "publishes a query-ready library graph from two published bookshelves"`
  通过，1 个目标测试通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-bookshelf-membership.test.ts test/graphrag-library-membership.test.ts`
  通过，5 个测试通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli-graphrag-query-scope.test.ts test/cli-graphrag-upper-index-failclosed.test.ts`
  通过，8 个测试通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli-graphrag-route.test.ts`
  通过，15 个测试通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-book-hotplug-catalog.test.ts`
  通过，12 个测试通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-book-hotplug-runtime-gate.test.ts test/graphrag-capability-scope.test.ts`
  通过，12 个测试通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli-graphrag-timeout.test.ts`
  通过，1 个测试通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`
  通过，1 个目标测试通过，51 个非目标测试按过滤条件跳过。

补充说明：一次合并大批次 vitest 命令在 180 秒进程超时前已有 15 个用例
通过，但未形成完整批次结论；最终结论以上述拆分复跑结果为准。

## 逐项判定

### 1. 单书包复制传播完整性不回归

判定：`PASS_WITH_RISK`

证据：

- 单书 hotplug catalog projection、runtime gate、capability scope 已通过：
  `test/graphrag-book-hotplug-catalog.test.ts` 12 个测试通过，
  `test/graphrag-book-hotplug-runtime-gate.test.ts` 与
  `test/graphrag-capability-scope.test.ts` 合计 12 个测试通过。
- CLI 单书 GraphRAG 路由仍可工作。`test/cli-graphrag-route.test.ts`
  覆盖 `qmd query --graphrag --json` 成功、非 JSON evidence 投影、
  `--graph-book-id` 选择单书输出、多书歧义 fail closed。
- `test/cli/basic.test.ts` 的 qmd `vsearch` 目标回归通过。
- bookshelf graph 测试断言成员单书包内不存在上层
  `BOOKSHELF_MANIFEST.json` 或 `semantic_units.parquet`，避免上层产物写回
  单书闭包。

剩余风险：

- 单书 `--graph-book-id` 成功路径使用 fake bridge 验证路由与输出投影，
  未在真实外部 provider/runtime 可用条件下完成一次端到端成功回答。
  该项仍应标为外部风险（external provider risk）。

必须修复项：无阻断项。

### 2. 书架/library 派生索引不污染单书包

判定：`PASS`

证据：

- `bookshelfPackageRoot()` 与 `libraryPackageRoot()` 分别解析到
  `bookshelves/{id}` 和 `library/{id}`，不指向单书包或 catalog。
- bookshelf graph 测试在构建后断言单书包下不存在
  `BOOKSHELF_MANIFEST.json` 与 `semantic_units.parquet`。
- library graph 构建从已发布 bookshelf package 派生，不把 library manifest
  或 library parquet 写入成员 book package。
- membership 和 graph 测试均通过，证明派生索引闭包与单书闭包分离。

剩余风险：无新增风险。

必须修复项：无。

### 3. 上层包闭包不写入 catalog 且删除 catalog projection 不影响显式查询

判定：`PASS`

证据：

- `upper-package-paths.ts` 中 package root helper 明确使用
  `graph_vault/bookshelves/{bookshelfId}` 与
  `graph_vault/library/{libraryId}`。legacy catalog helper 仅用于 legacy
  检测。
- `readQueryReadyPackage()` 先检查 package root；只有 package root 缺失且
  legacy catalog artifacts 存在时，才抛出
  `upper_package_migration_required:legacy_catalog_only`。
- bookshelf graph 测试先创建
  `graph_vault/catalog/bookshelves/{bookshelfId}/projection.json`，再删除该
  projection，随后显式调用 `queryBookshelfGraph()` 并取得 evidence。
- library graph 测试对
  `graph_vault/catalog/library/{libraryId}/projection.json` 执行同样创建、
  删除、显式查询成功断言。
- CLI route 测试覆盖 bookshelf 与 library legacy catalog-only typed error。

剩余风险：catalog projection 生成能力仍属后续能力，不影响当前显式
package-root 查询合规。

必须修复项：无。

### 4. runner ledger 不参与语义检索

判定：`PASS`

证据：

- bookshelf/library 查询路径通过 `readQueryReadyPackage()`、manifest、
  quality gate、`community_reports.parquet` 与 `evidence_map.parquet`
  读取 package-local 查询输入。
- `bookshelf_graph_bridge_query.py` 只读取传入 `outputRoot` 下的
  `community_reports.parquet` 和 `evidence_map.parquet`，未读取
  `runs/**`、`events.jsonl` 或 `graph_vault/catalog/batch-runs/**`。
- `test/graphrag-capability-scope.test.ts` 通过，覆盖 scoped query 跳过
  无关 damaged run records。

剩余风险：未发现 runner ledger 被用作语义输入。

必须修复项：无。

### 5. 查询预算不随书籍数量线性增长

判定：`PASS`

证据：

- bookshelf/library 查询默认 `maxReports` 与 `maxInputTokens` 来自 manifest
  的 `fixedQueryBudget`。
- bridge query 只选择固定 `maxReports` 个 upper community report，并在
  `estimatedInputTokens > maxInputTokens` 时返回
  `budget_exceeded_narrow_scope_required`。
- library scale 测试模拟 10、100、1000 book，断言
  `selectedReportCount`、`estimatedInputTokens`、evidence 数量形成固定
  fingerprint，并覆盖 over-budget typed failure。

剩余风险：当前上层回答为 fixed-budget report search，LLM synthesis 与受控
deepening 尚未实现；但已实现路径不随书籍数量线性增长。

必须修复项：无。

### 6. evidence lineage 可追溯

判定：`PASS`

证据：

- bookshelf query response 将 evidence 映射为 `bookId`、`sourceId`、
  `documentId`、`contentHash`、`graphTextUnitId`、community report artifact
  与 package-root locator。
- library query response 同样保留 `bookId`、`sourceId`、`documentId`、
  `contentHash`、`graphTextUnitId`、target bookshelf、community report
  与 digest metadata。
- bookshelf graph 测试断言 evidence 包含 book/source/document/contentHash/
  textUnit，并断言 locator 指向
  `bookshelves/{id}/generations/{generation}/community_reports.parquet`。
- library graph 测试断言 evidence 包含 library scope metadata、target
  bookshelf 与
  `library/{id}/generations/{generation}/community_reports.parquet` locator。

剩余风险：真实 LLM synthesis 尚未落地，未来 synthesis 需要继续保持每条
回答证据引用 published artifacts。

必须修复项：无。

### 7. staging/failed/running/pending/stale 产物不能被查询路径当 ready

判定：`PASS_WITH_RISK`

证据：

- `readQueryReadyPackage()` 要求 `CURRENT.json.queryReady === true`，并要求
  `CURRENT.readyState` 精确匹配 `bookshelf_query_ready` 或
  `library_query_ready`。
- `CURRENT.json.sha256`、manifest sha、root/generation manifest、root/
  generation quality gate、`PUBLISH_READY.json` 与 sidecar 均在查询前校验。
- bookshelf 测试将 `CURRENT.readyState` 改为 `running`，validator 与 query
  均 fail closed。
- library 测试将 `CURRENT.readyState` 改为 `pending`，validator 与 query
  均 fail closed。
- bookshelf 测试覆盖成员 book manifest stale 后 query 返回
  `upper_index_stale`。
- library 测试覆盖成员 bookshelf manifest stale 后 query 返回 stale 诊断。

剩余风险：

- 当前测试覆盖了 `running`、`pending` 与 stale 反例，但没有为所有
  `failed`、`staging` 状态枚举增加独立 CLI fixture。实现的 readyState
  精确匹配原则可防御这些状态，但覆盖证据仍不完整。

必须修复项：无阻断项。转为无风险 PASS 前，应补齐 failed/staging CLI
fixture。

### 8. manifest/quality gate/publish marker 状态闭环完整

判定：`PASS`

证据：

- `readPackageCurrent()` 校验 `CURRENT.json` schema、scope、相对路径、
  `current === generations/{generation}`、generation-local manifest 与
  manifest checksum。
- `readQueryReadyPackage()` 校验 root/generation manifest 内容一致、
  root/generation quality gate 内容一致、各 sidecar 一致、
  `PUBLISH_READY` scope/generation/readyState/manifestPath/
  qualityGatePath/currentPath/manifestSha256 一致。
- bookshelf 与 library validator 均校验 manifest、quality gate、
  required checks、manifest files、sidecar 与 parquet inspection。
- bookshelf/library graph 测试均包含删除 required quality check 后
  validator 报出 missing check 的反例。

剩余风险：无阻断风险。该闭环已覆盖 query-ready 前置检查。

必须修复项：无。

### 9. CLI typed error 与 timing 可观测

判定：`PASS_WITH_RISK`

证据：

- `test/cli-graphrag-query-scope.test.ts` 覆盖
  `upper_index_missing`、`upper_package_migration_required`、
  `upper_index_runtime_error` 的 exit code、retryable、remediation command
  与 `timingAvailable` 字段。
- `test/cli-graphrag-route.test.ts` 覆盖 missing bookshelf/library upper
  index、legacy catalog-only migration error、book 与 upper scope ambiguity、
  多书 GraphRAG scope ambiguity。
- `test/cli-graphrag-upper-index-failclosed.test.ts` 覆盖 sensitive parquet
  污染时 CLI 返回 typed JSON、exit code 65、`timingAvailable: true`，
  且 stderr 不泄露 token 或绝对路径。
- `test/cli-graphrag-timeout.test.ts` 覆盖 provider timeout typed JSON。

剩余风险：

- bookshelf/library query response 内部 `providerDetail.runtimeMetrics`
  仍使用 0ms stage duration 和 logical fixed-budget stage marker。外层 CLI
  typed timing 可观测已覆盖，但内部 stage duration 尚非真实耗时分解。

必须修复项：无阻断项。若要求 observability 无风险 PASS，应补真实 upper
stage duration 或明确该字段是 logical marker。

### 10. 敏感信息、绝对路径、provider payload、raw prompt/completion 不进入可发布索引，现有单书 GraphRAG 查询和 qmd vsearch 不回归

判定：`PASS_WITH_RISK`

证据：

- bookshelf sensitive parquet 测试注入 `providerRequestPayload`、
  `rawPrompt`、Bearer token 与绝对 `query.log` 路径后，validator fail
  closed。
- library sensitive parquet 测试覆盖同类污染 fail closed。
- CLI fail-closed 测试注入 token 与绝对路径后，stderr 不包含泄露值，返回
  `upper_quality_gate_failed` typed JSON。
- 单书 GraphRAG route 测试、`--graph-book-id` fake bridge 测试、timeout
  typed JSON 测试均通过。
- qmd `vsearch` 目标回归通过。

剩余风险：

- 真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未执行，不能
  证明 provider runtime 在真实凭据和网络条件下无回归。该项应保留为外部
  provider risk，而不是 package-root 实现阻断项。

必须修复项：无阻断项。

## implementation-turn_009 覆盖性复核

implementation-turn_009 summary 中列出的命令基本覆盖 10 项维度，且本轮已
对关键命令重新拆分验证。覆盖充足项包括 package-root authority、catalog
projection 删除后显式查询、legacy catalog-only migration error、fixed
budget、evidence lineage、sensitive scan、单书 hotplug gate、qmd vsearch
与 CLI typed error。

覆盖不足项仍为：

- 真实外部 provider 下的单书 `--graph-book-id` 成功回答。
- failed/staging 全状态枚举的独立 CLI fixture。
- upper query response 内部真实 timing duration。

## 必须修复项

当前未发现阻断 design-turn_012 package-root 规范的必须修复项。

## 风险收敛项

1. 在 provider/runtime 可用时运行一次真实单书
   `qmd query --graphrag --graph-book-id <bookId>` 成功回答，并记录
   redaction、evidence lineage、timing 与 provider metrics。
2. 增加 failed/staging 状态枚举的 CLI fail-closed fixtures，补齐
   running/pending/stale 之外的状态覆盖。
3. 为 bookshelf/library query response 增加真实 stage duration，或在契约中
   明确当前 0ms metrics 为 logical fixed-budget marker。
4. 若继续扩展 LLM synthesis 或 bounded deepening，新增测试必须证明固定
   LLM call cap、固定 token budget、证据回链与敏感信息扫描仍成立。
