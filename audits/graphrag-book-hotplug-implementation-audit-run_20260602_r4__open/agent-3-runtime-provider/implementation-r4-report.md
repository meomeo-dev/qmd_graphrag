## 范围

- 审计身份：`agent-3-runtime-provider`
- 审计场景：runtime/provider security/query gate
- 固定基准（fixed baseline）：
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-3-runtime-provider/baseline.yaml`
- baseline SHA-256：
  `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

本轮先读取了同目录下既有 baseline/summary/report 作为固定基准来源：

- `baseline.yaml`
- `report.md`
- `post-fix-summary.json`
- `post-fix-report.md`
- `post-runtime-compat-rerun-20260602-summary.json`
- `post-runtime-compat-rerun-20260602-report.md`

本轮未修改生产代码（production code）、未修改测试、未修改真实
`graph_vault`，仅执行只读检查与临时目录验证。

## 结论

本轮总体结论为 `partial`。

与上一轮相比，最重要的阻断项已经解决：

- 伪造 `runtime-compatibility.json` 的
  `outputManifest/parquet/lancedb` schema digests，并同步更新 sidecars、
  `BOOK_MANIFEST.json` 文件条目和 `artifact-metadata.json` 绑定后，
  package validator 与 runtime gate 都会 fail closed（闭锁 / fail closed）。
- 同一场景下，`graph_query` capability 不再可见（not visible）。

同时，本轮复核确认以下安全门仍然成立：

- provider payload 禁止仍为 fail closed。
- 删除 manifest 声明的 `producerRunIds` 对应 run evidence 时仍为 fail closed。
- `artifact-metadata` 缺行时仍为 fail closed。

仍未达到 full pass（完全通过）的原因主要有三项：

1. `artifact-metadata` 的 `createdAt` 仍是可选字段，删除后 capability 仍可见。
2. runtime gate 状态机已持久化主路径，但 `visible_not_query_ready` 实例的诊断仍可为空，
   且未完整物化合同中的 `validating`、`rolled_back`、quarantine record。
3. 逐产物 lineage 虽然已校验
   `producerRunId/producerStep/producerToolVersion/producerSchemaVersion/`
   `upstreamArtifactHashes` 的存在性，但尚未把输入哈希（input hash）与上游哈希
   语义正确性提升为统一强制门。

## 关键实现复核

### 1. 查询 Artifact 最低闭包

`scripts/graphrag/book-hotplug-package.mjs` 明确固定了 GraphRAG 查询所需最低
artifact 集合，包括：

- `qmd_output_manifest.json`
- `qmd_graph_text_unit_identity.json`
- `artifact-metadata.json`
- `runtime-compatibility.json`
- `context.json`
- `stats.json`
- 6 个 parquet
- `lancedb`

见：
`scripts/graphrag/book-hotplug-package.mjs:33-47`。

package validator 会校验：

- manifest / publish marker 与 sidecars
- 文件 bytes / sha256
- required artifact 存在性
- producer runs
- artifact metadata
- runtime compatibility

见：
`scripts/graphrag/book-hotplug-package.mjs:713-899`。

### 2. runtime gate 与 capability 可见性

runtime gate 在 `validateHotplugRuntimeQueryGate()` 中执行：

- forbidden path 拒绝
- required artifact 文件闭包验证
- manifest 声明的 `producerRunIds` 存在性验证
- `artifact-metadata.json` 绑定验证
- `runtime-compatibility.json` digest 验证

见：
`src/graphrag/book-hotplug-runtime-gate.ts:328-392`。

query capability 的派生以 runtime gate 为前置硬门：

- `projectQueryReadyLineage()` 首先调用
  `validateHotplugRuntimeQueryGate()`
- runtime gate 不通过时直接返回 `null`
- catalog rebuild 仅对 `queryReadyLineage != null` 的书生成 capability

见：
`src/graphrag/capability-catalog.ts:438-556`，
`src/graphrag/book-hotplug-catalog.ts:422-443`。

### 3. runtime compatibility digest 校验

