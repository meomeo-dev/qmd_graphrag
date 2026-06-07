overallStatus: PASS_WITH_RISK

# implementation-turn_012 agent-3 实施复审报告

## 结论

本轮复审未发现阻断性必须修复项。implementation-turn_011 后新增的
failed/staging CLI fixture 已覆盖显式 bookshelf 与 library scope 的四个组合：
bookshelf failed、bookshelf staging、library failed、library staging。四个 fixture
均以最小 package-root `CURRENT.json` 设置 `queryReady: true`，并将
`readyState` 置为 failed 或 staging；查询路径返回
`upper_quality_gate_failed`，诊断包含 `current_ready_state_mismatch`，且不输出
stdout。

保留 `PASS_WITH_RISK` 的原因是：真实外部 provider 条件下的单书
`--graph-book-id` 成功回答未在本轮执行；catalog projection 生成、LLM synthesis、
受控下钻与 library 管理命令仍属于后续能力。

## 必须修复项

无。

## 复审依据

- Type DD YAML parse：通过，输出 `yaml-ok`。
- `test/cli-graphrag-route.test.ts -t "refuses .* upper CURRENT as query-ready"`：
  4 项通过，覆盖 failed/staging 与 bookshelf/library 四个组合。
- `test/cli-graphrag-route.test.ts`：19 项通过。
- `test/cli-graphrag-query-scope.test.ts`：8 项通过。
- `rg "totalDurationMs: 0|durationMs: 0|loggedComputeDurationMs: 0"
  src/graphrag/upper-index ...`：无匹配，未发现上层 query metrics 回退为固定 0。

## 重点核查

- `test/cli-graphrag-route.test.ts:728` 的 `writeUpperCurrentFixture` 在
  `graph_vault/bookshelves/{bookshelfId}` 或
  `graph_vault/library/{libraryId}` 下写入 package-root fixture，并在
  `CURRENT.json` 中保留 `queryReady: true` 与非 query-ready `readyState`。
- `test/cli-graphrag-route.test.ts:1111` 参数化覆盖
  `["bookshelf", "failed"]`、`["bookshelf", "staging"]`、
  `["library", "failed"]`、`["library", "staging"]`。
- `test/cli-graphrag-route.test.ts:1140` 到 `1157` 断言退出码 65、
  `upper_quality_gate_failed`、`timingAvailable: true`、
  `current_ready_state_mismatch` 与空 stdout。
- `src/graphrag/upper-index/upper-package-paths.ts:275` 到 `300` 在
  `readQueryReadyPackage` 中先校验 package root、`queryReady` 与
  `readyState`，在 `readyState` 不匹配时直接抛出
  `upper_quality_gate_failed:current_ready_state_mismatch`。
- `src/graphrag/upper-index/bookshelf-query.ts:80` 到 `100` 与
  `src/graphrag/upper-index/library-query.ts:83` 到 `103` 将上述异常映射为
  CLI 可观测的 `upper_quality_gate_failed`，因此 failed/staging fixture 不依赖
  后续 semantic query 失败来通过。
- Type DD 中 `postImplementationTurn011` 将 failed/staging CLI fixture 标记为
  post-turn_011 修复，并明确需要 implementation-turn_012 复审；未将其误写为
  turn_011 已审计闭环。

## 10 项实施审计维度

### 1. 单书包复制传播完整性不回归

判定：通过。

证据：本轮新增 fixture 只写入 `graph_vault/bookshelves/{bookshelfId}` 与
`graph_vault/library/{libraryId}` 的临时 package-root，不写入
`graph_vault/books/{bookId}`。`cli-graphrag-route` 全文件 19 项通过，包含既有
单书 `--graphrag`、`--graph-book-id` 与 auto route 回归。

剩余风险：真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未在本轮
执行，仍需由集成环境验证。

### 2. 书架/library 派生索引不污染单书包

判定：通过。

证据：上层 package root 由
`src/graphrag/upper-index/upper-package-paths.ts:77` 到 `87` 解析到
`bookshelves` 或 `library`，未指向 `books`。failed/staging fixture 的 root 也由
`test/cli-graphrag-route.test.ts:734` 到 `738` 固定在上层包目录。

剩余风险：后续 catalog projection 生成能力落地时，仍需重新确认不会写回单书包
闭包。

### 3. 上层包闭包不写入 catalog，删除 projection 不影响显式查询

判定：通过。

