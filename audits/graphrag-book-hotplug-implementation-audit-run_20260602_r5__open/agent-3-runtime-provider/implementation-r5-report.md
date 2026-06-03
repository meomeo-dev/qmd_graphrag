# Runtime Provider 实现审计报告

## 审计结论

- Agent: `agent-3-runtime-provider`
- 场景: `runtime provider / 挂载后 GraphRAG 查询和 provider 隔离`
- 总体结论: `partial`
- 基准维度数: `10`
- 判定统计: `pass=2`，`partial=8`，`fail=0`

本报告严格复用固定基准 `baseline.yaml`，未新增、删除、重命名、重排、
或改写任何审计维度与通过标准（pass criteria）。

## 重点发现

### 1. 高严重度（high）

- `privacy_payload_exclusion`
  `UnifiedAnswer` 对 GraphRAG evidence 的 `locator` 未做脱敏（sanitization）。
  当前仅对 `metadata` 做 `sanitizeVaultMetadata()`，若 provider 返回绝对路径
  或私有 URI，它们可直接进入最终回答。
  证据：
  - `src/query/unified-answer.ts:83-99`
  - `src/vault/metadata.ts:55-80`
  - `test/cli-graphrag-route.test.ts:747-753`

### 2. 中严重度（medium）

- `direct_query_entrypoint`
  查询数据目录解析已切到 manifest-first（清单优先），但实现仍保留
  `graphrag/output` 与 `output` 的 legacy fallback；同时 query capability
  推导仍依赖 `books.yaml`、`artifacts.yaml`、`checkpoints.yaml` 等可重建投影，
  尚未收敛为仅靠 `BOOK_MANIFEST.json` 与包内最小工件闭包。
  证据：
  - `src/graphrag/book-package-layout.ts:34-50`
  - `src/graphrag/capability-catalog.ts:442-547`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:942-990`

- `schema_runtime_compatibility`
  runtime compatibility digest 已覆盖 output manifest、parquet、LanceDB、
  artifact metadata 四类摘要，但未实现 Type DD 声明的 embedding model、
  embedding dimension、graph projection version、package layout version、
  runtime reader version 等输入。
  证据：
  - `src/graphrag/book-hotplug-runtime-compatibility-digests.ts:76-113`
  - `src/graphrag/book-hotplug-runtime-gate.ts:270-330`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1648-1669`

