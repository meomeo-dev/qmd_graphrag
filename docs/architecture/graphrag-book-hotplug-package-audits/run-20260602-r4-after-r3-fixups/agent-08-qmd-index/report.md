# agent-08-qmd-index R4 复审报告

## scenario

书包 qmd 索引缺失或过期，需要挂载后重建或投影。

复审对象：

- 主文档：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 规范性补充文档：
  `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

复审边界：只检查 Type DD、R3 fixups、固定 baseline 和上一轮同场景审计
结论。不读取 provider payload、provider secrets、请求/响应载荷、日志
payload、`.env` 或私人运行根。

## reused_fixed_baseline

本次 R4 复审复用本目录既有固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-08-qmd-index/baseline.yaml`

`reused_fixed_baseline`: true

固定 10 维如下。未新增、删除、重命名、重排任何维度，未改变任何
`passCriteria`。

| 序号 | id | name |
| --- | --- | --- |
| 1 | qmd_index_presence_policy | qmd 索引存在性策略 |
| 2 | qmd_index_freshness_contract | qmd 索引新鲜度契约 |
| 3 | rebuild_inputs_closure | 重建输入闭包 |
| 4 | rebuild_output_location | 重建输出位置 |
| 5 | projection_atomicity | 投影原子性 |
| 6 | qmd_query_readiness_gate | qmd 查询就绪门禁 |
| 7 | stale_projection_invalidation | 旧投影失效规则 |
| 8 | concurrency_and_idempotency | 并发与幂等 |
| 9 | diagnostics_without_payloads | 无 payload 诊断 |
| 10 | qmd_index_test_matrix | qmd 索引测试矩阵 |

## baseline_integrity_check

| 检查项 | 结果 |
| --- | --- |
| R4 baseline 是否存在 | 通过 |
| R4 baseline 是否复用既有固定基线 | 通过 |
| R4/R3 agent baseline 文件比较 | 通过，内容一致 |
| baseline SHA-256 | `3bb68306a780308d10ed00df6e3bc7921eb32277bc1f3bbe908649b95bc1de76` |
| 维度数量 | 通过，仍为 10 个 |
| 维度 id 顺序 | 通过，未新增、删除、重命名或重排 |
| passCriteria | 通过，未改变 |
| baseline.yaml 覆盖状态 | 通过，本轮未覆盖 `baseline.yaml` |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets 或日志载荷 |

## findings

### qmd_index_presence_policy

结论：部分通过。

主文档已区分 package-bundled book-scoped qmd index、本地重建 projection、
全局 catalog/qmd projection，以及 `included_index_valid`、`reindex_required`、
`reindexing`、`projection_ready`、`projection_failed`、
`schema_incompatible` 等 qmd 状态。R3 fixups 新增
`qmdAvailabilityAndReexportPolicy.availabilityMatrix`，对
`included_index_valid`、`reindex_required`、`reindexing`、
`projection_ready`、`projection_failed`、`schema_incompatible` 规定了
`qmdQueryAllowed`、`rebuildAllowed` 和导出行为。

仍未完全满足固定判据。矩阵没有把“缺失 index 且未声明
`reindex_on_mount`”、“携带过期包内 index”、“旧全局 projection stale”等
原因态逐项映射到 mount allowed、book visible、GraphRAG-only query allowed
和 qmd retrieval allowed。主文档要求缺失 index 时 manifest 必须声明
`reindex_on_mount`，但未声明时的可见性和检索禁用状态仍需要在状态矩阵中
成为机器可检验规则。

### qmd_index_freshness_contract

结论：通过。

主文档 `readinessGates.qmdReadyGate.freshnessInputs` 定义了
`identity.bookId`、`identity.sourceHash`、`input.normalizedHash`、
`qmd.buildManifestPath`、`qmd.indexSchema`、`qmd.toolVersion`、
`qmd.embeddingProfile`、`qmd.chunkingConfigHash` 和
`qmd.requiredArtifacts`。`qmdRebuildTransaction.freshnessDigest` 进一步
包含 `qmdBuildManifestSha256`、`sqliteSchemaDigest`、
`metadataSchemaDigest`、`buildConfigSha256` 和 `createdAt`。

`artifactSchemaConversionMatrix` 要求 `qmd_book_index` 只能
`preserve_if_fresh_else_rebuild_outside_package`。`staleProjectionInvalidation`
把 qmd freshness input 变化列为失效触发条件。过期索引不得作为当前
projection 使用，固定判据已满足。

### rebuild_inputs_closure

结论：通过。

