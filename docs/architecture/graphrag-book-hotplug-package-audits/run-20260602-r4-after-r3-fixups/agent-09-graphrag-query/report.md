# agent-09-graphrag-query R4 复审报告

## scenario

挂载后直接 GraphRAG 查询，需要完整 producer lineage 和 artifact gate。

复审对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

复审范围限定为单本书包复制、导入或挂载后，GraphRAG 查询入口能否仅依赖
`BOOK_MANIFEST.json`、包内 GraphRAG artifacts、包内 producer evidence
和必要本地投影，稳定判定 `query_ready`。复审未读取 provider request、
provider response、secrets、logs payload 或 recovery payload。

## reused_fixed_baseline

复用的固定 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-09-graphrag-query/baseline.yaml`

baseline SHA-256:

`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

固定 10 维如下，未新增、删除、重命名、重排维度，未改变 `passCriteria`：

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
| R4 baseline 文件存在 | 通过 |
| R4 是否复用既有 `baseline.yaml` | 通过，未覆盖 |
| baseline SHA-256 | `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419` |
| baseline 维度数量 | 通过，仍为 10 个 |
| baseline 维度 id 与顺序 | 通过，与固定 baseline 一致 |
| `passCriteria` 是否变更 | 通过，未变更 |
| 与 R3 agent-09 baseline 哈希关系 | 一致 |
| 本轮写入文件 | 仅写入 `report.md` |
| provider payload/secrets 读取边界 | 通过，未读取 |

## findings

### 1. `direct_query_entrypoint`

结论：通过。

主文档将 `BOOK_MANIFEST.json` 定义为单本书包的权威描述，并要求
`graph_vault/books/{bookId}` 包含验证、查询、导出和重挂载所需的完整闭包。
catalog 与全局 qmd/retrieval indexes 被限定为可重建投影
（rebuildable projections），不是包权威状态。

`graphragReadyGate.queryEntrypoint` 规定查询命令可 target `bookId`，通过已提交
mount projection 定位当前 `packageGeneration` 的 `graphrag/output`，查询前验证
`query_ready`，并拒绝 stale 或 cross-book artifacts。R3 补充文档中的
`scannerNoReadContracts.queryGate` 只允许 query gate 读取 committed catalog
projection、GraphRAG artifact metadata rows 和 qmd projection manifest，
且禁止读取 provider payloads、credentials 和 raw logs。

该设计不依赖旧 batch 状态、provider payload、发送方绝对路径或人工补参。
mount projection 是从 `BOOK_MANIFEST.json` 与包内闭包派生的本地读视图，不是
外部全局 catalog 权威输入。

### 2. `artifact_minimum_closure`

结论：通过。

`readinessGates.graphragReadyGate.minimumArtifactClosure` 明确列出 GraphRAG
直接查询所需最低 artifact 集合：

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

`graphRagArtifactMetadataContract` 要求每个必需 artifact 都有 metadata row，
并携带 `path`、`role`、`required`、`bytes`、`sha256`、`schemaVersion`、
`schemaDigest`、`validationGranularity`、`producerRunId`、`producerStage`、
`upstreamArtifactHashes`、`outputArtifactHash` 和 `compatibilityGroup`。
目录型 `lancedb` 使用 `directory_manifest` 校验粒度
（validation granularity）。

缺少必需 artifact metadata row、sha 不匹配、schema mismatch、producer hash
绑定缺失、LanceDB dimension mismatch 和 parquet schema mismatch 均列入
query gate 负例。缺失任一必需 artifact 时不能声明 `query_ready`，应 fail
closed 为 not query-ready。

### 3. `artifact_gate_state_machine`

结论：通过。

主文档通过 `atomicPackageLifecycle`、`mountScanTransactionModel`、
`readinessGates.packageStates`、`graphragReadyGate.states`、
`upgradePathMatrix` 和 `quarantineAndRepairStateMachine` 共同定义 artifact gate
状态机。直接复制目录先处于 copied/candidate 语义；缺少 publish marker 为
`incomplete_copy`；manifest、sidecar、路径、checksum、identity 和 schema 通过
后进入 mounted；GraphRAG artifact、checksum、lineage、schema 和 dimension gate
全部通过后才进入 `query_ready`；schema 或 artifact 不满足时进入
`visible_not_query_ready` 或 not query-ready 诊断路径；危险或损坏候选进入
`quarantined`。

