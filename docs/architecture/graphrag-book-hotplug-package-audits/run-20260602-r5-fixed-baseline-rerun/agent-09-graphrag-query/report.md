# agent-09-graphrag-query R5 固定基准复审报告

## scenario

挂载后直接 GraphRAG 查询，需要完整 producer lineage 和 artifact gate。

审计对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

`graphrag-book-hotplug-package-r3-fixups.type-dd.yaml` 按主文档
`supplementalTypeDD` 声明作为规范性补充（normative supplement）评估。

审计范围仅限设计文档是否满足固定 10 维 `passCriteria`。未读取 provider
request、provider response、secrets、`.env`、凭据、日志 payload、recovery
payload 或私有运行数据。

## reused_fixed_baseline

复用固定 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-09-graphrag-query/baseline.yaml`

baseline SHA-256：

`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

固定审计维度如下，未新增、删除、重排、重命名维度，未修改
`passCriteria`：

| 顺序 | id | name |
| --- | --- | --- |
| 1 | `direct_query_entrypoint` | 直接查询入口 |
| 2 | `artifact_minimum_closure` | 查询 Artifact 最低闭包 |
| 3 | `artifact_gate_state_machine` | Artifact Gate 状态机 |
| 4 | `producer_lineage_completeness` | Producer Lineage 完整性 |
| 5 | `lineage_artifact_binding` | Lineage 与 Artifact 绑定 |
| 6 | `schema_runtime_compatibility` | Schema 与运行时兼容 |
| 7 | `query_scope_isolation` | 单书查询范围隔离 |
| 8 | `privacy_payload_exclusion` | Provider Payload 排除 |
| 9 | `recovery_diagnostics` | 失败恢复与诊断 |
| 10 | `executable_contract_tests` | 可执行契约测试 |

## baseline_integrity_check

| 检查项 | 结果 |
| --- | --- |
| baseline 文件存在 | 通过 |
| baseline 是否为指定 R5 固定路径 | 通过 |
| baseline SHA-256 | `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419` |
| baseline 维度数量 | 通过，10 个 |
| baseline 维度 id 与顺序 | 通过，与固定 baseline 一致 |
| `passCriteria` 是否变更 | 通过，未变更 |
| 是否创建新基准 | 否 |
| 是否修改 `baseline.yaml` | 否 |
| 本轮写入范围 | 仅写入本 `report.md` |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets、`.env`、凭据或日志 payload |

## findings

### 1. `direct_query_entrypoint` - 直接查询入口

结论：未通过。

主文档将 `BOOK_MANIFEST.json` 定义为 mounted book package 的权威描述，并
要求 package root 包含验证、查询、导出和重挂载所需闭包，不依赖 sibling source
或 catalog roots。该部分满足包权威（package authority）方向的基础要求。

缺口在查询入口本身。`readinessGates.graphragReadyGate.queryEntrypoint`
规定查询命令 target `bookId` 后，通过 committed mount projection 解析
`bookId`，再定位当前 `packageGeneration` 的 `graphrag/output`。R3 补充文档
`scannerNoReadContracts.queryGate` 也把 committed catalog projection 列为
query gate 可读输入。

固定 baseline 要求挂载扫描完成后，GraphRAG 查询入口能仅凭
`BOOK_MANIFEST.json` 和包内 artifacts 定位本书查询上下文，且不依赖全局
catalog、旧 batch 状态、provider payload、发送方绝对路径或人工补参。当前设计
把 committed mount/catalog projection 放在 query entrypoint 的解析路径上，
没有明确说明该投影只是可选 cache，也没有规定 projection 缺失、损坏或被删除时
查询入口必须回退到 `BOOK_MANIFEST.json` 和包内 artifact 闭包。因此该维度未满足
固定 criteria。

### 2. `artifact_minimum_closure` - 查询 Artifact 最低闭包

结论：通过。

主文档 `readinessGates.graphragReadyGate.minimumArtifactClosure` 明确列出
GraphRAG 查询最低 artifact 集合：

