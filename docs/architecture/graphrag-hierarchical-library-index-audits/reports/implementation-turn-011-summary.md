# implementation-turn_011 汇总报告

## 结论

总体结论：`PASS_WITH_RISK`。

三名实施审计代理均依据固定 10 项实施审计维度完成只读复审，结论分别为：

- agent-1：`PASS_WITH_RISK`
- agent-2：`PASS_WITH_RISK`
- agent-3：`PASS_WITH_RISK`

本轮复审未发现新的必须修复项。implementation-turn_010 后的 F-001、F-002
和 runtime metrics 修复已由三名代理确认闭环：

- 非法 bookshelf/library scope id 在通用 upper package path 层 fail closed。
- library evidence bridge 不再生成 `unknown-*` 占位 lineage。
- upper parquet inspect 拒绝缺失或 `unknown-*` evidence lineage。
- bookshelf/library query runtime metrics 使用真实 bridge elapsed time。

本轮不升级为无风险 `PASS`。保留风险为：真实外部 provider 条件下的单书
`--graph-book-id` 成功回答未执行；failed/staging 全状态枚举的独立 CLI
fixture 仍不完整；catalog projection 生成、LLM synthesis、受控下钻与 library
管理命令仍是后续能力。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定设计审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 审计轮次：`implementation-turn_011`
- agent 报告：
  - `implementation-turn_011/agent-1/report.md`
  - `implementation-turn_011/agent-2/report.md`
  - `implementation-turn_011/agent-3/report.md`

## 本轮确认闭环

### F-001：非法上层 scope id 统一拒绝

状态：闭环。

证据：

- `src/graphrag/upper-index/upper-package-paths.ts` 定义
  `assertSafeUpperScopeId(scopeKind, scopeId)`。
