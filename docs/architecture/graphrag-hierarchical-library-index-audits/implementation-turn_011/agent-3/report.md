overallStatus: PASS_WITH_RISK

# implementation-turn_011 agent-3 实施复审报告

## 审计结论

本轮复审未发现 implementation-turn_010 后修复引入新的阻断项。F-001、
F-002 与上层查询 runtime metrics 修复已在源码与目标测试中形成闭环：
非法上层 scope id 在通用 package path 层 fail closed；library evidence
bridge 和 parquet inspect 均拒绝缺失或 `unknown-*` lower lineage；
bookshelf/library query response 的 runtime metrics 已使用 bridge elapsed
time，不再固定为 `0`。

本报告仍判定为 `PASS_WITH_RISK`，原因是外部 provider 条件下的真实单书
`--graph-book-id` 成功回答未在本轮执行，failed/staging 全状态 CLI fixture
覆盖仍不完整，catalog projection 生成、LLM synthesis、受控下钻与 library
管理命令仍属于后续能力。上述风险不阻断当前 package-root 最小实施闭环。

## 审计输入

- 唯一规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 前轮报告：
  `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_010/agent-*/report.md`
- 汇总报告：
  `docs/architecture/graphrag-hierarchical-library-index-audits/reports/final-summary.md`
  与
  `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-010-summary.md`

## 本轮验证

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli-graphrag-query-scope.test.ts`
  通过，8 个测试。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-library-graph.test.ts -t "evidence"`
  通过，2 个目标测试，5 个按过滤条件跳过。
- 静态扫描未发现 upper-index、CLI 或上层脚本把
  `graph_vault/catalog/bookshelves/**` 或 `graph_vault/catalog/library/**`
  当作正常 package-root 写入或查询路径。
- 静态扫描未发现生产源码和脚本保留 `unknown-book`、
  `unknown-source`、`unknown-document`、`unknown-content` 或
  `unknown-text-unit` 占位值；命中仅来自负例测试。

## 必须修复项

无。

## 重点修复复审

### F-001：非法上层 scope id fail closed

判定：PASS。

证据：

- `src/graphrag/upper-index/upper-package-paths.ts:57` 定义
  `assertSafeUpperScopeId(scopeKind, scopeId)`。