查询入口在 gate failure 时返回稳定诊断，不触发 provider calls，也不得将候选包
投影为可查询。artifact gate 通过前不会生成可查询能力
（query capability）。

### 4. `producer_lineage_completeness`

结论：通过。

`graphragReadyGate.producerLineageSchema.requiredFields` 覆盖
`producerRunId`、`stage`、`parentProducerRunIds`、`inputArtifactHashes`、
`outputArtifactHashes`、`modelProfile`、`embeddingProfile`、`toolVersion`
和 `completedAt`。`graphRagArtifactMetadataContract.artifactRows` 进一步要求
每个必需 artifact 记录 `schemaVersion`、`producerStage`、
`upstreamArtifactHashes` 和 `outputArtifactHash`。

R3 补充文档中的 `migrationEvidenceSchema` 要求记录 old/new producer run ids、
before/after artifact hashes 和 `producerProvenanceStatus`，并显式区分
`preserved_verified`、`preserved_redacted`、`missing_marked_not_query_ready`、
`rebuilt_by_actual_producer_run` 与 `unavailable_repair_required`。该补充防止
迁移证据把未实际运行的 producer stage 误表达为成功。

因此，每个查询必需 artifact 均可追溯到 producer run、step、input hash、
tool version、schema version、生成时间和上游 artifact hash；lineage 不完整时
不得声明 `queryReady`。

### 5. `lineage_artifact_binding`

结论：通过。

`BOOK_MANIFEST.json` 的 `graphrag` section 要求 `producerRunIds`，`files`
条目要求 `producerRunId`、`bytes`、`sha256` 和 `required`。主文档的
`graphragReadyGate.bindingRule` 要求每个必需 GraphRAG artifact 必须列入
`files` 并绑定 producer run output hash，同时每个 producer run output hash
必须解析到 package file entry。

`graphRagArtifactMetadataContract.closureDigest` 使用排序后的 artifact metadata
rows 计算闭包摘要；负例覆盖 producer output hash 缺少 file entry、file entry
缺少 producer output hash、stale generation 和 cross-book artifact path。

这些规则在 `producerRunIds`、`graphrag/runs` 证据、artifact metadata rows 与
`files` 闭包之间建立双向引用关系，可证明 artifact 是声明 producer 生成的当前
文件，而不是孤立残留、历史文件或被替换文件。

### 6. `schema_runtime_compatibility`

结论：通过。

主文档的 `graphRagArtifactMetadataContract.queryGateCompatibilityInputs` 明确纳入
`outputManifestSchema`、`graphRagArtifactSchema`、`parquetSchemaDigest`、
`lancedbSchemaDigest`、`embeddingModel`、`embeddingDimension`、
`graphProjectionVersion`、`packageLayoutVersion` 和 `runtimeReaderVersion`。
这些输入覆盖 baseline 要求的 GraphRAG runtime、parquet schema、LanceDB
schema、embedding model/dimension、output manifest schema 和 package layout
schema。

R3 补充文档的 `schemaVersionUpgradeMatrix` 又按 `packageSchemaVersion`、
`layoutVersion`、`qmdIndexSchema`、`graphRagArtifactSchema` 和
`producerLineageSchema` 定义当前包、legacy distribution manifest、GraphRAG
output schema v0、producer lineage missing 和 unsupported legacy schema 的
处理结果。兼容失败会进入 `visible_not_query_ready`、`repair_required`、
`quarantine_mount_candidate` 或 fail-closed 路径，不会投影为 query-ready。

### 7. `query_scope_isolation`

结论：通过。

主文档固定 package root 为 `graph_vault/books/{bookId}`，要求所有 `files`
使用 package-relative paths，并拒绝 absolute paths、parent traversal、
symlink escape 和 hardlink outside package。查询入口通过当前
`packageGeneration` 定位本书 `graphrag/output`，拒绝 stale 或 cross-book
artifacts。

