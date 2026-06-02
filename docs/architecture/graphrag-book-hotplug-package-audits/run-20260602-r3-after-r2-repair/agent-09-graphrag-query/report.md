# agent-09-graphrag-query R3 复审报告

## scenario

挂载后直接 GraphRAG 查询，需要完整 producer lineage 和 artifact gate。

复审对象为 `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。
复审范围限定为单本书包复制或挂载后，GraphRAG 查询入口能否仅依赖
`BOOK_MANIFEST.json`、包内 GraphRAG artifacts、包内 producer evidence
和必要本地投影，稳定判定 query-ready。复审未读取 provider request、
provider response、secrets、logs payload 或 recovery payload。

## reused_fixed_baseline

复用的固定 baseline 为：
`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-09-graphrag-query/baseline.yaml`

baseline SHA-256:
`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

固定 10 维如下，未新增、删除、重命名、重排维度，未改变 passCriteria：

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
| R3 baseline 文件存在 | 通过 |
| R3 baseline 是否复用既有文件 | 通过，未覆盖 `baseline.yaml` |
| R2/R3 baseline 内容一致性 | 通过，`cmp` 结果一致 |
| baseline SHA-256 | `10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419` |
| baseline 维度数量 | 通过，仍为 10 个 |
| baseline 维度 id 与顺序 | 通过，与固定 baseline 一致 |
| passCriteria 是否变更 | 通过，未变更 |
| 本轮写入文件 | 仅写入 `report.md` |
| provider payload/secrets 读取边界 | 通过，未读取 |

## findings

### 1. `direct_query_entrypoint`

结论：通过。

Type DD 将 `BOOK_MANIFEST.json` 定义为单本书包权威描述，并将 catalog 与
全局索引限定为可重建投影。`graphragReadyGate.queryEntrypoint` 规定查询命令
可 target `bookId`，通过已提交 mount projection 定位当前 `packageGeneration`
的 `graphrag/output`，查询前验证 `query_ready`，并拒绝 stale 或 cross-book
artifacts。

该入口不依赖旧 batch 状态、provider payload、发送方绝对路径或人工补参。
committed mount projection 是从 `BOOK_MANIFEST.json` 派生的读视图，不是全局
catalog 权威状态，因此不违反 baseline 的直接查询边界。

### 2. `artifact_minimum_closure`

结论：通过。

`readinessGates.graphragReadyGate.minimumArtifactClosure` 明确列出 GraphRAG
查询所需最低 artifact 集合：output manifest、text-unit identity、context、
stats、documents、text units、entities、relationships、communities、
community reports 与 `lancedb`。R3 修订新增
`graphRagArtifactMetadataContract`，要求每个必需 artifact 都有 metadata row，
且 row 必须携带 `path`、`role`、`required`、`bytes`、`sha256`、
`schemaVersion`、`schemaDigest`、`producerRunId`、`upstreamArtifactHashes`
和 `outputArtifactHash`。

目录型 `lancedb` 被标为 `vector_index`，校验粒度为 `directory_manifest`。
缺少必需 artifact metadata row、sha 不匹配、schema mismatch 或维度 mismatch
均列为 query gate 负例。缺失任一必需 artifact 时不能成为 query-ready。

### 3. `artifact_gate_state_machine`

结论：通过。

Type DD 通过 `atomicPackageLifecycle`、`mountScanTransactionModel`、
`readinessGates.packageStates`、`graphragReadyGate.states`、
`quarantineAndRepairStateMachine` 和 migration state 共同定义状态机。直接复制
目录先处于 copied/candidate 语义；缺失 publish marker 为 incomplete copy；
校验通过后进入 mounted；GraphRAG artifact、checksum、lineage、schema 和
dimension gate 全部通过后才进入 `query_ready`；schema 不兼容可保持
`visible_not_query_ready`；损坏或危险候选进入 `quarantined`。

查询入口在 gate failure 时返回稳定诊断，不触发 provider calls，也不把候选包
投影为可查询，满足 artifact gate 通过前禁止查询的要求。

### 4. `producer_lineage_completeness`

结论：通过。

`graphragReadyGate.producerLineageSchema.requiredFields` 覆盖
`producerRunId`、`stage`、`parentProducerRunIds`、`inputArtifactHashes`、
`outputArtifactHashes`、`modelProfile`、`embeddingProfile`、`toolVersion`
和 `completedAt`。R3 新增 artifact metadata row 字段
`schemaVersion`、`producerStage`、`upstreamArtifactHashes` 和
`outputArtifactHash`，补齐 R2 中 schema version 与上游 artifact hash
不够显式的问题。