- `artifact_gate_state_machine`
  runtime gate 失败时不会投影 query capability，这一点成立；但审计对象中的
  catalog 重建逻辑未显式投影 `visible_not_query_ready` / `quarantined`
  状态，`books.yaml` 仍主要沿用 manifest 中的 `queryReady` 与
  `graphRagReadyState`，因此状态机在实现层未完整落地。
  证据：
  - `src/graphrag/book-hotplug-runtime-gate.ts:332-395`
  - `src/graphrag/book-hotplug-catalog.ts:336-370`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:990-1097`

- `lineage_artifact_binding`
  运行时 gate 已把 manifest 文件闭包、artifact metadata、producerRunId、
  stage fingerprint、provider fingerprint、content hash 绑定到一起；但
  `graphrag/runs/*.yaml` 在当前实现里主要做“存在性”验证，未进一步校验
  run 记录内部的 artifact/hash/input 绑定关系。
  证据：
  - `src/graphrag/book-hotplug-runtime-gate.ts:243-267`
  - `src/graphrag/book-hotplug-runtime-gate.ts:378-382`
  - `src/graphrag/book-hotplug-catalog.ts:247-279`
  - `src/graphrag/capability-catalog.ts:266-338`

### 3. 低严重度（low）

- `executable_contract_tests`
  测试面已覆盖主路径，但缺少若干 Type DD 明示场景：例如 stale
  `graph-capabilities.yaml` 不能强推 ready、`locator` 私有路径脱敏、
  output manifest/LanceDB/artifact metadata digest mismatch 的独立用例。
  证据：
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:984-989`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1091-1097`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:206-362`
  - `test/unified-query.test.ts:688-840`

## 基准逐条判定

### 1. `direct_query_entrypoint` / 直接查询入口

- `status`: `partial`
- 证据路径：
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:942-990`
  - `src/cli/qmd.ts:3327-3350`
  - `src/cli/qmd.ts:3437-3465`
  - `src/graphrag/book-package-layout.ts:34-50`
  - `src/graphrag/capability-catalog.ts:438-556`
  - `test/cli-graphrag-route.test.ts:728-753`
  - `test/cli-graphrag-route.test.ts:918-939`
- 发现：
  - CLI 查询入口已按 `selectedBookIds[0]` 解析单书 `dataDir`，并将
    capability scope 限定到单书。
  - `resolveBookGraphRagDataDir()` 先读 `BOOK_MANIFEST.graphrag.outputManifestPath`，
    但仍保留 `books/{bookId}/graphrag/output` 与 `books/{bookId}/output`
    fallback。
  - `loadGraphQueryCapabilities()` 与 `projectQueryReadyLineage()` 仍依赖
    `catalog/books.yaml`、`state/artifacts.yaml`、`state/checkpoints.yaml`，
    尚未完全达到“仅凭 manifest + 包内 artifacts”。
- 修复建议：
  - 让运行时直接以 manifest 与包内 query gate 结果为权威来源
    （source of truth），把 `books.yaml`、`artifacts.yaml`、
    `checkpoints.yaml` 降为纯缓存或重建产物。
  - 在 query 路径删除 legacy `output` fallback，至少在 mounted/query
    入口上显式 fail closed。

### 2. `artifact_minimum_closure` / 查询 Artifact 最低闭包

- `status`: `pass`
- 证据路径：
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1586-1677`
  - `src/graphrag/book-hotplug-runtime-gate.ts:163-197`
  - `src/graphrag/book-hotplug-runtime-gate.ts:200-267`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:285-358`
  - `test/graphrag-book-hotplug-catalog.test.ts:732-847`
- 发现：
  - Type DD 明确列出了 GraphRAG query-ready 的最小工件集合、角色、
    validation granularity、`bytes`、`sha256`、`required` 等字段要求。
  - runtime gate 会校验 required artifact file entry、实际文件存在、
    `bytes`、`sha256`、artifact metadata row、closure digest。
  - 缺少必需文件或 metadata row 时，能力不会投影为 query-ready。
- 修复建议：
  - 保持当前 fail-closed 行为，并补足对 output manifest、identity map
    是否均在 `requiredArtifacts` 中的回归测试，避免回退。

### 3. `artifact_gate_state_machine` / Artifact Gate 状态机

- `status`: `partial`
- 证据路径：
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:990-1097`
  - `src/graphrag/book-hotplug-runtime-gate.ts:332-395`
  - `src/graphrag/book-hotplug-catalog.ts:336-370`
  - `src/graphrag/book-hotplug-catalog.ts:422-443`
- 发现：
  - 设计文档完整定义了 `copied -> candidate -> validating -> validated ->
    mounted -> query_ready / visible_not_query_ready / quarantined / rolled_back`
    状态机。
  - 审计对象中的实现主要返回 `ok + diagnostics`，并通过 capability
    缺失实现“不可查询”，但没有把 `visible_not_query_ready` 或
    `quarantined` 作为稳定状态显式投影到 catalog。
  - `books.yaml` 的 `overallStatus` 与 `graphRagReadyState` 主要来自
    manifest，而不是 runtime gate 的实时结果。
- 修复建议：
  - 在 catalog 重建时显式记录 `graphRagReadyState=visible_not_query_ready`
    与稳定诊断码。
  - 将 runtime gate 失败与 quarantine / rollback 元数据对齐，避免
    仅靠“无 capability”表达失败。

### 4. `producer_lineage_completeness` / Producer Lineage 完整性

- `status`: `partial`
- 证据路径：
  - `src/graphrag/book-hotplug-runtime-gate.ts:51-67`
  - `src/graphrag/book-hotplug-runtime-gate.ts:243-267`
  - `src/graphrag/book-hotplug-runtime-gate.ts:378-382`
  - `src/graphrag/capability-catalog.ts:250-338`
  - `src/graphrag/capability-catalog.ts:488-548`
  - `test/graphrag-book-hotplug-catalog.test.ts:623-727`
- 发现：
  - artifact metadata row 已包含 `producerRunId`、`producerStep`、
    `producerToolVersion`、`producerSchemaVersion`、`upstreamArtifactHashes`、
    `createdAt`。
  - runtime gate 会检查 run 文件存在，capability projection 会检查
    content hash、stage fingerprint、provider fingerprint 与 artifact set。
  - 但 `graphrag/runs/*.yaml` 当前未被解析以核对 input hash、tool
    version、schema version、生成时间与 artifact row 的一致性。
- 修复建议：
  - 在 runtime gate 中解析 run 摘要文件，逐项核对 input hash、
    stage fingerprint、tool/schema version、finishedAt 与 row 的字段。
  - 对不一致场景给出稳定诊断，并维持 fail-closed。

### 5. `lineage_artifact_binding` / Lineage 与 Artifact 绑定

- `status`: `partial`
- 证据路径：
  - `src/graphrag/book-hotplug-runtime-gate.ts:168-197`
  - `src/graphrag/book-hotplug-runtime-gate.ts:243-267`
  - `src/graphrag/book-hotplug-catalog.ts:247-279`
  - `src/graphrag/capability-catalog.ts:518-548`
  - `src/job-state/artifact-validation.ts:530-583`
- 发现：
  - manifest file entry、artifact metadata row、artifact manifest、checkpoint
    与 producer run id 之间已有多重绑定。
  - 绑定目前主要落在 `fileSha256`、`bytes`、`producerRunId`、
    `stageFingerprint`、`providerFingerprint`、`corpusContentHash`。
  - `runs/*.yaml` 自身尚未证明“这些当前文件就是该 run 产出”，因此对
    “被替换但同名残留文件”的防御仍有空白。
- 修复建议：
  - 要求 run 摘要记录 artifactId / outputArtifactHash 闭包，并在
    runtime gate 中校验它们与 manifest / metadata / state artifacts 一致。

### 6. `schema_runtime_compatibility` / Schema 与运行时兼容

- `status`: `partial`
- 证据路径：
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1648-1669`
  - `src/graphrag/book-hotplug-runtime-compatibility-digests.ts:76-113`
  - `src/graphrag/book-hotplug-runtime-gate.ts:270-330`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:206-283`
- 发现：
  - 设计要求区分 output manifest schema、GraphRAG artifact schema、
    parquet schema、LanceDB schema、embedding model/dimension、
    graph projection version、package layout version、runtime reader version。
  - 当前 digest 仅比较四组摘要：
    `outputManifestSchemaDigest`、`parquetSchemaDigest`、
    `lancedbSchemaDigest`、`artifactMetadataSchemaDigest`。
  - `outputManifestSchemaDigest` 还是由有限字段派生的语义摘要，尚未覆盖
    embedding model / dimension 等兼容性输入。
- 修复建议：
  - 将 embedding model、embedding dimension、package layout version、
    runtime reader version 等输入纳入 `runtime-compatibility.json` 与
    digest 计算。
  - 补独立测试，分别覆盖 output manifest、LanceDB、artifact metadata
    mismatch。

### 7. `query_scope_isolation` / 单书查询范围隔离

- `status`: `pass`
- 证据路径：
  - `src/cli/qmd.ts:3312-3350`
  - `src/cli/qmd.ts:3421-3455`
  - `src/job-state/artifact-validation.ts:530-545`
  - `src/job-state/artifact-validation.ts:684-699`
  - `test/cli-graphrag-route.test.ts:892-940`
  - `test/unified-query.test.ts:904-965`
  - `test/unified-query.test.ts:1322-1355`
- 发现：
  - GraphRAG 查询要求 `selectedBookIds.length === 1`，否则直接拒绝。
  - runtime 请求只传递该书的 `dataDir` 与该书 capability scope。
  - artifact validation 要求 artifact 属于当前 `bookId`，并位于
    `books/{bookId}/graphrag/output` 或其受控等价路径。
  - 已有测试覆盖多书歧义、按书选择输出目录、拒绝 vault 外路径、
    不按 qmd collection path 误匹配 capability。
- 修复建议：
  - 持续保留单书强约束，并在新增 query 模式中复用相同 scope 校验。

### 8. `privacy_payload_exclusion` / Provider Payload 排除

- `status`: `partial`
- 证据路径：
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1678-1755`
  - `src/graphrag/book-hotplug-runtime-gate.ts:69-81`
  - `src/graphrag/book-hotplug-runtime-gate.ts:346-348`
  - `src/integrations/python-bridge.ts:198-235`
  - `src/query/unified-answer.ts:83-99`
  - `test/graphrag-book-hotplug-catalog.test.ts:573-617`
  - `test/cli-graphrag-route.test.ts:728-800`
- 发现：
  - 包级扫描已拒绝 provider request/response、logs、debug、trace、
    `.env`、recovery payload 等敏感根目录。
  - bridge 文本与日志证据已做 payload / secret / absolute path 脱敏。
  - `UnifiedAnswer` 仅清洗 `metadata`，但直接保留 provider 返回的
    `locator`；若 provider 填入绝对路径或私有 URI，可进入最终回答。
- 修复建议：
  - 在 `buildEvidenceRefsFromGraphRagResponse()` 中对 `locator.path`、
    `locator.uri` 做相同级别的私有路径与敏感 URL 脱敏。
  - 增加回答层回归测试，确保 `locator` 不泄漏绝对路径、tokenized URL、
    provider 私有地址。

### 9. `recovery_diagnostics` / 失败恢复与诊断

- `status`: `partial`
- 证据路径：
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1044-1097`
  - `src/graphrag/book-hotplug-runtime-gate.ts:172-197`
  - `src/graphrag/book-hotplug-runtime-gate.ts:243-267`
  - `src/graphrag/book-hotplug-runtime-gate.ts:270-330`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:206-362`
  - `test/graphrag-book-hotplug-catalog.test.ts:623-847`
- 发现：
  - 缺失文件、checksum mismatch、lineage 缺失、runtime digest forged、
    metadata row 缺失等场景均会给出稳定诊断并 fail closed。
  - query capability 不会在 gate 失败时投影出来。
  - 但当前审计对象内未见显式 quarantine record、visible-not-query-ready
    projection rollback、或修复入口状态回写。
- 修复建议：
  - 将 runtime gate 诊断与 quarantine / rollback 记录串联。
  - 对 `visible_not_query_ready` 增加稳定的 catalog 状态与 repair hint。

### 10. `executable_contract_tests` / 可执行契约测试

- `status`: `partial`
- 证据路径：
  - `test/cli-graphrag-route.test.ts:728-972`
  - `test/unified-query.test.ts:688-1490`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:206-362`
  - `test/graphrag-book-hotplug-catalog.test.ts:136-847`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:984-989`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1091-1097`
- 发现：
  - 已覆盖挂载后直接查询、单书 dataDir 路由、多书歧义、provider payload
    root 拒绝、missing producer runs、missing metadata row、forged runtime
    digest、跨书或越界 artifact path 拒绝。
  - 尚缺少 stale `graph-capabilities.yaml` 不得强推 ready、answer locator
    脱敏、output manifest digest mismatch、LanceDB digest mismatch、
    artifact metadata digest mismatch 等独立测试。
- 修复建议：
  - 以 final contracts 中 `requiredCases` 为准补齐未落地用例，优先补
    stale cache、locator redaction、LanceDB/output manifest mismatch。
