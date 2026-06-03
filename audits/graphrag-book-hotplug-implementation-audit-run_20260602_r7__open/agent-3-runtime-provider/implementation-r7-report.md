# GraphRAG 单本书热插拔 R7 实现审计报告

## 审计结论

- Agent: `agent-3-runtime-provider`
- 场景: runtime/provider/privacy/query gate
- 总体结论: `partial`
- 固定基准数: `10`
- 判定统计: `pass=6`, `partial=4`, `fail=0`

本轮沿用 R6 Agent 3 的 10 个固定审计基准，未新增、改名或重排基准。
R6 目录只包含实现报告和 summary；本轮从 R6 报告声明复用的
`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r5__open/agent-3-runtime-provider/baseline.yaml`
复制固定基准到本目录 `fixed-baseline.yaml`。

## 重点核对结果

1. R6 的高严重度问题已修复。`BOOK_MANIFEST` 主路径 catalog rebuild
   现在能生成 `graph_query` capability；本地复核
   `test/graphrag-book-hotplug-catalog.test.ts` 结果为 `8 passed`。

2. manifest-first 直接查询路径已具备可执行闭环。`loadGraphQueryCapabilities()`
   会先确保/重建 hotplug catalog projection，projection 缺失或 stale 时从
   `BOOK_MANIFEST.json` 与包内 artifact 重新投影；CLI 显式 GraphRAG 查询按
   `--graph-book-id` 限定单书，并通过 `resolveBookGraphRagDataDir()` 优先使用
   `BOOK_MANIFEST.graphrag.outputManifestPath`。

3. runtime compatibility digest gate 已可阻断 forged digest。runtime gate、
   package validator 和 capability projection 在 `parquetSchemaDigest` forged
   负例下均 fail closed。

4. provider payload 与 locator 脱敏已闭合到回答层、metadata 层和 package gate
   层。GraphRAG provider evidence 中的绝对路径、内部 URL、provider cache
   metadata 不进入 `UnifiedAnswer`；包内 provider request/response、logs、
   debug、trace、durable recovery payload 会被拒绝。

5. Producer lineage 的实现较 R6 明显增强。capability projection 会读取
   `graphrag/runs/*.yaml`，将 run record 转为 checkpoint candidate，并通过
   `validateBookArtifactSet()` 校验 artifactId、bookId、producerRunId、
   stageFingerprint、providerFingerprint、corpus content hash 和 book-scoped
   output path。

6. 剩余 partial 集中在两类缺口：runtime gate 自身未完整核对 run-record
   语义；runtime compatibility gate 未独立强制 embedding model/dimension、
   package layout 和 runtime reader 等 broader compatibility 字段。

## 验证证据

本地只读复核：

- `npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts --reporter=dot --testTimeout 60000`
  结果：`2 passed`
- `npx vitest run test/unified-query.test.ts --reporter=dot --testTimeout 60000`
  结果：`37 passed`