当前 runtime gate 会从 manifest `files` 重算四类 schema digests，并与
`runtime-compatibility.json` 中的值比较：

- `outputManifestSchemaDigest`
- `parquetSchemaDigest`
- `lancedbSchemaDigest`
- `artifactMetadataSchemaDigest`

见：
`src/graphrag/book-hotplug-runtime-gate.ts:266-325`，
`src/graphrag/book-hotplug-runtime-compatibility-digests.ts:1-126`。

这说明上一轮报告中的 blocking finding
`runtime-compat-digest-semantic-gate-missing` 已不再成立。

### 4. artifact metadata gate

`artifact-metadata.json` 的生成与验证已包含：

- `producerRunId`
- `producerStep`
- `producerToolVersion`
- `producerSchemaVersion`
- `upstreamArtifactHashes`
- `fileSha256`
- `bytes`

见：
`scripts/graphrag/book-hotplug-artifact-metadata.mjs:79-190`，
`scripts/graphrag/book-hotplug-artifact-metadata.mjs:193-260`。

但 `createdAt` 目前仍不是强制字段；runtime gate 侧 schema 仍允许它缺失：
`src/graphrag/book-hotplug-runtime-gate.ts:51-67`。

### 5. runtime gate 状态落盘

`state/hotplug-runtime-gate.json` 当前会持久化：

- `copied`
- `candidate`
- `validated`
- `mounted`
- `query_ready | visible_not_query_ready | quarantined`

以及 `rollback.projectionRollbackRequired` 与 `recoveryAction`。

见：
`scripts/graphrag/book-hotplug-quality-gate.mjs:114-168`。

但合同期望的 `validating`、`rolled_back` 与独立 quarantine record 仍未完整体现。

## 临时目录验证

样本书：`book-00474fb29e5e-59d02d41`

### 1. runtime compatibility digest 伪造

在临时复制包中，我执行了以下变更：

- 篡改 `graphrag/output/runtime-compatibility.json` 的
  `outputManifestSchemaDigest`
  `parquetSchemaDigest`
  `lancedbSchemaDigest`
- 用项目自带 sidecar writer 同步更新该文件 sidecars
- 同步更新 `artifact-metadata.json` 中
  `graphrag/output/runtime-compatibility.json` 对应 row 的
  `fileSha256/bytes`
- 重算 `artifact-metadata.json.closureDigest`
- 同步更新 `BOOK_MANIFEST.json` 中受影响文件的 `bytes/sha256`
- 重算 `BOOK_MANIFEST.json` 与 `PUBLISH_READY.json` 内嵌 checksums 与 sidecars

结果：

- `validateBookHotplugPackage().ok = false`
- `validateHotplugRuntimeQueryGate().ok = false`
- 诊断包含：
  - `runtime_compatibility_digest_mismatch:outputManifestSchemaDigest`
  - `runtime_compatibility_digest_mismatch:parquetSchemaDigest`
  - `runtime_compatibility_digest_mismatch:lancedbSchemaDigest`
- `rebuildCatalogFromBookHotplugPackages()` 结果：
  `capabilityCount = 0`
- `loadGraphQueryCapabilities()` 结果：
  `capabilityCount = 0`

这项结论直接表明：上一轮 blocking finding 已修复。

### 2. 删除 manifest 声明的 producer run

删除 manifest `graphrag.producerRunIds[0]` 指向的
`graphrag/runs/graph_extract-20260526223809-86vlf0.yaml` 后：

- package validator 失败
- runtime gate 失败
- 诊断包含
  `missing_producer_run:graph_extract-20260526223809-86vlf0`
- capabilityCount = 0

因此，“producer lineage 缺失必须 fail closed” 这一重点复核项通过。

### 3. provider payload 注入

在临时复制包中加入 `provider-requests/payload.json` 后：

- package validator 失败
- runtime gate 失败
- capabilityCount = 0

这证明 provider payload 禁止仍然有效。

### 4. artifact metadata 缺行

从 `artifact-metadata.json.rows` 删除
`graphrag/output/documents.parquet` 对应行，并重算 sidecars / manifest 绑定后：

