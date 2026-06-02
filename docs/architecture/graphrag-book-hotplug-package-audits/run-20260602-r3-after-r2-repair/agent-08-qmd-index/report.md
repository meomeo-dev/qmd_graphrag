# agent-08-qmd-index R3 复审报告

## scenario

书包 qmd 索引缺失或过期，需要挂载后重建或投影。复审对象为修订后的
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。

本次复审只检查 Type DD、固定审计基线和同场景 R2 报告，不读取 provider payload、
provider secrets、请求/响应载荷、日志 payload、`.env` 或私有运行根。

## reused_fixed_baseline

本次 R3 复审复用本目录既有固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-08-qmd-index/baseline.yaml`

固定 10 维如下，未新增、删除、重命名或重排任何维度，未改变任何
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
| R3 baseline 是否存在 | 通过 |
| R3 baseline 是否复用既有固定基线 | 通过 |
| R3/R2 baseline 文件比较 | 通过，内容一致 |
| baseline SHA-256 | `3bb68306a780308d10ed00df6e3bc7921eb32277bc1f3bbe908649b95bc1de76` |
| 维度数量 | 通过，仍为 10 个 |
| 维度 id 顺序 | 通过，未新增、删除、重命名或重排 |
| passCriteria | 通过，未改变 |
| baseline.yaml 覆盖状态 | 通过，本轮未覆盖 `baseline.yaml` |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets 或日志载荷 |

## findings

### qmd_index_presence_policy

结论：部分通过。

Type DD 已区分包内 book-scoped qmd index、本地 qmd projection、全局 qmd
projection，以及 `included_index_valid`、`reindex_required`、`reindex_pending`、
`reindexing`、`projection_ready`、`projection_failed`、`schema_incompatible` 等
qmd-ready 状态。`externalRuntimeLayout` 和 `qmdRebuildTransaction` 也明确 readonly
包挂载后的本地重建结果位于
`graph_vault/catalog/qmd-book-projections/{bookId}`。

缺口是仍没有固定状态矩阵（state matrix）逐项规定：携带有效 index、缺失 index
且声明 `reindex_on_mount`、缺失 index 且未声明 `reindex_on_mount`、携带过期
index、schema 不兼容、本地 projection 有效、全局 projection 过期时，分别是否
允许 mount、是否可见、是否允许 GraphRAG-only query、是否允许 qmd retrieval。
因此它尚未完全满足“每种状态是否允许挂载、查询或仅可见不可检索”的判据。

### qmd_index_freshness_contract

结论：通过。

R3 新增 `qmdRebuildTransaction.freshnessDigest`，字段包括 `normalizedHash`、
`qmdBuildManifestSha256`、`qmdToolVersion`、`qmdIndexSchema`、
`sqliteSchemaDigest`、`chunkingConfigHash`、`embeddingProfileFingerprint`、
`metadataSchemaDigest`、`buildConfigSha256` 和 `createdAt`。这些字段覆盖
normalized input digest、qmd build manifest digest、qmdIndexSchema、tool version
和 build time 或等价 generation marker。

`artifactSchemaConversionMatrix` 要求 `qmd_book_index` 具备 `freshnessDigest`，
且只能 `preserve_if_fresh_else_rebuild_outside_package`。`staleProjectionInvalidation`
也把 qmd freshness input 变化列为失效触发条件。过期索引不得被继续当作当前
qmd-ready projection 使用，固定判据已满足。

### rebuild_inputs_closure

结论：通过。

R3 新增 `qmdRebuildTransaction.rebuildInputClosure`，要求重建输入包含 canonical
normalized markdown、`qmd/qmd_build_manifest.json`、qmd build manifest 所需
metadata、qmd config snapshot 和 package `BOOK_MANIFEST.json`。对应 hash 包括
`normalizedHash`、`qmdBuildManifestSha256`、`qmdConfigSha256` 和
`metadataSchemaDigest`。

结合 `bookManifestSchema.files` 对 package-relative path、sha256、required 和
sensitivity 的要求，以及 `securityExportPolicy`、`sensitiveMaterialTaxonomy`
禁止 provider payload、secrets、runtime payload 和绝对路径进入包或扫描输入，
接收方无需 provider payload、原始 batch catalog 或外部 source root 即可具备
重建 qmd index 的闭包。实现时仍应把这些字段落入机器可校验 schema，但 Type DD
层面的基线判据已满足。

### rebuild_output_location

结论：部分通过。

Type DD 明确 readonly package 的 qmd rebuild 输出写入包外本地 projection：
`graph_vault/catalog/qmd-book-projections/{bookId}`。`qmdRebuildTransaction` 定义
`stagingRoot`、`liveRoot`、SQLite、checksum sidecar、projection manifest 和
`REBUILD_READY.json`，与 readonly package mode 和 checksum sidecar 闭包基本一致。

剩余缺口是再次导出规则（re-export rule）仍不完整。`externalRuntimeLayout` 说明
这些本地 roots 默认不属于 distributable book package，除非 debug export 生成脱敏
support bundle；但未明确普通 export 或 explicit repack 时，接收方本地重建的
projection 是否永远排除、是否可转化为新的包内 `qmd/index/qmd_book_index.sqlite`，
以及排除时如何在新 `BOOK_MANIFEST.json` 中保持 `reindex_on_mount` 语义。因此该维
仍未完全闭合。

### projection_atomicity

结论：通过。

R3 的 `qmdRebuildTransaction` 补齐 per-book qmd rebuild 原子协议。协议要求获取
per-book qmd rebuild lease，将 SQLite 和 projection manifest 写入 staging root，
fsync SQLite、sidecars、staging root 和 parent directory，随后 atomic rename 到
live root generation，并在 catalog projection generation 中更新 `qmdReadyState`。
提交记录 durable 后才释放 lease。

全局层面，`mountScanTransactionModel.atomicProjectionCommit` 已定义 staging root、
checksum、fsync、atomic replacement、current-generation pointer last update 和
last-good reader view。失败时 query/list 只读最后 committed generation。该设计可
防止 partial SQLite、partial global projection 或 stale qmd-ready/query-ready 状态
被暴露。

### qmd_query_readiness_gate

结论：通过。

Type DD 明确 mounted、qmd-ready、GraphRAG-ready 和 query-ready 是不同状态。
`qmdReadyRule` 要求 qmd-only queries 只能在 `projection_ready` 或
`included_index_valid` 时执行；GraphRAG 查询路径不需要 qmd index lookup 时，才可
在 qmd projection rebuilding 期间保持 GraphRAG-ready。

`graphragReadyGate.queryEntrypoint` 要求查询通过 committed mount projection 解析
bookId、定位当前 `packageGeneration` 的输出、验证 query-ready state，并拒绝 stale
或 cross-book artifacts。该维满足基线门禁要求。

### stale_projection_invalidation

结论：通过。

`staleProjectionInvalidation` 覆盖 `packageGeneration`、`manifestSha256`、checksum
validation、schema compatibility、package root deletion、qmd freshness input 和
GraphRAG lineage binding 的变化。规则要求在观察到 stale condition 的同一
projection commit 中移除 query-ready capability。

`mountScanTransactionModel.deletionAndReplacement` 同时规定 book root 缺失、
same bookId new generation、failed replacement 和 stale projection cleanup 的行为。
这满足删除、替换、source/normalized hash 变化、schema 变化和 checksum mismatch
后的旧 projection 失效要求。

### concurrency_and_idempotency

结论：部分通过。

R3 已新增或强化多项并发约束：`qmdReadyGate.rebuildPolicy` 定义 idempotency key
和同 key 合并；`qmdRebuildTransaction.protocol` 要求 per-book qmd rebuild lease；
`retryPolicy` 定义 same idempotency key coalesce、stale package generation cancel、
transient IO backoff retry 和 schema incompatible 标记；`lockLeaseAndStagingCleanup`
定义 heartbeat、TTL、fencing token、stale takeover 和 staging cleanup。

缺口是 qmd rebuild 的 idempotency key 仍只包含
`{bookId}:{normalizedHash}:{qmd.indexSchema}:{qmd.toolVersion}`，未覆盖
`qmdBuildManifestSha256`、`buildConfigSha256`、`chunkingConfigHash`、
`embeddingProfileFingerprint`、`metadataSchemaDigest` 或 `packageGeneration` 等
freshness digest 输入。不同重建输入可能被错误合并为同一任务。Type DD 也未给出
qmd rebuild lease 的具体锁文件路径，以及 scanner、importer、runner 与 qmd
rebuild lease 的完整兼容矩阵。因此最终 projection 确定性仍有未约束空间。

### diagnostics_without_payloads

结论：部分通过。

Type DD 的隐私边界已经明确：scope 排除 provider 请求、响应、密钥和日志 payload；
`securityExportPolicy` 和 `sensitiveMaterialTaxonomy` 禁止 provider payload、
credentials、runtime payload、绝对路径和 user home path；`qmdRebuildTransaction`
也规定 diagnostics `payloadRule: no_provider_payloads_no_absolute_paths`。

不足是 qmd index 诊断 schema 仍不完整。R3 仅列出
`qmd_rebuild_started`、`qmd_rebuild_cancelled_stale_generation`、
`qmd_rebuild_failed_io`、`qmd_rebuild_failed_schema`、`qmd_rebuild_committed` 等稳定
code，未定义 qmd index missing、stale、checksum mismatch、schema incompatible、
write denied 等诊断的 required fields。固定判据要求 error code、
package-relative path、digest 差异和 recovery hint；这些字段未在 qmd 诊断块中
完整声明。

### qmd_index_test_matrix

结论：部分通过。

R3 的测试合同新增或保留了多项相关用例：缺失 book-scoped qmd index 且声明
`reindex_on_mount` 时可 mount-time reindex；qmd freshness changes 在同一
projection generation 中使 qmd-ready 失效；catalog 与 qmd projection commits 只暴露
旧 generation 或新 generation；删除书包后移除 projection；qmd rebuild transaction
通过 staging 发布 rebuilt SQLite，且不暴露 partial qmd-ready state。

固定测试矩阵仍未完整逐项落地。缺口包括：缺失 index 且未声明
`reindex_on_mount`、normalized input 变化的专门用例、`qmdIndexSchema` 不兼容、
qmd rebuild failure、readonly 包本地 projection 写入断言、per-book SQLite 原子替换
失败注入、并发 reindex coalescing、中断后 retry，以及无 payload 诊断字段断言。

## pass_fail

总体判定：部分通过，未达到完全通过。

R3 相比 R2 已明显补齐 qmd index freshness digest、重建输入闭包和 per-book
atomic rebuild transaction。`qmd_index_freshness_contract`、
`rebuild_inputs_closure`、`projection_atomicity` 已从 R2 的部分通过提升为通过。

仍未完全通过的维度集中在 qmd 状态可用性矩阵、local projection 再次导出语义、
idempotency key 覆盖范围、qmd 诊断 schema 和测试矩阵。

| baseline id | R3 result | 判定摘要 |
| --- | --- | --- |
| qmd_index_presence_policy | 部分通过 | 状态已拆分，但缺 mount/visibility/query/retrieval 固定矩阵。 |
| qmd_index_freshness_contract | 通过 | freshness digest 已包含 build manifest digest、schema、tool、build marker。 |
| rebuild_inputs_closure | 通过 | 重建闭包已包含 normalized input、build manifest、config、metadata 和 hashes。 |
| rebuild_output_location | 部分通过 | 输出位置清楚，但普通 export/repack 语义未闭合。 |
| projection_atomicity | 通过 | per-book qmd rebuild 与全局 projection 原子协议已定义。 |
| qmd_query_readiness_gate | 通过 | qmd-only query 与 GraphRAG-ready 的门禁关系明确。 |
| stale_projection_invalidation | 通过 | 删除、替换、checksum、schema 和 freshness 变化会失效旧 projection。 |
| concurrency_and_idempotency | 部分通过 | 有 lease/retry/coalesce，但 idempotency key 未覆盖完整 freshness digest。 |
| diagnostics_without_payloads | 部分通过 | payload 边界明确，qmd 诊断字段 schema 不完整。 |
| qmd_index_test_matrix | 部分通过 | 主路径测试已有，负面、readonly、并发、失败和诊断矩阵不足。 |

## criteria_delta_from_r2

基线判据变化：无。R3 复审使用与 R2 完全相同的 10 个 dimension id、name 与
passCriteria；没有新增、删除、重命名或重排维度，也没有改变 passCriteria。

评估结果相对 R2 的变化如下：

| baseline id | R2 结果 | R3 结果 | 变化 |
| --- | --- | --- | --- |
| qmd_index_presence_policy | 部分通过 | 部分通过 | 新增 qmd rebuild 细节，但仍缺可用性矩阵。 |
| qmd_index_freshness_contract | 部分通过 | 通过 | 新增完整 freshness digest。 |
| rebuild_inputs_closure | 部分通过 | 通过 | 新增 rebuild input closure 和 required hashes。 |
| rebuild_output_location | 部分通过 | 部分通过 | 输出位置更完整，但 re-export 规则仍未闭合。 |
| projection_atomicity | 部分通过 | 通过 | 新增 per-book qmd rebuild 原子事务。 |
| qmd_query_readiness_gate | 通过 | 通过 | 无实质退化。 |
| stale_projection_invalidation | 通过 | 通过 | 无实质退化。 |
| concurrency_and_idempotency | 部分通过 | 部分通过 | 新增 lease/retry，但幂等键仍不覆盖完整输入。 |
| diagnostics_without_payloads | 部分通过 | 部分通过 | 新增 rebuild codes，但缺 qmd 诊断字段合同。 |
| qmd_index_test_matrix | 部分通过 | 部分通过 | 新增 qmd rebuild transaction 测试，矩阵仍未完整。 |

## required_design_changes

1. 在 `readinessGates.qmdReadyGate` 增加机器可读状态矩阵，逐项定义 bundled valid、
   missing with reindex、missing without reindex、stale bundled index、schema
   incompatible、local projection valid 和 global projection stale 时的 mount、
   visibility、GraphRAG-only query 与 qmd retrieval 行为。

2. 明确本地 qmd projection 的普通 export/repack 规则。若默认排除接收方本地
   projection，导出的 `BOOK_MANIFEST.json` 必须继续保留 `reindex_on_mount` 语义；
   若允许纳入包内 index，必须重新生成 qmd build evidence、checksums、
   `freshnessDigest`、`BOOK_MANIFEST.json` 和 `packageGeneration`。

3. 将 qmd rebuild idempotency key 扩展为完整 freshness digest 或其 digest，包括
   `qmdBuildManifestSha256`、`buildConfigSha256`、`chunkingConfigHash`、
   `embeddingProfileFingerprint`、`metadataSchemaDigest`、`qmdIndexSchema`、
   `qmdToolVersion` 和必要的 generation/fencing 信息。

4. 给出 qmd rebuild lease 的具体锁边界和兼容矩阵，覆盖 mount scanner、importer、
   runner、explicit rebuild command、catalog commit 和 query reader。中断后 retry
   应声明 checkpoint、staging cleanup、stale lock takeover 与最终 commit 条件。

5. 定义 qmd index 诊断 schema。缺失、过期、schema incompatible、checksum
   mismatch、rebuild failed 和 write denied 均应有 stable code、
   package-relative path、expected/observed digest、recovery hint，并禁止 provider
   payload 摘要、绝对路径和未脱敏异常栈。

6. 扩展测试合同，逐项覆盖固定 baseline 要求的全部场景：缺失 index 且声明
   `reindex_on_mount`、缺失 index 且未声明、normalized input 变化、
   `qmdIndexSchema` 不兼容、重建失败、projection 原子替换、删除书包后失效、
   readonly 包重建和并发 reindex。

## residual_risks

1. `qmdReadyGate.freshnessInputs` 与 `qmdRebuildTransaction.freshnessDigest` 目前存在
   两套字段表达。实现若只读取前者，仍可能遗漏 build manifest digest 或 build
   config digest。应在 schema 层统一为同一个 canonical digest contract。

2. qmd index 的确定性重建可能受 SQLite 版本、tokenizer、locale、排序规则或 qmd
   tool patch version 影响。即使 digest 完整，不同平台仍可能生成字节不同但语义等价
   的 index，需要实现层定义 canonical build 或语义校验。

3. 本地 projection 默认不进入分发包有利于 readonly 与隐私边界，但会增加用户对
   “原始包”、“本地可用 projection” 和 “重新打包后可迁移 index” 的理解成本。

4. 若 qmd rebuild 实际依赖 embedding provider 或外部模型，离线接收方可能无法完成
   projection。Type DD 已禁止隐式 provider call；实现必须把失败降级为 visible 或
   GraphRAG-only，而不是自动联网。

5. 全局 qmd projection 聚合多本书时，单本书删除或替换的局部失效必须避免污染其他
   书的 qmd-ready 状态，同时不能留下孤儿 document id、chunk id 或 stale retrieval
   entries。
