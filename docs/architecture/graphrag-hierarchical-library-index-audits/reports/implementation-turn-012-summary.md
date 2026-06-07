# implementation-turn_012 汇总报告

## 结论

总体结论：`PASS_WITH_RISK`。

三名实施审计代理均依据固定 10 项实施审计维度完成只读复审，结论分别为：

- agent-1：`PASS_WITH_RISK`
- agent-2：`PASS_WITH_RISK`
- agent-3：`PASS_WITH_RISK`

本轮复审未发现新的必须修复项。implementation-turn_011 后新增的
failed/staging CLI fixture 覆盖已由三名代理确认闭环：

- bookshelf failed `CURRENT.json` 显式 CLI 查询 fail closed。
- bookshelf staging `CURRENT.json` 显式 CLI 查询 fail closed。
- library failed `CURRENT.json` 显式 CLI 查询 fail closed。
- library staging `CURRENT.json` 显式 CLI 查询 fail closed。

这些 fixture 均故意写入 `queryReady: true`，但将 `readyState` 设为
`failed` 或 `staging`。查询路径返回 `upper_quality_gate_failed`，诊断包含
`current_ready_state_mismatch`，并在进入 semantic query bridge 前终止。

本轮不升级为无风险 `PASS`。剩余风险为：真实外部 provider 条件下的单书
`--graph-book-id` 成功回答未执行；catalog projection 生成、LLM synthesis、
受控下钻和 library 管理命令仍属后续能力。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定设计审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 审计轮次：`implementation-turn_012`
- agent 报告：
  - `implementation-turn_012/agent-1/report.md`
  - `implementation-turn_012/agent-2/report.md`
  - `implementation-turn_012/agent-3/report.md`

## 本轮确认闭环

### failed/staging CLI fixture

状态：闭环。

证据：

- `test/cli-graphrag-route.test.ts` 中的参数化测试
  `qmd query --%s-id refuses %s upper CURRENT as query-ready` 覆盖：
  - `bookshelf` + `failed`
  - `bookshelf` + `staging`
  - `library` + `failed`
  - `library` + `staging`
- `writeUpperCurrentFixture()` 只写入
  `graph_vault/bookshelves/{bookshelfId}` 或
  `graph_vault/library/{libraryId}` 下的最小 package-root fixture。
- `CURRENT.json` 设置 `queryReady: true`，但 `readyState` 为
  `failed` 或 `staging`。
- CLI 断言 exit code 为 `65`，typed error code 为
  `upper_quality_gate_failed`，diagnostics 包含
  `current_ready_state_mismatch`，stdout 为空。
- `readQueryReadyPackage()` 在 package-local readiness 阶段先拒绝
  readyState mismatch；semantic query bridge 不会启动。

## 验证证据

主控送审前验证：

- TypeScript build check 通过。
- Type DD YAML parse 通过。
- `test/cli-graphrag-route.test.ts -t "refuses .* upper CURRENT as query-ready"`：
  4 个目标测试通过。
- `test/cli-graphrag-route.test.ts`：19 个测试通过。
- `test/cli-graphrag-query-scope.test.ts`：8 个测试通过。

代理复审中额外验证：

- agent-1：Type DD YAML parse、failed/staging 目标 CLI fixture 和 CLI query
  scope 测试通过。
- agent-2：Type DD YAML parse、failed/staging 目标 CLI fixture、CLI query
  scope、library evidence、upper-index fail-closed 和 qmd vsearch 目标测试通过。
- agent-3：Type DD YAML parse、failed/staging 目标 CLI fixture、完整
  `cli-graphrag-route`、CLI query scope 和 runtime metrics 静态扫描通过。

## 逐项汇总

### 1. 单书包复制传播完整性不回归

判定：`PASS_WITH_RISK`。

新增 fixture 只写入 `graph_vault/bookshelves/{bookshelfId}` 与
`graph_vault/library/{libraryId}`，不写入 `graph_vault/books/{bookId}`。
`cli-graphrag-route` 全文件通过，包含既有单书 `--graphrag`、
`--graph-book-id` 与 auto route 回归。保留风险是未在真实外部 provider 条件下
执行一次生产级单书 `--graph-book-id` 成功回答。

### 2. 书架/library 派生索引不污染单书包

判定：`PASS`。

上层 package root helper 固定使用 `graph_vault/bookshelves/{bookshelfId}` 与
`graph_vault/library/{libraryId}`。新增 failed/staging fixture 也只写入这些
上层包目录。

### 3. 上层包闭包不写入 catalog

判定：`PASS_WITH_RISK`。

package-root 与 legacy catalog root 分离；legacy catalog-only 产物仍返回
`upper_package_migration_required`。保留风险是 catalog projection 生成仍属后续
能力，后续实现时必须继续保持 projection 非权威。

### 4. runner ledger 不参与语义检索

判定：`PASS`。

本轮 fixture 在 package-local readiness 阶段 fail closed，不读取 runner
ledger、`runs/**` 或 `graph_vault/catalog/batch-runs/**` 作为语义输入。

### 5. 查询预算不随书籍数量线性增长

判定：`PASS_WITH_RISK`。

failed/staging fixture 在预算执行前被拒绝；已实现上层查询继续使用固定
`maxReports` 与 `maxInputTokens`。保留风险是 LLM synthesis 与受控下钻仍是后续
能力。

### 6. evidence lineage 可追溯

判定：`PASS_WITH_RISK`。

F-002 后，library bridge 与 inspect 拒绝缺失或 `unknown-*` lower lineage。
本轮重点是 failed/staging CLI fixture，未重新执行真实 provider 端到端回答。

### 7. staging/failed/running/pending/stale 不能被当 ready

判定：`PASS`。

新增参数化 CLI fixture 覆盖 failed/staging 与 bookshelf/library 四个显式上层
scope 组合。running、pending 与 stale 反例已在既有 bookshelf/library graph
测试中覆盖。查询路径要求 readyState 精确匹配
`bookshelf_query_ready` 或 `library_query_ready`。

### 8. manifest、quality gate、publish marker 状态闭环

判定：`PASS`。

query-ready 路径要求 package-local `CURRENT.json`、`CURRENT.json.sha256`、
generation/root manifest、generation/root quality gate、`PUBLISH_READY.json`
和 sidecar 一致。failed/staging fixture 在 CURRENT readyState 校验阶段被拒绝。

### 9. CLI typed error 与 timing 可观测

判定：`PASS`。

failed/staging CLI fixture 返回 exit code `65`、typed error
`upper_quality_gate_failed`、diagnostics `current_ready_state_mismatch` 和
`timingAvailable: true`。bookshelf/library query runtime metrics 已使用 measured
bridge elapsed time。

### 10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归

判定：`PASS_WITH_RISK`。

upper graph validator 与 bridge inspect 仍拒绝 provider payload、raw prompt、
raw completion 和绝对路径；qmd vsearch 目标测试在 agent-2 本轮复审中通过。
保留风险是真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未执行。

## 保留风险

- 真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未验证。
- catalog projection 生成、LLM synthesis、受控下钻和 library 管理命令仍属后续能力。
- 后续新增能力前应继续拆分 upper-index 长文件，避免向核心文件堆叠行为。
