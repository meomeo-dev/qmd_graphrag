overallStatus: PASS_WITH_RISK

# implementation-turn_012 agent-1 实施复审报告

## 结论

未发现阻断性必须修复项。implementation-turn_011 之后新增的
failed/staging CLI fixture 覆盖已经落到
`test/cli-graphrag-route.test.ts`，并覆盖以下四个显式上层查询组合：

- `bookshelf` + `failed`
- `bookshelf` + `staging`
- `library` + `failed`
- `library` + `staging`

这些 fixture 构造最小 package-root `CURRENT.json`，显式设置
`queryReady: true`，同时将 `readyState` 设为 `failed` 或 `staging`。
查询路径返回 `upper_quality_gate_failed`，诊断包含
`current_ready_state_mismatch`，并保持 `stdout` 为空。源码路径显示该错误在
语义 bridge 调用之前由 package-local readiness 检查抛出。

保留 `PASS_WITH_RISK` 的原因是：真实外部 provider 条件下的单书
`--graph-book-id` 成功回答仍未由本轮复审执行证明；catalog projection 生成、
LLM synthesis、受控下钻和 library 管理命令仍是后续能力。

## 必须修复项

无。

## 本轮验证

- Type DD YAML parse：通过，输出 `yaml-ok`。
- `test/cli-graphrag-route.test.ts -t "refuses .* upper CURRENT as query-ready"`：
  4 项通过，15 项跳过。
- `test/cli-graphrag-query-scope.test.ts`：8 项通过。

## 关键证据

- `test/cli-graphrag-route.test.ts:728` 定义
  `writeUpperCurrentFixture`，在 `graph_vault/bookshelves/{id}` 或
  `graph_vault/library/{id}` 写入最小 package-root fixture。
- `test/cli-graphrag-route.test.ts:755` 写入 `CURRENT.json`，其中
  `readyState` 来自测试参数，`queryReady` 固定为 `true`。
- `test/cli-graphrag-route.test.ts:1111` 使用参数化矩阵覆盖
  bookshelf failed、bookshelf staging、library failed、library staging。
- `test/cli-graphrag-route.test.ts:1140` 断言退出码为 `65`，
  `test/cli-graphrag-route.test.ts:1147` 断言 code 为
  `upper_quality_gate_failed`，
  `test/cli-graphrag-route.test.ts:1154` 断言诊断包含
  `current_ready_state_mismatch`。
- `src/graphrag/upper-index/upper-package-paths.ts:275` 的
  `readQueryReadyPackage` 先读取 package root；
  `src/graphrag/upper-index/upper-package-paths.ts:299` 在 `readyState` 不是
  `bookshelf_query_ready` 或 `library_query_ready` 时抛出
  `upper_quality_gate_failed:current_ready_state_mismatch`。
