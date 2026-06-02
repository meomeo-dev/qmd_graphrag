# agent-08-qmd-index R5 固定基准复审报告

## scenario

书包 qmd 索引缺失或过期，需要挂载后重建或投影。

审计对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

审计边界：仅评估上述设计文档是否满足固定 baseline 的 10 个
`passCriteria`。未评估实现代码，未读取 provider payload、secrets、`.env`、
凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

本轮复用固定基准：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-08-qmd-index/baseline.yaml`

`reused_fixed_baseline`: true

固定 10 个审计维度如下，顺序、id、name 与 `passCriteria` 均保持不变。

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
| R5 baseline 文件存在 | 通过 |
| R5 baseline 是否复用固定基准 | 通过 |
| R5/R4 agent baseline 文件比较 | 通过，内容一致 |
| baseline SHA-256 | `3bb68306a780308d10ed00df6e3bc7921eb32277bc1f3bbe908649b95bc1de76` |
| 维度数量 | 通过，仍为 10 个 |
| 维度 id 顺序 | 通过，未新增、删除、重命名或重排 |
| passCriteria | 通过，未改变 |
| baseline.yaml 覆盖状态 | 通过，本轮未修改 `baseline.yaml` |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets、`.env`、凭据、日志 payload 或私有运行数据 |

## findings

### qmd_index_presence_policy

结论：部分通过。

主文档已区分 package-bundled book-scoped qmd index、缺失索引、本地重建
projection 和全局 qmd projection。`qmdReadyGate.states` 定义了
`included_index_valid`、`reindex_required`、`reindex_pending`、`reindexing`、
`projection_ready`、`projection_failed`、`schema_incompatible`。R3 补充文档的
`qmdAvailabilityAndReexportPolicy.availabilityMatrix` 进一步规定了主要 qmd
状态的 `qmdQueryAllowed`、`rebuildAllowed` 和 export 行为。

固定判据仍未完全满足。设计没有把以下状态逐项映射到 mount allowed、book
visible、GraphRAG-only query allowed、qmd retrieval allowed 和 unavailable
reason：缺失 index 且未声明 `reindex_on_mount`、携带过期包内 index、旧全局
projection stale。当前文档可推断这些状态不得 qmd 检索，但缺少机器可检验的
完整状态矩阵。

### qmd_index_freshness_contract

结论：通过。

主文档 `readinessGates.qmdReadyGate.freshnessInputs` 覆盖 `bookId`、
`sourceHash`、`normalizedHash`、qmd build manifest path、index schema、tool
version、embedding profile、chunking config hash 和 required artifacts。
`qmdRebuildTransaction.freshnessDigest.fields` 进一步包含
`qmdBuildManifestSha256`、`qmdToolVersion`、`qmdIndexSchema`、
`sqliteSchemaDigest`、`metadataSchemaDigest`、`buildConfigSha256` 和 `createdAt`。

`validIndexRule` 要求 freshness input 与 manifest、index metadata 全部匹配；
metadata 缺失必须 reindex。`artifactSchemaConversionMatrix` 对
`qmd_book_index` 采用 `preserve_if_fresh_else_rebuild_outside_package`。过期索引
不得作为当前 projection 使用，满足固定判据。

### rebuild_inputs_closure

结论：通过。

主文档要求缺失 book-scoped qmd index 时 manifest 声明 `reindex_on_mount` 并列出
重建 projection 所需 normalized input 文件。`qmdRebuildTransaction` 要求
rebuild input closure 包含 canonical normalized markdown、
`qmd/qmd_build_manifest.json`、qmd build manifest 所需 metadata、qmd config
snapshot 和 package `BOOK_MANIFEST.json`，并绑定 `normalizedHash`、
`qmdBuildManifestSha256`、`qmdConfigSha256`、`metadataSchemaDigest`。

结合 `bookManifestSchema.files` 的 package-relative path、sha256、required、
sensitivity 约束，以及 R3 `scannerNoReadContracts`，接收方不需要 provider
payload、secrets、原始 batch catalog 或外部 source root 即可执行或判定 qmd
index 重建。

### rebuild_output_location

结论：通过。

主文档明确 readonly package 的 mount-time qmd rebuild 写入包外本地 projection：
`graph_vault/catalog/qmd-book-projections/{bookId}`。`qmdRebuildTransaction` 定义
staging root、live root、SQLite、checksum sidecar、projection manifest 和
`REBUILD_READY.json`。

R3 补充文档补齐再次导出（re-export）语义：默认 export 只导出原 package
closure，不包含本地 projection；显式 repack 会创建新的 `packageGeneration`，
把 projection 放入 `qmd/index`，重新计算 `freshnessDigest`，并通过 staging、
manifest 和 sidecars 发布。该设计与 readonly package mode、checksum closure 和
再次导出规则一致。

### projection_atomicity

结论：通过。

主文档 `mountScanTransactionModel.atomicProjectionCommit` 要求 derived catalog 与
qmd projection 写入 staging root，checksum、fsync 后原子替换，并最后更新
current-generation pointer。读路径只读取 last committed generation。

`qmdRebuildTransaction.protocol` 要求获取 per-book qmd rebuild lease，将 SQLite
和 projection manifest 写入 staging root，fsync SQLite、sidecars、staging root
和 parent directory，原子 rename 到 live root generation，再更新
`qmdReadyState`。失败不会暴露 partial SQLite、partial global projection 或 stale
qmd-ready/query-ready 状态。

### qmd_query_readiness_gate

结论：通过。

主文档明确 mounted、qmd-ready、GraphRAG-ready 和 query-ready 是不同状态。
`qmdReadyRule` 要求 qmd-only queries 只能在 `projection_ready` 或
`included_index_valid` 时执行；当查询路径不需要 qmd index lookup 时，书包可在
qmd projection rebuilding 期间保持 GraphRAG-ready。

`graphragReadyGate.queryEntrypoint` 要求查询通过 committed mount projection 解析
`bookId`，定位当前 `packageGeneration` 的 `graphrag/output`，验证 query-ready
state，并拒绝 stale 或 cross-book artifacts。R3 availability matrix 明确 qmd
检索允许状态，满足固定门禁要求。

### stale_projection_invalidation

结论：通过。

主文档 `staleProjectionInvalidation.triggers` 覆盖 `packageGeneration`、
`manifestSha256`、checksum validation、schema compatibility、package root
deletion、qmd freshness input 和 GraphRAG lineage binding 变化。规则要求在观察到
stale condition 的同一 projection commit 中移除 query-ready capability。

`mountScanTransactionModel.deletionAndReplacement` 定义删除、替换、失败替换和
stale projection cleanup。`qmdReadyGate.freshnessInputs` 包含 `sourceHash` 与
`normalizedHash`，因此 source/normalized hash 变化进入 qmd freshness 失效路径。
该维满足删除、替换、hash 变化、schema 变化和 checksum mismatch 后旧 projection
失效的要求。

### concurrency_and_idempotency

结论：部分通过。

R3 补充文档的 `qmdIdempotencyKey.fields` 已包含 `bookId`、`packageGeneration`、
`freshnessDigest`、`qmdBuildManifestSha256`、`qmdConfigSha256`、
`metadataSchemaDigest` 和 `sqliteSchemaDigest`。主文档定义了 per-book qmd
rebuild lease、same idempotency key coalescing、stale package generation
cancellation、transient IO retry、stale lease takeover 和 staging cleanup。

固定判据仍未完全满足。主文档 `qmdReadyGate.rebuildPolicy.idempotencyKey` 仍保留
较窄的 `{bookId}:{normalizedHash}:{qmd.indexSchema}:{qmd.toolVersion}`，与 R3
补充文档的扩展 idempotency key 并存，未声明 canonical key、override rule 或
冲突解析。主文档的通用 `lockCompatibilityMatrix` 也未把 importer、mount
scanner、runner、explicit rebuild command 和 per-book qmd rebuild lease 的触发、
锁边界、任务合并、中断后重试落入同一张机器可检验矩阵。

### diagnostics_without_payloads

结论：部分通过。

R3 补充文档 `qmdDiagnosticsSchema` 要求 qmd diagnostics 包含 `diagnosticId`、
`bookId`、`packageGeneration`、`qmdState`、`errorCode`、`severity`、
`packageRelativePath`、`freshnessDigest`、`rebuildId`、`retryable`、`repairHint`
和 `createdAt`。稳定错误码覆盖 index missing、schema incompatible、freshness
digest mismatch、rebuild input missing、IO failure、schema failure、SQLite
replace failure、projection commit failure、repack required 和 readonly write
denied。主文档与 R3 补充文档均禁止 provider payload、credentials、raw logs 和
绝对路径进入诊断。

固定判据仍未完全满足。诊断 schema 只有 `freshnessDigest`，没有 required
`digestKind`、`expectedDigest`、`observedDigest`、`digestDiff` 或等价字段。
对于 checksum mismatch、freshness mismatch、schema mismatch 等错误，单个 digest
不能稳定表达“预期值与观测值”的差异。

### qmd_index_test_matrix

结论：部分通过。

主文档与 R3 补充文档已覆盖多项关键测试合同：缺失 book-scoped qmd index 且声明
`reindex_on_mount` 时可 mount-time reindex；qmd freshness changes 在同一
projection generation 中使 qmd-ready 失效；catalog 与 qmd projection commit 只
暴露旧 generation 或新 generation；删除书包后移除 projection；qmd rebuild
transaction 通过 staging 发布 rebuilt SQLite 且不暴露 partial qmd-ready；
readonly package 默认导出排除本地 projection；显式 repack 创建新 generation。

固定测试矩阵仍未逐项闭合。缺少明确用例：缺失 index 且未声明
`reindex_on_mount`、normalized input 变化、`qmdIndexSchema` 不兼容的 qmd-ready
禁用断言、projection 原子替换失败注入、readonly 包重建写入包外位置断言、并发
reindex coalescing、中断后 retry，以及 qmd 诊断无 payload 且包含 digest 差异字段
的断言。

## pass_fail

总体判定：fail。

设计文档满足 6 个维度，部分满足 4 个维度。由于固定 baseline 要求 10 个
`passCriteria` 全部满足，部分满足维度按未通过处理。

| baseline id | R5 result | 判定摘要 |
| --- | --- | --- |
| qmd_index_presence_policy | partial | 状态已拆分，但缺完整 mount/visibility/query/retrieval 状态矩阵。 |
| qmd_index_freshness_contract | pass | freshness digest 覆盖 normalized input、build manifest、schema、tool、config 和 build marker。 |
| rebuild_inputs_closure | pass | 重建闭包包含 normalized input、build manifest、config、metadata、manifest 和 required hashes。 |
| rebuild_output_location | pass | readonly 重建写入包外 projection，默认导出排除本地 projection，repack 语义闭合。 |
| projection_atomicity | pass | 全局 projection 与 per-book rebuilt SQLite 均有 staging、fsync、atomic rename 和 last-good 规则。 |
| qmd_query_readiness_gate | pass | qmd-only query、GraphRAG-ready、book visibility 与 query-ready 门禁关系清楚。 |
| stale_projection_invalidation | pass | 删除、替换、checksum、schema、hash 和 freshness 变化会失效旧 projection。 |
| concurrency_and_idempotency | partial | 有 lease、coalesce、retry，但主文档与 R3 幂等键并存且缺 canonical 规则。 |
| diagnostics_without_payloads | partial | 字段和敏感边界已定义，但缺 digest 差异 required fields。 |
| qmd_index_test_matrix | partial | 主路径测试已有，负面、readonly、并发、失败注入和诊断字段测试不足。 |

## criteria_delta_from_previous_run

previous run 采用同一 agent 的最近一轮公开复审：
`run-20260602-r4-after-r3-fixups/agent-08-qmd-index/report.md`。

基准判据变化：无。R5 baseline 与 R4 baseline SHA-256 相同，10 个 dimension
id、name、顺序和 `passCriteria` 均未改变。

评估结果变化：无实质变化。R5 继续把 R3 补充文档作为规范性补充一并评估；
当前文档仍保持 6 pass、4 partial、总体 fail。

| baseline id | R4 result | R5 result | delta |
| --- | --- | --- | --- |
| qmd_index_presence_policy | partial | partial | 无变化，仍缺完整状态矩阵。 |
| qmd_index_freshness_contract | pass | pass | 无变化。 |
| rebuild_inputs_closure | pass | pass | 无变化。 |
| rebuild_output_location | pass | pass | 无变化。 |
| projection_atomicity | pass | pass | 无变化。 |
| qmd_query_readiness_gate | pass | pass | 无变化。 |
| stale_projection_invalidation | pass | pass | 无变化。 |
| concurrency_and_idempotency | partial | partial | 无变化，仍需 canonical idempotency key 与锁矩阵。 |
| diagnostics_without_payloads | partial | partial | 无变化，仍缺 digest diff required fields。 |
| qmd_index_test_matrix | partial | partial | 无变化，仍缺固定矩阵逐项测试。 |

## required_design_changes

1. 在 `readinessGates.qmdReadyGate` 或 R3 qmd availability policy 中增加机器可读
   状态矩阵。矩阵必须覆盖 bundled valid、missing with `reindex_on_mount`、
   missing without `reindex_on_mount`、stale bundled index、schema incompatible、
   local projection valid、global projection stale，并为每项定义 mount、visibility、
   GraphRAG-only query、qmd retrieval、diagnostic reason。

2. 统一 qmd reindex 的 canonical idempotency key。主文档较窄的 key 必须被替换，
   或明确由 R3 扩展 key 覆盖；最终 key 至少应绑定 `bookId`、`packageGeneration`、
   `freshnessDigest`、qmd build manifest digest、qmd config digest、metadata schema
   digest 和 SQLite schema digest。

3. 增加 qmd reindex 并发矩阵。矩阵必须覆盖 mount scanner、importer、runner、
   explicit rebuild command 同时触发时的锁边界、幂等任务合并、中断后 retry、
   stale generation cancellation 和最终 projection ownership。

4. 扩展 `qmdDiagnosticsSchema.requiredFields`，加入 digest 差异字段，例如
   `digestKind`、`expectedDigest`、`observedDigest`、`digestDiff`。字段必须继续保持
   package-relative、bounded、no payload、no private absolute path。

5. 将固定 baseline 的 qmd index 测试矩阵逐项落入 `testContracts` 或专门测试契约：
   缺失 index、声明与未声明 `reindex_on_mount`、normalized input 变化、
   `qmdIndexSchema` 不兼容、重建失败、projection 原子替换、删除书包后失效、
   readonly 包重建、并发 reindex、诊断无 payload 与 digest diff。

## residual_risks

- 若状态矩阵继续只通过文字规则表达，query gate 可能在缺失 index、过期 index 或
  stale global projection 场景下出现实现分歧。
- 若 canonical idempotency key 不统一，不同触发者可能错误合并或重复执行 qmd
  rebuild，导致最终 projection ownership 不确定。
- 若诊断缺少 expected/observed digest 差异，运维只能看到 freshness mismatch，
  但无法稳定定位 normalized input、schema、config 或 checksum 的具体偏差。
- 若测试矩阵不补齐失败注入、并发和 readonly 写入位置断言，设计中的原子性与
  no-payload 约束可能无法在实现阶段被回归保护。
