# implementation-turn_009 / agent-3 实施审计报告

## 结论

判定：PASS_WITH_RISK

当前工作区已将书架与 library 的权威根从 legacy
`graph_vault/catalog/**` 迁移到 package-local 根：
`graph_vault/bookshelves/{bookshelfId}/` 与
`graph_vault/library/{libraryId}/`。查询入口通过 package root、
`CURRENT.json`、generation manifest、package-local quality gate 与
`PUBLISH_READY.json` 进行 fail-closed 校验；legacy catalog-only、missing
package、membership-only `queryReady=false`、stale member manifest、polluted
parquet 和 over budget 都有对应代码路径或测试断言。

本审计未运行构建、测试或 CLI smoke。主控运行证据显示迁移后曾执行
`node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit
--pretty false` 且通过；implementation-turn_008 报告记录过 build、相关回归、
library smoke 与 qmd vsearch 通过。当前 agent-3 仅做只读审计，因此不把这些
证据扩展为当前工作区全量验证通过。

## 1. 单书包复制传播完整性不回归

判定：PASS_WITH_RISK

证据：
- `bookshelf-membership.ts` 只读取单书 `BOOK_MANIFEST.json`、
  `PUBLISH_READY.json`、包内 qmd 与 GraphRAG 产物定位，不写回
  `graph_vault/books/{bookId}/`。
- `bookshelf-graph-validator.ts` 通过 `resolveBookManifestPath` 校验成员书
  manifest sha，用于 stale 检测。
- CLI 仍保留 `--graph-book-id` 路径，并与 `--bookshelf-id`、
  `--library-id` 互斥。
- implementation-turn_008 记录 qmd vsearch smoke 通过。

风险：
- 当前 package-root 迁移后，本 agent 未运行单书 `--graph-book-id` 真实查询
  和单书包质量门；单书 GraphRAG 非回归仍需当前工作区实测闭环。

## 2. 书架/library 派生索引不污染单书包

判定：PASS

证据：
- `bookshelfPackageRoot()` 指向 `graph_vault/bookshelves/{id}`，
  `libraryPackageRoot()` 指向 `graph_vault/library/{id}`。
- 书架 membership、书架 graph、library membership、library graph 的发布写入
  都围绕对应 package root 下的 `staging/`、`generations/`、`CURRENT.json`、
  `state/`、`runs/` 与 `PUBLISH_READY.json`。
- 只读扫描未发现 upper-index 源码中向 `graph_vault/books/{bookId}/` 写入的
  上层发布逻辑；测试中对 `books/**` 的写入属于 fixture 构造。

## 3. 上层包闭包不写入 catalog，删除 projection 不影响显式查询

判定：PASS_WITH_RISK

证据：
- upper-index 源码中 `catalog/bookshelves`、`catalog/library` 只出现在
  legacy 检测 helper：`legacyBookshelfCatalogRoot()`、
  `legacyLibraryCatalogRoot()`、`hasLegacyCatalogUpperArtifacts()`。
- `readQueryReadyPackage()` 先读取 package root；package root 缺失且存在
  legacy catalog-only artifact 时返回
  `upper_package_migration_required:legacy_catalog_only`。
- 书架与 library 查询入口都通过 `readQueryReadyPackage()` 读取显式 package，
  不把 catalog projection 当作 query-ready 证明。
- CLI route 测试已新增 legacy catalog-only 反例断言，期望
  `upper_package_migration_required`。

风险：
- 当前测试中未看到“删除 catalog projection 后显式 package 查询仍成功”的
  专门反例；代码结构支持该行为，但仍需用 CLI smoke 固化。

## 4. runner ledger 不参与语义检索

判定：PASS

证据：
- upper-index 源码未引用 `graph_vault/catalog/batch-runs/**` 作为输入。
- 查询路径只读取 package-local generation 的 manifest、quality gate、
  parquet 语义产物和 evidence map。
- package-local `runs/{runId}/` 被纳入上层包可观测状态，但查询桥接只消费
  `community_reports.parquet`、`evidence_map.parquet` 等语义文件，不读取
  runner ledger。

## 5. 查询预算不随书籍数量线性增长

判定：PASS_WITH_RISK

证据：
- 书架查询从 manifest `fixedQueryBudget.maxSemanticUnits` 和
  `maxInputTokens` 派生 `maxReports`、`maxInputTokens`。
- library 查询从 manifest `fixedQueryBudget` 派生固定 `maxReports`、
  `maxInputTokens`，并用 `maxBookshelvesForDeepening` 限制下钻书架数。
- Python query bridge 在估算 token 超过上限时返回
  `budget_exceeded_narrow_scope_required`。
- `test/graphrag-library-graph.test.ts` 包含 10、100、1000 book scale 的固定预算
  测试断言，以及 `maxInputTokens: 1` 的 over budget 反例。

风险：
- 本 agent 未运行这些测试；当前工作区仍需重新执行 package-root 后的预算测试
  和 CLI over budget smoke。

## 6. evidence lineage 可追溯

判定：PASS

证据：
- 书架查询 evidence 输出包含 `sourceId`、`documentId`、`bookId`、
  `contentHash`、`graphTextUnitId`、`artifactId` 和 package-local
  `community_reports.parquet` locator。
- library 查询 evidence 输出同样包含上述字段，并额外记录
  `targetBookshelfId`、library generation 与 upper community report 信息。
- validator 检查 evidence map row count，并要求 quality gate 包含
  evidence lineage 相关 check。
