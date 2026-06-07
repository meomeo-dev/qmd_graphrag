overallStatus: PASS_WITH_RISK

# implementation-turn_012 agent-2 实施复审报告

## 审计结论

本轮未发现阻断性必须修复项。implementation-turn_011 之后新增的
failed/staging CLI fixture 已覆盖显式 bookshelf 与 library 查询的四个组合，
并证明即使 `CURRENT.json` 写入 `queryReady: true`，只要 `readyState` 为
`failed` 或 `staging`，查询路径仍以 typed error 快速 fail closed，不进入
semantic query bridge。

保留 `PASS_WITH_RISK` 的原因是：真实外部 provider 条件下的单书
`--graph-book-id` 成功回答仍未在本轮执行；catalog projection 生成、LLM
synthesis、受控下钻和 library 管理命令仍是后续能力。

## 必须修复项

无。

## 本轮核查范围

- 唯一规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 新增 failed/staging CLI fixture：
  `test/cli-graphrag-route.test.ts`
- package-root 关键路径与查询校验：
  `src/graphrag/upper-index/upper-package-paths.ts`
  `src/graphrag/upper-index/bookshelf-query.ts`
  `src/graphrag/upper-index/library-query.ts`
- F-001/F-002/runtimeMetrics 非回退核查：
  `src/graphrag/upper-index/upper-package-paths.ts`
  `scripts/graphrag/library_graph_bridge_build.py`
  `scripts/graphrag/bookshelf_graph_bridge_inspect.py`
  `src/graphrag/upper-index/bookshelf-query.ts`
  `src/graphrag/upper-index/library-query.ts`

## 关键证据

- `test/cli-graphrag-route.test.ts:1111` 到 `1157` 使用
  `test.each` 覆盖 `bookshelf failed`、`bookshelf staging`、
  `library failed`、`library staging` 四个组合。
- `test/cli-graphrag-route.test.ts:728` 到 `769` 的 fixture 仅写入最小
  package-root `CURRENT.json` 与 generation manifest，并故意设置
  `queryReady: true` 与非 ready `readyState`。
- `src/graphrag/upper-index/upper-package-paths.ts:275` 到 `301` 在
  `readQueryReadyPackage` 中先校验 package root、`CURRENT.json`、sidecar、
  manifest sha256 和 ready state；ready state 不匹配时抛出
  `upper_quality_gate_failed:current_ready_state_mismatch`。
- `src/graphrag/upper-index/bookshelf-query.ts:232` 到 `245` 和
  `src/graphrag/upper-index/library-query.ts:272` 到 `285` 显示 semantic query
  bridge 只会在 `readPublishedScope` 成功后启动；上述 fixture 在该阶段前
  已被截断。
- Type DD 在 `postImplementationTurn011` 中明确将 failed/staging fixture 标记为
  post-audit fix，并要求 implementation-turn_012 re-audit，没有误判为
  turn_011 已审计闭环。

## 验证命令

已执行并通过：