`graphRagArtifactMetadataContract.negativeTests` 覆盖 `cross-book artifact path`。
R3 补充文档将 `BOOK_MANIFEST.mount.packageRoot` 收紧为值为 `"."` 的
package-relative locator，并通过 `compatibilityBridgeLifecycle` 要求 legacy
locator 和 symlink bridge 必须 package-relative、checksum-bound、可过期且默认
不得进入 hotplug-v1 导出包。

这些规则限制直接查询只能读取该书包声明的 GraphRAG output、producer evidence
和必要投影，不能混入其他书、历史残留、全局缓存或 sibling roots。

### 8. `privacy_payload_exclusion`

结论：通过。

主文档 scope 明确排除 provider 请求、provider 响应、密钥和日志 payload 的分发。
`securityExportPolicy`、`producerEvidenceRedaction` 和
`sensitiveMaterialTaxonomy` 禁止 provider request/response、prompts、
raw responses、provider headers、request/response bodies、credentials、
absolute paths、runtime logs、debug/trace 和 durable recovery payload 进入包、
manifest、producer evidence 或诊断输出。

R3 补充文档进一步加入 `providerSensitiveClassExtensions`，覆盖 provider caches、
reversible interactions、provider auth config 和 credential stores。
`scannerNoReadContracts` 明确 importer、mount scanner、compatibility checker、
migration scanner 和 query gate 均不得读取敏感根；`queryGate` 的
`providerCallPolicy` 为 `never_on_gate_failure`。

artifact gate 和 lineage 验证所需证据以脱敏 metadata、hash、fingerprint 和 run
manifest 表达，不要求、不读取、不分发 provider payload、secrets、logs payload
或 recovery payload。

### 9. `recovery_diagnostics`

结论：通过。

主文档对 missing manifest、missing publish marker、missing required file、
checksum mismatch、path traversal、symlink escape、corrupt sidecar、
lineage binding missing、schema incompatible 和 producer evidence 缺失均定义
稳定诊断与 fail-closed 行为。mount scan failure 保留 previous last-good reader
view；quarantine repair 只有完整 validator pass 和新 projection generation commit
后才能清除隔离；schema 不兼容可保留为 visible-not-query-ready。

R3 补充文档的 `schemaVersionUpgradeMatrix.compatibilityDiagnostics` 与
`migrationEvidenceSchema` 增加 missing file、missing producer lineage、
tool version too old、unsupported legacy schema、artifact/schema incompatible、
decision status、failure reason 和 rollback plan 等诊断与证据字段。

该设计覆盖 artifact 缺失、hash 不匹配、lineage 断裂、schema 不兼容和 producer
evidence 缺失时的稳定诊断、修复入口、quarantine 行为与 catalog projection
回滚规则。

### 10. `executable_contract_tests`

结论：通过。

主文档 `implementationPlan.testContracts` 覆盖挂载复制、原子投影、provider
payload 排除、GraphRAG minimum artifact closure、artifact-lineage binding、
damaged package diagnostics、schema conversion、stale generation 和 query-ready
failure。`graphRagArtifactMetadataContract.negativeTests` 逐项覆盖 missing row、
sha mismatch、producer output hash 缺失、file entry 缺失 producer hash、
LanceDB dimension mismatch、parquet schema mismatch、stale generation 和
cross-book artifact path。

R3 补充文档的 `fixtureContracts` 增加 current valid、legacy complete、missing
GraphRAG、GraphRAG output schema v0 not query-ready、producer lineage missing、
duplicate residue 和 unsupported legacy schema 等 fixtures。`scannerNoReadContracts`
和 provider sensitive tests 也足以落地 provider payload 不读取的自动化断言。

这些条款足以让实现者编写挂载后 GraphRAG 直接查询、artifact 缺失、artifact
替换、lineage 缺失、schema 不兼容、跨书污染和 provider payload 不读取的自动化
测试。

## pass_fail

总体结论：通过。