主文档要求缺失 book-scoped qmd index 时 manifest 声明
`reindex_on_mount`，并列出重建 projection 所需 normalized input 文件。
`qmdRebuildTransaction.rebuildInputClosure` 要求携带 canonical normalized
markdown、`qmd/qmd_build_manifest.json`、qmd build manifest 所需 metadata、
qmd config snapshot 和 package `BOOK_MANIFEST.json`，并要求
`normalizedHash`、`qmdBuildManifestSha256`、`qmdConfigSha256` 和
`metadataSchemaDigest`。

结合 `bookManifestSchema.files` 的 package-relative path、sha256、required
和 sensitivity 约束，以及 R3 fixups 的 scanner no-read contracts，接收方
不需要 provider payload、secrets、原始 batch catalog 或外部 source root
即可判断和执行 qmd index 重建。

### rebuild_output_location

结论：通过。

主文档明确 readonly package 的 mount-time qmd rebuild 写入包外本地
projection：`graph_vault/catalog/qmd-book-projections/{bookId}`。
`qmdRebuildTransaction.transactionPaths` 定义 staging root、live root、
SQLite、checksum sidecar、projection manifest 和 `REBUILD_READY.json`。

R3 fixups 补齐再次导出规则。默认 `exportBookDefault` 为
`original_package_closure_only`，即本地 projection 不进入普通导出。
显式 `exportBookWithLocalProjection` 会创建新的 `packageGeneration`，把
projection 纳入 `qmd/index`，重新计算 `freshnessDigest` 并写入 migration
evidence。`repackRule` 要求 staging、重新生成 manifest 和 sidecars，且不得
原地修改 mounted source package。该维已闭合 readonly、checksum 闭包和
再次导出语义。

### projection_atomicity

结论：通过。

主文档 `mountScanTransactionModel.atomicProjectionCommit` 要求把派生 catalog
与 qmd projection 写入 staging root，checksum、fsync 后原子替换，并最后
更新 current-generation pointer。读路径只读取 last committed generation。

`qmdRebuildTransaction.protocol` 要求获取 per-book qmd rebuild lease，将
SQLite 和 projection manifest 写入 staging root，fsync SQLite、sidecars、
staging root 和 parent directory，再 atomic rename 到 live root generation，
随后更新 `qmdReadyState`。失败不会暴露 partial SQLite、partial global
projection 或 stale qmd-ready/query-ready 状态。

### qmd_query_readiness_gate

结论：通过。

主文档明确 mounted、qmd-ready、GraphRAG-ready 和 query-ready 是不同状态。
`qmdReadyRule` 要求 qmd-only queries 只能在 `projection_ready` 或
`included_index_valid` 时执行；当查询路径不需要 qmd index lookup 时，书可以
在 qmd projection rebuilding 期间保持 GraphRAG-ready。

`graphragReadyGate.queryEntrypoint` 要求查询通过 committed mount projection
解析 `bookId`，定位当前 `packageGeneration` 的 `graphrag/output`，验证
query-ready state，并拒绝 stale 或 cross-book artifacts。R3 fixups 的
availability matrix 又明确 qmd 检索允许状态，门禁关系满足固定判据。

### stale_projection_invalidation

结论：通过。

主文档 `staleProjectionInvalidation.triggers` 覆盖
`packageGeneration`、`manifestSha256`、checksum validation、schema
compatibility、package root deletion、qmd freshness input 和 GraphRAG lineage
binding 的变化。规则要求在观察到 stale condition 的同一 projection commit
中移除 query-ready capability。

`mountScanTransactionModel.deletionAndReplacement` 定义删除、替换、失败替换
和 stale projection cleanup。`qmdReadyGate.freshnessInputs` 包含
`sourceHash` 与 `normalizedHash`，因此 source/normalized hash 变化会进入 qmd
freshness 失效路径。该维满足删除、替换、hash 变化、schema 变化和 checksum
mismatch 后旧 projection 失效的要求。

### concurrency_and_idempotency

结论：部分通过。

R3 fixups 修正了 R3 的主要幂等键缺口：
`qmdAvailabilityAndReexportPolicy.qmdIdempotencyKey.fields` 已包含 `bookId`、
`packageGeneration`、`freshnessDigest`、`qmdBuildManifestSha256`、
`qmdConfigSha256`、`metadataSchemaDigest` 和 `sqliteSchemaDigest`。主文档也有
per-book qmd rebuild lease、same-idempotency-key coalescing、stale
package generation cancel、transient IO retry 和 stale lease takeover。