- `node -e "const fs=require('fs'); const yaml=require('yaml'); yaml.parse(fs.readFileSync('docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml','utf8')); console.log('yaml-ok')"`
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli-graphrag-route.test.ts -t "refuses .* upper CURRENT as query-ready"`
  - 4 项通过，覆盖 bookshelf failed、bookshelf staging、library failed、
    library staging。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli-graphrag-query-scope.test.ts`
  - 8 项通过。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-library-graph.test.ts -t "evidence"`
  - 2 项通过，覆盖 missing lower evidence 与 `unknown-*` lineage fail closed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli-graphrag-upper-index-failclosed.test.ts`
  - 1 项通过，覆盖污染 upper parquet 的 CLI fail closed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`
  - 1 项通过。

## 10 项实施审计维度

### 1. 单书包复制传播完整性不回归

判定：PASS_WITH_RISK。

证据：本轮关注的 failed/staging fixture 只在
`graph_vault/bookshelves/{bookshelfId}/` 与 `graph_vault/library/{libraryId}/`
下构造上层 package-root 状态，不写入 `graph_vault/books/{bookId}/`。
`readQueryReadyPackage` 读取的是 upper package root；单书包权威仍由既有
book manifest、publish marker、qmd index 和 GraphRAG output 维持。
qmd vsearch 目标回归测试通过。

剩余风险：真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未在本轮
执行，只能判定未见代码层回退，不能判定 provider 运行闭环已完成。

### 2. 书架/library 派生索引不污染单书包

判定：PASS。

证据：upper package path helper 将 bookshelf root 固定为
`graph_vault/bookshelves/{bookshelfId}/`，library root 固定为
`graph_vault/library/{libraryId}/`。新增 fixture 的 root 选择同样遵守该结构。
bookshelf/library graph 与 membership 模块读取成员书包作为输入，但未发现本轮
新增路径写回单书包闭包。

剩余风险：无本轮新增阻断风险。

### 3. 上层包闭包不写入 catalog，删除 projection 不影响显式查询

判定：PASS_WITH_RISK。

证据：`upper-package-paths.ts` 中 package-root 与 legacy catalog root 分离；
缺少 package root 但存在 legacy catalog-only artifact 时返回
`upper_package_migration_required:legacy_catalog_only`。显式 upper query 的
readiness 由 package-local `CURRENT.json`、manifest、quality gate 和
`PUBLISH_READY.json` 证明，而不是由 catalog projection 证明。
`cli-graphrag-query-scope` 测试覆盖 legacy catalog-only typed error 映射。

剩余风险：从 upper package 重新生成 catalog projection 仍属于后续能力；本轮只
确认 catalog 非权威路径未回退。

### 4. runner ledger 不参与语义检索

判定：PASS。

证据：对 `src/graphrag/upper-index`、`src/cli` 与 `scripts/graphrag` 的扫描显示，
upper-index 查询路径没有读取 `graph_vault/catalog/batch-runs/**`。batch-runs
引用仍位于 batch workflow、distribution manifest 等 runner/observability
语境中，未进入 upper semantic query。

剩余风险：无本轮新增阻断风险。

### 5. 查询预算不随书籍数量线性增长

判定：PASS_WITH_RISK。

证据：bookshelf/library query 从 manifest 的 `fixedQueryBudget` 读取
`maxSemanticUnits` 与 `maxInputTokens`，bridge payload 传入 `maxReports` 与
`maxInputTokens`。`test/graphrag-library-graph.test.ts` 已有 10、100、1000
book scale 的固定预算测试；预算超限返回
`budget_exceeded_narrow_scope_required`。

剩余风险：当前上层 query 是固定预算 report search，LLM synthesis 与受控下钻仍
是后续能力；该风险不影响本轮 failed/staging fail-closed 结论。

### 6. evidence lineage 可追溯

判定：PASS。

证据：bookshelf/library query evidence 映射包含 `targetBookId`、
`targetSourceId`、`targetDocumentId`、`targetContentHash`、
`targetCommunityReportId` 和 `targetTextUnitId`。本轮复跑
`test/graphrag-library-graph.test.ts -t "evidence"` 通过，确认 missing lower
evidence 与 `unknown-*` lineage 均 fail closed，F-002 未回退。

剩余风险：无本轮新增阻断风险。

### 7. staging/failed/running/pending/stale 产物不能被当作 ready

判定：PASS。

证据：本轮新增 CLI fixture 覆盖 failed/staging 四个显式 upper scope 组合，并
断言返回 `upper_quality_gate_failed` 与 `current_ready_state_mismatch`。
已有 bookshelf graph 测试覆盖 running CURRENT，library graph 测试覆盖 pending
CURRENT；bookshelf/library stale 成员测试返回 `upper_index_stale`。
`readQueryReadyPackage` 在进入 manifest/gate/publish marker 读取和 semantic
query bridge 前先校验 query-ready readyState。

剩余风险：无本轮新增阻断风险。

### 8. manifest、quality gate、publish marker 状态闭环完整

判定：PASS_WITH_RISK。

证据：query-ready package 校验要求 package-local `CURRENT.json` 及 sidecar、
generation manifest、root manifest、generation/root quality gate、
`PUBLISH_READY.json` 及 sidecar 一致。failed/staging fixture 有意只提供最小
CURRENT 与 generation manifest，且在 readyState 阶段即 fail closed，证明不完整
状态不会被提升为 query-ready。

剩余风险：本轮未执行完整生产构建流水线，只复审测试 fixture 与关键校验路径。

### 9. CLI typed error 与 timing 可观测

判定：PASS。

证据：failed/staging CLI fixture 断言 exit code 65、`code:
upper_quality_gate_failed`、`timingAvailable: true`、scopeKind/scopeId 与诊断
字段。`resolveUpperTypedQueryErrorDetails` 覆盖 missing、migration、runtime
等 upper typed error 映射。bookshelf/library query runtime metrics 已使用真实
bridge elapsed time，未见退回固定 0 的实现。

剩余风险：无本轮新增阻断风险。

### 10. 敏感信息不进入可发布索引；单书 GraphRAG 与 qmd vsearch 不回归

判定：PASS_WITH_RISK。

证据：upper graph validator 与 bridge inspect 对 provider payload、raw prompt、
raw completion、密钥形态和绝对路径进行敏感信息扫描；bookshelf/library 污染
parquet 测试与 CLI fail-closed 测试通过。qmd vsearch 目标回归测试通过。

剩余风险：真实外部 provider 条件下的单书 GraphRAG 成功回答未在本轮执行；因此
该维度保留外部运行风险。

## 最终判定

implementation-turn_012 agent-2 未发现阻断项。新增 failed/staging CLI fixture
覆盖符合送审要求，且 F-001、F-002、runtimeMetrics、package-root authority、
legacy catalog-only migration error 与 catalog projection 非权威路径未见回退。
结论为 `PASS_WITH_RISK`。
