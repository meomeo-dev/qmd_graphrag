# implementation-turn_010 汇总报告

## 结论

总体结论：`PASS_WITH_RISK`。

三名实施审计代理均依据固定实施审计维度完成只读审计，结论分别为：

- agent-1：`PASS_WITH_RISK`
- agent-2：`PASS_WITH_RISK`
- agent-3：`PASS_WITH_RISK`

本轮审计确认 bookshelf 与 library 已按 design-turn_012 的 package-root 目录
权威实现核心闭环：bookshelf 权威根为
`graph_vault/bookshelves/{bookshelfId}/`，library 权威根为
`graph_vault/library/{libraryId}/`；`graph_vault/catalog/**` 仅作为 projection、
routing 与 observability；legacy catalog-only 上层产物在查询路径返回
`upper_package_migration_required`。

本轮不升级为无风险 `PASS`。agent-2 提出两个必须修复项，agent-1 与
agent-3 也记录了测试稳定性、真实 provider 回归、failed/staging CLI fixture
和 runtime metrics 精度风险。主控已在审计后完成 F-001、F-002 与上层查询
runtime metrics 修复，并完成目标验证；这些审计后修复仍需要
`implementation-turn_011` 三代理复审后才能闭环。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定设计审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 审计轮次：`implementation-turn_010`
- agent 报告：
  - `implementation-turn_010/agent-1/report.md`
  - `implementation-turn_010/agent-2/report.md`
  - `implementation-turn_010/agent-3/report.md`

## 本轮必须修复项

### F-001：统一拒绝非法上层 scope id

agent-2 发现 `upper-package-paths.ts` 在通用 package root 层缺少统一
`scopeId` 目录名约束。该缺口可能破坏
`graph_vault/bookshelves/{bookshelfId}` 与
`graph_vault/library/{libraryId}` 的闭包边界。

审计后修复：

- `src/graphrag/upper-index/upper-package-paths.ts` 新增
  `assertSafeUpperScopeId(scopeKind, scopeId)`。
- 拒绝空值、前后空白、`/`、`\`、`.`、`..`、包含 `..`、空字节、Windows
  drive 和 URI scheme。
- `bookshelfPackageRoot()`、`libraryPackageRoot()`、
  `legacyBookshelfCatalogRoot()`、`legacyLibraryCatalogRoot()` 和
  `packageLocator()` 均调用统一校验。
- `test/cli-graphrag-query-scope.test.ts` 增加非法上层 scope id 拒绝测试。

### F-002：library evidence bridge 拒绝不可追溯占位值

agent-2 发现 library bridge 在下层 evidence 缺失时可能写入 `unknown-*`
占位值。该行为满足非空 schema，但不满足 evidence lineage 可追溯要求。

审计后修复：

- `scripts/graphrag/library_graph_bridge_build.py` 在找不到下层 evidence 时
  fail closed，不再写入占位 evidence。
- `_required_lower_lineage()` 要求 `targetBookId`、`targetSourceId`、
  `targetDocumentId`、`targetContentHash`、`targetCommunityReportId`、
  `targetTextUnitId` 和 `targetArtifactDigest` 均存在且不是 `unknown-*`。
- library bridge 捕获 `ValueError` 并返回 `{ ok: false, diagnostics: [...] }`，
  不产生不可追溯的可发布产物。
- `scripts/graphrag/bookshelf_graph_bridge_inspect.py` 增加
  `evidence_map.parquet` lineage 诊断，拒绝缺失字段和 `unknown-*` 值。
- `test/graphrag-library-graph.test.ts` 增加 build-time 缺失下层 evidence
  fail-closed 和 published artifact `unknown-*` lineage fail-closed 覆盖。

### F-003：上层查询 runtime metrics 使用真实耗时

agent-3 记录上层查询 response 内部 runtime metrics 仍是固定逻辑标记。

审计后修复：

- `src/graphrag/upper-index/bookshelf-query.ts` 将 `totalDurationMs`、stage
  `durationMs` 和 `loggedComputeDurationMs` 改为 bridge 调用真实 elapsed time。
- `src/graphrag/upper-index/library-query.ts` 同步修复。

## 审计后验证

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`：
  通过。
