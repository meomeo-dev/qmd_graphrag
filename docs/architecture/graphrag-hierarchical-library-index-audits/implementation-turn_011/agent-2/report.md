overallStatus: PASS_WITH_RISK

# implementation-turn_011 agent-2 实施审计报告

## 审计范围

本报告执行只读实施审计 (read-only implementation audit)，复审
implementation-turn_010 后主控修复是否闭环。审计依据为唯一 Type DD：

`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮重点复核：

- F-001：上层 scope id 在 package path 层统一拒绝非法目录名。
- F-002：library/bookhelf evidence lineage 缺失或 `unknown-*` 时 fail closed。
- bookshelf/library query runtime metrics 使用真实 bridge elapsed time。
- Type DD 与 final summary 不把 implementation-turn_010 的
  `PASS_WITH_RISK` 误写成最终无风险通过。

审计过程中未修改源码、测试、设计基准或其他文档；仅写入本报告。

## 总体结论

implementation-turn_010 的两个必须修复项已闭环：

- `src/graphrag/upper-index/upper-package-paths.ts:57` 至 `:75`
  新增 `assertSafeUpperScopeId()`，并在 package root、legacy catalog root 与
  package locator 生成前统一调用，覆盖路径穿越、URI scheme、Windows drive、
  分隔符、空值和空字节等非法 id。
- `scripts/graphrag/library_graph_bridge_build.py:41` 至 `:79`、
  `:462` 至 `:488` 已将缺失或 `unknown-*` 下层 evidence lineage 改为
  fail closed diagnostics，不再生成不可追溯占位 evidence。
- `scripts/graphrag/bookshelf_graph_bridge_inspect.py:116` 至 `:143`、
  `:180` 至 `:187` 已对可发布 `evidence_map.parquet` 增加缺失字段和
  `unknown-*` lineage 拒绝。
- `src/graphrag/upper-index/bookshelf-query.ts:244` 至 `:281`、
  `:334` 至 `:355` 和
  `src/graphrag/upper-index/library-query.ts:284` 至 `:321`、
  `:375` 至 `:396` 已用 bridge 调用 elapsed time 填充 runtime metrics，
  不再使用固定 `0`。

未发现新的阻断项。结论仍为 `PASS_WITH_RISK`，原因是本轮只读审计无法证明真实
外部 provider 条件下的单书 `--graph-book-id` 成功回答；failed/staging 全状态
枚举的独立 CLI fixture 也仍是覆盖风险。

## 必须修复项

无。

## 本轮只读验证

- `git status --short --branch`：工作区存在主控变更与新审计目录；本报告未回退或
  覆盖其他文件。
- Type DD YAML parse：通过，输出 `yaml-ok`。
- 静态扫描未发现上层 query metrics 仍硬编码为
  `totalDurationMs: 0`、`durationMs: 0` 或 `loggedComputeDurationMs: 0`。
- 静态扫描中 `unknown-*` 仅出现在风险说明、测试夹具和 fail-closed 拒绝逻辑，
  未发现新的上层 bridge 生成占位 lineage 路径。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli-graphrag-query-scope.test.ts`：
  8 项通过。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-library-graph.test.ts`：
  7 项通过。

## 逐项判定

### 1. 单书包复制传播完整性不回归

status: PASS_WITH_RISK

证据：

- bookshelf membership 仍以单书包 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
  hotplug quality gate、runtime gate 和 published package validator 为成员接收
  前置条件，见
  `src/graphrag/upper-index/bookshelf-membership.ts:310` 至 `:370`。
- 上层 graph build 只读取成员书包的 GraphRAG/qmd 产物，不写回单书包。bookshelf
  bridge payload 读取成员 `communityReportsPath`、`entitiesPath`、
  `relationshipsPath` 与 `textUnitsPath`，见
  `src/graphrag/upper-index/bookshelf-graph.ts:523` 至 `:545`。
- 主控送审前已验证单书 hotplug runtime/capability 与 qmd vsearch 目标回归通过。

剩余风险：

- 本轮未执行真实外部 provider 条件下的单书 `--graph-book-id` 成功回答，只能确认
  本地合同与目标测试未回归。

### 2. 书架/library 派生索引不污染单书包

status: PASS

证据：

- bookshelf graph build 发布到 `graph_vault/bookshelves/{bookshelfId}` 下的
  `generations/{generation}`、root manifest、root quality gate、diagnostics 和
  `PUBLISH_READY.json`，见
  `src/graphrag/upper-index/bookshelf-graph.ts:810` 至 `:845`。
- library graph build 发布到 `graph_vault/library/{libraryId}` 下的同类
  package-local 闭包，见
  `src/graphrag/upper-index/library-graph.ts:713` 至 `:748`。
- library 只把已发布 bookshelf package 作为成员输入，成员 semantic artifacts
  通过 package locator 指向 `bookshelves/{id}/generations/{generation}`，见
  `src/graphrag/upper-index/library-membership.ts:308` 至 `:341`。

剩余风险：

- 未发现污染单书包闭包的实现路径。

### 3. 上层包闭包不写入 catalog，删除 projection 不影响显式查询

status: PASS

证据：

- 上层 package root 由 `bookshelfPackageRoot()` 和 `libraryPackageRoot()` 解析到
  `graph_vault/bookshelves/{id}` 与 `graph_vault/library/{id}`，见
  `src/graphrag/upper-index/upper-package-paths.ts:77` 至 `:88`。
- legacy catalog root 仅用于检测旧产物并返回迁移错误；`readQueryReadyPackage()`
  在 package root 缺失且存在 legacy catalog-only artifact 时抛出
  `upper_package_migration_required:legacy_catalog_only`，见
  `src/graphrag/upper-index/upper-package-paths.ts:250` 至 `:293`。
- library graph 测试覆盖删除 catalog projection 后显式 package 查询仍成功，见
  `test/graphrag-library-graph.test.ts:483` 至 `:498`。
- implementation-turn_010 summary 明确 catalog 只能是 projection、routing 与
  observability，且 F-001/F-002 修复需 turn_011 复审，见
  `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-010-summary.md:20`
  至 `:24`、`:185` 至 `:191`。

剩余风险：

- 从上层包重建 catalog projection 属后续能力；当前审计确认显式查询不依赖
  projection 权威。

### 4. runner ledger 不参与语义检索

status: PASS

证据：

- bookshelf graph build 的语义输入来自成员单书 GraphRAG parquet 与 identity
  artifact，不读取 `graph_vault/catalog/batch-runs/**`，见
  `src/graphrag/upper-index/bookshelf-graph.ts:523` 至 `:545`。
- library graph build 的语义输入来自已发布 bookshelf 的
  `communityReportsPath` 与 `evidenceMapPath`，见
  `src/graphrag/upper-index/library-graph.ts:425` 至 `:446`。
- 静态检索显示 `batch-runs` 仍存在于旧 batch runner 脚本和分发排除规则中，
  未出现在 upper-index 查询或 bridge semantic input 逻辑中。

剩余风险：

- 无新阻断项。建议后续保持 batch-runs 污染反例测试，以防 catalog runner ledger
  被误接入检索。

### 5. 查询预算不随书籍数量线性增长

status: PASS

证据：

- bookshelf query 使用 manifest 的 `fixedQueryBudget.maxInputTokens` 和
  `maxSemanticUnits`，并把 `maxReports`、`maxInputTokens` 传给 bridge，见
  `src/graphrag/upper-index/bookshelf-query.ts:169` 至 `:176`、
  `:243` 至 `:257`。
- library query 同样使用 fixed budget，并限制
  `maxBookshelvesForDeepening` 生成 capability，见
  `src/graphrag/upper-index/library-query.ts:168` 至 `:175`、
  `:226` 至 `:230`、`:283` 至 `:297`。
- library budget 规模测试覆盖 10、100、1000 book simulation，并验证
  semantic unit、selected report、token 和 evidence 指纹固定，见
  `test/graphrag-library-graph.test.ts:625` 至 `:727`。

剩余风险：

- 当前测试使用 deterministic bridge 与 fixture/simulation；真实 LLM synthesis 和受控
  deepening 仍属后续能力，不能外推为已完成。

### 6. evidence lineage 可追溯到 book/source/document/hash/report/text_unit

status: PASS

证据：

- F-002 已修复：`_required_lower_lineage()` 要求 `targetBookId`、
  `targetSourceId`、`targetDocumentId`、`targetContentHash`、
  `targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest` 全部存在
  且不以 `unknown-` 开头，见
  `scripts/graphrag/library_graph_bridge_build.py:57` 至 `:79`。
- 找不到下层 evidence 时 `_evidence_for_report()` 返回 `None`，随后 build 返回
  `{ ok: false, diagnostics: [...] }`，见
  `scripts/graphrag/library_graph_bridge_build.py:41` 至 `:54`、
  `:462` 至 `:488`。
- `bookshelf_graph_bridge_inspect.py` 对所有可发布 `evidence_map.parquet` 检查必需
  lineage 字段并拒绝 `unknown-*`，见
  `scripts/graphrag/bookshelf_graph_bridge_inspect.py:116` 至 `:143`。
- 测试覆盖 build-time 缺失下层 evidence fail closed，见
  `test/graphrag-library-graph.test.ts:734` 至 `:783`；覆盖 published artifact
  `unknown-*` lineage fail closed，见
  `test/graphrag-library-graph.test.ts:953` 至 `:1025`。

剩余风险：

- 当前 lineage 检查证明字段存在且非占位，并通过 lower evidence row 传递；跨包
  digest 对实体文件的全链路证明仍依赖 manifest/sidecar 与 validator 共同维护。

### 7. staging/failed/running/pending/stale 不能被当作 ready

status: PASS_WITH_RISK

证据：

- `readPackageCurrent()` 要求 `CURRENT.json`、`CURRENT.json.sha256`、generation
  manifest 和 manifest sidecar 存在且匹配，并要求 current path 指向
  `generations/{generation}`，见
  `src/graphrag/upper-index/upper-package-paths.ts:183` 至 `:247`。
- `readQueryReadyPackage()` 要求 `queryReady=true`、readyState 匹配
  `bookshelf_query_ready` 或 `library_query_ready`，并校验 root/generation
  manifest、quality gate、`PUBLISH_READY.json` 与 sidecar，见
  `src/graphrag/upper-index/upper-package-paths.ts:275` 至 `:380`。
- library pending pointer 测试覆盖 query fail closed，见
  `test/graphrag-library-graph.test.ts:555` 至 `:623`。
- library stale member bookshelf manifest 测试覆盖 `upper_index_stale`，见
  `test/graphrag-library-graph.test.ts:790` 至 `:862`。

剩余风险：

- running、pending 与 stale 已有覆盖；failed/staging 全状态枚举的独立 CLI fixture
  仍不完整，因此保留风险而非纯 PASS。

### 8. manifest、quality gate、publish marker 状态闭环完整

status: PASS

证据：

- bookshelf publish 采用 staging 校验后 promote 到 generation，再写
  `CURRENT.json`、root `BOOKSHELF_MANIFEST.json`、root gate、diagnostics 和
  `PUBLISH_READY.json`，见
  `src/graphrag/upper-index/bookshelf-graph.ts:797` 至 `:845`。
- library publish 同样在 staging validation 通过后 promote，再写
  `CURRENT.json`、root `LIBRARY_MANIFEST.json`、root gate、diagnostics 和
  `PUBLISH_READY.json`，见
  `src/graphrag/upper-index/library-graph.ts:700` 至 `:748`。
- validators 校验 manifest/gate 存在、sidecar、manifest file closure、parquet
  inspect、evidence row count 和成员 manifest stale，bookshelf 见
  `src/graphrag/upper-index/bookshelf-graph-validator.ts:56` 至 `:160`，
  library 见
  `src/graphrag/upper-index/library-graph-validator.ts:151` 至 `:223`。

剩余风险：

- 未发现状态闭环阻断项。

### 9. CLI typed error 与 timing 可观测

status: PASS

证据：

- CLI typed error 覆盖 `missing_scope`、`ambiguous_scope`、
  `upper_index_missing`、`upper_package_migration_required`、`upper_index_stale`、
  `upper_quality_gate_failed`、`budget_exceeded_narrow_scope_required` 和
  `upper_index_runtime_error`，见
  `src/cli/graphrag-query-scope.ts:15` 至 `:23`、`:100` 至 `:182`。
- F-001 的非法 scope id 测试覆盖 bookshelf package root、library package root 和
  package locator 在 path joining 前拒绝危险 id，见
  `test/cli-graphrag-query-scope.test.ts:91` 至 `:102`。
- F-003 已修复：bookshelf query 的 `totalDurationMs`、stage `durationMs` 与
  `loggedComputeDurationMs` 使用 `bridgeDurationMs`，见
  `src/graphrag/upper-index/bookshelf-query.ts:281`、`:334` 至 `:355`。
- library query 同步使用 `bridgeDurationMs`，见
  `src/graphrag/upper-index/library-query.ts:321`、`:375` 至 `:396`。
- `test/cli-graphrag-query-scope.test.ts` 本轮只读执行 8 项通过。

剩余风险：

- timing 使用 millisecond elapsed time；极快调用理论上可能测得 `0ms`，但不再是固定
  硬编码值。当前 bridge 调用路径通常包含 Python 子进程，实际测试耗时非零。

### 10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归

status: PASS_WITH_RISK

证据：

- `bookshelf_graph_bridge_inspect.py` 检查 provider payload、raw prompt、
  raw completion、credential、Bearer token、API token、query.log 和绝对路径等敏感
  文本，见
  `scripts/graphrag/bookshelf_graph_bridge_inspect.py:15` 至 `:56`、
  `:86` 至 `:113`。
- library sensitive parquet 污染测试验证 query fail closed，见
  `test/graphrag-library-graph.test.ts:870` 至 `:945`。
- 主控送审前已验证 qmd vsearch 目标回归、book hotplug runtime/capability 相关测试
  通过；本轮审计未发现 upper-index 改动写入单书 GraphRAG 或 qmd vsearch 路径。

剩余风险：

- 真实外部 provider 条件下的单书 `--graph-book-id` 成功回答仍未在本轮复审中运行。
  因该风险超出只读实施审计可证明范围，本维度保留 `PASS_WITH_RISK`。

## 文档状态复核

- Type DD 当前状态仍为 `status: design_audit_passed`，并在
  `postImplementationTurn010` 中标注 `package_root_hardening_fixed_pending_reaudit`、
  `auditResult: 3_agents_pass_with_risk` 和
  `requiredNextAudit: implementation-turn_011`，见
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:1796` 至
  `:1806`。
- Type DD 的 implementation sequencing 将 phase1 标注为
  `implemented_with_risk_after_implementation_turn_010_fixes`，并保留
  `implementation-turn_011 three-agent re-audit` 为 remaining，见
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml:2093` 至
  `:2108`。
- final summary 明确 implementation-turn_010 的正式 agent 报告仍为
  `PASS_WITH_RISK`，F-001/F-002/runtime metrics 修复不能把 turn_010 记为最终无风险
  通过，见
  `docs/architecture/graphrag-hierarchical-library-index-audits/reports/final-summary.md:436`
  至 `:441`。

结论：文档未把 implementation-turn_010 的 `PASS_WITH_RISK` 误写成最终无风险通过；
catalog 职责仍被限定为 projection、routing、capability、默认 scope 与
observability。