- package validator 失败
- runtime gate 失败
- 诊断为
  `artifact_metadata_missing_row:graphrag/output/documents.parquet`
- capabilityCount = 0

因此 artifact metadata gate 仍为 fail closed。

### 5. artifact metadata 的 `createdAt`

从 `artifact-metadata.json.rows` 删除所有 `createdAt` 字段，并同步 sidecars /
manifest 绑定后：

- package validator 通过
- runtime gate 通过
- capabilityCount = 1

这说明逐产物 lineage 的时间字段尚未成为 query-ready 强制门。

## 真实 `graph_vault` 只读状态

本轮对真实 `graph_vault` 只做了状态文件与 catalog 的只读统计，未进行全量临时改写：

- `graph_vault/books` 目录：72
- 含 `BOOK_MANIFEST.json` 的包：38
- `PUBLISH_READY.json`：38
- `artifact-metadata.json`：38
- `runtime-compatibility.json`：38
- `state/hotplug-runtime-gate.json`：38
- manifest `graphrag.queryReady=true`：30
- runtime gate `currentState=query_ready`：30
- runtime gate `currentState=visible_not_query_ready`：8
- runtime gate `currentState=quarantined`：0
- `catalog/graph-capabilities.yaml` 项数：30

这组数据与 r3 的整体状态一致：30 个 query-ready capability 可见，8 个包保持
`visible_not_query_ready`。

但本轮额外观察到一个恢复诊断缺口：

- 若只读取 `state/hotplug-runtime-gate.json`，这 8 个
  `visible_not_query_ready` 包的 `diagnostics` 当前为空数组。

这会削弱恢复审计链的可观测性，因此 `recovery_diagnostics` 仍不能给 pass。

## 固定 10 维结论

### 1. `direct_query_entrypoint`: pass

单书热插拔包复制到临时 vault 后，仍可从包内证据重建查询 capability。

### 2. `artifact_minimum_closure`: pass

最低闭包清单固定，package validator 与 runtime gate 共同校验 required artifacts。

### 3. `artifact_gate_state_machine`: partial

主状态已落盘，但未完整覆盖合同中的 `validating`、`rolled_back`、quarantine
record，且 `visible_not_query_ready` 诊断落盘不充分。

### 4. `producer_lineage_completeness`: partial

manifest producer runs 缺失会 fail closed；artifact metadata 也校验多项 lineage
字段存在性。但 `createdAt` 仍非强制，输入哈希与上游哈希的语义正确性尚未成为统一强制门。

### 5. `lineage_artifact_binding`: pass

manifest、runs、artifact metadata、capability 投影之间的绑定可运行验证。

### 6. `schema_runtime_compatibility`: partial

上一轮阻断项已解决，semantic digest 伪造会 fail closed；但兼容门仍主要围绕 digest /
结构重算，尚未形成完整 runtime/parquet/LanceDB/embedding 实值兼容矩阵。

### 7. `query_scope_isolation`: pass

临时单书复制仍只暴露该书 capability，未见跨书污染。

### 8. `privacy_payload_exclusion`: pass

provider payload 注入后 validator/runtime gate/capability 投影均 fail closed。

### 9. `recovery_diagnostics`: partial

失败会阻断 capability，但 receiver-side 的恢复链物化仍不完整，且部分
`visible_not_query_ready` 状态缺少落盘诊断。

### 10. `executable_contract_tests`: pass

本轮针对性套件均通过：

- `test/graphrag-book-hotplug-runtime-gate.test.ts`
- `test/graphrag-book-hotplug-catalog.test.ts`

并且临时负例与测试结论一致。

## 结论摘要

本轮最重要的复核结果是：上一轮关于 forged runtime compatibility digest
仍可见 query capability 的 blocking finding 已解决，当前实现会正确 fail closed。

尚存的主要残余风险不再是 capability 泄漏，而是：

- 恢复状态机的持久化与诊断可观测性不足
- 逐产物 lineage 仍有字段未提升为 query-ready 强制门
- runtime compatibility 尚未扩展为更完整的实值兼容矩阵