因此，每个查询必需 artifact 均可追溯到 producer run、step、input hash、
tool version、schema version、生成时间和上游 artifact hash。binding 缺失时
gate fail closed，不得声明 queryReady。

### 5. `lineage_artifact_binding`

结论：通过。

`BOOK_MANIFEST.json` 的 `graphrag` section 要求 `producerRunIds`，`files`
条目要求 `producerRunId`。`graphragReadyGate.bindingRule` 要求每个必需
GraphRAG artifact 必须列入 files 并绑定 producer run output hash，同时每个
producer run output hash 必须解析到 package file entry。R3 的
`graphRagArtifactMetadataContract` 又增加 `closureDigest` 和双向缺失负例。

这些约束能够证明 artifact 是声明 producer 生成的当前文件，而不是孤立残留、
历史文件或被替换文件。

### 6. `schema_runtime_compatibility`

结论：通过。

R3 新增 `queryGateCompatibilityInputs`，明确纳入 `outputManifestSchema`、
`graphRagArtifactSchema`、`parquetSchemaDigest`、`lancedbSchemaDigest`、
`embeddingModel`、`embeddingDimension`、`graphProjectionVersion`、
`packageLayoutVersion` 和 `runtimeReaderVersion`。这些输入覆盖 baseline 要求的
GraphRAG runtime、parquet schema、LanceDB schema、embedding 模型与维度、
output manifest schema 和 package layout schema。

兼容失败会落入 `schema_incompatible`、`dimension_incompatible`、
`visible_not_query_ready` 或 fail-closed 路径，不会被投影为 query-ready。

### 7. `query_scope_isolation`

结论：通过。

Type DD 将 package root 固定为 `graph_vault/books/{bookId}`，要求 files 使用
package-relative paths，并拒绝 absolute paths、parent traversal、symlink
escape 和 hardlink outside package。查询入口通过当前 `packageGeneration`
定位 `graphrag/output`，拒绝 stale 或 cross-book artifacts。R3 负例清单还加入
`cross-book artifact path`。

这些规则限制直接查询只能读取该书包声明的 GraphRAG output、producer evidence
和必要投影，不能混入其他书、历史残留、全局缓存或 sibling roots。

### 8. `privacy_payload_exclusion`

结论：通过。

scope 明确排除 provider 请求、provider 响应、密钥和日志 payload 的分发。
manifest exclusions、producer evidence redaction 与 R3 新增
`sensitiveMaterialTaxonomy` 共同禁止 provider request、provider response、
completion payload、prompt、token usage、credentials、absolute local path
和 runtime recovery payload 进入导出、导入、mount scan、migration 或 query
诊断路径。

artifact gate 和 lineage 验证所需证据以脱敏 metadata、hash、fingerprint 和
run manifest 表达。gate failure 不触发 provider calls，满足 provider payload
排除要求。

### 9. `recovery_diagnostics`

结论：通过。

缺失 manifest、缺失 publish marker、缺失 required file、checksum mismatch、
path traversal、symlink escape、corrupt sidecar、lineage binding missing、
schema incompatible 和 producer evidence 缺失均有稳定诊断与 fail-closed 行为。
mount scan failure 保留 previous last-good reader view；quarantine repair 只有
完整 validator pass 和新 projection generation commit 后才能清除隔离；schema
不兼容可以保留为 visible-not-query-ready。

该设计覆盖 artifact 缺失、hash 不匹配、lineage 断裂、schema 不兼容和
producer evidence 缺失时的诊断、修复入口、quarantine 行为与 catalog
projection 回滚规则。

### 10. `executable_contract_tests`

结论：通过。

`implementationPlan.testContracts` 已覆盖挂载复制、原子投影、provider payload
排除、GraphRAG minimum artifact closure、artifact-lineage binding、damaged
package diagnostics、schema conversion、stale generation 和 query-ready failure。
R3 新增 `graphRagArtifactMetadataContract.negativeTests`，逐项覆盖 missing row、
sha mismatch、producer output hash 缺失、file entry 缺失 producer hash、
LanceDB dimension mismatch、parquet schema mismatch、stale generation 和
cross-book artifact path。

这些条款足以编写挂载后 GraphRAG 直接查询、artifact 缺失、artifact 替换、
lineage 缺失、schema 不兼容、跨书污染和 provider payload 不读取的自动化测试。

## pass_fail

总体结论：通过。

R3 修订后的 Type DD 已闭合 R2 留下的主要 GraphRAG query gate 缺口：
最低 artifact 闭包有逐项 metadata row，producer lineage 显式包含 schema
version 和 upstream hashes，query gate 兼容矩阵补齐 runtime/output/layout
维度，专项负例测试清单已形成可执行契约。