- `test/cli-graphrag-query-scope.test.ts`：8 个测试通过。
- `test/graphrag-library-graph.test.ts`：7 个测试通过。
- `test/graphrag-bookshelf-graph.test.ts`：4 个测试通过。
- `test/graphrag-bookshelf-membership.test.ts`：3 个测试通过。
- `test/graphrag-library-membership.test.ts`：2 个测试通过。
- `test/cli-graphrag-route.test.ts`：15 个测试通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 个测试通过。
- `test/graphrag-book-hotplug-runtime-gate.test.ts` 与
  `test/graphrag-capability-scope.test.ts`：12 个测试通过。
- `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`：
  1 个目标测试通过，51 个非目标测试按过滤条件跳过。

## 逐项汇总

### 1. 单书包复制传播完整性不回归

判定：`PASS_WITH_RISK`。

上层 package-root 构建和查询未写回单书包闭包，单书 GraphRAG route、
runtime gate、capability scope 和 qmd vsearch 目标回归均有测试覆盖。保留风险
是本轮仍未在真实外部 provider 可用条件下取得一次生产级单书
`--graph-book-id` 成功回答。

### 2. 书架/library 派生索引不污染单书包

判定：`PASS`。

bookshelf 产物写入 `graph_vault/bookshelves/{bookshelfId}`，library 产物写入
`graph_vault/library/{libraryId}`。测试断言成员单书包不存在上层 manifest 或
上层 parquet 产物。

### 3. 上层包闭包不写入 catalog

判定：`PASS`。

显式上层查询从 package root 校验 query-ready；删除 catalog projection 后，
显式 bookshelf/library package 查询仍成功。legacy catalog-only 上层产物返回
`upper_package_migration_required`。

### 4. runner ledger 不参与语义检索

判定：`PASS`。

上层查询只读取 package-local manifest、quality gate、community reports、
evidence map 和相关 parquet 语义产物；runner ledger 和
`graph_vault/catalog/batch-runs/**` 不参与语义检索。

### 5. 查询预算不随书籍数量线性增长

判定：`PASS`。

上层查询使用固定 `maxReports` 与 `maxInputTokens`，library 10、100、1000 book
规模模拟验证 selected report、token 估算和 evidence 数量保持固定。

### 6. evidence lineage 可追溯

判定：`PASS_AFTER_FIX`。

审计时 agent-2 发现 library evidence bridge 可能写入 `unknown-*` 占位值。
审计后已改为 build 与 inspect 双侧 fail closed，并补充缺失下层 evidence 与
`unknown-*` published artifact 测试。该修复已由 implementation-turn_011
三代理复审确认闭环。

### 7. staging/failed/running/pending/stale 不能被当 ready

判定：`PASS_WITH_RISK`。

`CURRENT.json`、`CURRENT.json.sha256`、manifest、quality gate、
`PUBLISH_READY.json` 和 sidecar 均纳入 query-ready 校验。running、pending 与
stale 反例已覆盖。turn_010 当时的保留风险是 failed/staging 全状态枚举的
独立 CLI fixture 仍不完整；该覆盖后续已在 implementation-turn_012 复审闭环。

### 8. manifest、quality gate、publish marker 状态闭环

判定：`PASS`。

package-local root/generation manifest、quality gate、`CURRENT.json`、
`PUBLISH_READY.json` 和 checksum sidecar 均纳入 query-ready 验证；篡改或缺失会
fail closed。

### 9. CLI typed error 与 timing 可观测

判定：`PASS_AFTER_FIX`。

CLI typed error 覆盖 missing、legacy catalog-only、scope ambiguity 和 over
budget。审计后已将 bookshelf/library query response 内部 runtime metrics 从
固定 `0` 改为真实 bridge elapsed time。该修复已由 implementation-turn_011
三代理复审确认闭环。

### 10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归

判定：`PASS_WITH_RISK`。

upper parquet 污染 fail-closed、qmd vsearch 目标回归、单书 hotplug runtime gate
和 capability scope 均通过。保留风险仍是真实外部 provider 条件下的单书
`--graph-book-id` 成功回答未执行。

## 保留风险

- implementation-turn_010 的正式 agent 报告仍为 `PASS_WITH_RISK`。
- F-001、F-002 与 runtime metrics 修复发生在 agent 报告之后；后续
  implementation-turn_011 三代理复审已确认闭环。
- 真实外部 provider 条件下的单书 `--graph-book-id` 成功回答仍未完成。
- failed/staging 全状态枚举的独立 CLI fixture 在 turn_010 当时仍不完整；
  后续 implementation-turn_012 已复审确认闭环。
- catalog projection 生成、LLM synthesis、受控下钻和 library 管理命令仍属后续能力。
