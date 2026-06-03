# GraphRAG 单本书热插拔 R6 实现审计报告

## 审计结论

- Agent: `agent-3-runtime-provider`
- 场景: runtime/provider/privacy/query gate
- 总体结论: `partial`
- 固定基准数: `10`
- 判定统计: `pass=5`, `partial=5`, `fail=0`

本轮严格复用
`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r5__open/agent-3-runtime-provider/baseline.yaml`
的 10 个固定基准，未新增、重命名或重排基准。

## 重点核对结果

1. GraphRAG provider evidence locator 已在统一回答（UnifiedAnswer）入口脱敏。
   `sanitizeGraphRagLocator()` 只允许 vault-relative portable path 和
   `urn:` / `doi:` URI，拒绝绝对路径、`file:`、`http(s):` 私有 URI。
   回归测试覆盖绝对路径、内部 URL 和 provider cache metadata 不进入回答。

2. GraphRAG evidence metadata 已通过 `sanitizeVaultMetadata()` 清洗。敏感 key、
   provider request/response/raw payload/body 字段、绝对路径值和 secret 值会被
   剔除；capability 记录也在写入和过滤时清洗 metadata。

3. runtime compatibility digest gate 已实装并有负例测试。伪造
   `parquetSchemaDigest` 会使 runtime gate、package validator 和 graph
   capability projection fail closed。artifact metadata row 的 `createdAt`
   缺失也会触发稳定诊断并阻止 query capability。

4. manifest-first/runtime query gate 有实质修复，但尚未完全闭合。CLI 显式
   GraphRAG 查询按 `--graph-book-id` 和单书 capability scope 选择
   `dataDir`；`resolveBookGraphRagDataDir()` 优先读取
   `BOOK_MANIFEST.json.graphrag.outputManifestPath`。但是本地复核发现
   `BOOK_MANIFEST` 主路径重建 graph capability 的测试仍失败，query-ready
   package 可返回 0 个 `graph_query` capability。

5. catalog projection stale 判断已有修复路径。`ensureCatalogProjectionFromBookHotplugPackages()`
   会比较投影 bookId 集合，缺失或 stale 时重建 catalog；单独测试中 stale
   catalog 重建用例通过。但同文件的 manifest-first 主路径 capability 用例失败，
   说明 stale 判断修复未完全避免 query-ready capability 缺失。

## 验证证据

用户提供的已执行证据：

- unified/cli/hotplug 相关测试：`58 passed`
- 真实 vault：`38 packages`, `30 queryReady`,
  `8 visible_not_query_ready`
- forbidden scan：空

本地只读复核：

- `npx vitest run test/unified-query.test.ts --reporter=dot --testTimeout 60000`
  结果：`37 passed`
- `npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts --reporter=dot --testTimeout 60000`
  结果：`2 passed`
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts --reporter=verbose --testTimeout 60000`
  结果：`1 failed | 7 passed`
- 失败用例：
  `GraphRAG hotplug catalog projection > rebuilds graph capability catalog from BOOK_MANIFEST package`
  在 `test/graphrag-book-hotplug-catalog.test.ts:251` 期望 1 个 capability，
  实际为 0。

## 基准逐项判定

| 序号 | 基准 id | 判定 |
|---:|---|---|
| 1 | `direct_query_entrypoint` | `partial` |
| 2 | `artifact_minimum_closure` | `pass` |
| 3 | `artifact_gate_state_machine` | `pass` |
| 4 | `producer_lineage_completeness` | `partial` |
| 5 | `lineage_artifact_binding` | `partial` |
| 6 | `schema_runtime_compatibility` | `partial` |
| 7 | `query_scope_isolation` | `pass` |
| 8 | `privacy_payload_exclusion` | `pass` |
| 9 | `recovery_diagnostics` | `pass` |
| 10 | `executable_contract_tests` | `partial` |

### 1. `direct_query_entrypoint`

判定：`partial`

CLI 查询入口已按单书 scope 构造 GraphRAG 请求，并优先从 manifest 解析
`dataDir`：

- `src/cli/qmd.ts:3389-3466`
- `src/graphrag/book-package-layout.ts:34-50`
- `src/query/unified-router.ts:493-530`

但 `resolveBookGraphRagDataDir()` 仍有 legacy output fallback；更关键的是，
本地复核中 `BOOK_MANIFEST` 主路径重建 capability 的测试失败，说明 fresh
projection 场景仍可能使 query-ready package 缺失 `graph_query` capability。

### 2. `artifact_minimum_closure`

判定：`pass`

runtime gate 对 manifest 中 `requiredArtifacts` 逐项检查 portable path、manifest
file entry、文件存在、bytes 和 sha256。artifact metadata 还检查 required row、
producerRunId、createdAt、fileSha256、bytes 和 closure digest：

- `src/graphrag/book-hotplug-runtime-gate.ts:163-267`
- `scripts/graphrag/book-hotplug-artifact-metadata.mjs:193-281`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:285-362`
- `test/graphrag-book-hotplug-catalog.test.ts:732-847`

