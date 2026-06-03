# GraphRAG 单本书热插拔 R8 实施审计报告

## 审计结论

- Agent: `agent-3-runtime-provider`
- 场景: runtime/provider/privacy/manifest-first GraphRAG query gate
- 总体结论: `partial`
- 固定基准数: `10`
- 判定统计: `pass=7`, `partial=3`, `fail=0`

本轮复用 R7 Agent 3 固定基准：
`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r7__open/agent-3-runtime-provider/fixed-baseline.yaml`。
R8 目录内 `fixed-baseline.yaml` 为原样复制，未新增、删除、重命名或重排
任何 baseline 维度。

## 重点核对结果

1. R7 的 producer run record 仅做存在性检查问题已实质修复。runtime
   gate 现在通过只读 package reader 解析 `graphrag/runs/{runId}.yaml`，
   使用 `BookJobRunRecordSchema` 校验 run record，并核对 `runId`、
   `bookId`、`status`、`artifactIds`、`producerStep`、`stageFingerprint`
   和 `providerFingerprint`。

2. runtime gate 与 package validator 复用同一 producer-run binding 逻辑。
   forged `artifactIds` 和 forged provider fingerprint 会同时阻断
   runtime gate、package validation 和 capability projection。

3. manifest-first query gate 保持只读。`readHotplugPackageUnknown()` 只读
   YAML/JSON 文件；runtime gate 测试确认不会在 package root 写入 `.lock`
   或 runtime 文件。

4. broader runtime compatibility 仍未完全关闭。实现仍主要强制
   `outputManifestSchemaDigest`、`parquetSchemaDigest`、`lancedbSchemaDigest`
   和 `artifactMetadataSchemaDigest` 四类 semantic digest；`embeddingModel`、
   `embeddingDimension`、`packageLayoutVersion`、`runtimeReaderVersion` 等
   字段仍缺少独立 fail-closed 比较与负例测试。

## 验证命令

本轮执行的只读/测试命令：

- `npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts --reporter=dot --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
  - 结果：`1 passed`, `5 tests passed`
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts --reporter=dot --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
  - 结果：`1 passed`, `8 tests passed`
- `npm exec -- tsc -p tsconfig.build.json --noEmit`
  - 结果：通过

## 基准逐项判定

| 序号 | 基准 id | 判定 |
|---:|---|---|
| 1 | `direct_query_entrypoint` | `pass` |
| 2 | `artifact_minimum_closure` | `pass` |
| 3 | `artifact_gate_state_machine` | `pass` |
| 4 | `producer_lineage_completeness` | `partial` |
| 5 | `lineage_artifact_binding` | `pass` |
| 6 | `schema_runtime_compatibility` | `partial` |
| 7 | `query_scope_isolation` | `pass` |
| 8 | `privacy_payload_exclusion` | `pass` |
| 9 | `recovery_diagnostics` | `pass` |
| 10 | `executable_contract_tests` | `partial` |

### 1. `direct_query_entrypoint`

判定：`pass`

GraphRAG capability 投影入口会先执行 runtime gate；catalog 投影缺失或
stale 时可从 hotplug package 的 manifest 与包内 artifact 重建。虽然
`projectQueryReadyLineage()` 内部仍读取 rebuild 后的 catalog cache，但该 cache
是从 package 重新生成的派生投影，不是外部权威输入。

主要证据：

- `src/graphrag/capability-catalog.ts:467`
- `src/graphrag/capability-catalog.ts:471`
- `src/graphrag/book-hotplug-catalog.ts:302`
- `src/graphrag/book-hotplug-catalog.ts:420`

### 2. `artifact_minimum_closure`

判定：`pass`

package builder 明确 GraphRAG 必需 artifact 闭包；runtime gate 对 manifest
file entry、package-relative path、文件存在性、bytes 和 sha256 执行 fail-closed
校验，并对 artifact metadata rows 做 closure digest 和文件哈希绑定。

主要证据：

- `scripts/graphrag/book-hotplug-package.mjs:36`
- `src/graphrag/book-hotplug-runtime-gate.ts:174`
- `src/graphrag/book-hotplug-runtime-gate.ts:259`
- `src/graphrag/book-hotplug-runtime-gate.ts:285`

### 3. `artifact_gate_state_machine`

判定：`pass`

最终合同定义 copied、candidate、validating、validated、mounted、query_ready、
visible_not_query_ready、quarantined 和 rolled_back 状态。实现侧在 runtime
gate、package validator 和 capability projection 中均按失败诊断阻止 query
capability 投影。

主要证据：

- `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1027`
- `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1081`
- `src/graphrag/book-hotplug-runtime-gate.ts:418`
- `src/graphrag/capability-catalog.ts:471`

### 4. `producer_lineage_completeness`

判定：`partial`

R8 已补上 run record 解析和语义绑定。runtime gate 会读取 producer run
record，校验 schema、`runId`、`bookId`、`status`，并把 artifact metadata rows
与 run `artifactIds`、stage 和 provider fingerprint 关联。

剩余缺口：完整 lineage 仍未全量 fail-closed。`BookJobRunRecordSchema` 不携带
producer tool/schema version 或 run 级生成时间字段；runtime gate 依赖 artifact
metadata rows 表达这些字段。`stageFingerprint` 和 `providerFingerprint` 在
artifact metadata row 中仍是 optional，绑定逻辑只在字段存在时比较，缺失时
没有稳定诊断。因此该基准较 R7 明显收敛，但尚不能判定完全通过。

主要证据：

- `src/contracts/book-job.ts:167`
- `src/contracts/book-job.ts:176`
- `src/graphrag/book-hotplug-runtime-gate.ts:52`
- `src/graphrag/book-hotplug-runtime-gate.ts:63`
- `src/graphrag/book-hotplug-runtime-gate.ts:293`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:122`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:176`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:188`
- `scripts/graphrag/book-hotplug-artifact-metadata.mjs:239`