- `src/graphrag/upper-index/bookshelf-query.ts:80` 和
  `src/graphrag/upper-index/library-query.ts:84` 都先调用
  `readQueryReadyPackage`；bridge 调用分别在
  `src/graphrag/upper-index/bookshelf-query.ts:245` 和
  `src/graphrag/upper-index/library-query.ts:285` 之后才发生。
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:1809`
  将 post-turn_011 状态标为
  `pass_with_risk_post_fixture_fix_pending_reaudit`，
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:1819`
  记录 failed/staging fixture 是 post-audit fix，
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:1823`
  明确需要 implementation-turn_012 re-audit。

## 10 项实施审计维度

### 1. 单书包复制传播完整性不回归

判定：PASS_WITH_RISK。

证据：新增 fixture 和 package-root 查询路径只涉及
`graph_vault/bookshelves/{bookshelfId}` 与 `graph_vault/library/{libraryId}`。
单书查询仍通过独立 `--graph-book-id` scope，未观察到对
`graph_vault/books/{bookId}` 闭包的写入路径。`upper-package-paths.ts` 的上层
路径 helper 只解析 bookshelves/library root。

剩余风险：本轮未执行真实外部 provider 条件下的单书
`--graph-book-id` 成功回答，只能确认本地上层补强未显示破坏单书包路径。

### 2. 书架/library 派生索引不污染单书包

判定：PASS。

证据：新增 failed/staging fixture 写入 package-root 上层目录，不写入
`graph_vault/books/**`。`writeUpperCurrentFixture` 根据 scope 写入
`graph_vault/bookshelves/{id}` 或 `graph_vault/library/{id}`。

剩余风险：无本轮新增风险。

### 3. 上层包闭包不写入 catalog，删除 projection 不影响显式查询

判定：PASS_WITH_RISK。

证据：上层 package root helper 指向 `bookshelves/{id}` 与 `library/{id}`。
legacy catalog-only 路径只用于检测迁移错误：
`upper_package_migration_required:legacy_catalog_only`。已有 query scope 测试仍
覆盖 legacy catalog-only mapping 与 unsafe id 拒绝。

剩余风险：catalog projection 生成仍是后续能力；本轮重点复审 failed/staging
fixture，不重新执行 catalog projection 删除后的完整 smoke。

### 4. runner ledger 不参与语义检索

判定：PASS。

证据：本轮核查的显式查询 readiness 顺序先校验 package-local
`CURRENT.json`、manifest sha 与 gate 状态；failed/staging fixture 在进入 bridge
前 fail closed。未见查询路径读取 `graph_vault/catalog/batch-runs/**` 作为语义
输入。

剩余风险：无本轮新增风险。

### 5. 查询预算不随书籍数量线性增长

判定：PASS_WITH_RISK。

证据：bookshelf/library 查询在 package readiness 通过后使用 manifest 中的
`fixedQueryBudget.maxInputTokens` 与 `maxSemanticUnits`，bridge payload 传入
`maxReports` 和 `maxInputTokens`。failed/staging fixture 在预算执行前被拒绝，
避免非 ready scope 进入语义检索。

剩余风险：本轮没有重新运行不同规模 library 的固定预算压力测试；保留为覆盖风险。

### 6. evidence lineage 可追溯

判定：PASS_WITH_RISK。

证据：turn_011 后的源码仍保留 F-002 修复：library bridge 要求 lower lineage
字段，bookshelf inspect 拒绝 `unknown-*` lineage。query response 映射仍输出
`bookId`、`sourceId`、`documentId`、`contentHash`、`graphTextUnitId` 与
community report artifact。

剩余风险：本轮重点为 failed/staging CLI fixture，未重新执行完整端到端真实
answer evidence 抽样。

### 7. staging/failed/running/pending/stale 产物不能当作 ready

判定：PASS。

证据：新增参数化 fixture 已覆盖 failed/staging 四个显式上层查询组合。
`readQueryReadyPackage` 在 `readyState` 不等于 query-ready 状态时抛出
`current_ready_state_mismatch`，并由 CLI typed error 映射为
`upper_quality_gate_failed`。历史测试已覆盖 running/pending/stale 类路径。

剩余风险：无本轮新增风险。

### 8. manifest、quality gate、publish marker 状态闭环完整

判定：PASS_WITH_RISK。

证据：`readQueryReadyPackage` 要求 package-local `CURRENT.json`、generation
manifest、root manifest、generation/root quality gate、`PUBLISH_READY.json`
及 sidecar。新增 failed/staging fixture 只有最小 current/manifest，且在
`readyState` mismatch 处提前 fail closed，不会绕过 gate/publish marker。

剩余风险：本轮不重跑完整 publish 生命周期构建；仅复审查询侧闭环未回退。

### 9. CLI typed error 与 timing 可观测

判定：PASS。

证据：新增 fixture 断言 exit code `65`、code
`upper_quality_gate_failed`、`timingAvailable: true`，并检查诊断
`current_ready_state_mismatch`。bookshelf/library query runtime metrics 仍使用
真实 bridge elapsed time，不再固定为 `0`。

剩余风险：无本轮新增风险。

### 10. 安全发布内容与现有能力非回归

判定：PASS_WITH_RISK。

证据：本轮新增 fixture 只写入最小 package metadata，不包含 provider payload、
raw prompt/completion 或绝对路径。F-001 的 unsafe upper scope id 拒绝仍位于
`upper-package-paths.ts`，query scope helper 测试 8 项通过。qmd vsearch 与真实
单书 provider 成功回答不在本轮有限复审命令范围内。

剩余风险：真实外部 provider 条件下的单书 `--graph-book-id` 成功回答仍未执行；
qmd vsearch 全量回归未在本轮复审重跑。