缺少必需 artifact 或 metadata row 时能力不会投影为 query-ready。

### 3. `artifact_gate_state_machine`

判定：`pass`

`buildRuntimeGateState()` 会落盘 `copied`、`candidate`、`validated`、`mounted`
以及 `query_ready` / `visible_not_query_ready` / `quarantined` 当前状态，并
记录 diagnostics 和 rollback action：

- `scripts/graphrag/book-hotplug-quality-gate.mjs:114-178`
- `scripts/graphrag/backfill-hotplug-packages.mjs:299-315`

真实 vault 证据显示 30 个 query-ready 和 8 个 visible-not-query-ready 包，
且 forbidden scan 为空。

### 4. `producer_lineage_completeness`

判定：`partial`

artifact metadata 已覆盖 producer run、step、tool version、schema version、
upstream hashes 和 createdAt。capability projection 还校验 producer stage、
stage fingerprint、provider fingerprint、content hash 和 artifact set：

- `scripts/graphrag/book-hotplug-artifact-metadata.mjs:117-178`
- `src/graphrag/capability-catalog.ts:250-338`
- `src/graphrag/capability-catalog.ts:438-556`

剩余缺口：runtime TS gate 对 `graphrag/runs/*.yaml` 仍主要做存在性检查，未在
该路径解析 run 记录内部的 artifactIds、inputFingerprint、tool/schema version
和生成时间并与 metadata row 逐项比对。

### 5. `lineage_artifact_binding`

判定：`partial`

当前实现已把 manifest files、artifact metadata、state artifacts、checkpoints
和 producerRunIds 进行多层绑定：

- `src/graphrag/book-hotplug-runtime-gate.ts:168-197`
- `src/graphrag/book-hotplug-runtime-gate.ts:243-267`
- `src/job-state/artifact-validation.ts:530-583`
- `scripts/graphrag/book-hotplug-artifact-metadata.mjs:264-273`

剩余缺口与第 4 项一致：runtime query gate 自身未完整验证 run record 内部
artifact/hash/input 语义，仍可能依赖 package validator 或 state checkpoint
间接过滤。

### 6. `schema_runtime_compatibility`

判定：`partial`

四类 digest gate 已实装并能阻断 forged digest：

