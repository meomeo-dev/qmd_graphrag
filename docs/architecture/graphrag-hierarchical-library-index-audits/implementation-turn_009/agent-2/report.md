# implementation-turn_009 / agent-2 实施审计报告

## 结论

总体结论：PASS_WITH_RISK。

当前实现已经把书架与 Library 上层包权威根迁移到
`graph_vault/bookshelves/{bookshelfId}/` 与
`graph_vault/library/{libraryId}/`，查询路径通过 package-local
`CURRENT.json`、manifest、quality gate 和 `PUBLISH_READY.json` 判定
query-ready。`graph_vault/catalog/**` 在上层查询路径中未作为包权威；
legacy catalog-only 上层产物在缺少 package root 时返回
`upper_package_migration_required`。

本审计为只读静态审计（read-only static audit）。未独立运行构建、单元测试、
CLI smoke test 或真实 GraphRAG 查询。可引用的运行证据仅限主控交接记录：
主控曾运行
`node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
并记录通过；本审计未复验该命令。

## 逐项判定

### 1. 单书包复制传播完整性不回归：PASS_WITH_RISK

证据：

- 上层 package root helper 只解析 `bookshelves/{bookshelfId}` 与
  `library/{libraryId}`，没有把单书包根作为写入目标：
  `src/graphrag/upper-index/upper-package-paths.ts:57-65`。
- 书架 graph 测试断言不会在 `graph_vault/books/{bookId}` 写入
  `BOOKSHELF_MANIFEST.json` 或 `semantic_units.parquet`：
  `test/graphrag-bookshelf-graph.test.ts:241-254`。
- 单书查询路径仍保留在 CLI 的 `graphBookId` 分支：
  `src/cli/qmd.ts:3638-3644` 与 `src/cli/qmd.ts:3735` 之后继续走
  existing book GraphRAG runtime。

保留风险：

- 本审计未运行单书 hotplug package gate、单书 `--graph-book-id` 查询、
  qmd vsearch 回归测试。当前只能判定静态路径没有明显污染单书包。

### 2. 书架/library 派生索引不污染单书包：PASS

证据：

- 书架 membership 写入根为 `bookshelfPackageRoot(...)`，即
  `graph_vault/bookshelves/{bookshelfId}`：
  `src/graphrag/upper-index/bookshelf-membership.ts:529-551`。
- 书架 graph 写入 staging、generations、root marker 均在 package root：
  `src/graphrag/upper-index/bookshelf-graph.ts:489-493`，
  `src/graphrag/upper-index/bookshelf-graph.ts:810-845`。
- Library membership 与 graph 写入根为 `libraryPackageRoot(...)`：
  `src/graphrag/upper-index/library-membership.ts:662-665`，
  `src/graphrag/upper-index/library-graph.ts:392-398`。
- 书架 graph 测试显式检查成员单书包中不存在上层 manifest 和上层 parquet：
  `test/graphrag-bookshelf-graph.test.ts:241-254`。

### 3. 上层包闭包不写入 catalog，删除 catalog projection 不影响显式查询：
PASS_WITH_RISK

证据：

- 上层包权威 helper 明确返回 `graph_vault/bookshelves/{bookshelfId}` 与
  `graph_vault/library/{libraryId}`：
  `src/graphrag/upper-index/upper-package-paths.ts:57-65`。
- `readQueryReadyPackage()` 先检查 package root；只有 package root 缺失且存在
  legacy catalog artifacts 时才返回 migration-required：
  `src/graphrag/upper-index/upper-package-paths.ts:232-250`。
- 书架与 Library 查询均通过 `readQueryReadyPackage()` 读取 package-local
  generation root，不读取 catalog projection 作为 query-ready 依据：
  `src/graphrag/upper-index/bookshelf-query.ts:72-108`，
  `src/graphrag/upper-index/library-query.ts:75-111`。
- 上层实现源码中对 `catalog/bookshelves` 和 `catalog/library` 的使用只集中在
  legacy detection helper，没有发现 build/query 写入 catalog 上层包闭包：
  `src/graphrag/upper-index/upper-package-paths.ts:68-80`。
- 书架和 Library graph 测试断言对应 catalog 上层目录不存在：
  `test/graphrag-bookshelf-graph.test.ts:215-220`，
  `test/graphrag-library-graph.test.ts:402-407`。

保留风险：

- 当前测试更多证明“构建后 catalog 上层目录不存在”，尚未看到显式删除已有
  catalog projection 后仍能查询 package root 的独立测试。静态代码已经支持该
  结论，但建议补充删除 projection 的 smoke test。

### 4. runner ledger 不参与语义检索：PASS

证据：

- 上层 package root、query-ready 读取、membership/graph build 均不把
  `graph_vault/catalog/batch-runs/**` 作为输入。
- 书架 graph 构建读取成员单书 artifact 路径和 package-local membership：
  `src/graphrag/upper-index/bookshelf-graph.ts:497-545`。
- Library graph 构建读取已发布书架 package 的 community reports/evidence map：
  `src/graphrag/upper-index/library-graph.ts:400-445`。
- `batch-runs` 搜索命中主要属于既有 runner state 与 runner 测试，不在
  `src/graphrag/upper-index` query/build 语义输入路径中。

### 5. 查询预算不随书籍数量线性增长：PASS_WITH_RISK

证据：

- 书架 graph build 生成并校验 fixed-budget simulation：
  `src/graphrag/upper-index/bookshelf-graph.ts:563-586`。
- Library graph build 生成并校验 fixed-budget simulation：
  `src/graphrag/upper-index/library-graph.ts:458-481`。
- 书架查询 bridge payload 使用 `maxReports` 与 `maxInputTokens`：
  `src/graphrag/upper-index/bookshelf-query.ts:243-256`。
- Library 查询 bridge payload 使用 `maxReports` 与 `maxInputTokens`：
  `src/graphrag/upper-index/library-query.ts:283-296`。
- Library capability 枚举按 `maxBookshelvesForDeepening` 截断：
  `src/graphrag/upper-index/library-query.ts:226-230`。
- 测试覆盖超低 token budget 返回
  `budget_exceeded_narrow_scope_required`：
  `test/graphrag-library-graph.test.ts:466-477`。

保留风险：

- 本审计未运行不同规模 Library 的实际对比测试。静态实现显示预算上限存在，
  但“规模增加不线性增长”仍需主控执行规模化回归验证。

### 6. evidence lineage 可追溯：PASS

证据：

- 书架查询 evidence 输出包含 `bookId`、`sourceId`、`documentId`、
  `contentHash`、`graphTextUnitId`、community report artifact 以及
  package-relative locator：
  `src/graphrag/upper-index/bookshelf-query.ts:292-328`。
- Library 查询 evidence 输出包含同类 lineage 字段，并补充
  `targetBookshelfId`：
  `src/graphrag/upper-index/library-query.ts:332-369`。
- locator 已迁移为 package-root generation 路径：
  `src/graphrag/upper-index/upper-package-paths.ts:124-138`。
- 书架与 Library 查询测试断言 locator 指向
  `bookshelves/.../generations/.../community_reports.parquet` 与
  `library/.../generations/.../community_reports.parquet`：
  `test/graphrag-bookshelf-graph.test.ts:276-285`，
  `test/graphrag-library-graph.test.ts:458-465`。

### 7. staging/failed/running/pending/stale 不能被查询路径当 ready：PASS

证据：

- 查询前必须经过 `readQueryReadyPackage()`，它要求 package root、`CURRENT.json`
  指向 generation-local manifest、manifest checksum、root manifest、
  gate 文件、`PUBLISH_READY.json` 与 sidecar 存在且匹配：
  `src/graphrag/upper-index/upper-package-paths.ts:232-320`。
- membership-only `CURRENT.json` 明确 `queryReady: false`：
  `src/graphrag/upper-index/bookshelf-membership.ts:770-780`，
  `src/graphrag/upper-index/library-membership.ts:898-908`。
- `readQueryReadyPackage()` 对 `queryReady: false` 返回
  `upper_index_missing:current_not_query_ready`：
  `src/graphrag/upper-index/upper-package-paths.ts:252-255`。
- 书架 validator 检查 manifest/gate query-ready、manifest 文件闭包、parquet
  schema 和成员 manifest stale：
  `src/graphrag/upper-index/bookshelf-graph-validator.ts:56-160`。
- Library validator 检查 package query-ready、成员书架 query-ready 和 stale：
  `src/graphrag/upper-index/library-graph-validator.ts:102-149`，
  `src/graphrag/upper-index/library-graph-validator.ts:151-223`。

### 8. manifest/quality gate/publish marker 状态闭环完整：PASS_WITH_RISK

证据：

- 书架 graph publish 写入 generation manifest、root `CURRENT.json`、
  root `BOOKSHELF_MANIFEST.json`、root quality gate、diagnostics 与
  `PUBLISH_READY.json`：
  `src/graphrag/upper-index/bookshelf-graph.ts:792-845`。
- Library graph publish 写入 generation manifest、root `CURRENT.json`、
  root `LIBRARY_MANIFEST.json`、root quality gate、diagnostics 与
  `PUBLISH_READY.json`：
  `src/graphrag/upper-index/library-graph.ts:695-748`。
- `readQueryReadyPackage()` 校验 generation manifest、root manifest、
  `PUBLISH_READY.json` 及 sidecar：
  `src/graphrag/upper-index/upper-package-paths.ts:263-310`。
- 书架和 Library graph 测试检查 package-root manifest、`PUBLISH_READY.json`
  和 package-root quality gate 存在：
  `test/graphrag-bookshelf-graph.test.ts:196-214`，
  `test/graphrag-library-graph.test.ts:383-401`。

保留风险：

- `readQueryReadyPackage()` 要求 root gate 文件和 sidecar 存在，但未直接校验
  root gate sidecar 内容或 root gate 与 generation gate 的一致性。实际查询
  使用 generation gate 并通过 validator 复查，因此不是立即阻断项，但状态闭环
  的 root copy 校验仍可加强。

### 9. CLI typed error 与 timing 可观测，含 upper_package_migration_required：
PASS_WITH_RISK

证据：

- CLI typed error helper 新增 `upper_package_migration_required`，exit code 为
  65，且 retryable 为 false：
  `src/cli/graphrag-query-scope.ts:15-23`，
  `src/cli/graphrag-query-scope.ts:134-143`。
- 书架与 Library 查询将 legacy catalog-only 转换为
  `upper_package_migration_required`：
  `src/graphrag/upper-index/bookshelf-query.ts:86-94`，
  `src/graphrag/upper-index/library-query.ts:89-97`。
- CLI route 将上层 scope error 包装为 typed query error，并保留 diagnostics：
  `src/cli/qmd.ts:3571-3634` 与 `src/cli/qmd.ts:3652-3730`。
- CLI tests 覆盖 missing package root 和 legacy catalog-only 的书架/Library
  typed error：
  `test/cli-graphrag-route.test.ts:962-1056`，
  `test/cli-graphrag-route.test.ts:1058-1152`。
- query scope helper 测试覆盖 migration error 映射：
  `test/cli-graphrag-query-scope.test.ts:55-70`。
- `--timing` 通过 CLI query timing recorder 接入：
  `src/cli/qmd.ts:3464-3474`，
  `src/cli/qmd.ts:3538-3544`。

保留风险：

- 上层 query response 的 `runtimeMetrics` stage duration 目前为 `0`，更像固定
  结构化指标而非真实 bridge duration：
  `src/graphrag/upper-index/bookshelf-query.ts:329-360`，
  `src/graphrag/upper-index/library-query.ts:370-400`。CLI 外层 timing 可观测，
  但 runtimeMetrics 精度仍可改进。

### 10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归：PASS_WITH_RISK

证据：

- 书架 graph manifest 与 quality gate 在 publish 前执行 forbidden text scan：
  `src/graphrag/upper-index/bookshelf-graph.ts:785-792`。
- Library graph manifest 与 quality gate 在 publish 前执行 forbidden text scan：
  `src/graphrag/upper-index/library-graph.ts:687-695`。
- fail-closed 测试构造 provider payload、Bearer token、绝对路径污染
  `community_reports.parquet`，期望 validator 和 CLI 返回质量门错误：
  `test/cli-graphrag-upper-index-failclosed.test.ts:214-245`。
- 上层查询 evidence locator 使用 package-relative 路径，不输出绝对路径：
  `src/graphrag/upper-index/bookshelf-query.ts:305-312`，
  `src/graphrag/upper-index/library-query.ts:345-352`。
- 单书 GraphRAG 查询分支仍在 CLI 中保留，qmd search 服务仍作为 unified
  route 的 fallback/input：
  `src/cli/qmd.ts:3563-3570`，
  `src/cli/qmd.ts:3638-3651`。

保留风险：

- 本审计未运行 qmd vsearch、单书 GraphRAG query 或 hotplug quality gate
  回归测试；非回归结论主要来自静态路由保留和未发现上层写回单书包。

## 必须修复项

无阻断性 FAIL。

## 建议修复项

1. 补充一个显式删除 `graph_vault/catalog/bookshelves/{bookshelfId}` 或
   `graph_vault/catalog/library/{libraryId}` projection 后，仍能通过
   `--bookshelf-id` / `--library-id` 查询 package root 的 CLI smoke test。
2. 在 `readQueryReadyPackage()` 中校验 root quality gate sidecar 内容，并确认
   root quality gate 与 current generation gate 的 checksum 或内容一致。
3. 将上层 query `runtimeMetrics.stages[].durationMs` 从固定 `0` 改为真实 bridge
   调用耗时，或在报告中明确它是 fixed-budget logical stage marker。
4. 主控继续运行完整验证：单书 hotplug gate、单书 `--graph-book-id` 查询、
   qmd vsearch、书架查询、Library 查询、不同规模 Library fixed-budget 回归。

## 保留风险

- 本审计未执行测试，无法独立确认当前未提交工作区在本机全部通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts` 当前为未跟踪文件；若未纳入
  提交或 CI，敏感信息 fail-closed 覆盖会丢失。
- `scripts/graphrag/build-library-membership.mjs` 的帮助文本仍出现
  “catalog library id to materialize” 表述。该项看起来是文案残留，不构成包根
  行为失败，但建议后续清理以避免操作误导。