- `graphrag/output/qmd_output_manifest.json`
- `graphrag/output/qmd_graph_text_unit_identity.json`
- `graphrag/output/context.json`
- `graphrag/output/stats.json`
- `graphrag/output/documents.parquet`
- `graphrag/output/text_units.parquet`
- `graphrag/output/entities.parquet`
- `graphrag/output/relationships.parquet`
- `graphrag/output/communities.parquet`
- `graphrag/output/community_reports.parquet`
- `graphrag/output/lancedb`

`graphRagArtifactMetadataContract.artifactRows.requiredFields` 要求每个必需
artifact metadata row 具备 `path`、`role`、`required`、`bytes`、`sha256`、
`schemaVersion`、`schemaDigest`、`validationGranularity`、`producerRunId`、
`producerStage`、`upstreamArtifactHashes`、`outputArtifactHash` 和
`compatibilityGroup`。`requiredArtifactMetadata` 为每个最低闭包 artifact
指定 role 和 validation granularity。缺失 metadata row、sha 不匹配、producer
hash 绑定缺失、LanceDB dimension mismatch、parquet schema mismatch、stale
generation 和 cross-book path 均列为 query gate 负例。缺失必需 artifact 不能
进入 `query_ready`。

### 3. `artifact_gate_state_machine` - Artifact Gate 状态机

结论：未通过。

设计已有若干相关状态与规则：直接复制目录缺少 `PUBLISH_READY.json` 时为
`incomplete_copy`；mount scan validation 失败会进入 `not_mounted` 或
`not_query_ready`；`readinessGates.packageStates` 包含 `candidate`、`mounted`、
`query_ready`、`quarantined` 和 `incompatible`；upgrade matrix 使用
`visible_not_query_ready`；quarantine repair state machine 提供隔离、修复和清除
状态。

固定 baseline 要求 artifact gate 明确定义从 `copied`、`candidate`、
`validated`、`mounted`、`query-ready`、`visible_not_query_ready` 到
`quarantined` 的状态、转移条件、诊断输出和禁止查询条件。当前设计把这些语义
分散在 atomic lifecycle、mount scan、readiness gates、upgrade path 和
quarantine repair 中：

- `copied` 只是文本语义，未作为 artifact gate 状态。
- `validated` 出现在 migration state machine 中，不是 GraphRAG artifact gate
  的明确状态。
- `visible_not_query_ready` 是 upgrade outcome，不在 packageStates 或
  graphragReadyGate states 中形成统一状态。
- 没有一张 artifact gate transition table 明确列出每个固定状态之间的触发条件、
  诊断字段和 prohibited query condition。

因此，虽然设计禁止 gate 失败时投影为可查询，并已有稳定诊断基础，但未完整满足
固定 criteria 对 artifact gate 状态机的明确性要求。

### 4. `producer_lineage_completeness` - Producer Lineage 完整性

结论：通过。

`graphragReadyGate.producerLineageSchema.requiredFields` 覆盖
`producerRunId`、`stage`、`parentProducerRunIds`、`inputArtifactHashes`、
`outputArtifactHashes`、`modelProfile`、`embeddingProfile`、`toolVersion`
和 `completedAt`。`graphRagArtifactMetadataContract.artifactRows` 进一步要求
每个必需 artifact 记录 `schemaVersion`、`producerStage`、
`upstreamArtifactHashes` 和 `outputArtifactHash`。

R3 补充文档 `migrationEvidenceSchema` 要求记录 old/new producer run ids、
before/after artifact hashes 和 `producerProvenanceStatus`，并区分
`preserved_verified`、`preserved_redacted`、`missing_marked_not_query_ready`、
`rebuilt_by_actual_producer_run` 与 `unavailable_repair_required`。这些字段能
表达 producer run、step、input hash、tool version、schema version、生成时间和
上游 artifact hash。lineage 缺失或断裂时，设计要求不得声明 query-ready。

### 5. `lineage_artifact_binding` - Lineage 与 Artifact 绑定

结论：通过。

