# implementation-turn_009 agent-1 实施审计报告

overallStatus: PASS_WITH_RISK

## 审计范围

审计对象：当前工作区中的书-书架-Library 层级 GraphRAG 索引改造实现。

核心规范：

- bookshelf 上层包权威根必须为 `graph_vault/bookshelves/{bookshelfId}/`。
- library 上层包权威根必须为 `graph_vault/library/{libraryId}/`。
- `graph_vault/catalog/**` 只能承载 projection、routing、capability 与
  observability，不得承载上层包闭包。
- legacy catalog-only upper artifacts 在查询路径必须返回
  `upper_package_migration_required`。

本 agent 执行只读审计，未运行构建、单元测试或 CLI smoke test。主控交接摘要称
曾运行：

```bash
node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false
```

结果为通过；本报告将其作为主控运行证据，不作为本 agent 运行证据。

## 总体结论

当前实现已经把 bookshelf/library 的主要构建、验证和查询路径迁移到
package-root 目录。`upper-package-paths.ts` 统一解析
`graph_vault/bookshelves/{bookshelfId}` 与 `graph_vault/library/{libraryId}`，
查询前校验 package-local `CURRENT.json`、generation manifest、
root manifest、package-local quality gate 和 `PUBLISH_READY.json`。当 package
root 缺失但 legacy catalog upper artifacts 存在时，会 fail closed 并返回
`upper_package_migration_required`。

静态证据显示，upper-index 运行代码中旧
`graph_vault/catalog/bookshelves/**` 与 `graph_vault/catalog/library/**`
路径仅保留在 legacy 检测 helper 中；构建器、validator 与查询路径未把 catalog
projection 当作 query-ready 权威。CLI typed error 映射已包含
`upper_package_migration_required`，并映射到 exit code 65。

本轮不能判定为完全 PASS，原因是本 agent 未运行测试；同时 CLI membership 脚本
帮助文案仍把 `--bookshelf-id`、`--library-id` 描述为 catalog id，容易误导使用者。
该问题不改变当前代码写入位置，但属于 operability 风险。

## 1 单书包复制传播完整性不回归

status: PASS_WITH_RISK

证据：

- bookshelf membership 只读取单书包 manifest、`PUBLISH_READY.json` 与单书包
  质量门；成员 evidenceRefs 指向 `books/{bookId}/BOOK_MANIFEST.json` 与
  `books/{bookId}/PUBLISH_READY.json`，未发现写回单书包闭包的实现。
- bookshelf graph validator 在校验 stale 时读取
  `resolveBookManifestPath(graphVault, bookId)` 并比较 manifest sha256，只读判断
  成员单书是否变化。
- 现有单书 CLI 路由代码仍保留 `--graph-book-id` 路径；上层 scope 仅在
  `bookshelfId` 或 `libraryId` 存在时接管。

风险：

- 本 agent 未运行单书 hotplug gate、单书 `--graph-book-id` 查询或 qmd vsearch
  非回归测试。

## 2 书架/library 派生索引不污染单书包

status: PASS

证据：

- `buildBookshelfGraph` 使用 `bookshelfPackageRoot(graphVault, bookshelfId)` 作为
  root，发布到 `bookshelves/{bookshelfId}/generations/{generation}`，再写
  package-root `CURRENT.json`、`BOOKSHELF_MANIFEST.json`、
  `state/bookshelf-quality-gate.json` 与 `PUBLISH_READY.json`。
- `buildLibraryGraph` 使用 `libraryPackageRoot(graphVault, libraryId)` 作为 root，
  发布到 `library/{libraryId}/generations/{generation}`，再写
  package-root `CURRENT.json`、`LIBRARY_MANIFEST.json`、
  `state/library-quality-gate.json` 与 `PUBLISH_READY.json`。
- `resolveBookshelfMembership` 与 `resolveLibraryMembership` 分别写入
  `bookshelves/{bookshelfId}` 和 `library/{libraryId}`，membership 阶段的
  `CURRENT.json` 明确 `queryReady: false`。

## 3 上层包闭包不写入 catalog 且删除 projection 不影响显式查询

status: PASS_WITH_RISK