| baseline id | R3 判定 | 摘要 |
| --- | --- | --- |
| `direct_query_entrypoint` | 通过 | bookId 查询入口经当前 generation 与 gate 验证直接定位本书输出。 |
| `artifact_minimum_closure` | 通过 | 最低闭包、逐项 metadata row、bytes、sha256、schemaVersion 和 required 均已定义。 |
| `artifact_gate_state_machine` | 通过 | copied/candidate/mounted/query-ready/visible-not-query-ready/quarantined 语义完整。 |
| `producer_lineage_completeness` | 通过 | producer run、stage、input/output hash、tool、schema、completedAt 和 upstream 已闭合。 |
| `lineage_artifact_binding` | 通过 | files、producerRunIds、output hash 与 metadata closure digest 可双向验证。 |
| `schema_runtime_compatibility` | 通过 | runtime、parquet、LanceDB、embedding、output manifest 和 layout 兼容输入已补齐。 |
| `query_scope_isolation` | 通过 | package-relative path、current generation 和 cross-book 拒绝规则完整。 |
| `privacy_payload_exclusion` | 通过 | provider payload、secrets、logs 和 runtime payload 不读取、不导出、不诊断泄露。 |
| `recovery_diagnostics` | 通过 | stable diagnostics、quarantine、repair、visible-not-query-ready 和 rollback 均有规则。 |
| `executable_contract_tests` | 通过 | 正向查询与核心负例均可从测试契约和 negativeTests 直接落地。 |

## criteria_delta_from_r2

baseline criteria delta：无。

R3 复审复用的 `baseline.yaml` 与 R2 固定 baseline 内容一致，SHA-256 均为
`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`。
未新增、删除、重排、重命名维度，未改变 passCriteria。

Type DD 相对 R2 的设计结果变化如下：

| baseline id | R2 判定 | R3 判定 | delta |
| --- | --- | --- | --- |
| `direct_query_entrypoint` | 通过 | 通过 | 保持通过。 |
| `artifact_minimum_closure` | 部分通过 | 通过 | 新增 artifact metadata row，补齐 role、schema、bytes、sha256、required 和目录校验粒度。 |
| `artifact_gate_state_machine` | 通过 | 通过 | 保持通过，并由 metadata negativeTests 强化 gate 输入。 |
| `producer_lineage_completeness` | 部分通过 | 通过 | metadata row 显式加入 schemaVersion、upstreamArtifactHashes 和 outputArtifactHash。 |
| `lineage_artifact_binding` | 通过 | 通过 | 保持通过，并由 closureDigest 与双向缺失负例强化。 |
| `schema_runtime_compatibility` | 部分通过 | 通过 | queryGateCompatibilityInputs 补齐 runtime、output manifest 和 package layout。 |
| `query_scope_isolation` | 通过 | 通过 | 保持通过，并新增 cross-book artifact path 负例。 |
| `privacy_payload_exclusion` | 通过 | 通过 | 保持通过，并由 sensitiveMaterialTaxonomy 扩展 no-read/no-export 边界。 |
| `recovery_diagnostics` | 通过 | 通过 | 保持通过。 |
| `executable_contract_tests` | 部分通过 | 通过 | 新增 GraphRAG query gate 专项 negativeTests，覆盖 R2 缺失负例。 |

## required_design_changes

无阻断性设计变更。

R3 未发现必须修改 Type DD 才能满足本 baseline 的缺口。后续实现应保持
`minimumArtifactClosure`、`graphRagArtifactMetadataContract`、manifest `files`
和 producer evidence 之间的一致性校验，避免实现时把这些约束拆散为不可验证的
局部检查。

## residual_risks

- `graphRagArtifactMetadataContract` 与既有 `graphragReadyGate` 字段存在跨区块
  约束，实施时需要一个单一 validator 计算 query-ready，避免不同模块各自解释。
- `runtimeReaderVersion` 承担 GraphRAG runtime 兼容性语义，依赖升级时必须维护
  显式 compatibility matrix，避免 runtime 行为漂移但 schema digest 未变化。
- `lancedb` 目录型 artifact 的 `directory_manifest` 需要在实现中精确定义文件
  枚举、collection schema、embedding dimension 和 checksum 策略。
- 严格 lineage gate 可能使旧包或迁移包进入 visible-not-query-ready 或
  quarantine；用户侧需要清晰区分可挂载、可查询、需重建 GraphRAG 三种状态。
- provider evidence 使用脱敏 metadata 与 fingerprint 后，仍需测试 fingerprint
  稳定性和不可逆性，避免间接泄露 provider payload。