剩余问题是主文档 `qmdReadyGate.rebuildPolicy.idempotencyKey` 仍保留较窄的
`{bookId}:{normalizedHash}:{qmd.indexSchema}:{qmd.toolVersion}`。该键与 R3
fixups 的扩展键并存，未声明哪个是 canonical key 或 override rule。主文档也
没有把 importer、mount scanner、runner、explicit rebuild command 与 per-book
qmd rebuild lease 的触发关系和锁兼容矩阵落成同一张机器可检验表。因此该维比
R3 有实质改善，但仍未完全证明多个触发者并发 reindex 时最终 projection
确定且不会互相覆盖。

### diagnostics_without_payloads

结论：部分通过。

R3 fixups 新增 `qmdDiagnosticsSchema`，要求 qmd diagnostics 包含
`diagnosticId`、`bookId`、`packageGeneration`、`qmdState`、`errorCode`、
`severity`、`packageRelativePath`、`freshnessDigest`、`rebuildId`、
`retryable`、`repairHint` 和 `createdAt`。稳定 error code 覆盖 index missing、
schema incompatible、freshness mismatch、rebuild input missing、rebuild IO
failure、schema failure、SQLite replace failure、projection commit failure、
re-export requires repack 和 readonly write denied。主文档与 R3 fixups 均
禁止 provider payload、credentials、raw logs 和绝对路径进入诊断。

剩余缺口是固定判据要求记录 digest 差异。当前 schema 只有
`freshnessDigest`，没有 required `expectedDigest`、`observedDigest`、
`digestKind` 或等价差异字段。对于 checksum mismatch、freshness mismatch、
schema mismatch 等诊断，单个 digest 字段不足以稳定表达“预期值与观测值”的
差异。因此该维仍为部分通过。

### qmd_index_test_matrix

结论：部分通过。

主文档测试合同已覆盖：缺失 book-scoped qmd index 且声明
`reindex_on_mount` 时可 mount-time reindex；qmd freshness changes 在同一
projection generation 中使 qmd-ready 失效；catalog 与 qmd projection commit
只暴露旧 generation 或新 generation；删除书包后移除 projection；qmd rebuild
transaction 通过 staging 发布 rebuilt SQLite 且不暴露 partial qmd-ready。

R3 fixups 的 `qmdDiagnosticsSchema.tests.requiredCases` 继续补充 included index
valid、reindex required、rebuild success、rebuild IO failure、schema
incompatible、readonly package export default excludes local projection、repack
includes local projection with new generation 和 stale idempotency key
cancelled。

固定测试矩阵仍未完整逐项落地。缺少明确用例：缺失 index 且未声明
`reindex_on_mount`、normalized input 变化的专门断言、`qmdIndexSchema`
不兼容的 qmd-ready 禁用断言、projection 原子替换失败注入、readonly 包重建
写入包外位置断言、并发 reindex coalescing、中断后 retry，以及 qmd 诊断无
payload 且包含 digest 差异字段的断言。

## pass_fail

总体判定：部分通过，未达到完全通过。

R3 fixups 已关闭 R3 的一个关键缺口：本地 qmd projection 的默认导出、显式
repack、checksum 和 `packageGeneration` 语义已经明确，因此
`rebuild_output_location` 从部分通过提升为通过。

仍未完全通过的维度集中在：qmd availability 原因态矩阵不完整、幂等键存在
双定义、qmd 诊断缺 digest 差异字段，以及测试矩阵未覆盖全部固定场景。

| baseline id | R4 result | 判定摘要 |
| --- | --- | --- |
| qmd_index_presence_policy | 部分通过 | 有 qmd 状态与 availability matrix，但缺原因态到 mount/visibility/query/retrieval 的完整矩阵。 |
| qmd_index_freshness_contract | 通过 | freshness digest 与 stale invalidation 已覆盖固定输入。 |
| rebuild_inputs_closure | 通过 | 重建闭包包含 normalized input、build manifest、config、metadata 和 hashes。 |
| rebuild_output_location | 通过 | 输出位置、readonly 语义、默认 export 和显式 repack 已闭合。 |
| projection_atomicity | 通过 | mount scan 与 qmd rebuild 均有 staging、fsync、atomic replacement 和 last-good 规则。 |
| qmd_query_readiness_gate | 通过 | qmd-only query、GraphRAG-ready、catalog projection 和 visibility 关系明确。 |
| stale_projection_invalidation | 通过 | 删除、替换、checksum、schema、source/normalized hash 与 freshness 变化会失效旧 projection。 |
| concurrency_and_idempotency | 部分通过 | 扩展 key 已补充，但主文档仍保留窄 key 且 actor/lock 矩阵不完整。 |
| diagnostics_without_payloads | 部分通过 | qmd 诊断 schema 已有，但缺 expected/observed digest 差异字段。 |
| qmd_index_test_matrix | 部分通过 | 主路径和部分负面测试已有，固定矩阵仍缺若干专门用例。 |