证据：

- upper-index 源码中 `catalog/bookshelves` 与 `catalog/library` 仅出现在
  `legacyBookshelfCatalogRoot`、`legacyLibraryCatalogRoot` 与
  `hasLegacyCatalogUpperArtifacts`，用于识别 legacy catalog-only 产物。
- 查询路径调用 `readQueryReadyPackage()`，先解析 package root；catalog 只在
  package root 不存在时用于 legacy 检测，不参与 ready 判定。
- 测试文件中已有 package-root 断言：bookshelf graph 测试检查
  `bookshelves/{id}/BOOKSHELF_MANIFEST.json`、`PUBLISH_READY.json`、
  `state/bookshelf-quality-gate.json`，并断言
  `catalog/bookshelves/{id}` 不存在；library graph 测试对
  `library/{id}` 做同类断言，并断言 `catalog/library/{id}` 不存在。

风险：

- 未发现显式删除 catalog projection 后仍能执行 `--bookshelf-id` 或
  `--library-id` 查询的已运行证据。本 agent 未运行相关测试。

## 4 runner ledger 不参与语义检索

status: PASS

证据：

- upper-index 查询路径只将 generation root 作为 bridge `outputRoot`，并读取
  manifest、quality gate、parquet artifacts 与 evidence map。
- `graph_vault/catalog/batch-runs/**` 仅出现在 runner 相关测试和既有 runner
  模块，不在 bookshelf/library query、graph build、validator 的语义输入路径中。
- package-local `runs/{runId}` 被写入上层 package generation 内，作为状态、
  checkpoint 与 recovery evidence；manifest file closure 会校验这些文件，但
  查询 bridge payload 不把 runs 作为检索输入。

## 5 查询预算不随书籍数量线性增长

status: PASS_WITH_RISK

证据：

- bookshelf 查询 payload 使用 `maxReports` 与 `maxInputTokens`，默认来自
  manifest 的 `fixedQueryBudget.maxSemanticUnits` 与 `maxInputTokens`。
- library 查询 payload 同样使用固定 `maxReports` 与 `maxInputTokens`，默认来自
  library manifest 的 fixed query budget。
- capabilities 只按 `maxBooksForDeepening` 或 `maxBookshelvesForDeepening`
  截断候选成员。
- library graph 测试包含“10、100、1000 book scale”固定预算模拟用例。

风险：

- 本 agent 未运行固定预算测试，不能确认当前未提交测试修改后实际通过。

## 6 evidence lineage 可追溯

status: PASS

证据：

- bookshelf 查询响应 evidence 映射包含 `bookId`、`sourceId`、`documentId`、
  `contentHash`、`graphTextUnitId`、`artifactId` 与 `targetArtifactDigest`。
- library 查询响应 evidence 同样包含 `bookId`、`sourceId`、`documentId`、
  `contentHash`、`graphTextUnitId`、`artifactId`、`targetBookshelfId` 与
  `targetArtifactDigest`。
- locator 已改为 package-root generation 相对路径，例如
  `bookshelves/{bookshelfId}/generations/{generation}/community_reports.parquet`
  和 `library/{libraryId}/generations/{generation}/community_reports.parquet`，
  不再指向 catalog current root。

## 7 staging/failed/running/pending/stale 不能被当 ready

status: PASS_WITH_RISK

证据：

- `readQueryReadyPackage()` 要求 package root 存在、`CURRENT.json.queryReady`
  为 true、generation manifest 与 root manifest checksum 一致、root
  `PUBLISH_READY.json` 合法且与 current generation 匹配。
- membership 阶段发布 `CURRENT.json` 时 `queryReady: false`，因此不能被
  `readQueryReadyPackage()` 当作 query-ready index。
- bookshelf validator 会比较成员 book manifest sha256；不一致时产生
  `member_manifest_stale:{bookId}`，查询层转为 `upper_index_stale`。
- library validator 会通过 `readQueryReadyPackage()` 读取成员 bookshelf，并比较
  member bookshelf manifest sha256；不一致时产生
  `member_bookshelf_manifest_stale:{bookshelfId}`。

风险：

