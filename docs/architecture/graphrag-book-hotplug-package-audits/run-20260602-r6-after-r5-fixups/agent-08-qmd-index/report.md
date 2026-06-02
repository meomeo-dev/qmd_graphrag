# agent-08-qmd-index R6 固定基准设计审计报告

## scenario

书包 qmd 索引缺失或过期，需要挂载后重建或投影。

审计对象：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

审计边界：仅评估上述设计文档是否满足固定 baseline 的 10 个
`passCriteria`。未评估实现代码，未读取 provider payload、secrets、`.env`、
凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

本轮复用固定基准：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-08-qmd-index/baseline.yaml`

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
| R6 baseline 文件存在 | 通过 |
| baseline SHA-256 | `3bb68306a780308d10ed00df6e3bc7921eb32277bc1f3bbe908649b95bc1de76` |
| 固定维度数量 | 通过，仍为 10 个 |
| 固定维度 id 顺序 | 通过，未新增、删除、重命名或重排 |
| 固定维度 name | 通过，未改变 |
| 固定维度 passCriteria | 通过，未改变 |
| baseline.yaml 覆盖状态 | 通过，本轮未修改 `baseline.yaml` |
| 规范性补充文档纳入 | 通过，R3 与 R5 fixups 均作为 Type DD 补充评估 |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets、`.env`、凭据、日志 payload 或私有运行数据 |

## findings

### qmd_index_presence_policy

结论：通过。

主 Type DD 已把 package-bundled book-scoped qmd index、本地 rebuilt projection
和全局 qmd projection 分离：包内 `qmd/index/qmd_book_index.sqlite` 是可选书级
索引，本地重建结果写入 `graph_vault/catalog/qmd-book-projections/{bookId}`，
全局 `graph_vault/catalog/qmd-projection.yaml` 是可重建投影。

R5 `qmdAvailabilityReasonMatrix` 补齐了 R5 之前缺失的原因态矩阵
(reasoned state matrix)。矩阵逐项覆盖 bundled index valid、missing index with
`reindex_on_mount`、missing index without `reindex_on_mount`、stale bundled
index、schema incompatible、local projection valid、global projection stale、
projection failed 和 checksum mismatch，并明确 package mounted、book visible、
GraphRAG-only query allowed、qmd retrieval allowed、rebuild action 与诊断码。
固定判据要求的挂载、查询、仅可见不可检索关系已明确。

### qmd_index_freshness_contract

结论：通过。

主 Type DD `readinessGates.qmdReadyGate.freshnessInputs` 覆盖 `bookId`、
`sourceHash`、`input.normalizedHash`、qmd build manifest path、qmd index schema、
tool version、embedding profile、chunking config hash 和 required artifacts。
`qmdRebuildTransaction.freshnessDigest.fields` 进一步包含
`qmdBuildManifestSha256`、`qmdToolVersion`、`qmdIndexSchema`、
`sqliteSchemaDigest`、`metadataSchemaDigest`、`buildConfigSha256` 和 `createdAt`
等等价字段。

`validIndexRule` 要求 freshness input 与 manifest、index metadata 全部匹配；
metadata 缺失必须 reindex。R5 矩阵规定 stale bundled index 与 global projection
stale 均不得 qmd retrieval，并进入重建或失效流程。过期索引不会被当作当前
projection 使用。

### rebuild_inputs_closure

结论：通过。

主 Type DD 要求缺失 book-scoped qmd index 时，manifest 必须声明
`reindex_on_mount` 并列出重建 projection 所需 normalized input 文件。
`qmdRebuildTransaction.rebuildInputClosure` 要求包内携带 canonical normalized
markdown、`qmd/qmd_build_manifest.json`、qmd build manifest 所需 metadata、qmd
config snapshot 和 package `BOOK_MANIFEST.json`，并绑定 `normalizedHash`、
`qmdBuildManifestSha256`、`qmdConfigSha256`、`metadataSchemaDigest`。

结合 `bookManifestSchema.files` 的 package-relative path、sha256、required 与
sensitivity 约束，以及 R3 scanner no-read contracts，接收方无需 provider
payload、secrets、原始 batch catalog 或外部 source root 即可重建或判定无法重建
qmd index。

### rebuild_output_location

结论：通过。

主 Type DD 明确 readonly package 的 mount-time qmd rebuild 写入包外本地
projection：`graph_vault/catalog/qmd-book-projections/{bookId}`。
`qmdRebuildTransaction.transactionPaths` 定义 staging root、live root、SQLite、
checksum sidecars、projection manifest 和 `REBUILD_READY.json`。

R3 `qmdAvailabilityAndReexportPolicy` 规定默认 export 只包含原 package closure，
不导出本地 projection。显式 repack 会创建新的 `packageGeneration`，把 projection
纳入 `qmd/index`，重新计算 `freshnessDigest`，并通过 staging、manifest 与
sidecars 发布。输出位置与 readonly package mode、checksum 闭包和再次导出规则
一致。

### projection_atomicity

结论：通过。

主 Type DD `mountScanTransactionModel.atomicProjectionCommit` 要求 catalog 与 qmd
projection 先写入 staging root，经 checksum、fsync 后原子替换，并最后更新
current-generation pointer。读路径只读取 last committed generation。

`qmdRebuildTransaction.protocol` 要求获取 per-book qmd rebuild lease，把 SQLite
和 projection manifest 写入 staging root，fsync SQLite、sidecars、staging root
和 parent directory，原子 rename 到 live root generation，再更新
`qmdReadyState`。失败时保留 previous projection generation，不暴露 partial
SQLite、partial global projection 或 stale qmd-ready/query-ready 状态。

### qmd_query_readiness_gate

结论：通过。

主 Type DD 明确 mounted、qmd-ready、GraphRAG-ready 与 query-ready 是不同状态。
`qmdReadyRule` 要求 qmd-only queries 只能在 `projection_ready` 或
`included_index_valid` 时执行；当查询路径不需要 qmd index lookup 时，GraphRAG-only
query 可在 qmd projection rebuilding 期间继续可用。

R5 `qmdAvailabilityReasonMatrix` 明确 qmd retrieval 只允许
`bundled_index_valid` 或 `local_projection_valid`。R5
`manifestFirstDirectQueryResolver` 规定 catalog projection 只是 cache，缺失或 stale
时不得覆盖 manifest、hash、schema 或 lineage failure。qmd 索引缺失或过期不会被
误报为可进行 qmd 检索。

### stale_projection_invalidation

结论：通过。

主 Type DD `staleProjectionInvalidation.triggers` 覆盖 `packageGeneration`、
`manifestSha256`、checksum validation、schema compatibility、package root
deletion、qmd freshness input 和 GraphRAG lineage binding 变化。规则要求在观察到
stale condition 的同一 projection commit 中移除 query-ready capability。

`mountScanTransactionModel.deletionAndReplacement` 定义删除、替换、失败替换和
stale projection cleanup。`qmdReadyGate.freshnessInputs` 包含 `sourceHash` 与
`normalizedHash`，R5 矩阵又明确 stale bundled index、global projection stale 与
checksum mismatch 的 unavailable 或 quarantine 结果。删除书包、替换书包、
sourceHash/normalizedHash 变化、qmdIndexSchema 变化或 checksum mismatch 后，旧
projection 与旧 book-scoped index 均会被移除、隔离或标记不可用，且原因可诊断。

### concurrency_and_idempotency

结论：通过。

R5 `qmdCanonicalIdempotencyAndDiagnostics` 定义 canonical
`qmdProjectionRebuildKey`，字段包括 `bookId`、`packageGeneration`、
`freshnessDigest`、`qmdBuildManifestSha256`、`qmdConfigSha256`、
`metadataSchemaDigest`、`sqliteSchemaDigest`、`qmdIndexSchema` 和
`normalizedHash`，并规定用 sorted canonical JSON 的 sha256 作为 key。R5
`overrideRule` 明确该 key 覆盖主 Type DD 中较窄的旧 key，且任何 actor 不得使用
旧 key 做 deduplication。

R5 `qmdReindexActorLockMatrix` 把 mount scanner、importer、batch runner、
explicit rebuild command 和 query reader 放入同一 actor/lock 矩阵，定义 per-book
lease、projection commit lock、fencing token、重复任务合并、中断后 retry、stale
lease takeover、commit failure preserve previous generation 和 package deletion
cancel semantics。最终 projection 由 canonical key、packageGeneration 与 fencing
token 共同约束，不会被并发任务互相覆盖。

### diagnostics_without_payloads

结论：通过。

R3 `qmdDiagnosticsSchema` 要求 qmd diagnostics 包含 error code、
package-relative path、freshness digest、rebuild id、retryable 与 repair hint，
并列出 qmd index missing、schema incompatible、freshness mismatch、rebuild input
missing、IO failure、schema failure、SQLite replace failure、projection commit
failure、repack required 和 readonly write denied 等稳定错误码。

R5 `qmdCanonicalIdempotencyAndDiagnostics.diagnosticsSchemaExtension` 补齐 digest
差异字段：`digestKind`、`expectedDigest`、`observedDigest` 和 `idempotencyKey`。
其 redaction rule 要求 digest 字段只能是 hex digest 或 null，不得包含 raw
content、SQL rows、provider payloads、secrets、absolute paths 或 unbounded
exception text。结合主 Type DD、R3 与 R5 的 provider no-read/forbidden input
规则，诊断满足无 payload、无 secrets、无日志 payload、无私人绝对路径的固定判据。

### qmd_index_test_matrix

结论：通过。

主 Type DD、R3 补充与 R5 `fixedBaselineTestContracts.qmdIndex.requiredCases` 合并后，
测试契约覆盖固定基准要求的 qmd index 矩阵：

- 缺失 book-scoped index 且声明 `reindex_on_mount`。
- 缺失 book-scoped index 且未声明 `reindex_on_mount`。
- bundled qmd index valid。
- stale bundled index。
- normalized input/freshness 变化导致 qmd-ready invalidation。
- `qmdIndexSchema` incompatible。
- projection failed retry 与 rebuild failure。
- catalog/qmd projection 原子替换只暴露旧 generation 或新 generation。
- 删除书包后 projection 失效。
- readonly package rebuild 写入包外本地 projection。
- concurrent reindex coalescing。
- diagnostics include expected and observed digest。

固定测试矩阵已形成可执行合同 (executable contract)；实现层测试用例仍需按这些合同
落地。

## pass_fail

总体判定：pass。

设计文档在纳入 R5 规范性补充后，满足固定 baseline 的 10 个 `passCriteria`。

| baseline id | R6 result | 判定摘要 |
| --- | --- | --- |
| qmd_index_presence_policy | pass | R5 原因态矩阵明确 bundled、missing、local projection、global stale 等状态的挂载、可见性、GraphRAG-only query 与 qmd retrieval。 |
| qmd_index_freshness_contract | pass | freshness inputs 与 freshness digest 覆盖 normalized input、build manifest、schema、tool、config、metadata 和 build marker。 |
| rebuild_inputs_closure | pass | 重建闭包包含 package-relative normalized input、qmd build manifest、config、metadata、manifest 和 checksums。 |
| rebuild_output_location | pass | readonly 重建写入包外 projection，默认导出排除本地 projection，显式 repack 生成新 packageGeneration。 |
| projection_atomicity | pass | mount projection 与 qmd SQLite rebuilt projection 均有 staging、fsync、atomic replace、last-good generation 与 failure preservation。 |
| qmd_query_readiness_gate | pass | qmd retrieval 只允许 valid bundled index 或 valid local projection；GraphRAG-only query 与 qmd readiness 分离。 |
| stale_projection_invalidation | pass | 删除、替换、source/normalized hash、schema、checksum 和 freshness 变化均会移除、隔离或标记旧 projection unavailable。 |
| concurrency_and_idempotency | pass | R5 canonical idempotency key 覆盖旧 key，并用 actor/lock/fencing 矩阵闭合并发与 retry。 |
| diagnostics_without_payloads | pass | 诊断包含 error code、package-relative path、digestKind、expected/observed digest 和 repair hint，且禁止 payload、secrets、logs 与绝对路径。 |
| qmd_index_test_matrix | pass | R5 fixed baseline test contracts 覆盖缺失索引、reindex policy、stale/schema、失败、原子替换、删除、readonly 和并发 reindex。 |

## criteria_delta_from_previous_run

上一轮同一 Agent 的固定基准复审为
`run-20260602-r5-fixed-baseline-rerun/agent-08-qmd-index/report.md`。该轮审计对象只
包含主 Type DD 与 R3 补充，结论为 6 Pass / 4 Partial，总体 Fail。

本轮 baseline 未变化：10 个维度的 id、name、顺序与 `passCriteria` 均未改变。

本轮设计输入变化：R5 fixups 作为规范性补充纳入审计。R5 文档补齐以下上一轮缺口：

- `qmdAvailabilityReasonMatrix` 关闭 `qmd_index_presence_policy` 的状态矩阵缺口。
- `qmdCanonicalIdempotencyAndDiagnostics` 关闭 canonical qmd reindex key 与 digest
  差异诊断缺口。
- `qmdReindexActorLockMatrix` 关闭 mount scanner、importer、runner 与 explicit
  rebuild command 的 actor/lock/retry 矩阵缺口。
- `fixedBaselineTestContracts.qmdIndex` 关闭缺失 index、未声明
  `reindex_on_mount`、schema incompatible、projection failure、readonly rebuild、
  concurrent reindex 与 digest diagnostic 的测试矩阵缺口。

结果变化：R5 的 4 个 Partial 在 R6 中均提升为 Pass，总体由 Fail 变为 Pass。

## required_design_changes

无。

固定 10 个 `passCriteria` 已由主 Type DD、R3 补充与 R5 补充共同满足。后续工作不应
新增、删除、重排或重命名固定审计维度；若继续修订设计，应保持 R5 的规范优先级
(normative precedence)，避免重新引入主 Type DD 中较窄 idempotency key 的歧义。

## residual_risks

- 本报告只审计设计文档，不证明实现代码、迁移脚本或测试 fixtures 已按合同完成。
- R5 fixed baseline test contracts 已覆盖矩阵，但仍需实现层测试验证 staging、fsync、
  atomic replace、fencing token、retry 和 failure injection 行为。
- readonly package repack 会产生新的 `packageGeneration`，实现时需确保不会就地修改
  原 mounted package。
- 诊断实现必须保持 package-relative path 与 bounded digest 字段，避免把异常栈、SQL
  rows、raw logs、provider payload 摘要或私人绝对路径写入本地诊断或导出材料。
