# agent-09-graphrag-query R2 复审报告

## scenario

挂载后直接 GraphRAG 查询，需要完整 producer lineage 和 artifact gate。

复审对象为 `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。
复审范围限定为单本书包复制或挂载后，GraphRAG 查询入口能否只依赖
`BOOK_MANIFEST.json`、包内 GraphRAG artifacts、包内 producer evidence
和必要本地投影，稳定判定 query-ready。复审未读取 provider request、
provider response、secrets、logs payload 或 recovery payload。

## reused_fixed_baseline

复用的固定 baseline 为：
`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-09-graphrag-query/baseline.yaml`

baseline SHA-256:
`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`

固定 10 维如下，未新增、删除、重命名维度，未改变 passCriteria：

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
| R2 baseline 文件存在 | 通过 |
| R2 baseline 是否复用既有文件 | 通过，未覆盖 `baseline.yaml` |
| R1/R2 baseline 内容一致性 | 通过，SHA-256 相同且 `cmp` 结果一致 |
| baseline 维度数量 | 通过，仍为 10 个 |
| baseline 维度 id 与顺序 | 通过，与固定 baseline 一致 |
| passCriteria 是否变更 | 通过，未变更 |
| 本轮写入文件 | 仅写入 `report.md` |
| provider payload/secrets 读取边界 | 通过，未读取 |

## findings

### 1. `direct_query_entrypoint`

结论：通过。

修订版定义了 `graphragReadyGate.queryEntrypoint.commandContract`：
查询命令可 target `bookId`，通过已提交 mount projection 解析当前
`packageGeneration` 的 `graphrag/output`，并在查询前验证 `query_ready`
状态，拒绝 stale 或 cross-book artifacts。`mountScanTransactionModel`
同时规定查询和列表命令读取 last committed generation pointer，避免读取
部分提交投影。

该设计满足“挂载扫描完成后可直接查询”的入口边界。需要注意的是，入口仍经由
committed mount projection 解析 `bookId`；baseline 禁止依赖全局 catalog 作为
权威状态，而修订版已将 catalog 定义为派生投影，因此该用法不构成失败。

### 2. `artifact_minimum_closure`

结论：部分通过。

修订版新增 `graphragReadyGate.minimumArtifactClosure`，列出
`qmd_output_manifest.json`、text-unit identity、context、stats、documents、
text units、entities、relationships、communities、community reports 和
`lancedb`。`bookManifestSchema.files` 要求每个文件记录 `path`、`role`、
`bytes`、`sha256`、`required`、`producerRunId` 与 `sensitivity`，并要求
GraphRAG stage outputs 绑定 producer run。

剩余缺口是最低闭包清单本身没有逐项声明每个 artifact 的 role、schema
version、required 标记和目录型 `lancedb` 的校验粒度。相关字段可由 `files`
section 表达，但 Type DD 尚未要求 `minimumArtifactClosure` 与 `files`
条目逐项一一对应并显式携带 schema version。因此该维度从 R1 的不足状态
提升为部分通过，但尚未完全满足 baseline 的“明确列出”要求。

### 3. `artifact_gate_state_machine`

结论：通过。

修订版补充了多层 gate：`atomicPackageLifecycle` 覆盖 staged import、
direct copy、publish markers、checksum sidecars、incomplete copy 和
quarantine；`readinessGates.packageStates` 区分 mounted 与 query-ready；
`graphragReadyGate.states` 明确 artifact missing、checksum failed、
lineage missing、schema incompatible、dimension incompatible、
graph projection ready 和 query ready。`mountLifecycle.conflictHandling`
规定缺失文件、hash mismatch 和 schema incompatibility 的结果，
`queryEntrypoint.failureMode` 明确 gate failure 返回稳定诊断且不触发
provider calls。

baseline 要求的 copied、candidate、validated、mounted、query-ready、
visible_not_query_ready 和 quarantined 未以完全同名状态单列，但等价状态和
转移条件已分布在 atomic lifecycle、mount scan transaction、mount lifecycle
和 readiness gates 中，足以指导实现 artifact gate。

### 4. `producer_lineage_completeness`

结论：部分通过。

修订版新增 `producerLineageSchema.requiredFields`，覆盖 `producerRunId`、
`stage`、`parentProducerRunIds`、`inputArtifactHashes`、
`outputArtifactHashes`、`modelProfile`、`embeddingProfile`、`toolVersion`
和 `completedAt`，并规定 stage order 为 `graph_extract`、
`community_report`、`embed`、`query_ready`。`bindingRule` 还规定缺失任一侧
必须 fail gate。

剩余缺口是 baseline 明确要求每个查询必需 artifact 可追溯到 schema version
和上游 artifact hash。修订版通过 `parentProducerRunIds`、
`inputArtifactHashes` 和 `compatibilityInputs` 可推导上游关系与 schema
兼容，但 `producerLineageSchema.requiredFields` 未直接列出 `schemaVersion`
或 `upstreamArtifactHashes`。因此该维度仍保留部分通过。

### 5. `lineage_artifact_binding`

结论：通过。

修订版在 `bookManifestSchema.graphrag` 中要求 `producerRunIds`，在
`bookManifestSchema.files` 中要求 `producerRunId`，并在
`graphragReadyGate.bindingRule` 中定义双向绑定：每个 required GraphRAG
artifact 必须列入 files 且绑定 producer run output hash；每个 producer run
output hash 必须解析到 package file entry；任一方向缺失均 fail gate。

该设计可识别孤立残留 artifact、被替换文件和 producer evidence 与文件闭包
不一致的问题，满足本维度。

### 6. `schema_runtime_compatibility`

结论：部分通过。

修订版将 query gate 兼容输入扩展为 `graphRagArtifactSchema`、
`parquetSchemaDigest`、`lancedbSchemaDigest`、`embeddingModel`、
`embeddingDimension` 和 `graphProjectionVersion`，并在 gate state 中区分
`schema_incompatible` 与 `dimension_incompatible`。版本迁移模型也把
`packageSchemaVersion`、`layoutVersion`、`qmdIndexSchema`、
`graphRagArtifactSchema`、`parquetSchemaDigest`、`lancedbSchemaDigest`
和 `producerLineageSchema` 纳入 compatibility matrix。

剩余缺口是 baseline 要求区分 GraphRAG runtime、output manifest schema 和
package layout schema。修订版具备相关概念，但 `graphragReadyGate` 的
`compatibilityInputs` 未显式列入 GraphRAG runtime、output manifest schema
和 package layout schema，仍需在 query gate 输入中闭合。

### 7. `query_scope_isolation`

结论：通过。

修订版将 package root 限定为 `graph_vault/books/{bookId}`，要求 files 使用
package-relative paths，并拒绝 absolute paths、parent traversal、symlink
escape 和 hardlink outside package。`queryEntrypoint` 要求通过当前
`packageGeneration` 定位 `graphrag/output`，并拒绝 stale 或 cross-book
artifacts。`staleProjectionInvalidation` 规定 package generation、manifest
hash、checksum、schema 和 lineage 变化会在同一 projection commit 中移除
query-ready capability。

这些规则共同限制查询只能读取该书包声明的 GraphRAG output、producer
evidence 和必要投影，满足单书查询范围隔离要求。

### 8. `privacy_payload_exclusion`

结论：通过。

修订版在 scope 中排除 provider 请求、响应、密钥和日志 payload；在 manifest
exclusions 与 export denied patterns 中排除 provider requests、provider
responses、logs、recovery payload 和 secret-like paths；在 producer evidence
redaction 中仅允许脱敏字段和 fingerprint，禁止 prompts、raw responses、
provider headers、request bodies、response bodies、environment 和 absolute
paths。`queryEntrypoint.failureMode` 还规定 gate failures 不触发 provider
calls，除非显式 rebuild command 被请求。

该设计满足 artifact gate 和 lineage 验证不得读取、要求或分发 provider
payload/secrets 的要求。

### 9. `recovery_diagnostics`

结论：通过。

修订版对失败路径给出稳定处理：缺失 manifest、缺失 publish marker、
缺失 required file、checksum mismatch、path traversal、symlink escape 和
corrupt sidecar 均有 fail-closed policy；mount scan failure 不破坏其他有效包
投影；last-good projection 在失败扫描中保留；deletion、replacement 和 stale
projection cleanup 通过 transaction commit 处理。GraphRAG gate failure
返回稳定诊断且不触发 provider calls，schema incompatibility 可保持
`visible_not_query_ready`。

该设计覆盖 artifact 缺失、hash 不匹配、lineage 断裂、schema 不兼容和
producer evidence 缺失的诊断、quarantine 或 not-query-ready 行为，以及
catalog projection 回滚规则。

### 10. `executable_contract_tests`

结论：部分通过。

修订版 `implementationPlan.testContracts` 已包含 provider payload 排除、
atomic projection、qmd freshness invalidation、GraphRAG query-ready 需要
minimum artifact closure 与 artifact-lineage binding 等测试契约。
`largeLibraryTests` 还覆盖 concurrent query 只能看到 old 或 new generation。

剩余缺口是 baseline 要求实现者能直接编写挂载后 GraphRAG 直接查询、artifact
缺失、artifact 替换、lineage 缺失、schema 不兼容、跨书污染和 provider
payload 不读取的自动化测试。修订版仍以概括性测试条款为主，没有逐条列出
这些 GraphRAG query gate 负例，因此该维度为部分通过。

## pass_fail

总体结论：部分通过。

修订后的 Type DD 已经实质修复 R1 的主要设计缺口：直接查询入口、artifact
gate、lineage 与 artifact 双向绑定、provider payload 排除、失败诊断和单书
隔离均已形成可实施 contract。仍未完全通过的原因是最低 artifact 闭包的逐项
metadata 要求、producer lineage schema 中的 schema/upstream 字段、query gate
兼容输入和专项自动化测试清单还不够显式。

| baseline id | R2 判定 | 摘要 |
| --- | --- | --- |
| `direct_query_entrypoint` | 通过 | 已定义 bookId 查询入口、当前 generation 定位和 gate failure 行为。 |
| `artifact_minimum_closure` | 部分通过 | 已列最低文件集合，但未逐项绑定 role、schema version、required 和目录校验粒度。 |
| `artifact_gate_state_machine` | 通过 | lifecycle、mount transaction 和 GraphRAG gate 已覆盖状态、失败关闭和禁止查询。 |
| `producer_lineage_completeness` | 部分通过 | 已定义 producer fields 和 stage order，但 schema/upstream 字段仍需显式化。 |
| `lineage_artifact_binding` | 通过 | 已定义 files、producerRunIds、runs output hash 的双向绑定。 |
| `schema_runtime_compatibility` | 部分通过 | 已覆盖 parquet、LanceDB、embedding 等，但 query gate 输入仍缺 runtime、output manifest 和 layout。 |
| `query_scope_isolation` | 通过 | 已限制 package-relative paths、current generation 和 cross-book artifact 拒绝。 |
| `privacy_payload_exclusion` | 通过 | 已通过 exclusions、redaction、forbidden fields 和 no provider calls 约束闭合。 |
| `recovery_diagnostics` | 通过 | 已定义 stable diagnostics、quarantine、not-query-ready 和 last-good rollback。 |
| `executable_contract_tests` | 部分通过 | 有测试方向，但缺少本场景负例测试逐项清单。 |

## criteria_delta_from_r1

baseline criteria delta：无。

R2 复审复用的 `baseline.yaml` 与 R1 固定 baseline 内容一致，SHA-256 均为
`10c3e3d217ea17e6f2ec875b701b441bccceff2bda3e26138413534aa732c419`。
未新增、删除、重命名维度，未改变 passCriteria。

Type DD 相对 R1 的设计变化如下：

| baseline id | R1 判定 | R2 判定 | delta |
| --- | --- | --- | --- |
| `direct_query_entrypoint` | 未通过 | 通过 | 新增 query entrypoint contract 和 current generation 定位。 |
| `artifact_minimum_closure` | 部分通过 | 部分通过 | 新增最低 artifact 文件集合，但逐项 metadata 仍不足。 |
| `artifact_gate_state_machine` | 部分通过 | 通过 | 新增 GraphRAG gate states、failure mode 和 stale invalidation。 |
| `producer_lineage_completeness` | 部分通过 | 部分通过 | 新增 lineage schema 与 stage order，但 schema/upstream 字段仍不显式。 |
| `lineage_artifact_binding` | 未通过 | 通过 | 新增 required artifact、files 和 producer output hash 双向绑定。 |
| `schema_runtime_compatibility` | 部分通过 | 部分通过 | 新增 parquet、LanceDB、embedding 维度，但 runtime/layout 等仍需进入 gate。 |
| `query_scope_isolation` | 部分通过 | 通过 | 新增 stale/cross-book artifact 拒绝和 package generation 约束。 |
| `privacy_payload_exclusion` | 通过 | 通过 | 保持通过，并新增 producer evidence redaction 细节。 |
| `recovery_diagnostics` | 部分通过 | 通过 | 新增 gate failure、last-good projection 和 rollback 规则。 |
| `executable_contract_tests` | 部分通过 | 部分通过 | 新增 GraphRAG query-ready 总测试条款，但专项负例仍不完整。 |

## required_design_changes

1. 在 `minimumArtifactClosure` 中为每个 GraphRAG query 必需 artifact 明确
   `role`、`schemaVersion`、`bytes`、`sha256`、`required`、`producerRunId`
   和目录型 artifact 的 manifest/checksum 策略。

2. 在 `producerLineageSchema.requiredFields` 中显式加入 `schemaVersion`、
   `upstreamArtifactHashes` 或等价字段，避免仅通过 parent run 和 input hash
   间接推导上游 artifact。

3. 将 GraphRAG query gate 的 `compatibilityInputs` 补齐为完整兼容矩阵：
   GraphRAG runtime、parquet schema、LanceDB schema、embedding model、
   embedding dimension、output manifest schema、package layout schema 和
   producer lineage schema。

4. 将专项测试契约展开为逐条自动化测试：挂载后直接 GraphRAG 查询成功、
   必需 artifact 缺失、artifact 替换但文件名不变、producer evidence 缺失、
   lineage/hash mismatch、schema/runtime/dimension 不兼容、跨书污染拒绝、
   provider payload 不读取。

5. 明确 manifest 中 `graphrag.queryReady` 是导出方声明还是接收方重算结果。
   接收方有效状态应由 mount scanner/readiness gate 重新计算，并写入本地投影
   或诊断记录。

## residual_risks

- GraphRAG runtime 与 parquet/LanceDB 依赖升级后，兼容性可能出现行为漂移；
  需要实现层维护 migration、rebuild 或 visible-not-query-ready 路径。
- `lancedb` 作为目录型 artifact 的完整性校验粒度尚未细化，后续实现需避免
  只校验目录存在而遗漏 segment/table 文件替换。
- Producer evidence 使用脱敏 metadata 和 fingerprints 后，仍需保证 fingerprint
  稳定、可比较且不会反向泄露 provider payload。
- 历史包迁移可能因严格 lineage gate 而大量进入 repair 或 quarantine；用户侧
  需要清楚区分“可挂载但不可查询”和“必须重建 GraphRAG”。
- 当前测试条款仍偏设计级，若实现阶段未展开为负例 fixture，artifact gate 的
  防替换、防串书和不读 provider payload 约束可能回归。