`BOOK_MANIFEST.json` 的 `graphrag` section 要求 `producerRunIds`，`files`
条目要求 `producerRunId`、`bytes`、`sha256` 和 `required`。主文档
`graphragReadyGate.bindingRule` 要求每个必需 GraphRAG artifact 必须列入
`files`，并绑定 producer run output hash；每个 producer run output hash 也必须
解析到 package file entry。

`graphRagArtifactMetadataContract.closureDigest` 使用排序后的 artifact metadata
rows 计算闭包摘要。负例覆盖 producer output hash 缺少 file entry、file entry
缺少 producer output hash、stale packageGeneration 和 cross-book artifact path。
这些规则在 manifest `producerRunIds`、`graphrag/runs` 证据、artifact metadata
rows 与 `files` 闭包之间建立可验证引用关系。

### 6. `schema_runtime_compatibility` - Schema 与运行时兼容

结论：通过。

`graphRagArtifactMetadataContract.queryGateCompatibilityInputs` 明确纳入
`outputManifestSchema`、`graphRagArtifactSchema`、`parquetSchemaDigest`、
`lancedbSchemaDigest`、`embeddingModel`、`embeddingDimension`、
`graphProjectionVersion`、`packageLayoutVersion` 和 `runtimeReaderVersion`。
这些输入覆盖 GraphRAG runtime、parquet schema、LanceDB schema、embedding
model/dimension、output manifest schema 和 package layout schema。

R3 补充文档 `schemaVersionUpgradeMatrix` 按 `packageSchemaVersion`、
`layoutVersion`、`qmdIndexSchema`、`graphRagArtifactSchema` 和
`producerLineageSchema` 定义当前包、legacy distribution manifest、GraphRAG
output schema v0、producer lineage missing 和 unsupported legacy schema 的处理
结果。兼容失败会进入 `visible_not_query_ready`、`repair_required`、
`quarantine_mount_candidate` 或 fail-closed 路径，不会投影为 query-ready。

### 7. `query_scope_isolation` - 单书查询范围隔离

结论：通过。

主文档固定 package root 为 `graph_vault/books/{bookId}`，要求所有 `files`
使用 package-relative path，并拒绝 absolute path、parent traversal、symlink
escape 和 hardlink outside package。查询入口按当前 `packageGeneration` 定位本书
`graphrag/output`，并拒绝 stale 或 cross-book artifacts。

`graphRagArtifactMetadataContract.negativeTests` 覆盖 `cross-book artifact path`。
R3 补充文档将 `BOOK_MANIFEST.mount.packageRoot` 收紧为值为 `"."` 的
package-relative locator，并要求 legacy bridge 与 symlink bridge 必须
package-relative、checksum-bound、可过期，且默认不得进入 hotplug-v1 导出包。
这些约束足以防止其他书、历史残留、全局缓存或 sibling roots 混入单书查询上下文。

### 8. `privacy_payload_exclusion` - Provider Payload 排除

结论：通过。

主文档 scope 明确排除 provider 请求、provider 响应、密钥和日志 payload 的分发。
`securityExportPolicy`、`producerEvidenceRedaction` 和
`sensitiveMaterialTaxonomy` 禁止 provider request/response、prompts、raw
responses、provider headers、request/response bodies、credentials、absolute
paths、runtime logs、debug/trace 和 durable recovery payload 进入包、manifest、
producer evidence 或诊断输出。

R3 补充文档 `providerSensitiveClassExtensions` 覆盖 provider caches、reversible
interactions、provider auth config 和 credential stores。`scannerNoReadContracts`
明确 importer、mount scanner、compatibility checker、migration scanner 和 query
gate 均不得读取敏感根；`queryGate.providerCallPolicy` 为
`never_on_gate_failure`。artifact gate 与 lineage 验证所需证据以脱敏 metadata、
hash、fingerprint 和 run manifest 表达。

### 9. `recovery_diagnostics` - 失败恢复与诊断

结论：通过。