- package locator 已改为
  `bookshelves/{id}/generations/{generation}/...` 与
  `library/{id}/generations/{generation}/...`。

## 7. staging/failed/running/pending/stale 不能被查询路径当 ready

判定：PASS_WITH_RISK

证据：
- membership 阶段发布 `CURRENT.json` 时写入 `queryReady: false`，且
  `readQueryReadyPackage()` 对 `current.queryReady=false` 返回
  `upper_index_missing:current_not_query_ready`。
- graph 阶段才写入 root manifest、package-local gate、`PUBLISH_READY.json`
  和 `queryReady: true`。
- `readQueryReadyPackage()` 缺 package root 返回 `upper_index_missing`；
  legacy catalog-only 返回 `upper_package_migration_required`。
- bookshelf validator 对成员单书 manifest sha 变化返回
  `member_manifest_stale:*`；library validator 对成员书架 manifest sha 变化返回
  `member_bookshelf_manifest_stale:*`，查询层映射为 `upper_index_stale`。
- 测试覆盖 stale member manifest、polluted parquet、missing package 与 legacy
  catalog-only 反例。

风险：
- `readQueryReadyPackage()` 当前不校验 `CURRENT.json.sha256`，也未强制
  `current.current === generations/{current.generation}`；这会削弱状态指针的
  tamper-evidence。
- 未看到 failed/running/pending generation pointer 的独立 CLI 反例测试。

## 8. manifest、quality gate、publish marker 状态闭环完整

判定：PASS_WITH_RISK

证据：
- graph build 发布时写入 generation manifest、root manifest、
  package-local quality gate、`CURRENT.json` 与 `PUBLISH_READY.json`。
- `readQueryReadyPackage()` 校验 package root、generation manifest sha、
  root manifest sha、`PUBLISH_READY.json` schema、scope、generation 与
  manifest sha。
- generation validator 会校验 manifest file closure、file sha、sidecar sha、
  quality gate schema 与 required checks。

风险：
- `CURRENT.json` sidecar 未被读取校验。
- root quality gate sidecar 只被 `readQueryReadyPackage()` 检查存在，未校验
  内容 sha，也未强制 `PUBLISH_READY.qualityGatePath` 等于规范路径。
- `readyState` 目前主要作为字符串存在，未在 package-ready helper 中按 scope
  枚举强校验。

## 9. CLI typed error 与 timing 可观测

判定：PASS

证据：
- `resolveUpperTypedQueryErrorDetails()` 已包含
  `upper_package_migration_required`，exit code 为 65，retryable 为 false。
- missing package 返回 `upper_index_missing`，exit code 为 66。
- stale、quality gate failed、budget exceeded、runtime error 均有明确 code 与
  remediation command。
- `qmd.ts` 在 graph capability 与 graph query 两个阶段捕获
  Bookshelf/Library scope error，并输出 `metadata.diagnostics`、scope kind/id、
  `timingAvailable`。
- CLI route 测试断言 missing package 与 legacy catalog-only 的 stderr typed
  error、exit code、remediation 和 timing 字段。

## 10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归

判定：PASS_WITH_RISK

证据：
- parquet inspect bridge 检查 forbidden field、provider payload、raw prompt、
  credential、绝对路径等敏感模式，污染时返回
  `sensitive_payload_detected:*`。
- 新增 `test/cli-graphrag-upper-index-failclosed.test.ts` 构造 polluted
  `community_reports.parquet`，期望 CLI 返回 `upper_quality_gate_failed`。
- implementation-turn_008 记录 qmd vsearch smoke 成功。

风险：
- 当前 agent 未运行 polluted parquet CLI 测试。
- 当前 package-root 迁移后，单书 `--graph-book-id` 真实回答仍需重跑；此前报告中
  单书 GraphRAG provider/runtime 可用性被列为保留风险。

## 必须修复项

1. 在继续实施审计收敛前，运行当前 package-root 工作区的目标测试：
   `tsc --noEmit`、bookshelf membership/graph、library membership/graph、
   CLI query scope、CLI route、CLI upper-index fail-closed。
2. 增加 package-ready 状态指针加固：校验 `CURRENT.json.sha256`，
   强制 `current.current === generations/{current.generation}`，并校验
   `readyState` 为 scope 对应 query-ready 枚举值。
3. 完整校验 root quality gate 与 `PUBLISH_READY.qualityGatePath`：
   root gate sidecar 必须匹配文件内容，publish marker 的 manifest/gate/current
   路径必须等于规范 package-local 路径。
4. 增加显式删除 catalog projection 的 CLI/query 测试：删除
   `graph_vault/catalog/bookshelves/**` 或 `graph_vault/catalog/library/**` 后，
   `--bookshelf-id`、`--library-id` 仍从 package root 成功查询。
5. 增加 failed/running/pending 指针反例：即使 staging 或 runs 中存在这些状态，
   查询也只能接受 package root 的 query-ready generation。
6. 重跑单书 hotplug 质量门、单书 `--graph-book-id` 查询和 qmd vsearch，作为本轮
   package-root 迁移后的非回归证据。

## 保留风险

- 当前审计基于静态代码与测试读取，未执行命令；实际运行仍可能暴露测试迁移、
  fixture 路径或 Python parquet 依赖问题。
- `upper_package_migration_required` 已覆盖 legacy catalog-only 发现，但没有自动迁移
  工具；用户需要通过重建命令生成 package-root 上层包。
- 固定预算测试已有规模模拟，但真实大 library 的发布、查询延迟和 provider/runtime
  组合仍需后续 smoke 与实施审计复核。
