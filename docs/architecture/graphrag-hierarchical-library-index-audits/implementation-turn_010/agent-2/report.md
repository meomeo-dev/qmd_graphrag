# implementation-turn_010 agent-2 实施审计报告

overallStatus: PASS_WITH_RISK

## 审计范围

本轮执行只读实施审计 (read-only implementation audit)，依据
`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml` 和固定
10 项实施审计维度，重点验证 design-turn_012 后的 package-root 规范：

- bookshelf 权威根 (authority root):
  `graph_vault/bookshelves/{bookshelfId}/`
- library 权威根 (authority root):
  `graph_vault/library/{libraryId}/`
- `graph_vault/catalog/**` 只能作为 projection、routing 和 observability。
- legacy catalog-only 上层产物必须 fail closed，并返回
  `upper_package_migration_required`。

审计未修改源码；仅新增本报告。

## 总体结论

当前实现已把 bookshelf 和 library 的查询权威迁移到 package-local 上层包。
`CURRENT.json.sha256`、`CURRENT.current` 与 generation 一致性、root/generation
manifest 一致性、quality gate sidecar、`PUBLISH_READY` scope/path/generation
校验、legacy catalog-only fail closed、删除 catalog projection 后显式查询、
stale member manifest、running/pending pointer 拒绝等核心路径均有实现证据和
测试证据。

结论不是纯 PASS，原因是仍存在两个 fail-closed 边界风险：

- 上层 scope id 在通用 package path 层缺少统一目录名约束，可能破坏
  `bookshelves/{id}` 和 `library/{id}` 的根边界假设。
- library evidence bridge 在下层 evidence 缺失时可写入 `unknown-*` 占位值，
  质量门未显式拒绝这些不可追溯 lineage。

## 必须修复项

### F-001: 统一拒绝非法上层 scope id

`upper-package-paths.ts` 直接用 `scopeId` 拼接 package root：

- `bookshelfPackageRoot()`:
  `join(graphVaultRoot(graphVault), "bookshelves", bookshelfId)`，
  见 `src/graphrag/upper-index/upper-package-paths.ts:57`。
- `libraryPackageRoot()`:
  `join(graphVaultRoot(graphVault), "library", libraryId)`，
  见 `src/graphrag/upper-index/upper-package-paths.ts:64`。