主文档对 missing manifest、missing publish marker、missing required file、
checksum mismatch、path traversal、symlink escape、corrupt sidecar、
lineage binding missing、schema incompatible 和 producer evidence 缺失定义稳定
诊断与 fail-closed 行为。mount scan failure 保留 previous last-good reader view；
quarantine repair 只有完整 validator pass 和新 projection generation commit 后
才能清除隔离；schema 不兼容可保留为 visible-not-query-ready。

R3 补充文档 `schemaVersionUpgradeMatrix.compatibilityDiagnostics` 与
`migrationEvidenceSchema` 增加 missing file、missing producer lineage、
tool version too old、unsupported legacy schema、artifact/schema incompatible、
decision status、failure reason 和 rollback plan 等诊断与证据字段。该维度满足
artifact 缺失、hash 不匹配、lineage 断裂、schema 不兼容和 producer evidence
缺失时的稳定诊断、修复入口、quarantine 行为与 catalog projection 回滚要求。

### 10. `executable_contract_tests` - 可执行契约测试

结论：通过。

主文档 `implementationPlan.testContracts` 覆盖挂载复制、原子投影、provider
payload 排除、GraphRAG minimum artifact closure、artifact-lineage binding、
damaged package diagnostics、schema conversion、stale generation 和 query-ready
failure。`graphRagArtifactMetadataContract.negativeTests` 覆盖 missing required
artifact metadata row、artifact metadata sha mismatch、producer output hash 缺少
file entry、file entry 缺少 producer output hash、LanceDB dimension mismatch、
parquet schema digest mismatch、stale packageGeneration 和 cross-book artifact
path。

R3 补充文档 `fixtureContracts` 增加 current valid、legacy complete、missing
GraphRAG、GraphRAG output schema v0 not query-ready、producer lineage missing、
duplicate residue 和 unsupported legacy schema 等 fixtures。`scannerNoReadContracts`
和 provider sensitive tests 足以落地 provider payload 不读取的自动化断言。

该维度满足“可编写测试”的具体性要求，但测试集仍需按本报告未通过维度补强：
必须增加“不依赖 global catalog 的 manifest-first direct query”和“固定 artifact
gate 状态迁移表”的专门测试。

## pass_fail

总体结论：未通过。固定 10 维中 8 维通过，2 维未通过。

| 顺序 | baseline id | name | R5 判定 | 摘要 |
| --- | --- | --- | --- | --- |
| 1 | `direct_query_entrypoint` | 直接查询入口 | 未通过 | 查询入口依赖 committed mount/catalog projection，未保证仅凭 `BOOK_MANIFEST.json` 和包内 artifacts 定位查询上下文。 |
| 2 | `artifact_minimum_closure` | 查询 Artifact 最低闭包 | 通过 | 最低闭包、role、schemaVersion、bytes、sha256、required 和缺失 fail-closed 规则已定义。 |
| 3 | `artifact_gate_state_machine` | Artifact Gate 状态机 | 未通过 | 固定 states 与 transitions 分散在多处，缺少统一 artifact gate 状态机。 |
| 4 | `producer_lineage_completeness` | Producer Lineage 完整性 | 通过 | producer run、stage、input/output hash、toolVersion、schemaVersion、completedAt 和 upstream hash 已覆盖。 |
| 5 | `lineage_artifact_binding` | Lineage 与 Artifact 绑定 | 通过 | `producerRunIds`、`graphrag/runs`、artifact metadata rows 与 `files` 闭包可双向验证。 |
| 6 | `schema_runtime_compatibility` | Schema 与运行时兼容 | 通过 | runtime reader、parquet、LanceDB、embedding、output manifest 和 package layout 兼容输入已定义。 |
| 7 | `query_scope_isolation` | 单书查询范围隔离 | 通过 | package-relative path、当前 generation、bridge 生命周期和 cross-book 拒绝规则已定义。 |
| 8 | `privacy_payload_exclusion` | Provider Payload 排除 | 通过 | provider payload、secrets、credentials、logs 和 recovery payload 不读取、不导出。 |
| 9 | `recovery_diagnostics` | 失败恢复与诊断 | 通过 | stable diagnostics、repair entry、quarantine、visible-not-query-ready 和 rollback 已覆盖。 |
| 10 | `executable_contract_tests` | 可执行契约测试 | 通过 | 直接查询与核心负例具备测试基础，但需补强未通过维度对应测试。 |