### 5. `lineage_artifact_binding`

判定：`pass`

manifest `producerRunIds`、`graphrag/runs`、artifact metadata rows 和 files
closure 已建立可执行绑定。runtime gate 先校验 required artifact 的 manifest
file entry 与实际文件 sha256，再校验 artifact metadata closure digest、row
file sha/bytes，并调用 producer-run binding 校验 run `artifactIds`、stage 与
provider fingerprint。测试覆盖 forged artifact binding 和 forged provider
fingerprint，且确认 capability projection fail closed。

主要证据：

- `src/graphrag/book-hotplug-runtime-gate.ts:174`
- `src/graphrag/book-hotplug-runtime-gate.ts:259`
- `src/graphrag/book-hotplug-runtime-gate.ts:285`
- `src/graphrag/book-hotplug-runtime-gate.ts:293`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:168`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:181`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:195`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:400`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:477`

### 6. `schema_runtime_compatibility`

判定：`partial`

runtime compatibility artifact 写入 package/layout/runtime metadata，并强制比较
四类 semantic digest。runtime gate 能阻断 forged parquet digest。

剩余缺口：实现未独立比较 `embeddingModel`、`embeddingDimension`、
`packageLayoutVersion`、`runtimeReaderVersion` 等字段。主 Type-DD 已把这些字段
列入 query gate compatibility inputs，并要求 `lancedb embedding dimension
mismatch` 负例；当前 TS gate 和脚本 validator 仍未覆盖。

主要证据：

- `scripts/graphrag/book-hotplug-runtime-compatibility.mjs:96`
- `scripts/graphrag/book-hotplug-runtime-compatibility.mjs:109`
- `scripts/graphrag/book-hotplug-runtime-compatibility.mjs:161`
- `src/graphrag/book-hotplug-runtime-gate.ts:39`
- `src/graphrag/book-hotplug-runtime-gate.ts:350`
- `src/graphrag/book-hotplug-runtime-compatibility-digests.ts:76`
- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1648`
- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1686`

### 7. `query_scope_isolation`

判定：`pass`

capability validation 按 bookId 重新投影 query-ready lineage，并要求 capability
artifactIds 是该书 lineage artifactIds 的子集。runtime gate 和 package layout
均以 `graph_vault/books/{bookId}` 为 root，不读取 sibling roots 作为当前书
query context。

主要证据：

- `src/graphrag/capability-catalog.ts:648`
- `src/graphrag/capability-catalog.ts:653`
- `src/graphrag/capability-catalog.ts:658`
- `src/graphrag/book-hotplug-runtime-gate.ts:368`

### 8. `privacy_payload_exclusion`

判定：`pass`

runtime gate 禁止 provider request/response、logs/debug/trace、recovery payload、
`.env`、锁文件和 corrupt sidecar 进入 package。只读 reader 只读取包内
manifest、artifact metadata、runtime compatibility 和 redacted producer run
summary，不要求 provider payload。

主要证据：

- `src/graphrag/book-hotplug-runtime-gate.ts:80`
- `src/graphrag/book-hotplug-runtime-gate.ts:157`
- `src/graphrag/book-hotplug-package-readonly.ts:5`
- `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:971`
- `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1010`

### 9. `recovery_diagnostics`

判定：`pass`

producer run 缺失、run record invalid、book mismatch、status not succeeded、
artifact binding mismatch、stage mismatch、stage fingerprint mismatch、
provider fingerprint mismatch 均有稳定诊断。runtime digest mismatch 与 artifact
metadata/file closure mismatch 也有稳定诊断，能支撑 visible-not-query-ready 或
quarantine 决策。

主要证据：

- `src/graphrag/book-hotplug-producer-run-bindings.ts:118`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:124`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:132`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:135`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:173`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:186`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:193`
- `src/graphrag/book-hotplug-producer-run-bindings.ts:200`
- `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:995`

### 10. `executable_contract_tests`

判定：`partial`

R8 新增 runtime gate 负例覆盖 producer run `artifactIds` forged 和 provider
fingerprint forged，并确认 runtime gate、package validator 和 capability
projection 均 fail closed。既有测试还覆盖只读 gate、runtime digest forged、
metadata createdAt 缺失。

剩余缺口：尚缺 `stageFingerprint` 或 `providerFingerprint` 缺失时的 fail-closed
负例，以及 embedding dimension、package layout/runtime reader mismatch 的
broader compatibility 负例。因此测试矩阵较 R7 改善，但不能全量通过。

主要证据：

- `test/graphrag-book-hotplug-runtime-gate.test.ts:220`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:242`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:321`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:400`
- `test/graphrag-book-hotplug-runtime-gate.test.ts:477`
- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1680`
- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1690`