- 本 agent 未运行 stale、failed gate、missing marker 的 CLI fail-closed 用例。

## 8 manifest/quality gate/publish marker 状态闭环完整

status: PASS

证据：

- bookshelf graph publish 顺序为 staging validation 后移动到
  `generations/{generation}`，再写 root `CURRENT.json`、root
  `BOOKSHELF_MANIFEST.json`、root `state/bookshelf-quality-gate.json`、
  `state/diagnostics.json` 与 root `PUBLISH_READY.json`。
- library graph publish 使用同样的 package-local 闭环，写 root
  `CURRENT.json`、root `LIBRARY_MANIFEST.json`、root
  `state/library-quality-gate.json`、`state/diagnostics.json` 与
  `PUBLISH_READY.json`。
- `readQueryReadyPackage()` 校验 generation manifest、root manifest、
  generation gate、root gate、publish marker 及对应 `.sha256` sidecar。

## 9 CLI typed error 与 timing 可观测

status: PASS_WITH_RISK

证据：

- `resolveUpperTypedQueryErrorDetails()` 已新增
  `upper_package_migration_required`，exit code 为 65，`retryable: false`。
- bookshelf/library query scope 在 legacy catalog-only 情况下分别返回
  `legacy_catalog_bookshelf_package_requires_migration` 与
  `legacy_catalog_library_package_requires_migration` diagnostics。
- `qmd query` 上层 scope 路由把 `BookshelfQueryScopeError` 与
  `LibraryQueryScopeError` 转为 typed query error，并保留 `scopeKind`、
  `scopeId`、diagnostics 与 `timingAvailable`。
- CLI 查询调用用 `measureCliQueryTiming()` 包裹
  `cli.query_bookshelf_upper_index` 与 `cli.query_library_upper_index`。
- route 测试已包含 bookshelf 和 library legacy catalog-only typed error 的期望。

风险：

- `scripts/graphrag/build-bookshelf-membership.mjs` 帮助文案仍称
  `--bookshelf-id` 为 “catalog bookshelf id to materialize”。
- `scripts/graphrag/build-library-membership.mjs` 帮助文案仍称
  `--library-id` 为 “catalog library id to materialize”。
- 本 agent 未运行 CLI typed error 测试，不能确认 stderr JSON 和 exit code 在
  当前工作区实际通过。

## 10 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归

status: PASS_WITH_RISK

证据：

- bookshelf/library graph builders 在写 manifest 前调用
  `assertNoForbiddenText("manifest", stableJson(sensitivityScanManifest(...)))`
  和 `assertNoForbiddenText("quality_gate", stableJson(qualityGate))`。
- manifest 中 `sensitivityPolicy.locatorRule` 限制为 graph_vault-relative 和
  scope-relative locator。
- validator 拒绝绝对路径、`../`、URI scheme 等 manifest file path。
- fail-closed CLI 测试包含敏感 parquet payload 污染后 stderr 不泄露本地路径和
  token 的断言。

风险：

- 本 agent 未运行敏感信息测试、单书 GraphRAG 查询非回归测试或 qmd vsearch
  非回归测试。

## 必须修复项

无阻塞实现缺陷。

发布前建议修复：

- 更新 `scripts/graphrag/build-bookshelf-membership.mjs` 与
  `scripts/graphrag/build-library-membership.mjs` 的帮助文案，避免继续把上层
  package id 描述为 catalog id。
- 运行并记录 targeted test 与 smoke test：bookshelf membership、bookshelf
  graph、library membership、library graph、CLI query scope、CLI route、
  upper-index fail-closed、单书 hotplug gate、单书 `--graph-book-id` 查询、
  qmd vsearch 非回归。

## 保留风险

- 工作区存在大量未提交变更；本报告仅基于当前文件静态内容与主控交接摘要审计。
- TypeScript compile 通过来自主控交接摘要，本 agent 未复跑。
- legacy catalog-only fail-closed 的实现已存在，但迁移工具链和 catalog projection
  rebuild 的完整端到端证据不在本次只读审计范围内。
- “删除 catalog projection 不影响显式 package 查询”目前有静态路径证据和部分
  测试断言，但缺少本 agent 实际运行证据。