- 统一拒绝空值、前后空白、`/`、`\`、`.`、`..`、包含 `..`、空字节、
  Windows drive 和 URI scheme。
- `bookshelfPackageRoot()`、`libraryPackageRoot()`、legacy catalog root helper
  与 `packageLocator()` 均调用该校验。
- `test/cli-graphrag-query-scope.test.ts` 覆盖非法 bookshelf 与 library scope id。

### F-002：evidence lineage 缺失或 unknown 占位 fail closed

状态：闭环。

证据：

- `scripts/graphrag/library_graph_bridge_build.py` 在找不到 lower evidence 时
  返回失败 diagnostics，不生成占位 lineage。
- `_required_lower_lineage()` 要求 `targetBookId`、`targetSourceId`、
  `targetDocumentId`、`targetContentHash`、`targetCommunityReportId`、
  `targetTextUnitId` 和 `targetArtifactDigest` 均存在且不是 `unknown-*`。
- `scripts/graphrag/bookshelf_graph_bridge_inspect.py` 对
  `evidence_map.parquet` 增加 lineage 诊断，拒绝缺失字段和 `unknown-*`。
- `test/graphrag-library-graph.test.ts` 覆盖 build-time 缺失 lower evidence
  fail-closed 和 published artifact `unknown-*` lineage fail-closed。

### Runtime metrics：真实 bridge elapsed time

状态：闭环。

证据：

- `src/graphrag/upper-index/bookshelf-query.ts` 将 `totalDurationMs`、stage
  `durationMs` 与 `loggedComputeDurationMs` 写为 measured bridge duration。
- `src/graphrag/upper-index/library-query.ts` 同步使用 measured bridge duration。
- 静态扫描未发现上层 query metrics 仍硬编码为 `0`。

## 送审前与复审验证

主控送审前验证：

- TypeScript build check 通过。
- Type DD YAML parse 通过。
- `test/cli-graphrag-query-scope.test.ts`：8 个测试通过。
- `test/graphrag-library-graph.test.ts`：7 个测试通过。
- `test/graphrag-bookshelf-graph.test.ts`：4 个测试通过。
- `test/graphrag-bookshelf-membership.test.ts` 与
  `test/graphrag-library-membership.test.ts`：5 个测试通过。
- `test/cli-graphrag-route.test.ts`：15 个测试通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 个测试通过。
- `test/graphrag-book-hotplug-runtime-gate.test.ts` 与
  `test/graphrag-capability-scope.test.ts`：12 个测试通过。
- `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`：
  1 个目标测试通过，51 个非目标测试按过滤条件跳过。

代理复审中额外验证：

- agent-1：Type DD YAML parse、CLI query scope、library graph、bookshelf graph
  和 upper-index fail-closed 目标测试通过。
- agent-2：Type DD YAML parse、CLI query scope 和 library graph 全文件通过。
- agent-3：TypeScript build、CLI query scope 和 library graph evidence 目标测试通过。

## 逐项汇总

### 1. 单书包复制传播完整性不回归

判定：`PASS_WITH_RISK`。

上层 package-root 构建和查询未写回单书包闭包，单书 hotplug runtime gate、
capability scope 和 qmd vsearch 目标回归通过。保留风险是未在真实外部
provider 条件下取得一次生产级单书 `--graph-book-id` 成功回答。

### 2. 书架/library 派生索引不污染单书包

判定：`PASS`。

bookshelf 产物写入 `graph_vault/bookshelves/{bookshelfId}`，library 产物写入
`graph_vault/library/{libraryId}`。测试覆盖成员单书包未被写入上层 manifest
或 parquet。

### 3. 上层包闭包不写入 catalog

判定：`PASS`。

显式上层查询从 package root 校验 query-ready；删除 catalog projection 后显式
bookshelf/library package 查询仍成功。legacy catalog-only 上层产物返回
`upper_package_migration_required`。

### 4. runner ledger 不参与语义检索

判定：`PASS`。

查询路径只读取 package-local manifest、quality gate、community reports、
evidence map 和相关 parquet 语义产物。runner ledger 和
`graph_vault/catalog/batch-runs/**` 不参与语义输入。

### 5. 查询预算不随书籍数量线性增长

判定：`PASS`。

bookshelf/library 查询使用固定 `maxReports` 与 `maxInputTokens`。library
10、100、1000 book 规模模拟验证 selected report、token 估算和 evidence
数量保持固定。

### 6. evidence lineage 可追溯

判定：`PASS`。

F-002 后，library bridge 与 inspect 均拒绝缺失或 `unknown-*` lower lineage。
上层 evidence 保留 book/source/document/contentHash/community report/text_unit
回链字段和 package-root locator。

### 7. staging/failed/running/pending/stale 不能被当 ready

判定：`PASS_WITH_RISK`。

`CURRENT.json`、`CURRENT.json.sha256`、manifest、quality gate、
`PUBLISH_READY.json` 和 sidecar 均纳入 query-ready 校验。running、pending 与
stale 反例已覆盖。turn_011 当时的保留风险是 failed/staging 全状态枚举的
独立 CLI fixture 仍不完整；该覆盖后续已在 implementation-turn_012 复审闭环。

### 8. manifest、quality gate、publish marker 状态闭环

判定：`PASS`。

package-local root/generation manifest、quality gate、`CURRENT.json`、
`PUBLISH_READY.json` 和 checksum sidecar 均纳入 query-ready 验证；篡改或缺失
会 fail closed。

### 9. CLI typed error 与 timing 可观测

判定：`PASS_WITH_RISK`。

CLI typed error 覆盖 missing、legacy catalog-only、scope ambiguity、runtime
error 和 over budget；上层 query runtime metrics 已使用真实 bridge elapsed
time。turn_011 当时的保留风险是 failed/staging CLI fixture 未覆盖全枚举；
该覆盖后续已在 implementation-turn_012 复审闭环。

### 10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归

判定：`PASS_WITH_RISK`。

upper parquet 污染 fail-closed、provider payload/raw prompt/raw completion/
绝对路径扫描、qmd vsearch 目标回归和单书 hotplug runtime/capability 回归均通过。
保留风险是真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未执行。

## 保留风险

- 真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未验证。
- failed/staging 全状态枚举的独立 CLI fixture 在 turn_011 后已本地补强，
  需 implementation-turn_012 复审确认。
- catalog projection 生成、LLM synthesis、受控下钻和 library 管理命令仍属后续能力。
- 后续新增能力前应继续拆分 upper-index 长文件，避免向核心文件堆叠行为。

## turn_011 后本地补强

- `test/cli-graphrag-route.test.ts` 新增参数化 CLI fixture，覆盖
  bookshelf failed、bookshelf staging、library failed 与 library staging
  `CURRENT.json` 均返回 `upper_quality_gate_failed` 和
  `current_ready_state_mismatch`。
- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `test/cli-graphrag-route.test.ts -t "refuses .* upper CURRENT as query-ready"`：
  4 个目标测试通过。
- `test/cli-graphrag-route.test.ts` 完整回归通过，19 个测试通过。

该补强发生在 implementation-turn_011 三份 agent 报告之后，不改变
implementation-turn_011 的正式审计结论。下一轮 implementation-turn_012 应复审
该补强并确认是否移除 failed/staging CLI fixture 覆盖风险。

## implementation-turn_012 后续复审

implementation-turn_012 已复审该补强。三名 agent 均判定
`PASS_WITH_RISK` 且无新的必须修复项，并确认 failed/staging CLI fixture 覆盖
bookshelf failed、bookshelf staging、library failed 和 library staging 四个组合。
该覆盖风险已闭环；剩余风险为真实外部 provider 条件下的单书
`--graph-book-id` 成功回答未验证，以及 catalog projection、LLM synthesis、
受控下钻和 library 管理命令仍属后续能力。