## 主要发现

### F1. Producer lineage completeness 仍未强制所有高成本指纹字段存在

- 严重度：`medium`
- 关联基准：`producer_lineage_completeness`
- 状态：R7 核心问题已大幅收敛，但未完全关闭。

runtime gate 已解析 run record 并校验 `artifactIds`、stage 和 provider
fingerprint。剩余风险是 `stageFingerprint` 与 `providerFingerprint` 在 artifact
metadata row 中仍可缺失；绑定逻辑只在字段存在时比较，不会对缺失字段给出
稳定诊断。run record schema 也未携带 producer tool/schema version 和 run 级
生成时间，完整 lineage 仍依赖 artifact metadata row。

### F2. Broader runtime compatibility 字段仍未独立 fail closed

- 严重度：`medium`
- 关联基准：`schema_runtime_compatibility`
- 状态：R7 遗留问题未关闭。

当前 gate 强制四类 semantic digest，但没有单独比较 embedding model/dimension、
package layout version 和 runtime reader version。Type-DD 已把这些字段列入
query gate compatibility inputs，因此该基准仍为 partial。

### F3. 执行测试缺少 broader compatibility 与缺失指纹负例

- 严重度：`low`
- 关联基准：`executable_contract_tests`
- 状态：R8 已补 producer-run forged 负例，但测试矩阵仍不完整。

新增测试能证明 forged run artifact binding 与 forged provider fingerprint 会
fail closed。剩余测试缺口与 F1、F2 对齐：缺失 stage/provider fingerprint、
embedding dimension mismatch、package layout/runtime reader mismatch。
