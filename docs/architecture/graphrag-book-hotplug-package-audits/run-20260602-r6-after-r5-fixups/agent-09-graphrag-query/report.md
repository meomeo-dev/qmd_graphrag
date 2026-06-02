# agent-09-graphrag-query R6 固定基准设计审计报告

## scenario

挂载后直接 GraphRAG 查询，需要完整 producer lineage 和 artifact gate。

审计对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

`graphrag-book-hotplug-package-r3-fixups.type-dd.yaml` 与
`graphrag-book-hotplug-package-r5-fixups.type-dd.yaml` 按主文档
`supplementalTypeDD` 和 R5 补充文档 `normativePrecedence` 声明作为规范性补充
文档（normative supplements）评估。

审计范围仅限设计文档是否满足固定 10 维 `passCriteria`。未读取 provider
request、provider response、secrets、`.env`、凭据、日志 payload、recovery
payload 或私有运行数据。

## reused_fixed_baseline

复用固定基准（fixed baseline）：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-09-graphrag-query/baseline.yaml`

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
| baseline 是否为指定 R6 固定路径 | 通过 |
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

结论：通过。

主文档将 `graph_vault/books/{bookId}/BOOK_MANIFEST.json` 定义为 mounted book
package 的权威描述，要求 package root 包含验证、查询、导出和重挂载所需闭包。
R5 补充文档新增 `manifestFirstDirectQueryResolver`，明确 GraphRAG 查询可在
mount validation 后从 book package manifest 与包内 artifacts 解析，不要求
global catalog 作为查询权威。

该 resolver 的必需输入包括 `BOOK_MANIFEST.json`、manifest checksum sidecar、
`BOOK_MANIFEST.graphrag.outputManifestPath`、`graphrag.requiredArtifacts`、
每个必需 artifact 的 `files` 条目、`graphrag/output/qmd_output_manifest.json`、
`graphrag/output/artifact-metadata.json` 与 `graphrag/runs` 中的脱敏 producer
lineage summaries。`graph_vault/catalog/books.yaml`、
`graph_vault/catalog/graph-capabilities.yaml` 与 qmd projection 仅为 optional
caches。

`cacheMismatchPolicy` 规定 catalog projection 缺失、过期或与当前 manifest
digest 不一致时，direct query readiness 仍由 manifest 与包内 artifacts 决定；
stale cache 不得覆盖 manifest、hash、schema 或 lineage failure。`forbiddenInputs`
排除 provider payload roots、provider logs、raw prompts、raw completions、
secrets 与 absolute local paths。因此设计满足“挂载后仅凭 `BOOK_MANIFEST.json`
和包内 artifacts 定位本书查询上下文”的固定 criteria。

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
`producerStage`、`upstreamArtifactHashes`、`outputArtifactHash` 与
`compatibilityGroup`。`requiredArtifactMetadata` 为最低闭包中的每个 artifact
指定 role 与 validation granularity。

缺失必需 artifact metadata row、artifact metadata sha mismatch、producer
output hash 缺少 file entry、file entry 缺少 producer output hash、LanceDB
embedding dimension mismatch、parquet schema digest mismatch、stale
packageGeneration 与 cross-book artifact path 均列为 query gate negative tests。
缺少任一必需 artifact 或其元数据时不得进入 `query_ready`。

### 3. `artifact_gate_state_machine` - Artifact Gate 状态机

结论：通过。

R5 补充文档新增 `graphRagArtifactGateStateMachine`，以单一状态机覆盖复制、
验证、挂载可见性、查询就绪、隔离、诊断与回滚。状态显式包含：

- `copied`
- `candidate`
- `validating`
- `validated`
- `mounted`
- `query_ready`
- `visible_not_query_ready`
- `quarantined`
- `rolled_back`

该状态机覆盖固定 criteria 指名的 `copied`、`candidate`、`validated`、
`mounted`、`query_ready`、`visible_not_query_ready` 与 `quarantined`。每条
transition 均声明 `trigger`、`requiredEvidence`、`diagnosticCode`、
`catalogProjectionEffect` 与 `prohibitedQueryCondition`。在 `query_ready` 之前，
`copied`、`candidate`、`validating`、`mounted`、`visible_not_query_ready`、
`quarantined` 与 `rolled_back` 均有明确禁止查询条件或 false query capability。

`mounted -> query_ready` 要求 required artifacts present、checksum binding、
artifact metadata closure digest、producer output hash binding 以及 compatible
parquet and LanceDB schema digests。checksum mismatch、unsafe path、corrupt
sidecar 或 payload leak 进入 `quarantined`；lineage missing 等可修复失败进入
`visible_not_query_ready`；validation crash 或 commit failure 进入 `rolled_back`
并保留 last-good generation。artifact gate 通过前不得投影为可查询。

### 4. `producer_lineage_completeness` - Producer Lineage 完整性

结论：通过。

`graphragReadyGate.producerLineageSchema.requiredFields` 覆盖
`producerRunId`、`stage`、`parentProducerRunIds`、`inputArtifactHashes`、
`outputArtifactHashes`、`modelProfile`、`embeddingProfile`、`toolVersion` 与
`completedAt`。其中 `stage` 对应 producer step，`inputArtifactHashes` 对应
input hash，`completedAt` 提供 producer 输出生成时间（generation time）。

`graphRagArtifactMetadataContract.artifactRows` 要求每个必需 artifact 记录
`schemaVersion`、`producerStage`、`upstreamArtifactHashes` 与
`outputArtifactHash`。`stageOrder` 固定 `graph_extract`、`community_report`、
`embed`、`query_ready` 的 producer stage 顺序。R3 补充文档
`migrationEvidenceSchema` 进一步要求记录 old/new producer run ids、
before/after artifact hashes 与 `producerProvenanceStatus`，并区分
`preserved_verified`、`preserved_redacted`、`missing_marked_not_query_ready`、
`rebuilt_by_actual_producer_run` 与 `unavailable_repair_required`。

R5 `graphRagArtifactGateStateMachine` 将 producer lineage summaries 和 producer
output hash binding 作为进入 `validated` 与 `query_ready` 的 required evidence。
lineage missing 转入 `visible_not_query_ready`，不得声明 `queryReady`。

### 5. `lineage_artifact_binding` - Lineage 与 Artifact 绑定

结论：通过。

`BOOK_MANIFEST.json` 的 `graphrag` section 要求 `producerRunIds`，`files`
条目要求 `producerRunId`、`bytes`、`sha256` 与 `required`。主文档
`graphragReadyGate.bindingRule` 要求每个必需 GraphRAG artifact 必须列入
`files`，并绑定 producer run output hash；每个 producer run output hash 也必须
解析到 package file entry。缺失任一方向绑定即 gate failure。

`graphRagArtifactMetadataContract.closureDigest` 使用排序后的 artifact metadata
rows 计算闭包 digest。`artifactRows` 将 `producerRunId`、`producerStage`、
`upstreamArtifactHashes` 与 `outputArtifactHash` 绑定到每个 artifact row。R5
`manifestFirstDirectQueryResolver` 又要求 direct query validation 读取
`artifact-metadata.json` 与 `graphrag/runs` 脱敏 producer lineage summaries。

这些规则在 manifest `producerRunIds`、`graphrag/runs` evidence、artifact
metadata rows 与 `files` 闭包之间建立可验证引用关系，能够识别孤立残留文件、
替换 artifact、stale package generation 与 cross-book artifact path。

### 6. `schema_runtime_compatibility` - Schema 与运行时兼容

结论：通过。

`graphRagArtifactMetadataContract.queryGateCompatibilityInputs` 明确纳入
`outputManifestSchema`、`graphRagArtifactSchema`、`parquetSchemaDigest`、
`lancedbSchemaDigest`、`embeddingModel`、`embeddingDimension`、
`graphProjectionVersion`、`packageLayoutVersion` 与 `runtimeReaderVersion`。
这些输入覆盖 GraphRAG runtime、parquet schema、LanceDB schema、embedding
model/dimension、output manifest schema 与 package layout schema。

R3 补充文档 `schemaVersionUpgradeMatrix` 按 `packageSchemaVersion`、
`layoutVersion`、`qmdIndexSchema`、`graphRagArtifactSchema` 与
`producerLineageSchema` 定义当前包、legacy distribution manifest、GraphRAG
output schema v0、producer lineage missing 与 unsupported legacy schema 的处理
结果。R5 artifact gate 的 `mounted -> query_ready` transition 明确要求
compatible parquet and LanceDB schema digests。

兼容失败进入 `visible_not_query_ready`、`repair_required`、
`quarantine_mount_candidate` 或 fail-closed 路径，不会投影为 query-ready。

### 7. `query_scope_isolation` - 单书查询范围隔离

结论：通过。

主文档固定 package root 为 `graph_vault/books/{bookId}`，要求所有 `files`
使用 package-relative path，并拒绝 absolute path、parent traversal、symlink
escape 与 hardlink outside package。GraphRAG 查询入口按当前
`packageGeneration` 定位本书 `graphrag/output`，并拒绝 stale 或 cross-book
artifacts。

R5 `manifestFirstDirectQueryResolver` 要求 validate package-relative GraphRAG
artifact paths，并将 catalog projection 限定为 optional cache。即使全局 catalog
projection 存在，也必须与当前 manifest digest 一致；stale cache 不得使失败的
manifest、hash、schema 或 lineage 进入 query-ready。

`graphRagArtifactMetadataContract.negativeTests` 覆盖 `cross-book artifact path`。
R3 补充文档将 bridge 与 sensitive root 读取边界收紧为 package-relative 与
no-read policy。设计足以防止其他书、历史残留、全局缓存或 sibling roots 混入
单书 GraphRAG 查询上下文。

### 8. `privacy_payload_exclusion` - Provider Payload 排除

结论：通过。

主文档 scope 明确排除 provider 请求、provider 响应、密钥与日志 payload 的
分发。`securityExportPolicy`、`producerEvidenceRedaction` 与
`sensitiveMaterialTaxonomy` 禁止 provider request/response、prompts、raw
responses、provider headers、request/response bodies、credentials、absolute
paths、runtime logs、debug/trace 与 durable recovery payload 进入包、manifest、
producer evidence 或诊断输出。

R3 补充文档 `scannerNoReadContracts` 要求 importer、mount scanner、
compatibility checker、migration scanner 与 query gate 均不得读取 sensitive
roots；`queryGate.providerCallPolicy` 为 `never_on_gate_failure`。R5
`manifestFirstDirectQueryResolver.forbiddenInputs` 进一步排除 provider payload
roots、provider response logs、raw prompts、raw completions、secrets 与
absolute local paths。

artifact gate 与 lineage 验证所需证据以脱敏 metadata、hash、fingerprint 和 run
manifest 表达，不要求读取、分发或恢复 provider payload。

### 9. `recovery_diagnostics` - 失败恢复与诊断

结论：通过。

主文档对 missing manifest、missing publish marker、missing required file、
checksum mismatch、path traversal、symlink escape、corrupt sidecar、lineage
binding missing、schema incompatible 与 producer evidence 缺失定义 stable
diagnostics 与 fail-closed 行为。mount scan failure 保留 previous last-good
reader view；quarantine repair 只有完整 validator pass 和新 projection
generation commit 后才能清除隔离；schema 不兼容可保留为
visible-not-query-ready。

R5 `graphRagArtifactGateStateMachine` 为 GraphRAG artifact gate 提供稳定
`diagnosticCode`、`catalogProjectionEffect` 与 `prohibitedQueryCondition`。
checksum mismatch 等 unsafe failure 进入 `quarantined`，repairable gate failure
进入 `visible_not_query_ready`，validation crash 或 commit failure 进入
`rolled_back` 并 preserve last-good generation。

R3 `schemaVersionUpgradeMatrix.compatibilityDiagnostics` 与
`migrationEvidenceSchema` 增加 missing producer lineage、unsupported schema、
artifact/schema incompatible、decision status、failure reason 与 rollback plan 等
诊断字段。该维度满足 artifact 缺失、hash 不匹配、lineage 断裂、schema 不兼容和
producer evidence 缺失时的稳定诊断、修复入口、quarantine 行为与 catalog
projection 回滚要求。

### 10. `executable_contract_tests` - 可执行契约测试

结论：通过。

主文档 `implementationPlan.testContracts` 覆盖挂载复制、原子投影、provider
payload 排除、GraphRAG minimum artifact closure、artifact-lineage binding、
damaged package diagnostics、schema conversion、stale generation 与 query-ready
failure。`graphRagArtifactMetadataContract.negativeTests` 覆盖 missing required
artifact metadata row、artifact metadata sha mismatch、producer output hash 缺少
file entry、file entry 缺少 producer output hash、LanceDB dimension mismatch、
parquet schema digest mismatch、stale packageGeneration 与 cross-book artifact
path。

R5 `fixedBaselineTestContracts.graphRagQuery` 增加以下专门测试：

- manifest-first direct query with catalog cache absent
- stale catalog cache cannot force query_ready
- artifact gate covers copied to query_ready transitions
- lineage missing returns visible_not_query_ready
- checksum mismatch quarantines candidate

R5 `manifestFirstDirectQueryResolver.tests` 与
`graphRagArtifactGateStateMachine.tests` 进一步覆盖 catalog projection deleted、
stale graph-capabilities cache、missing artifact metadata row、provider roots
absent、每个状态的 stable diagnostic code、checksum mismatch quarantine、lineage
missing visible_not_query_ready 与 stale catalog 不能 force query_ready。结合 R3
no-read contracts，设计足够具体，可编写挂载后直接查询、artifact 缺失、artifact
替换、lineage 缺失、schema 不兼容、跨书污染与 provider payload 不读取的自动化
契约测试。

## pass_fail

总体结论：通过。固定 10 维中 10 维通过，0 维未通过。

| 顺序 | baseline id | name | R6 判定 | 摘要 |
| --- | --- | --- | --- | --- |
| 1 | `direct_query_entrypoint` | 直接查询入口 | 通过 | R5 新增 manifest-first resolver，catalog 仅为 optional cache，缺失或 stale 时不阻断 manifest 与包内 artifacts 判定。 |
| 2 | `artifact_minimum_closure` | 查询 Artifact 最低闭包 | 通过 | 最低闭包、role、schemaVersion、bytes、sha256、required 和缺失 not query-ready 规则已定义。 |
| 3 | `artifact_gate_state_machine` | Artifact Gate 状态机 | 通过 | R5 新增统一 GraphRAG artifact gate 状态机，覆盖固定 states、transitions、diagnostics、projection effect 和禁止查询条件。 |
| 4 | `producer_lineage_completeness` | Producer Lineage 完整性 | 通过 | producer run、step、input/output hash、toolVersion、schemaVersion、completedAt 和 upstream hash 已覆盖。 |
| 5 | `lineage_artifact_binding` | Lineage 与 Artifact 绑定 | 通过 | `producerRunIds`、`graphrag/runs`、artifact metadata rows 与 `files` 闭包可双向验证。 |
| 6 | `schema_runtime_compatibility` | Schema 与运行时兼容 | 通过 | runtime reader、parquet、LanceDB、embedding、output manifest 和 package layout 兼容输入已定义。 |
| 7 | `query_scope_isolation` | 单书查询范围隔离 | 通过 | package-relative path、当前 generation、manifest digest cache policy 和 cross-book 拒绝规则已定义。 |
| 8 | `privacy_payload_exclusion` | Provider Payload 排除 | 通过 | provider payload、secrets、credentials、logs 和 recovery payload 不读取、不要求、不导出。 |
| 9 | `recovery_diagnostics` | 失败恢复与诊断 | 通过 | stable diagnostics、repair entry、quarantine、visible-not-query-ready 和 rollback 已覆盖。 |
| 10 | `executable_contract_tests` | 可执行契约测试 | 通过 | R5 增加 manifest-first direct query 与 artifact gate 专门 fixtures，覆盖固定负例。 |

## criteria_delta_from_previous_run

baseline criteria delta：无。

上一轮同一 agent 报告：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-09-graphrag-query/report.md`

