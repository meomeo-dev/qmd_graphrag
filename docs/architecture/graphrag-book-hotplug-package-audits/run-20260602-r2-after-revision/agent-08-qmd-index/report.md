# agent-08-qmd-index R2 复审报告

## scenario
书包 qmd 索引缺失或过期，需要挂载后重建或投影。典型状态包括
`qmd/index/qmd_book_index.sqlite` 缺失、携带索引但 freshness metadata 不匹配、
`qmdIndexSchema` 不兼容、readonly 书包需要把重建结果写入本地 projection、
以及多个 mount scanner、importer 或 runner 同时触发 reindex。

复审对象为修订后的
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。本复审只检查 Type DD
与审计基线，不读取 provider payload、provider secrets、请求响应载荷、日志载荷、
`.env` 或私有运行根。

## reused_fixed_baseline
本次 R2 复审复用本目录既有固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-08-qmd-index/baseline.yaml`

固定 10 维如下，未新增、删除、重命名任何维度，未改变任何 `passCriteria`。

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
| R2 baseline 是否存在 | 通过 |
| R2 baseline 是否复用 R1 固定基线 | 通过 |
| R1/R2 baseline 文件比较 | 通过，内容一致 |
| baseline SHA-256 | `3bb68306a780308d10ed00df6e3bc7921eb32277bc1f3bbe908649b95bc1de76` |
| 维度数量 | 通过，仍为 10 个 |
| 维度 id 顺序 | 通过，未新增、删除、重命名或重排 |
| passCriteria | 通过，未改变 |
| baseline.yaml 覆盖状态 | 通过，本轮未覆盖 `baseline.yaml` |
| 敏感材料读取边界 | 通过，未读取 provider payload、secrets、日志载荷或私有根 |

## findings
### qmd_index_presence_policy
结论：部分通过。
修订版已明确区分 package-bundled book-scoped qmd index、缺失索引、本地
projection 和全局 qmd projection。`qmd/index/qmd_book_index.sqlite` 被定义为
optional artifact；readonly 包的重建结果写入
`graph_vault/catalog/qmd-book-projections/{bookId}`；mount scanner 的 derived
outputs 包含 optional global qmd index projection。`qmdReadyGate` 也新增
`included_index_valid`、`reindex_required`、`reindex_pending`、`reindexing`、
`projection_ready`、`projection_failed` 和 `schema_incompatible`。

未完全通过的原因是状态与可用性矩阵仍不完整。Type DD 说明 qmd-only queries
需要 `projection_ready` 或 `included_index_valid`，但未把缺失索引且未声明
`reindex_on_mount`、携带索引但过期、全局 projection 存在但 book-scoped index
失效等状态逐项映射到 mount allowed、visible-only、GraphRAG-only query 和 qmd
retrieval allowed。

### qmd_index_freshness_contract
结论：部分通过。
修订版新增 freshness inputs，包括 `identity.bookId`、`identity.sourceHash`、
`input.normalizedHash`、`qmd.buildManifestPath`、`qmd.indexSchema`、
`qmd.toolVersion`、`qmd.embeddingProfile`、`qmd.chunkingConfigHash` 和
`qmd.requiredArtifacts`。`validIndexRule` 规定 book-scoped qmd index 只有在
freshness input 与 manifest、index metadata 全部匹配时才 fresh，metadata 缺失时
必须 reindex。

缺口是固定判据要求 qmd build manifest digest、qmdIndexSchema、tool version、
index build time 或等价字段。当前 Type DD 使用 `qmd.buildManifestPath`，没有把
build manifest digest 或 build config digest 明确列入 freshness input，也没有
定义 index build time、index generation 或等价 freshness marker。过期索引不得
作为当前 projection 使用的方向已写明，但 stale 判定仍缺少可实现的完整 digest
合同。

### rebuild_inputs_closure
结论：部分通过。
修订版要求 package root 包含 validate、query、export 和 remount 所需文件，不依赖
sibling source 或 catalog roots。`bookManifestSchema.qmd.contract` 规定未包含
book-scoped qmd index 时，manifest 必须声明 `reindex_on_mount` 并列出用于重建
projection 的 normalized input files。`input/` 是 canonical normalized input root，
`files` 条目包含 package-relative path、sha256 和 sensitivity，security policy
也明确 provider requests/responses、logs 和 secrets 不属于包闭包。

仍未完全通过的原因是 qmd rebuild closure 没有列出完整机器可读字段。Type DD 尚未
要求 `rebuildConfigPath`、qmd build manifest digest、schema metadata digest、
document identity map digest、metadata mapping、tokenizer/locale 或排序规则等
进入闭包。若这些输入只存在于旧 batch catalog、外部 qmd 配置或运行环境，接收方
仍无法保证无需 provider payload、原始 batch catalog 或外部 source root 即可
确定性重建。

### rebuild_output_location
结论：部分通过。
修订版已明确 readonly package 下 `rebuildPolicy.readonlyPackage` 为
`write_projection_outside_package`，projection root 为
`graph_vault/catalog/qmd-book-projections/{bookId}`。`externalRuntimeLayout` 也把
该 root 定义为 readonly 包挂载后的本地 qmd projection 与重建结果，符合不写回
不可变 package root 的方向。

未完全通过的原因是再次导出规则仍未闭合。Type DD 未说明本地 projection 是否可在
export 或 explicit repack 时纳入新的 `BOOK_MANIFEST.json`，纳入时如何生成 qmd build
evidence、checksum sidecars 和 packageGeneration，也未说明不纳入时导出的包如何
保留 `reindex_on_mount` 语义。`openQuestions.qmd_book_index_format` 仍保留
book-scoped SQLite 是否作为默认包产物的问题。

### projection_atomicity
结论：部分通过。
修订版新增 generation-based mount scan transaction、projection staging root、
qmd projection lock、atomic replacement、current-generation pointer last update
和 last-good reader view。`atomicProjectionCommit` 覆盖 catalog files 与
`graph_vault/catalog/qmd-projection.yaml`，失败时 query/list 只读上一个 committed
generation，不暴露 partial projection。

缺口是 mount-time qmd index rebuild 的 per-book 输出仍缺少完整原子协议。Type DD
没有明确 `graph_vault/catalog/qmd-book-projections/{bookId}` 下 SQLite 或等价索引
的 staging filename、临时目录、fsync、integrity check、atomic rename、失败标记、
中断清理和 query-ready marker 提交顺序。因此全局 projection commit 已较完整，
但 rebuilt qmd index 自身仍可能出现 partial SQLite 或 stale qmd-ready 状态。

### qmd_query_readiness_gate
结论：通过。
修订版已把 mounted、qmd-ready 和 GraphRAG-ready 拆开。`packageStates` 包含
`mounted_not_qmd_ready`、`mounted_not_graphrag_ready`、`query_ready`、
`quarantined` 和 `incompatible`；`qmdReadyGate` 定义 qmd readiness state、
freshness inputs、rebuild policy 和 qmd-ready rule；`graphragReadyGate` 定义
GraphRAG artifact closure、producer lineage binding、schema/dimension
compatibility 和 query entrypoint。

关键规则已明确：qmd-only queries 只能在 `projection_ready` 或
`included_index_valid` 时执行；当 qmd projection rebuilding 且查询路径不需要 qmd
index lookup 时，book 可以保持 GraphRAG-ready。该设计能防止 qmd 索引缺失或过期
时误报为可进行 qmd 检索。

### stale_projection_invalidation
结论：通过。
修订版新增 `staleProjectionInvalidation`，触发条件包括 packageGeneration 变化、
manifestSha256 变化、checksum validation 失败、schema compatibility 变化、
package root 删除、qmd freshness input 变化和 GraphRAG lineage binding 变化。
失效规则要求在观察到 stale condition 的同一 projection commit 中移除
query-ready capability；上一代仅在 package root 仍存在且仍有效时可读。

`deletionAndReplacement` 同时覆盖 missing book root、same bookId new generation、
failed replacement 和 stale projection cleanup。结合 `qmdReadyGate.validIndexRule`
和 query entrypoint 的 stale refusal，设计满足删除、替换、normalizedHash/sourceHash
变化、schema 变化和 checksum mismatch 后旧 projection 不继续作为 qmd-ready 使用
的固定判据。

### concurrency_and_idempotency
结论：部分通过。
修订版已定义多层锁和幂等方向。mount scan 使用 `mount-scan.lock`、
catalog commit 使用 `catalog-projection.lock`、qmd projection 使用
`qmd-projection.lock`，并规定锁获取顺序。qmd reindex 的 idempotency key 为
`{bookId}:{normalizedHash}:{qmd.indexSchema}:{qmd.toolVersion}`，相同 key 的并发
请求必须合并为一次 rebuild，较新的 packageGeneration 会取消 stale rebuild。

未完全通过的原因是 qmd reindex 的 retry 和锁边界仍不够精确。Type DD 尚未定义
per-book rebuild lock、runner/importer/scanner 的兼容锁矩阵、stale lock recovery、
rebuild 中断后的 checkpoint 与 retry 规则，以及 idempotency key 是否还必须包含
sourceHash、packageGeneration、qmd build manifest digest 或 embedding profile。
因此最终 projection 的确定性已有方向，但尚不足以约束完整实现。

### diagnostics_without_payloads
结论：部分通过。
修订版对隐私边界有明显增强。scope 排除 provider 请求、响应、密钥和日志 payload；
`securityExportPolicy` 禁止 provider payload、api key、bearer token、absolute local
path 和 user home path；producer evidence 只能导出脱敏 package-relative summary；
query gate failure 返回稳定诊断且不触发 provider calls。

不足是 qmd index 诊断 schema 未定义。固定判据要求 qmd index 缺失、过期、重建失败
或 schema 不兼容时，诊断包含 error code、package-relative path、digest 差异和恢复
提示，并禁止记录 provider requests/responses、secrets、logs、payload 摘要或私人
绝对路径。当前 Type DD 只把 `diagnostics.errorCode` 归为 restricted，未定义 qmd
诊断字段、digest diff 格式、recovery hint、package-relative-only 约束和异常栈
脱敏规则。

### qmd_index_test_matrix
结论：部分通过。
修订版测试合同已覆盖若干关键路径：未携带 book-scoped qmd index 且声明
`reindex_on_mount` 时可 mount-time reindex；qmd index freshness changes 在同一
projection generation 中使 qmd-ready 失效；catalog 与 qmd projection commits 只暴露
旧 generation 或新 generation；删除书包后 projection 原子移除；projection commit
failure 保留 last-good generation。

缺口是固定测试矩阵仍未完整落地。当前测试合同未逐项覆盖未声明
`reindex_on_mount` 的缺失索引、normalized input 变化、`qmdIndexSchema` 不兼容、
qmd rebuild failure、readonly 包本地 projection 写入、per-book SQLite 原子替换、
并发 reindex coalescing、中断后 retry，以及无 payload 诊断字段断言。

## pass_fail
总体判定：部分通过，未达到完全通过。

修订版已修复 R1 的主要结构性缺口：新增 qmd readiness gate、GraphRAG/query-ready
关系、stale projection invalidation、readonly package 下的外部 projection root、
generation-based projection commit 和 qmd reindex idempotency 方向。`qmd_query_readiness_gate`
与 `stale_projection_invalidation` 已满足固定判据。

仍未完全通过的维度集中在 freshness digest 合同、rebuild input closure、重建输出
的再次导出语义、per-book qmd index rebuild 原子协议、并发 retry、无 payload 诊断
schema 和测试矩阵。

| baseline id | R2 result | 判定摘要 |
| --- | --- | --- |
| qmd_index_presence_policy | 部分通过 | 状态已拆分，但缺完整 mount/visible/query 可用性矩阵。 |
| qmd_index_freshness_contract | 部分通过 | freshness inputs 已有，但缺 build manifest digest 与 build time 等字段。 |
| rebuild_inputs_closure | 部分通过 | normalized input 与 checksum 闭包已有，qmd config/schema metadata 闭包不足。 |
| rebuild_output_location | 部分通过 | readonly 本地 projection root 已明确，再次导出规则未闭合。 |
| projection_atomicity | 部分通过 | 全局 projection 原子提交已定义，per-book rebuilt SQLite 原子协议不足。 |
| qmd_query_readiness_gate | 通过 | qmd-ready、GraphRAG-ready、query-ready 与 qmd-only 查询门禁已明确。 |
| stale_projection_invalidation | 通过 | 删除、替换、checksum/schema/freshness 变化均会失效 query-ready capability。 |
| concurrency_and_idempotency | 部分通过 | 幂等 key 与合并规则已有，per-book lock、retry 和 stale lock 仍不足。 |
| diagnostics_without_payloads | 部分通过 | provider payload 边界明确，qmd 诊断 schema 与恢复提示未定义。 |
| qmd_index_test_matrix | 部分通过 | 主路径和 projection 测试已有，负面、readonly、并发和诊断矩阵不足。 |

## criteria_delta_from_r1
基线判据变化：无。R2 复审使用与 R1 完全相同的 10 个 dimension id、name 与
passCriteria；没有新增、删除、重命名维度，也没有改变 passCriteria。

评估结果相对 R1 的变化如下：

| baseline id | R1 结果 | R2 结果 | 变化 |
| --- | --- | --- | --- |
| qmd_index_presence_policy | 部分通过 | 部分通过 | 新增 qmdReadyGate 状态，但可用性矩阵仍不完整。 |
| qmd_index_freshness_contract | 未通过 | 部分通过 | 新增 freshness inputs 和 validIndexRule，digest 字段仍不足。 |
| rebuild_inputs_closure | 部分通过 | 部分通过 | 输入闭包增强有限，qmd rebuild config 仍未完整入闭包。 |
| rebuild_output_location | 未通过 | 部分通过 | 新增 readonly 外部 projection root，但再次导出规则未闭合。 |
| projection_atomicity | 未通过 | 部分通过 | 新增 projection transaction，per-book rebuild 原子性仍不足。 |
| qmd_query_readiness_gate | 未通过 | 通过 | 新增 qmd-ready 与 GraphRAG-ready 分离门禁。 |
| stale_projection_invalidation | 部分通过 | 通过 | 新增 freshness/schema/checksum/delete/replace 触发失效规则。 |
| concurrency_and_idempotency | 未通过 | 部分通过 | 新增 idempotency key、任务合并和锁顺序，retry 仍不足。 |
| diagnostics_without_payloads | 部分通过 | 部分通过 | 隐私边界增强，qmd 诊断字段仍缺。 |
| qmd_index_test_matrix | 部分通过 | 部分通过 | 新增 freshness invalidation 和 projection 测试，矩阵仍不完整。 |

## required_design_changes
1. 在 `qmdReadyGate` 中补充机器可读状态矩阵，逐项定义 bundled valid、missing with
   reindex、missing without reindex、stale bundled index、schema incompatible、
   local projection valid、global projection stale 时的 mount、visibility、
   GraphRAG-only query 和 qmd retrieval 行为。

2. 把 `qmd.buildManifestDigest`、`qmd.rebuildConfigDigest`、`qmd.indexBuiltAt` 或
   `qmd.indexGeneration`、document identity map digest、metadata mapping digest
   明确纳入 freshness contract。`qmd.buildManifestPath` 不能单独承担 digest 语义。

3. 扩展 `bookManifestSchema.qmd` 的 required 或 conditional fields，至少包括
   `reindexOnMount`、`rebuildInputs`、`rebuildConfigPath`、`rebuildConfigDigest`、
   `schemaMetadataDigest`、`indexMetadataPath`、`projectionPolicy` 和
   `readinessPolicy`。

4. 定义本地 qmd projection 的二次导出规则。明确默认 export 是否包含接收方重建的
   projection；若包含，必须重新生成 qmd build evidence、file checksums、
   `BOOK_MANIFEST.json` 和 packageGeneration；若不包含，必须保留
   `reindex_on_mount` 语义。

5. 为 `graph_vault/catalog/qmd-book-projections/{bookId}` 定义 per-book 原子
   rebuild 协议，包括 staging root、临时 SQLite、integrity check、fsync、
   atomic rename、ready marker、failure marker、cleanup 和 rollback。

6. 补充 qmd reindex 并发协议。定义 per-book rebuild lock、runner/importer/scanner
   兼容锁矩阵、owner heartbeat、stale lock recovery、中断 checkpoint、retry 策略
   和新 packageGeneration 抢占旧任务的提交规则。

7. 定义 qmd 诊断 schema。缺失、过期、schema incompatible、checksum mismatch、
   rebuild failed 和 write denied 均应有稳定 error code、package-relative path、
   expected/observed digest、recovery hint，并禁止 provider payload 摘要、绝对路径
   和未脱敏异常栈。

8. 扩展测试合同，覆盖 baseline 要求的全部场景：缺失 index 且声明
   `reindex_on_mount`、缺失 index 且未声明、normalized input 变化、
   `qmdIndexSchema` 不兼容、重建失败、projection 原子替换、删除书包后失效、
   readonly 包重建和并发 reindex。

## residual_risks
1. qmd index 的确定性重建可能依赖 tokenizer、locale、排序规则、SQLite 版本或
   qmd tool patch version。即使 freshness digest 完整，不同平台仍可能生成字节不同
   但语义等价的 index，需要实现层定义 canonical build 或语义校验。

2. readonly 包外部 projection 有利于分发安全，但会增加二次导出语义复杂度。用户
   需要能区分原始分发包、带本机重建 projection 的 repack 包，以及仅在本机可用的
   runtime projection。

3. 如果 qmd rebuild 需要 embedding、模型或 provider，离线接收方可能无法完成
   projection。Type DD 应继续保持 mount-time qmd rebuild 不依赖 provider payload；
   无法重建时应降级为 visible 或 GraphRAG-only，而不是隐式发起 provider call。

4. 全局 qmd projection 聚合多本书时，单本书删除或替换的局部失效必须避免污染其他
   书的 qmd-ready 状态，同时不能留下孤儿 document id、chunk id 或 stale retrieval
   entries。

5. 过度保守的 freshness 判定会导致频繁 reindex；过度宽松则可能使用 stale index。
   后续实现需要用 fixtures 覆盖等价输入、微小配置变更、schema 升级和跨平台重建。