| baseline id | R4 判定 | 摘要 |
| --- | --- | --- |
| `direct_query_entrypoint` | 通过 | 查询入口通过当前 generation 与 gate 验证定位本书 GraphRAG 输出。 |
| `artifact_minimum_closure` | 通过 | 最低闭包、metadata row、bytes、sha256、schemaVersion、role 与 required 已定义。 |
| `artifact_gate_state_machine` | 通过 | copied/candidate/validated/mounted/query-ready/visible-not-query-ready/quarantined 语义完整。 |
| `producer_lineage_completeness` | 通过 | run、stage、input/output hash、tool、schema、completedAt 与 upstream hash 已闭合。 |
| `lineage_artifact_binding` | 通过 | producerRunIds、runs 证据、files、output hash 与 closure digest 可双向验证。 |
| `schema_runtime_compatibility` | 通过 | runtime、parquet、LanceDB、embedding、output manifest 与 layout 兼容输入已补齐。 |
| `query_scope_isolation` | 通过 | package-relative path、当前 generation、bridge 生命周期和 cross-book 拒绝规则完整。 |
| `privacy_payload_exclusion` | 通过 | provider payload、secrets、logs、credentials 和 recovery payload 不读取、不导出。 |
| `recovery_diagnostics` | 通过 | stable diagnostics、quarantine、repair、visible-not-query-ready 和 rollback 均有规则。 |
| `executable_contract_tests` | 通过 | 正向直接查询与核心负例均可从测试契约和 fixtures 落地。 |

## criteria_delta_from_r3

baseline criteria delta：无。

R4 复审继续复用固定 `baseline.yaml`。R4 baseline 与 R3 agent-09 baseline 的
SHA-256 均为：

`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

未新增、删除、重排、重命名维度，未改变任何 `passCriteria`。

判定 delta：

| baseline id | R3 判定 | R4 判定 | delta |
| --- | --- | --- | --- |
| `direct_query_entrypoint` | 通过 | 通过 | 保持通过。 |
| `artifact_minimum_closure` | 通过 | 通过 | 保持通过。 |
| `artifact_gate_state_machine` | 通过 | 通过 | 保持通过。 |
| `producer_lineage_completeness` | 通过 | 通过 | 保持通过。 |
| `lineage_artifact_binding` | 通过 | 通过 | 保持通过。 |
| `schema_runtime_compatibility` | 通过 | 通过 | R3 补充文档强化 schema upgrade matrix 和 unsupported schema 诊断。 |
| `query_scope_isolation` | 通过 | 通过 | R3 补充文档强化 packageRoot `"."` 与 bridge 生命周期。 |
| `privacy_payload_exclusion` | 通过 | 通过 | R3 补充文档强化 provider cache/auth/credential/no-read 合同。 |
| `recovery_diagnostics` | 通过 | 通过 | R3 补充文档强化 migration evidence、rollback 和 compatibility diagnostics。 |
| `executable_contract_tests` | 通过 | 通过 | R3 补充文档增加 fixtureContracts 与 no-read 测试输入。 |

## required_design_changes

无阻塞性设计变更。

进入实现前应保持以下设计约束不被弱化：

- query gate 可使用 committed mount projection，但该 projection 必须始终是从
  `BOOK_MANIFEST.json` 与包内闭包派生的可重建读视图，不得成为外部权威 catalog
  依赖。
- `lancedb` 目录型 artifact 的 `directory_manifest` 需要在实现规格中落成稳定
  文件格式，包含可校验的集合 schema、embedding dimension、vector count 和
  file/hash closure。
- producer lineage summaries 必须保持脱敏，只记录 run、stage、hash、schema、
  tool version、fingerprint 和时间，不得回退到 raw provider evidence。
- 自动化测试必须覆盖 R4 baseline 的 10 维，不得只测试成功查询路径。

## residual_risks

- 实现若把 committed catalog projection 当成不可重建权威状态，可能重新引入
  global catalog 依赖。需要用删除 projection 后重扫恢复的测试约束该行为。
- `directory_manifest`、parquet schema digest 和 LanceDB schema digest 的具体
  编码若不稳定，可能导致跨机器误判 query-ready 或误判不兼容。
- migration evidence 若只记录动作声明而不校验 before/after artifact hashes 与
  producer output hashes，仍可能让历史残留 artifact 混入当前 generation。
- provider no-read 合同需要在 importer、scanner、compatibility checker、
  migration scanner 和 query gate 各自实现层强制执行；仅靠导出 denylist 不足以
  防止本地敏感根被误读。
- fixtures 必须包含跨书污染、artifact 替换和 lineage 断裂的负例，否则实现可能
  只满足文档字段存在性，而未验证字段间绑定关系。