- `upperPackageRoot()` 对 `scopeId` 没有统一 reject `..`、`/`、`\`、
  URI scheme 或 Windows drive，见
  `src/graphrag/upper-index/upper-package-paths.ts:82`。

`library-membership.ts` 已有 `assertSafeScopeId()`，见
`src/graphrag/upper-index/library-membership.ts:277`，但该约束没有下沉到
`upper-package-paths.ts`、bookshelf membership、bookshelf graph build、
library graph build 和 query 入口。应新增统一
`assertSafeUpperScopeId(scopeKind, scopeId)`，所有 package root 解析和 CLI
上层查询前必须调用。非法 id 应返回 typed error，不能拼接路径。

### F-002: evidence_map 必须拒绝不可追溯占位值

library bridge 在无法从 shelf evidence 找到下层 evidence 时，会用
`unknown-book`、`unknown-source`、`unknown-document`、`unknown-content` 和
`unknown-text-unit` 兜底，见
`scripts/graphrag/library_graph_bridge_build.py:71`。这些值满足非空 schema，
但不满足 bookId/sourceId/documentId/contentHash/community report/text_unit 的
真实 lineage 要求。

应在 build 和 inspect/validator 两侧 fail closed：

- `_evidence_for_report()` 找不到 evidence 时直接返回错误，而不是 `{}`。
- `bookshelf_graph_bridge_inspect.py` 或 TS validator 应拒绝空字符串和
  `unknown-*` lineage 字段。
- library quality gate 的 `evidence_map_links_shelf_and_book_evidence` 需要
  验证每个 evidence row 可回链到真实下层 evidence row 或 digest。

## 逐项判定

### 1. 单书包复制传播完整性不回归

status: PASS

bookshelf membership 读取单书 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
hotplug quality gate 和 runtime gate 后才接受成员，见
`src/graphrag/upper-index/bookshelf-membership.ts:310` 至
`src/graphrag/upper-index/bookshelf-membership.ts:370`。

bookshelf graph 测试确认上层构建不向成员书包写入
`BOOKSHELF_MANIFEST.json` 或 `semantic_units.parquet`，见
`test/graphrag-bookshelf-graph.test.ts:257` 至
`test/graphrag-bookshelf-graph.test.ts:270`。

单书 GraphRAG 显式 scope 非回归已验证：
`test/cli-graphrag-route.test.ts -t "qmd query --graphrag uses the selected book scoped output|qmd query --graphrag --json returns a unified GraphRAG answer"`
通过 2 项。

### 2. 书架/library 派生索引不污染单书包

status: PASS

bookshelf 和 library 构建都写入上层包根下的 staging、generations、state 和
runs。bookshelf graph publish 写入
`graph_vault/bookshelves/{bookshelfId}`，见
`src/graphrag/upper-index/bookshelf-graph.ts:810` 至
`src/graphrag/upper-index/bookshelf-graph.ts:845`。library graph publish 写入
`graph_vault/library/{libraryId}`，见
`src/graphrag/upper-index/library-graph.ts:713` 至
`src/graphrag/upper-index/library-graph.ts:748`。

测试确认构建后不存在 `graph_vault/catalog/bookshelves/{id}` 和
`graph_vault/catalog/library/{id}` package 闭包，见
`test/graphrag-bookshelf-graph.test.ts:231` 至
`test/graphrag-bookshelf-graph.test.ts:236`，以及
`test/graphrag-library-graph.test.ts:418` 至
`test/graphrag-library-graph.test.ts:423`。

### 3. 上层包闭包不写入 catalog，删除 catalog projection 不影响显式查询

status: PASS

显式上层查询先读取 package root，而非 catalog projection。package root 缺失时
才检查 legacy catalog-only，并返回迁移错误，见
`src/graphrag/upper-index/upper-package-paths.ts:225` 至
`src/graphrag/upper-index/upper-package-paths.ts:268`。

删除 catalog projection 后，bookshelf 显式查询仍成功，见
`test/graphrag-bookshelf-graph.test.ts:303` 至
`test/graphrag-bookshelf-graph.test.ts:318`。library 同类场景见
`test/graphrag-library-graph.test.ts:483` 至
`test/graphrag-library-graph.test.ts:498`。

CLI legacy catalog-only typed error 已验证：
`test/cli-graphrag-route.test.ts -t "upper typed error|legacy catalog-only|scope ambiguity"`
通过 6 项。

### 4. runner ledger 不参与语义检索

status: PASS

upper-index 构建输入来自成员书包或成员 bookshelf 的语义产物，不读取
`graph_vault/catalog/batch-runs/**`、events 或 recovery ledger 作为语义输入。

bookshelf graph bridge payload 使用 member `communityReportsPath`、`entitiesPath`、
`relationshipsPath` 和 `textUnitsPath`，见
`src/graphrag/upper-index/bookshelf-graph.ts:531` 至
`src/graphrag/upper-index/bookshelf-graph.ts:542`。library graph 使用 member
bookshelf `communityReportsPath` 和 `evidenceMapPath`，见
`src/graphrag/upper-index/library-graph.ts:437` 至
`src/graphrag/upper-index/library-graph.ts:444`。

静态检索未发现 upper-index 查询或 bridge 将 catalog batch-runs ledger 作为
semantic input。

### 5. 查询预算不随书籍数量线性增长

status: PASS

query bridge 用 `maxReports` 截断 selected reports，并在 `maxInputTokens` 超限时
返回 `budget_exceeded_narrow_scope_required`，见
`scripts/graphrag/bookshelf_graph_bridge_query.py:96` 至
`scripts/graphrag/bookshelf_graph_bridge_query.py:128`。

library 规模模拟测试覆盖 10、100、1000 本书，验证 semantic unit、selected
report、token 和 evidence 指纹固定，见
`test/graphrag-library-graph.test.ts:625` 至
`test/graphrag-library-graph.test.ts:727`。

### 6. evidence lineage 可追溯

status: PASS_WITH_RISK

schema 要求 evidence_map 包含 `targetBookId`、`targetSourceId`、
`targetDocumentId`、`targetContentHash`、`targetCommunityReportId`、
`targetTextUnitId` 和 `targetArtifactDigest`，见
`src/graphrag/upper-index/bookshelf-graph-contracts.ts:63` 至
`src/graphrag/upper-index/bookshelf-graph-contracts.ts:80`。

query response 将 evidence_map 字段映射到 GraphRAG evidence，bookshelf 见
`src/graphrag/upper-index/bookshelf-query.ts:296` 至
`src/graphrag/upper-index/bookshelf-query.ts:327`；library 见
`src/graphrag/upper-index/library-query.ts:336` 至
`src/graphrag/upper-index/library-query.ts:368`。

剩余风险见 F-002。library bridge 允许 `unknown-*` 占位 lineage，当前 schema 和
validator 未强制拒绝。

### 7. staging/failed/running/pending/stale 产物不能被查询路径当 ready

status: PASS

`readPackageCurrent()` 要求 `CURRENT.json` 和 `CURRENT.json.sha256` 存在且匹配，
并要求 `CURRENT.current` 等于 `generations/{generation}`，见
`src/graphrag/upper-index/upper-package-paths.ts:168` 至
`src/graphrag/upper-index/upper-package-paths.ts:205`。

`readQueryReadyPackage()` 要求 `queryReady=true`，并要求 readyState 是
`bookshelf_query_ready` 或 `library_query_ready`，见
`src/graphrag/upper-index/upper-package-paths.ts:270` 至
`src/graphrag/upper-index/upper-package-paths.ts:276`。

running/pending pointer 测试通过：

- bookshelf `CURRENT.readyState = "running"` 被拒绝，见
  `test/graphrag-bookshelf-graph.test.ts:345` 至
  `test/graphrag-bookshelf-graph.test.ts:405`。
- library `CURRENT.readyState = "pending"` 被拒绝，见
  `test/graphrag-library-graph.test.ts:555` 至
  `test/graphrag-library-graph.test.ts:623`。

stale member manifest 测试通过：

- bookshelf stale member book manifest 返回 `upper_index_stale`，见
  `test/graphrag-bookshelf-graph.test.ts:407` 至
  `test/graphrag-bookshelf-graph.test.ts:466`。
- library stale member bookshelf manifest 返回 `upper_index_stale`，见
  `test/graphrag-library-graph.test.ts:734` 至
  `test/graphrag-library-graph.test.ts:806`。

### 8. manifest/quality gate/publish marker 状态闭环完整

status: PASS

package ready 校验覆盖 root/generation manifest 一致性、manifest sidecar、
root/generation quality gate 一致性、quality gate sidecar、`PUBLISH_READY`
schema、scope、generation、readyState、manifestPath、qualityGatePath、
currentPath 和 sidecar，见
`src/graphrag/upper-index/upper-package-paths.ts:279` 至
`src/graphrag/upper-index/upper-package-paths.ts:345`。

bookshelf graph build 先写 staging，再验证 staged artifacts，随后 promote 到
`generations/{generation}`，更新 `CURRENT.json`，写 root manifest、root gate、
diagnostics 和 `PUBLISH_READY.json`，见
`src/graphrag/upper-index/bookshelf-graph.ts:797` 至
`src/graphrag/upper-index/bookshelf-graph.ts:845`。library graph 同类路径见
`src/graphrag/upper-index/library-graph.ts:700` 至
`src/graphrag/upper-index/library-graph.ts:748`。

### 9. CLI typed error 与 timing 可观测

status: PASS_WITH_RISK

typed error code、exitCode、retryable、remediationCommand 和 timingAvailable 的
映射在 `resolveUpperTypedQueryErrorDetails()` 中实现，见
`src/cli/graphrag-query-scope.ts:100` 至
`src/cli/graphrag-query-scope.ts:182`。CLI upper 查询分支把
Bookshelf/LibraryQueryScopeError 转成 JSON typed error，见
`src/cli/qmd.ts:3571` 至 `src/cli/qmd.ts:3634`，以及
`src/cli/qmd.ts:3652` 至 `src/cli/qmd.ts:3730`。

CLI 集成测试确认 missing index、legacy catalog-only 和 scope ambiguity 均输出
typed error 且 `timingAvailable: true`，见
`test/cli-graphrag-route.test.ts:962` 至
`test/cli-graphrag-route.test.ts:1224`。

剩余风险：`queryBookshelfGraph()` 和 `queryLibraryGraph()` 返回的
`providerDetail.runtimeMetrics.totalDurationMs` 与 stage `durationMs` 仍为 `0`，
见 `src/graphrag/upper-index/bookshelf-query.ts:332` 至
`src/graphrag/upper-index/bookshelf-query.ts:358`，以及
`src/graphrag/upper-index/library-query.ts:370` 至
`src/graphrag/upper-index/library-query.ts:380`。CLI 外层 timing 已存在，但
provider runtime metrics 仍是占位值。

### 10. 敏感信息不进入可发布索引，现有单书 GraphRAG 和 qmd vsearch 不回归

status: PASS

manifest/gate 层定义 forbidden fields，见
`src/graphrag/upper-index/bookshelf-graph-contracts.ts:374` 至
`src/graphrag/upper-index/bookshelf-graph-contracts.ts:383`。parquet inspect 层扫描
provider payload、raw prompt/completion、credential、Bearer token、API token、
query.log 和绝对路径，见
`scripts/graphrag/bookshelf_graph_bridge_inspect.py:15` 至
`scripts/graphrag/bookshelf_graph_bridge_inspect.py:56`。

敏感 payload 污染测试通过：

- bookshelf polluted parquet 被拒绝，且 CLI stderr 不泄露绝对路径或 token，见
  `test/cli-graphrag-upper-index-failclosed.test.ts:214` 至
  `test/cli-graphrag-upper-index-failclosed.test.ts:288`。
- library polluted parquet 被拒绝，见
  `test/graphrag-library-graph.test.ts:814` 至
  `test/graphrag-library-graph.test.ts:890`。

非回归验证通过：

- 单书 GraphRAG 显式查询测试通过 2 项。
- `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`
  通过 1 项。

## 验证命令

以下命令在当前工作区执行完成：

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 \
  test/graphrag-bookshelf-graph.test.ts \
  test/cli-graphrag-query-scope.test.ts
```

结果：2 个 test files passed，11 tests passed。

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/graphrag-library-graph.test.ts
```

结果：1 个 test file passed，5 tests passed。

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli-graphrag-route.test.ts \
  -t "upper typed error|legacy catalog-only|scope ambiguity"
```

结果：1 个 test file passed，6 tests passed，9 skipped。

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli-graphrag-route.test.ts \
  -t "qmd query --graphrag uses the selected book scoped output|qmd query --graphrag --json returns a unified GraphRAG answer"
```

结果：1 个 test file passed，2 tests passed，13 skipped。

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli/basic.test.ts \
  -t "vsearch does not emit query expansion diagnostics"
```

结果：1 个 test file passed，1 test passed，51 skipped。

合并执行 bookshelf、library、CLI fail-closed 与 scope helper 的首次命令在
180 秒总超时前已通过 8 个关键用例，但未作为最终判定依据；以上拆分命令作为
本报告的有效验证证据。

## 剩余风险

- 通用 scope id 校验缺口会影响 package-root 不变量，应优先修复 F-001。
- library lineage 占位值会影响证据可追溯性，应优先修复 F-002。
- `CURRENT.current` 路径错配、`CURRENT.json.sha256` 错配、
  `PUBLISH_READY` scope/generation 错配和 root/generation gate mismatch 均有
  实现校验，但负例测试主要覆盖 readyState、stale、legacy catalog-only 和
  sensitive payload。建议补充更细粒度的 pointer/sidecar mismatch 测试。
- 当前 upper query 仍是固定预算 community report search，不包含 LLM synthesis
  或 bounded deepening；这与 Type DD 标注的 remaining capabilities 一致。