- `src/graphrag/book-hotplug-runtime-compatibility-digests.ts:76-131`
- `src/graphrag/book-hotplug-runtime-gate.ts:270-330`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:206-283`

但固定基准要求覆盖 GraphRAG runtime、parquet schema、LanceDB schema、
embedding model/dimension、output manifest schema 和 package layout schema。
当前 runtime gate 的强制比较仍集中在 output manifest、parquet、LanceDB 和
artifact metadata 四组 digest；package layout、runtime reader、embedding
model/dimension 等字段未进入 TS gate 的等价强制比较。

### 7. `query_scope_isolation`

判定：`pass`

GraphRAG 查询要求 `selectedBookIds.length === 1`，否则返回 typed error。请求
只传递该书的 `dataDir`、capability ids、source/document/content hash 和
artifact ids。artifact validation 还要求 bookId 匹配并限制在 book-scoped
GraphRAG output：

- `src/cli/qmd.ts:3420-3466`
- `src/job-state/artifact-validation.ts:530-583`
- `src/job-state/artifact-validation.ts:684-699`
- `test/cli-graphrag-route.test.ts:892-940`

### 8. `privacy_payload_exclusion`

判定：`pass`

回答层、metadata 层和 package gate 层均已覆盖 provider payload 排除：

- `src/query/unified-answer.ts:28-50`
- `src/query/unified-answer.ts:109-128`
- `src/vault/metadata.ts:4-69`
- `src/graphrag/book-hotplug-runtime-gate.ts:69-81`
- `src/graphrag/book-hotplug-runtime-gate.ts:346-348`
- `test/unified-query.test.ts:688-738`
- `test/graphrag-book-hotplug-catalog.test.ts:573-617`

provider request/response、logs、debug、trace、`.env` 和 durable recovery payload
不会作为可分发 package material 被接受；GraphRAG provider 返回的绝对路径或
私有 URI 不进入 `UnifiedAnswer.evidence.locator`。

### 9. `recovery_diagnostics`

判定：`pass`

缺失文件、hash mismatch、artifact metadata row 缺失、createdAt 缺失、runtime
compatibility digest mismatch、producer evidence 缺失和 forbidden sensitive
material 均有稳定诊断码，并会阻止 query capability：

- `src/graphrag/book-hotplug-runtime-gate.ts:172-197`
- `src/graphrag/book-hotplug-runtime-gate.ts:243-330`
- `scripts/graphrag/book-hotplug-quality-gate.mjs:123-178`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:206-362`
- `test/graphrag-book-hotplug-catalog.test.ts:623-847`

### 10. `executable_contract_tests`

判定：`partial`

测试覆盖已明显扩大，包含 locator 脱敏、digest forged、createdAt 缺失、provider
payload root 拒绝、missing producer runs、missing metadata row、stale catalog
rebuild、多书歧义和单书 output 选择。

但本地复核仍有一个核心 hotplug catalog 测试失败：

- `test/graphrag-book-hotplug-catalog.test.ts:136-276`
- 失败断言：`test/graphrag-book-hotplug-catalog.test.ts:251`

因此 contract tests 不能判为全通过。

## 主要发现

### F1. Manifest-first capability 主路径仍可能缺失

- 严重度：`high`
- 关联基准：`direct_query_entrypoint`, `executable_contract_tests`
- 证据：
  - `test/graphrag-book-hotplug-catalog.test.ts:136-276`
  - `test/graphrag-book-hotplug-catalog.test.ts:251`
  - `src/graphrag/book-hotplug-catalog.ts:419-440`
  - `src/graphrag/capability-catalog.ts:438-556`

本地复核中，`BOOK_MANIFEST` package 主路径重建 capability 返回 0 个
`graph_query` capability。该问题会使 query-ready package 在 catalog
projection 缺失或重建后仍被显式 GraphRAG 查询拒绝。

### F2. Runtime run record 语义绑定仍不完整

- 严重度：`medium`
- 关联基准：`producer_lineage_completeness`, `lineage_artifact_binding`
- 证据：
  - `src/graphrag/book-hotplug-runtime-gate.ts:378-382`
  - `scripts/graphrag/book-hotplug-artifact-metadata.mjs:264-273`
  - `src/graphrag/capability-catalog.ts:488-548`

runtime gate 会检查 producer run 文件存在，package validator 会检查部分 run
binding，但 runtime query gate 自身未完整核对 run record 内部 artifactIds、
input fingerprint、tool/schema version 和生成时间。

### F3. Runtime compatibility broader fields 未完全进入强制比较

- 严重度：`medium`
- 关联基准：`schema_runtime_compatibility`
- 证据：
  - `src/graphrag/book-hotplug-runtime-compatibility-digests.ts:76-131`
  - `src/graphrag/book-hotplug-runtime-gate.ts:270-330`
  - `scripts/graphrag/book-hotplug-runtime-compatibility.mjs:96-122`

digest mismatch gate 已修复，但强制比较仍只覆盖四类 schema digest。package
layout、runtime reader、embedding model/dimension 等 compatibility 字段尚未被
同等纳入 TS runtime gate。