## criteria_delta_from_previous_run

baseline criteria delta：无。

上一轮同一 agent 报告：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-09-graphrag-query/report.md`

R5 继续复用固定 `baseline.yaml`，baseline SHA-256 与上一轮一致：

`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

未新增、删除、重排、重命名审计维度，未改变任何 `passCriteria`。

判定 delta：

| baseline id | R4 判定 | R5 判定 | delta |
| --- | --- | --- | --- |
| `direct_query_entrypoint` | 通过 | 未通过 | R5 严格按“仅凭 `BOOK_MANIFEST.json` 和包内 artifacts、不依赖全局 catalog”判定；当前 query entrypoint 仍依赖 committed mount/catalog projection。 |
| `artifact_minimum_closure` | 通过 | 通过 | 无变化。 |
| `artifact_gate_state_machine` | 通过 | 未通过 | R5 要求固定 states 和 transitions 在 artifact gate 中显式成表；当前设计分散表达，未形成统一状态机。 |
| `producer_lineage_completeness` | 通过 | 通过 | 无变化。 |
| `lineage_artifact_binding` | 通过 | 通过 | 无变化。 |
| `schema_runtime_compatibility` | 通过 | 通过 | 无变化。 |
| `query_scope_isolation` | 通过 | 通过 | 无变化。 |
| `privacy_payload_exclusion` | 通过 | 通过 | 无变化。 |
| `recovery_diagnostics` | 通过 | 通过 | 无变化。 |
| `executable_contract_tests` | 通过 | 通过 | 无变化，但需新增未通过维度的专门测试。 |

## required_design_changes

1. 为 GraphRAG direct query 增加 manifest-first resolver 契约。查询入口在挂载扫描
   完成后必须能从 `graph_vault/books/{bookId}/BOOK_MANIFEST.json`、manifest
   `graphrag` section、`files` 闭包、artifact metadata rows 和包内
   `graphrag/runs` evidence 定位本书查询上下文。committed catalog projection
   只能作为可重建 cache；projection 缺失、损坏或过期时，不得阻断仅依赖
   manifest 和包内 artifacts 的直接查询判定。

2. 增加统一 `graphRagArtifactGateStateMachine`。状态必须显式包含
   `copied`、`candidate`、`validated`、`mounted`、`query_ready`、
   `visible_not_query_ready` 和 `quarantined`，并列出每条 transition 的触发条件、
   required evidence、stable diagnostic code、catalog projection effect、prohibited
   query condition 和 rollback/quarantine behavior。

3. 增加对应 contract tests。至少覆盖：删除或禁用 catalog projection 后仍能通过
   `BOOK_MANIFEST.json` 和包内 artifacts 完成 direct query gate 判定；stale
   projection 不得覆盖 manifest/hash/lineage 失败；每个 artifact gate 固定状态的
   正向迁移和失败迁移均有稳定诊断。

## residual_risks

- 如果实现把 committed catalog projection 当成不可重建权威状态，仍会重新引入
  global catalog dependency，并削弱热插拔包的可移植性。
- `lancedb` 的 `directory_manifest`、parquet schema digest 和 LanceDB schema
  digest 若缺少稳定编码，跨机器 query-ready 判定可能不一致。
- lineage summaries 若只做字段存在性检查，而不校验 producer output hash 与
  package file entry 的双向绑定，历史残留或替换 artifact 仍可能混入当前查询。
- provider no-read 合同需要在 importer、mount scanner、compatibility checker、
  migration scanner 和 query gate 分别强制执行；仅靠 export denylist 不足以证明
  查询路径不会读取敏感根。
- legacy migration 若在生成 `BOOK_MANIFEST.json` 前绕过 artifact gate，可能把
  schema 不兼容或 producer evidence 不完整的旧 output 误标为 query-ready。