## criteria_delta_from_r3

基线判据变化：无。

R4 复审使用与 R3 完全相同的 10 个 dimension id、name 与 passCriteria。
没有新增、删除、重命名或重排维度，也没有改变 passCriteria。

评估结果相对 R3 的变化如下：

| baseline id | R3 result | R4 result | 变化 |
| --- | --- | --- | --- |
| qmd_index_presence_policy | 部分通过 | 部分通过 | 新增 availability matrix，但仍缺原因态完整矩阵。 |
| qmd_index_freshness_contract | 通过 | 通过 | 无退化，R3 fixups 进一步用于幂等键。 |
| rebuild_inputs_closure | 通过 | 通过 | 无退化。 |
| rebuild_output_location | 部分通过 | 通过 | R3 fixups 补齐默认 export 与显式 repack 规则。 |
| projection_atomicity | 通过 | 通过 | 无退化。 |
| qmd_query_readiness_gate | 通过 | 通过 | 无退化，availability matrix 强化 qmd 检索门禁。 |
| stale_projection_invalidation | 通过 | 通过 | 无退化。 |
| concurrency_and_idempotency | 部分通过 | 部分通过 | 扩展 key 已补齐，但与主文档窄 key 并存。 |
| diagnostics_without_payloads | 部分通过 | 部分通过 | 新增 qmd 诊断 schema，但 digest 差异字段仍不足。 |
| qmd_index_test_matrix | 部分通过 | 部分通过 | 新增 qmd diagnostics/repack 测试，但固定矩阵仍未全覆盖。 |

## required_design_changes

1. 在主文档或 R3 fixups 中增加 canonical qmd availability state matrix。矩阵
   应逐项覆盖 included bundled index、missing index with `reindex_on_mount`、
   missing index without `reindex_on_mount`、stale bundled index、
   schema incompatible、local projection valid、global projection stale、
   projection failed 和 checksum mismatch，并分别声明 mount allowed、book
   visible、GraphRAG-only query allowed、qmd retrieval allowed、repair/rebuild
   action 和 diagnostic code。

2. 统一 qmd rebuild idempotency key。删除或废弃主文档中的窄 key，或明确
   R3 fixups 的 `qmdIdempotencyKey` 为 canonical key，并要求所有 scanner、
   importer、runner 和 explicit rebuild command 使用同一 digest。

3. 补齐 qmd rebuild actor/lock compatibility matrix。至少覆盖 mount scanner、
   importer、runner、explicit rebuild command、catalog commit、qmd projection
   commit 和 query reader；声明 per-book lease 名称、锁边界、fencing token、
   duplicate task merge、中断后 retry 和 stale staging cleanup 条件。

4. 扩展 `qmdDiagnosticsSchema.requiredFields`，为 digest mismatch 类诊断增加
   `digestKind`、`expectedDigest`、`observedDigest` 或等价结构。字段必须保持
   package-relative、bounded、无 provider payload、无 secrets、无绝对路径。

5. 扩展测试合同，逐项覆盖固定 baseline 的全部 qmd index 场景：缺失 index、
   声明和未声明 `reindex_on_mount`、normalized input 变化、`qmdIndexSchema`
   不兼容、重建失败、projection 原子替换失败、删除书包后失效、readonly 包
   重建写入包外、并发 reindex coalescing、中断后 retry，以及无 payload 且含
   digest 差异的诊断断言。

## residual_risks

1. 主文档与 R3 fixups 同时描述 qmd idempotency key，若实现读取较窄的主文档
   key，仍可能把不同 qmd build manifest、config 或 metadata 的重建任务错误
   合并。

2. availability matrix 当前以 qmdState 为中心，不以失效原因态为中心。实现若
   只判断 `reindex_required`，可能无法区分可自动重建、只能可见不可检索、必须
   quarantine 或 schema incompatible 的场景。

3. qmd 诊断若没有 expected/observed digest，会降低 checksum mismatch 和
   freshness mismatch 的可诊断性，修复工具也难以稳定判断应重建、重新导出还是
   quarantine。

4. qmd index 的确定性重建仍可能受 SQLite 版本、tokenizer、locale、排序规则、
   embedding profile 或 qmd tool patch version 影响。Type DD 已定义 digest
   输入，但实现层仍需定义 canonical build 或语义等价校验。

5. 若 qmd rebuild 实际需要外部 provider 或远程模型，离线接收方可能无法完成
   projection。门禁失败不得隐式触发 provider call，应降级为 visible 或
   GraphRAG-only 状态，并给出无 payload 诊断。