R6 继续复用固定 `baseline.yaml`，baseline SHA-256 与上一轮一致：

`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

未新增、删除、重排、重命名审计维度，未改变任何 `passCriteria`。

判定 delta：

| baseline id | R5 判定 | R6 判定 | delta |
| --- | --- | --- | --- |
| `direct_query_entrypoint` | 未通过 | 通过 | R5 补充文档新增 `manifestFirstDirectQueryResolver`，将 global catalog 降级为 optional cache，并规定 cache 缺失、过期或 digest 不一致时由 manifest 与包内 artifacts 判定。 |
| `artifact_minimum_closure` | 通过 | 通过 | 无变化。 |
| `artifact_gate_state_machine` | 未通过 | 通过 | R5 补充文档新增 `graphRagArtifactGateStateMachine`，统一覆盖固定 states、transitions、diagnostic code、projection effect、禁止查询条件和 rollback/quarantine 行为。 |
| `producer_lineage_completeness` | 通过 | 通过 | 无变化。 |
| `lineage_artifact_binding` | 通过 | 通过 | 无变化。 |
| `schema_runtime_compatibility` | 通过 | 通过 | 无变化。 |
| `query_scope_isolation` | 通过 | 通过 | 无变化。 |
| `privacy_payload_exclusion` | 通过 | 通过 | 无变化。 |
| `recovery_diagnostics` | 通过 | 通过 | 无变化。 |
| `executable_contract_tests` | 通过 | 通过 | R5 增加 direct query 与 artifact gate 专门测试后，原测试可执行性结论保持通过且证据更完整。 |

## required_design_changes

无阻塞性设计变更要求。R5 补充文档已经补齐上一轮 agent-09 的两个固定基准缺口：

1. `manifestFirstDirectQueryResolver` 满足 manifest-first direct query，不再依赖
   global catalog 作为查询权威。
2. `graphRagArtifactGateStateMachine` 满足固定 artifact gate 状态、转移、诊断、
   projection effect、禁止查询条件与 rollback/quarantine 行为。

进入实现前建议保持以下非阻塞约束：

- 将 `completedAt` 在 producer lineage schema 中明确实现为 artifact 输出生成时间。
- 为 `graphrag/output/lancedb` 的 directory manifest、parquet schema digest 与
  LanceDB schema digest 固定 canonical encoding。
- 将 R5 `fixedBaselineTestContracts.graphRagQuery` 转化为实现级 fixture 名称与
  断言表，避免测试实现时弱化 criteria。

## residual_risks

- 如果实现仍把 committed catalog projection 当成不可重建权威状态，可能重新引入
  global catalog dependency，并削弱热插拔包的可移植性。
- `lancedb` directory manifest、parquet schema digest 与 LanceDB schema digest 若
  缺少稳定编码，跨机器 query-ready 判定可能不一致。
- lineage summaries 若只做字段存在性检查，而不校验 producer output hash 与
  package file entry 的双向绑定，历史残留或替换 artifact 仍可能混入当前查询。
- provider no-read 合同需要在 importer、mount scanner、compatibility checker、
  migration scanner 与 query gate 分别强制执行；仅靠 export denylist 不足以证明
  查询路径不会读取敏感根。
- legacy migration 若在生成 `BOOK_MANIFEST.json` 前绕过 artifact gate，可能把
  schema 不兼容或 producer evidence 不完整的旧 output 误标为 query-ready。