- `npx vitest run test/cli-graphrag-route.test.ts --reporter=dot --testTimeout 60000`
  结果：`9 passed`
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts --reporter=dot --testTimeout 60000`
  结果：`8 passed`

## 基准逐项判定

| 序号 | 基准 id | 判定 |
|---:|---|---|
| 1 | `direct_query_entrypoint` | `pass` |
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

判定：`pass`

`loadGraphQueryCapabilities()` 先调用
`ensureCatalogProjectionFromBookHotplugPackages()`，projection 缺失、stale 或
query-ready package 存在但 capability 为空时会触发
`rebuildCatalogFromBookHotplugPackages()`，并从包内 manifest、identity、artifact
metadata、runtime compatibility 和 run evidence 重建 capability。

主要证据：`src/graphrag/capability-catalog.ts:807`,
`src/graphrag/book-hotplug-catalog.ts:420`,
`src/graphrag/book-package-layout.ts:34`, `src/cli/qmd.ts:3405`,
`test/graphrag-book-hotplug-catalog.test.ts:136`。

### 2. `artifact_minimum_closure`

判定：`pass`

`RequiredGraphRagArtifacts` 覆盖 output manifest、identity map、artifact metadata、
runtime compatibility、context/stats、parquet、community reports 和 LanceDB。
runtime gate 检查 requiredArtifacts 的 package-relative path、manifest file entry、
存在性、bytes 和 sha256；artifact metadata row 缺失会阻断 capability。

主要证据：`scripts/graphrag/book-hotplug-package.mjs:33`,
`src/graphrag/book-hotplug-runtime-gate.ts:163`,
`src/graphrag/book-hotplug-runtime-gate.ts:200`,
`test/graphrag-book-hotplug-catalog.test.ts:732`。

### 3. `artifact_gate_state_machine`

判定：`pass`

`buildRuntimeGateState()` 记录 copied、candidate、validated、mounted，以及
`query_ready` / `visible_not_query_ready` / `quarantined` 当前状态、diagnostics 和
rollback action。package validator、runtime gate 和 catalog projection 均在 gate
未通过时阻止 query capability。

主要证据：`scripts/graphrag/book-hotplug-quality-gate.mjs:114`,
`scripts/graphrag/book-hotplug-package.mjs:713`,
`src/graphrag/book-hotplug-runtime-gate.ts:332`,
`src/graphrag/capability-catalog.ts:471`。

### 4. `producer_lineage_completeness`

判定：`partial`

已覆盖 producer run、step、tool version、schema version、upstream hashes 和 createdAt
的 metadata gate；capability projection 会读取 run record 并通过 checkpoint
语义、artifact set validation 和 content/stage/provider fingerprint 校验 lineage。

剩余缺口：runtime query gate 入口对 `graphrag/runs/*.yaml` 仍主要做存在性检查。
它未在同一入口解析 run record 并逐项比较 run-record `artifactIds`、
`inputFingerprint`、tool/schema version、生成时间与 artifact metadata rows。

证据：

- `scripts/graphrag/book-hotplug-artifact-metadata.mjs:117`
- `scripts/graphrag/book-hotplug-artifact-metadata.mjs:193`
- `src/graphrag/book-hotplug-runtime-gate.ts:243`
- `src/graphrag/book-hotplug-runtime-gate.ts:378`
- `src/graphrag/capability-catalog.ts:182`
- `src/graphrag/capability-catalog.ts:467`
- `src/job-state/artifact-validation.ts:497`

### 5. `lineage_artifact_binding`

判定：`partial`

当前 capability route 已把 artifacts 与 bookId、producerRunId、stage/provider
fingerprint、corpus content hash、book-scoped output path 绑定；manifest files 与
artifact metadata closure digest 也会校验。缺失 producer run 或 artifact metadata
row 会使 package validation 和 capability projection fail closed。

剩余缺口与第 4 项一致：runtime gate 自身还没有完整强制
`producerRunIds`、`graphrag/runs`、artifact metadata rows 和 files closure 的双向
语义绑定。

证据：

- `src/graphrag/book-hotplug-runtime-gate.ts:168`
- `src/graphrag/book-hotplug-runtime-gate.ts:243`
- `src/graphrag/book-hotplug-runtime-gate.ts:378`
- `src/graphrag/capability-catalog.ts:517`
- `src/job-state/artifact-validation.ts:530`
- `scripts/graphrag/book-hotplug-artifact-metadata.mjs:264`
- `test/graphrag-book-hotplug-catalog.test.ts:623`
- `test/graphrag-book-hotplug-catalog.test.ts:732`

### 6. `schema_runtime_compatibility`

判定：`partial`

runtime compatibility artifact 记录 package schema/layout、qmd/GraphRAG artifact
schema、runtime tool/version、provider fingerprint 和 embedding dimension；TS runtime
gate 对 output manifest、parquet、LanceDB、artifact metadata 四类 semantic digest
执行强制比较。forged digest 负例已覆盖 query-critical digest mismatch。

剩余缺口：package layout、runtime reader、embedding model/dimension 等 broader
compatibility 字段被写入 metadata，但未作为独立 fail-closed 比较项进入 TS
runtime gate。

证据：

- `scripts/graphrag/book-hotplug-runtime-compatibility.mjs:96`
- `scripts/graphrag/book-hotplug-runtime-compatibility.mjs:137`
- `src/graphrag/book-hotplug-runtime-compatibility-digests.ts:76`
- `src/graphrag/book-hotplug-runtime-gate.ts:38`
- `src/graphrag/book-hotplug-runtime-gate.ts:270`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:206`

### 7. `query_scope_isolation`

判定：`pass`

显式 GraphRAG 查询要求单一 selected book；多书匹配必须提供
`--graph-book-id`。请求传入的 dataDir 来自该书 manifest output path，capability
scope 只含 selected book、capability ids、source/document/content hash 和 artifact
ids。artifact validation 还要求 book-scoped GraphRAG output。

主要证据：`src/cli/qmd.ts:3420`, `src/cli/qmd.ts:3438`,
`src/contracts/graphrag.ts:17`, `src/job-state/artifact-validation.ts:684`,
`test/cli-graphrag-route.test.ts:892`, `test/cli-graphrag-route.test.ts:918`。

### 8. `privacy_payload_exclusion`

判定：`pass`

package gate 拒绝 provider payload roots、logs/debug/trace 和 durable recovery
payload；metadata sanitizer 剔除 raw provider request/response/body/payload、secret
key/value 和绝对路径值；UnifiedAnswer 只允许 vault-relative portable path 和
`urn:`/`doi:` locator URI。

主要证据：`src/graphrag/book-hotplug-runtime-gate.ts:69`,
`scripts/graphrag/book-hotplug-residue-quarantine.mjs:17`,
`scripts/graphrag/book-hotplug-package.mjs:718`,
`src/vault/metadata.ts:4`, `src/query/unified-answer.ts:28`,
`test/unified-query.test.ts:688`。

### 9. `recovery_diagnostics`

判定：`pass`

缺失文件、hash mismatch、missing metadata row、createdAt 缺失、runtime digest
mismatch、producer run 缺失和 forbidden sensitive material 均有稳定诊断，并阻止
query capability。runtime gate 与 quality gate 输出可以支撑 visible-not-query-ready、
quarantine 和 rollback 决策。

主要证据：`src/graphrag/book-hotplug-runtime-gate.ts:172`,
`src/graphrag/book-hotplug-runtime-gate.ts:326`,
`scripts/graphrag/book-hotplug-quality-gate.mjs:114`,
`test/graphrag-book-hotplug-runtime-gate.test.ts:206`,
`test/graphrag-book-hotplug-catalog.test.ts:623`。

### 10. `executable_contract_tests`

判定：`partial`

R7 本地复核中，R6 失败的 manifest-first catalog 主路径测试已通过。现有测试覆盖
direct GraphRAG query、catalog projection deleted/stale rebuild、missing artifact、
missing run、missing metadata row、runtime digest mismatch、provider payload root
拒绝、locator 脱敏、metadata redaction、跨书歧义和 selected book scoped output。

剩余缺口：尚未看到 malformed run-record semantic binding、embedding dimension
mismatch、package layout/runtime reader mismatch 的专门负例。

主要证据：`test/graphrag-book-hotplug-catalog.test.ts:136`,
`test/graphrag-book-hotplug-catalog.test.ts:623`,
`test/graphrag-book-hotplug-runtime-gate.test.ts:206`,
`test/unified-query.test.ts:688`, `test/cli-graphrag-route.test.ts:892`。

## 主要发现

### F1. Runtime gate 未完整核对 run record 语义

- 严重度：`medium`
- 关联基准：`producer_lineage_completeness`
- 状态：R6 遗留问题已缩小，但未完全关闭。

`projectQueryReadyLineage()` 与 `validateBookArtifactSet()` 已提供强约束路径；
但 `validateHotplugRuntimeQueryGate()` 对 producer run 只确认
`graphrag/runs/{runId}.yaml` 是文件，未在 runtime gate 入口解析 run record 并
比较 `artifactIds`、`inputFingerprint`、tool/schema version 和生成时间。

### F2. Manifest-first runtime gate 的 lineage 双向绑定仍依赖组合路径

- 严重度：`medium`
- 关联基准：`lineage_artifact_binding`
- 状态：部分通过。

artifact metadata、state artifacts、checkpoints、run records 和 manifest files 在
capability route 中已经组合校验；但 fixed baseline 要求 manifest 中
`producerRunIds`、`graphrag/runs` 证据和 `files` 闭包之间具有可验证引用关系。
当前 runtime gate 自身尚未把这些引用关系完整内聚为单一 fail-closed 校验。

### F3. Broader runtime compatibility 字段未独立强制比较

- 严重度：`medium`
- 关联基准：`schema_runtime_compatibility`
- 状态：部分通过。

runtime compatibility artifact 包含 package/runtime metadata，但强制比较集中在
四类 schema digest。embedding model/dimension、package layout 和 runtime reader
不匹配尚未形成独立稳定诊断和 fail-closed query gate 行为。

### F4. 可执行契约测试仍缺少两个负例族

- 严重度：`low`
- 关联基准：`executable_contract_tests`
- 状态：部分通过。

R6 的失败测试已修复，核心 route/runtime/privacy 测试通过；但 run-record 内部
语义篡改和 broader runtime compatibility mismatch 仍缺少直接测试。

## R6 finding 状态

- `direct_query_entrypoint`: R6 high finding 已关闭。
  `test/graphrag-book-hotplug-catalog.test.ts` 当前 `8 passed`，其中
  `rebuilds graph capability catalog from BOOK_MANIFEST package` 已通过。
- `schema_runtime_compatibility`: R6 broader-fields concern 仍为 partial。当前实现
  写入 broader compatibility metadata，但未独立强制比较全部字段。
- `executable_contract_tests`: R6 catalog 失败已关闭；本轮相关四组测试全部通过。