证据：权威 package root helper 指向 `graph_vault/bookshelves` 与
`graph_vault/library`。`graph_vault/catalog/bookshelves` 与
`graph_vault/catalog/library` 仅保留在 legacy 检测分支：
`upper-package-paths.ts:90` 到 `103`，并在缺少 package root 但存在 legacy artifact
时返回 `upper_package_migration_required:legacy_catalog_only`
（`upper-package-paths.ts:289` 到 `293`）。

剩余风险：catalog projection 生成仍是后续能力；需要在实现时保持 projection 非权威
约束。

### 4. runner ledger 不参与语义检索

判定：通过。

证据：本轮核查的 query-ready 路径从 package-root `CURRENT.json`、
generation manifest、quality gate 与 publish marker 建立 readiness；扫描到的
`graph_vault/catalog/batch-runs/**` 位于 batch workflow / observability 相关脚本，
未出现在上层 query scope 语义检索路径。

剩余风险：runner ledger 的全局不可检索性仍应由后续端到端安全扫描持续覆盖。

### 5. 查询预算不随书籍数量线性增长

判定：通过。

证据：bookshelf 与 library query 在进入 bridge 前读取 manifest 中的
`fixedQueryBudget`，并向 bridge 传递 `maxReports` 与 `maxInputTokens`。library
capability 只按 `maxBookshelvesForDeepening` 选择代表书架，bookshelf capability
只按 `maxBooksForDeepening` 选择成员书。

剩余风险：受控下钻、LLM synthesis 与更大规模 library 的真实性能测试仍属后续范围。

### 6. evidence lineage 可追溯

判定：通过。

证据：`scripts/graphrag/library_graph_bridge_build.py` 要求 lower lineage 包含
`targetBookId`、`targetSourceId`、`targetDocumentId`、`targetContentHash`、
`targetCommunityReportId`、`targetTextUnitId` 与 `targetArtifactDigest`，并拒绝
missing / `unknown-*`。`bookshelf_graph_bridge_inspect.py` 对
`evidence_map.parquet` 做同类 fail-closed 诊断。query response 将这些字段映射到
`bookId`、`sourceId`、`documentId`、`contentHash`、`graphTextUnitId` 与
`artifactId`。

剩余风险：跨 generation evidence lineage 的长期兼容性需随 catalog projection 与
library 管理命令补测。

### 7. staging/failed/running/pending/stale 不能被查询路径当作 ready

判定：通过。

证据：本轮新增并验证 failed/staging 四组合 CLI fixture；既有 bookshelf/library
graph 测试覆盖 running/pending `CURRENT` fail-closed；validator 中 stale 诊断映射到
`upper_index_stale` 或 `upper_quality_gate_failed`。核心 readiness 判断在
`readQueryReadyPackage` 中要求 `readyState` 等于 scope 对应 query-ready 状态。

剩余风险：本轮重点覆盖 failed/staging 显式 CLI fixture；更细粒度 stale fixture 可在
后续集成矩阵中继续扩展。

### 8. manifest、quality gate、publish marker 状态闭环完整

判定：通过。

证据：`readQueryReadyPackage` 要求 `CURRENT.json` 与 sidecar、generation manifest
与 sidecar、root manifest 与 sidecar、generation/root quality gate 与 sidecar、
`PUBLISH_READY.json` 与 sidecar 同时存在并相互一致。failed/staging fixture 在
`readyState` 阶段即 fail closed，证明即使 `queryReady: true` 也不能绕过状态闭环。

剩余风险：后续生成 catalog projection 时，需要继续确保 projection 不替代
package-local publish marker。

### 9. CLI typed error 与 timing 可观测

判定：通过。

证据：新增 CLI fixture 断言退出码 65、`route: "graphrag"`、
`stage: "graph_capability"`、`code: "upper_quality_gate_failed"`、
`timingAvailable: true` 与诊断 `current_ready_state_mismatch`。runtimeMetrics 扫描未
发现上层 query duration 固定为 0 的回退。

剩余风险：真实 provider 路径下的 timing 与模型请求指标仍需集成验证。

### 10. 敏感信息不进入可发布索引；单书 GraphRAG 与 qmd vsearch 不回归

判定：通过。

证据：`bookshelf_graph_bridge_inspect.py` 扫描 forbidden fields、provider payload、
raw prompt/completion、secret 与绝对路径；bookshelf/library graph 测试包含敏感
payload fail-closed fixture。`cli-graphrag-route` 全文件通过，覆盖既有单书
GraphRAG CLI 路径；此前 `cli-graphrag-query-scope` 8 项通过，确认 upper scope
错误映射未破坏基础 scope helper。

剩余风险：本轮未重跑完整 qmd vsearch 套件与真实外部 provider 单书回答；这两项仍是
发布前集成验证风险。