- `src/graphrag/upper-index/upper-package-paths.ts:61` 至 `73`
  拒绝空值、前后空白、`/`、`\`、`.`、`..`、包含 `..`、空字节、Windows
  drive 与 URI scheme，并返回 typed quality-gate 错误。
- `bookshelfPackageRoot()`、`libraryPackageRoot()`、
  `legacyBookshelfCatalogRoot()`、`legacyLibraryCatalogRoot()` 和
  `packageLocator()` 均调用该统一校验。
- `test/cli-graphrag-query-scope.test.ts:91` 至 `101` 覆盖
  `../escape`、`file:library` 与 `architecture/core` 三类非法 id。

剩余风险：当前校验属于目录安全约束，不额外限定字符白名单。若未来需要跨平台
归档或 URL 暴露 scope id，可再收紧为显式 slug 规则。

### F-002：lower evidence lineage fail closed

判定：PASS。

证据：

- `scripts/graphrag/library_graph_bridge_build.py:41` 至 `54`
  在找不到 lower evidence 时返回 `None`，不再制造占位值。
- `scripts/graphrag/library_graph_bridge_build.py:57` 至 `79`
  要求 `targetBookId`、`targetSourceId`、`targetDocumentId`、
  `targetContentHash`、`targetCommunityReportId`、`targetTextUnitId`
  与 `targetArtifactDigest` 均存在且不以 `unknown-` 开头。
- `scripts/graphrag/library_graph_bridge_build.py:462` 至 `488`
  捕获 `ValueError` 并返回 `{ ok: false, diagnostics: [...] }`，
  不发布不可追溯产物。
- `scripts/graphrag/bookshelf_graph_bridge_inspect.py:116` 至 `143`
  对 `evidence_map.parquet` 检查必需 lineage 字段，缺失或 `unknown-*`
  时追加 `invalid_evidence_lineage` 诊断。
- `test/graphrag-library-graph.test.ts:953` 至 `1025` 覆盖已发布
  artifact 中 `unknown-*` lineage 的查询 fail closed。
- 本轮目标测试 `test/graphrag-library-graph.test.ts -t "evidence"` 通过。

剩余风险：当前测试覆盖 bookshelf inspect 与 library publish/query 路径；
未来若新增更多上层 evidence artifact 类型，应复用同一 lineage 诊断策略。

### Runtime metrics：真实 bridge elapsed time

判定：PASS。

证据：

- `src/graphrag/upper-index/bookshelf-query.ts:244` 至 `281`
  记录 bridge 调用开始与结束时间。
- `src/graphrag/upper-index/bookshelf-query.ts:334` 至 `355`
  将 `totalDurationMs`、stage `durationMs` 与
  `loggedComputeDurationMs` 写为 `bridgeDurationMs`。
- `src/graphrag/upper-index/library-query.ts:284` 至 `321`
  同步记录 library bridge elapsed time。
- `src/graphrag/upper-index/library-query.ts:375` 至 `396`
  将 library runtime metrics 写为真实 bridge elapsed time。
- 静态扫描未在 upper query 源码中发现 `totalDurationMs: 0`、
  `durationMs: 0` 或 `loggedComputeDurationMs: 0` 的固定上层查询指标。

剩余风险：现有测试主要验证 metrics 存在与 token/request 预算，不强断言
duration 大于零；在极快 fake bridge 场景中真实 elapsed time 仍可能为 `0`。
该行为不再是固定常量，不阻断当前审计。

## 逐项实施审计维度

### 1. 单书包复制传播完整性不回归

判定：PASS_WITH_RISK。

证据：上层 package root 与单书包闭包分离；主控送审前已验证 book hotplug
runtime/capability 与 qmd vsearch 目标回归。本轮复审未发现上层路径 helper
写入 `graph_vault/books/{bookId}`。

剩余风险：本轮未在真实外部 provider 可用条件下执行一次生产级单书
`--graph-book-id` 成功回答，因此保留外部运行风险。

### 2. 书架/library 派生索引不污染单书包

判定：PASS。

证据：Type DD 将 bookshelf 权威根限定为
`graph_vault/bookshelves/{bookshelfId}`，library 权威根限定为
`graph_vault/library/{libraryId}`。测试中 bookshelf graph 构建后断言成员
`graph_vault/books/{bookId}` 下不存在 `BOOKSHELF_MANIFEST.json` 或
`semantic_units.parquet`。

剩余风险：无当前阻断风险。

### 3. 上层包闭包不写入 catalog，删除 projection 不影响显式查询

判定：PASS。

证据：`readQueryReadyPackage()` 先校验 package root；仅当 package root 缺失
且 legacy catalog-only artifact 存在时返回
`upper_package_migration_required:legacy_catalog_only`。bookshelf 与 library
测试均覆盖创建后删除 catalog projection，显式 package-root query 仍成功。
静态扫描未发现 upper-index、CLI 或上层脚本把
`graph_vault/catalog/bookshelves/**` 或 `graph_vault/catalog/library/**`
当作正常 package 闭包。

剩余风险：从上层 package 重建 catalog projection 仍是后续能力；该缺口不影响
显式上层 package 查询。

### 4. runner ledger 不参与语义检索

判定：PASS。

证据：上层 query path 读取 package-local `CURRENT.json`、manifest、
quality gate、`PUBLISH_READY.json`、`community_reports.parquet` 与
`evidence_map.parquet`。静态扫描未发现 bookshelf/library upper query 或 bridge
把 `graph_vault/catalog/batch-runs/**`、`runs/**` 或 `events.jsonl` 作为语义检索
输入；runs/events 仅作为构建观测状态。

剩余风险：无当前阻断风险。

### 5. 查询预算不随书籍数量线性增长

判定：PASS。

证据：bookshelf/library query 均从 manifest fixed query budget 取得
`maxSemanticUnits` 与 `maxInputTokens`，并允许调用方显式收窄。library 测试覆盖
10、100、1000 book 规模模拟，selected reports、token 上限与 evidence 输出保持
固定预算。

剩余风险：当前上层查询是 fixed-budget report search，LLM synthesis 与受控下钻尚未
实现；未来新增能力必须继续维持固定 LLM 调用数、候选语义单元数、token 上限和
下钻 scope 数。

### 6. evidence lineage 可追溯

判定：PASS。

证据：query evidence 输出包含 `bookId`、`sourceId`、`documentId`、
`contentHash`、`graphTextUnitId` 与 community report artifact id。F-002 后，
library build 和 inspect 均拒绝缺失或 `unknown-*` lower lineage；本轮目标测试
覆盖 build-time missing lower evidence 与 published artifact `unknown-*`
fail closed。

剩余风险：未来新增非 parquet evidence artifact 或跨 scope 深挖链路时，需要将同一
lineage 必需字段作为合同复用。

### 7. staging/failed/running/pending/stale 产物不能被当 ready

判定：PASS_WITH_RISK。

证据：`readQueryReadyPackage()` 要求 `CURRENT.json`、`CURRENT.json.sha256`、
generation/root manifest、generation/root quality gate、`PUBLISH_READY.json`
及 sidecar 一致，并校验 `readyState` 必须为 query-ready。现有测试覆盖 bookshelf
running、library pending、stale member manifest 与 legacy catalog-only fail closed。

剩余风险：failed/staging 全状态枚举的独立 CLI fixture 仍不完整；目前证据足以覆盖
主要 query-ready 闭环，但不升级为无风险 PASS。

### 8. manifest、quality gate、publish marker 状态闭环完整

判定：PASS。

证据：`readQueryReadyPackage()` 校验 root/generation manifest sha256 一致、
root/generation quality gate sidecar 一致、`PUBLISH_READY.json` scope/generation/
manifest/gate/current path 一致。validator 进一步校验 manifest files、row count、
quality gate required checks 与 member manifest sha。

剩余风险：无当前阻断风险。

### 9. CLI typed error 与 timing 可观测

判定：PASS_WITH_RISK。

证据：CLI scope helper 测试覆盖 missing upper index、legacy catalog-only
migration error、upper runtime error 和 unsafe scope id typed error。F-003 后，
bookshelf/library query response runtime metrics 使用 bridge elapsed time，并保留
prompt token、selected report count、max input token 等固定预算观测字段。

剩余风险：本轮未执行完整 CLI smoke 查询；failed/staging CLI fixture 尚未覆盖全枚举。
因此保持 `PASS_WITH_RISK`。

### 10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归

判定：PASS_WITH_RISK。

证据：`bookshelf_graph_bridge_inspect.py` 保留 provider payload、raw prompt、
raw completion、credential、absolute path 与 query log 扫描；library graph 测试覆盖
parquet 中敏感 payload 被 validator 与 query path fail closed。主控送审前已验证
qmd vsearch 目标回归和单书 hotplug runtime/capability 测试。

剩余风险：真实外部 provider 条件下的单书 `--graph-book-id` 成功回答仍未执行；
这是外部环境风险，不是当前 F-001/F-002/runtime metrics 修复阻断项。

## 文档状态复审

Type DD 与 final summary 未把 implementation-turn_010 误写为最终无风险通过。
Type DD 明确记录 `postImplementationTurn010.status` 为
`package_root_hardening_fixed_pending_reaudit`，并要求
`implementation-turn_011` 复审。final summary 明确
implementation-turn_010 的正式 agent 报告仍为 `PASS_WITH_RISK`，且 F-001、F-002
与 runtime metrics 修复发生在 agent 报告之后，不能记为最终无风险通过。

catalog 职责表述仍保持 projection、routing 与 observability；未发现把
`graph_vault/catalog/**` 重新描述为 bookshelf/library package authority 的新增
问题。
