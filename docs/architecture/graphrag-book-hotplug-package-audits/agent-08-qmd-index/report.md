# agent-08-qmd-index 审计报告

## scenario

书包 qmd 索引缺失或过期，需要挂载后重建或投影。典型状态包括
`qmd/index/qmd_book_index.sqlite` 不存在、存在但 schema 过旧、存在但不匹配当前
normalized input、全局 qmd projection 仍保留旧条目、readonly 包无法写回包内索引、
以及多个 scanner 或 importer 同时触发 reindex。

本审计只阅读 Type DD 文档和相邻审计文档，不读取 provider payload、provider
secrets、provider logs 或任何请求/响应载荷。

## fixed_baseline

本审计使用 `baseline.yaml` 中固定 10 维基准：

1. `qmd_index_presence_policy`: qmd 索引存在性策略。
2. `qmd_index_freshness_contract`: qmd 索引新鲜度契约。
3. `rebuild_inputs_closure`: 重建输入闭包。
4. `rebuild_output_location`: 重建输出位置。
5. `projection_atomicity`: 投影原子性。
6. `qmd_query_readiness_gate`: qmd 查询就绪门禁。
7. `stale_projection_invalidation`: 旧投影失效规则。
8. `concurrency_and_idempotency`: 并发与幂等。
9. `diagnostics_without_payloads`: 无 payload 诊断。
10. `qmd_index_test_matrix`: qmd 索引测试矩阵。

## findings

### F1: qmd index 可选与可重建方向正确，但状态分类不足

Type DD 明确把全局 qmd 与 retrieval indexes 定义为 cache 或 projection，而非
package authority；`qmd/index/qmd_book_index.sqlite` 是 optional artifact，若缺失，
mount scanner 可触发本地重建。`bookManifestSchema.qmd.contract` 也要求未携带书级
qmd index 时必须声明 `reindex_on_mount` 并列出用于重建 projection 的 normalized
input files。

不足是文档没有形成完整状态分类。缺少 index、携带可用 index、携带过期 index、
携带 schema 不兼容 index、本地已重建 projection、全局 projection 已存在但需刷新
这些状态没有机器可读枚举，也没有说明每种状态对 mount、visibility、qmd search
和 GraphRAG query readiness 的影响。实现者仍需自行推断缺失索引是否影响
query-ready，或只影响 qmd 检索。

### F2: 过期索引判定契约缺失

Type DD 在 compatibility 中要求 `qmdIndexSchema`，在 input 中要求
`normalizedHash` 和 `normalizedBytes`，在 qmd 中要求 `buildManifestPath`、
`indexPolicy` 和 `requiredArtifacts`。这些字段可以支撑 freshness 判定。

但文档没有定义 freshness algorithm。它未说明 qmd index 应绑定哪些 digest：
normalized input digest、qmd build manifest digest、qmd tool version、qmd index
schema、chunking/tokenization 配置、embedding 或 retrieval 配置、sourceHash 以及
packageVersion。缺少这些绑定时，过期 index 可能因 schema 字段相同而被误用，也
可能因工具版本变化被过度重建。

### F3: reindex_on_mount 的输入闭包只写了方向，未写足内容

文档要求如果不包含 book-scoped qmd index，manifest 必须声明 `reindex_on_mount`
并列出 normalized input files。目标布局也把 `input/` 作为 GraphRAG 与 qmd 使用的
规范化 markdown 输入，且 package root 必须包含 validate、query、export 和 remount
所需文件。

缺口是 qmd 重建通常不只需要 markdown 文件列表。Type DD 没有规定 qmd build
config、chunking 规则、metadata 映射、document id 映射、schema version、locale
或 tokenizer/toolchain 版本如何进入闭包。若这些信息只存在于旧 batch state、
global catalog 或外部 qmd 配置，接收方无法确定性重建同一 qmd index。

### F4: 重建输出位置与 readonly package mode 存在矛盾

`mount.contract` 规定默认 mount mode 是 readonly，writable runtime state 必须隔离
在 `import/` 或 `state/runtime`，并默认排除 package checksums。与此同时，
`qmd/index/qmd_book_index.sqlite` 被描述为包内 optional book-scoped qmd index，
缺失时 scanner 可触发本地重建。

这留下关键矛盾：mount-time rebuilt index 应写回 package root 的 `qmd/index/`，
还是写入接收方本地 projection root。若写回包内，会破坏 readonly 语义和 checksum
闭包；若写入全局或本地 mount state，再次导出是否携带该 index、manifest 是否需要
更新、以及下次 mount 如何识别该 projection，文档均未定义。

### F5: 全局 qmd projection 更新缺少原子性协议

文档说明 mount scanner 会 project catalog entries and qmd retrieval indexes，
删除书包时全局 qmd 和 retrieval indexes 会 remove or invalidate book projection。
这些规则说明 qmd projection 是 mount lifecycle 的一部分。

不足是 projection 写入没有 staging 或 atomic replace 契约。SQLite index 重建、
全局 projection 更新和 catalog projection 可能跨多个文件或数据库操作。若重建在
中途失败，当前 Type DD 没有规定临时文件命名、锁、事务、版本戳、完成标志或回滚。
这会导致部分 qmd projection 被查询层看到，或旧 projection 与新 catalog entry
混用。

### F6: qmd readiness 与 GraphRAG queryReady 的关系不清

Type DD 的 GraphRAG section 要求 `queryReady`，并规定 GraphRAG query readiness
需要完整 output 与 producer evidence。mount lifecycle 也写明 book 只有 declared
GraphRAG artifacts 通过验证后才 query-ready。

但 qmd index readiness 没有对应的 gate。若 GraphRAG artifacts 完整但 qmd index
缺失或过期，书是否仍为 query-ready，还是仅 GraphRAG-ready 但 qmd-search-not-ready，
没有明确。反过来，qmd projection 已重建但 GraphRAG output 不完整时，是否允许
qmd-only 查询也未定义。该缺口会造成 UI、CLI 和 retrieval plane 对同一本书的可用
状态解释不一致。

### F7: stale projection 失效规则覆盖删除，但未覆盖替换和过期

文档明确删除 `graph_vault/books/{bookId}` 后，下一次 mount scan 会移除 derived
catalog projection，并 remove or invalidate 全局 qmd 和 retrieval indexes 的 book
projection。这能覆盖 uninstall-by-delete。

未覆盖的情况是用户用同一 `bookId` 替换书包、normalized input 变化、qmdIndexSchema
变化、manifest checksum mismatch、旧 index 校验失败或 sourceHash 冲突。当前设计
规定 sameBookIdDifferentSourceHash fail closed，但没有明确旧 qmd projection 是否
立即失效。若旧 projection 留存，查询层可能继续返回已经失败挂载的旧内容。

### F8: 并发 reindex 与 runner 同步没有定义

本场景容易与并发 runner 冲突：batch runner 可能正在生成 `qmd/`，mount scanner
可能同时发现缺失 index 并触发重建，importer 也可能在 staging 中校验同一本书。
Type DD 要求 batch workflow 调用小 package modules，但没有给 qmd reindex 的幂等
键、锁边界或任务合并规则。

缺少并发契约时，两个 reindex 进程可能同时写同一个 SQLite 或全局 projection；
一个进程可能按旧 manifest 重建，另一个按新 manifest 更新 catalog。最终结果是否
取决于最后写入者，文档无法保证。

### F9: 诊断隐私方向正确，但 qmd reindex 诊断字段未定义

Type DD 明确排除 provider 请求、响应、密钥和 logs payload，并要求 scanner
failures 作为 mount diagnostics 报告，且不得 mutate provider payload roots。这
符合本审计“不读取 provider payload/secrets”的要求。

但 qmd index 缺失、过期和重建失败需要记录更细诊断，例如 expected digest、
observed digest、schema mismatch、tool unavailable、input missing 和 write
permission denied。文档未规定这些诊断只能使用 package-relative path 和摘要级
信息，也未禁止记录本机绝对路径、异常堆栈、source excerpt 或 provider-derived
payload 摘要。

### F10: 测试契约只覆盖缺失索引主路径

现有 `testContracts` 包含“一本未携带 book-scoped qmd index 的包，在 manifest
声明 `reindex_on_mount` 时可以 mount-time reindex”。这是 qmd index 缺失场景的
核心起点。

但测试没有覆盖过期索引、schema 不兼容、未声明 `reindex_on_mount`、normalized
input 改变、readonly 包重建输出位置、projection 原子替换、删除后失效、替换后旧
projection 失效、并发 reindex 和诊断脱敏。Type DD 目前不足以驱动稳定的 qmd
index 实现和回归测试。

## pass_fail

总体结论：部分通过（partial pass）。

Type DD 已经确立 qmd index 不作为全局权威、可作为书级 optional artifact、缺失时
可声明 `reindex_on_mount` 并由 mount scanner 重建 projection 的方向。未完全通过
的原因是：缺少索引状态机、freshness 判定、重建输出位置、原子 projection、qmd
readiness gate、旧 projection 失效、并发和测试矩阵。

| baseline id | 结果 | 判定 |
| --- | --- | --- |
| `qmd_index_presence_policy` | 部分通过 | optional book index 和 reindex_on_mount 存在，但状态枚举与可用性含义不足。 |
| `qmd_index_freshness_contract` | 未通过 | 未定义过期判定算法及 index 与 input/config/schema/tool 的绑定。 |
| `rebuild_inputs_closure` | 部分通过 | 要求列出 normalized input files，但缺少 qmd config、metadata 和工具链闭包。 |
| `rebuild_output_location` | 未通过 | readonly 包、包内 index、本地 projection 与再次导出规则互相未闭合。 |
| `projection_atomicity` | 未通过 | 全局 qmd projection 和 SQLite 重建没有 staging、锁或事务契约。 |
| `qmd_query_readiness_gate` | 未通过 | GraphRAG queryReady 已定义，qmd-ready 与 qmd-only 查询状态未定义。 |
| `stale_projection_invalidation` | 部分通过 | 删除书包会失效 projection，但替换、过期、schema mismatch 和 checksum failure 未覆盖。 |
| `concurrency_and_idempotency` | 未通过 | 未定义并发 reindex 的幂等键、锁、任务合并和中断重试。 |
| `diagnostics_without_payloads` | 部分通过 | provider payload 排除明确，但 qmd 诊断字段和脱敏规则不足。 |
| `qmd_index_test_matrix` | 部分通过 | 有缺失索引重建测试，缺少过期、readonly、原子、失效和并发矩阵。 |

## required_design_changes

1. 增加 `qmdIndexState` 状态机。至少包含 `bundled_valid`、
   `missing_reindex_declared`、`missing_reindex_not_allowed`、`stale`、
   `schema_incompatible`、`rebuild_pending`、`rebuild_failed`、
   `local_projection_valid` 和 `projection_invalidated`。

2. 定义 qmd index freshness contract。明确 index 必须绑定 normalized input
   digest、qmd build manifest digest、qmdIndexSchema、qmd tool version、chunking
   config、metadata/document identity map digest 和 package identity。

3. 扩展 `bookManifestSchema.qmd`。除 `buildManifestPath`、`indexPolicy` 和
   `requiredArtifacts` 外，增加 `indexDigest`、`indexBuiltFrom`、
   `rebuildInputs`、`rebuildConfigPath`、`projectionPolicy` 和
   `readinessPolicy` 等机器可读字段。

4. 明确 reindex 输出位置。建议 readonly mount 下将重建结果写入接收方本地
   `graph_vault/mount_state/books/{bookId}/qmd/` 或专用 projection root；包内
   `qmd/index/` 只由 export 或 explicit repack 更新。

5. 定义再次导出规则。若接收方本地 projection 已重建，export 是否可把它纳入新
   `BOOK_MANIFEST.json` 闭包必须显式化；纳入时必须重新生成 checksum 和 qmd build
   evidence。

6. 增加 qmd projection 原子协议。使用 per-book lock、staging SQLite、完整校验、
   manifest digest marker、atomic rename 或数据库事务；失败时保留旧 projection
   但标记 unavailable 或完全回滚，不得暴露部分 projection。

7. 拆分 readiness。至少区分 `visible`、`catalog_ready`、`qmd_ready`、
   `graphrag_ready` 和 `query_ready`，并说明 qmd 缺失或过期时各 retrieval path
   的行为。

8. 扩展 stale invalidation。当前 manifest 验证失败、sourceHash conflict、
   normalizedHash 变化、qmdIndexSchema 变化、index checksum mismatch、book delete
   或 package replace 时，旧 qmd projection 必须失效并记录原因。

9. 增加并发契约。以 `(bookId, sourceHash, normalizedHash, qmdIndexSchema,
   qmdBuildManifestDigest)` 作为 reindex 幂等键，定义锁范围、重复任务合并、
   中断恢复和 scanner/runner 冲突处理。

10. 补充 qmd index 测试矩阵。覆盖缺失索引并声明 reindex、缺失索引但未声明
    reindex、过期 index、schema incompatible、readonly mount、本地 projection
    写入、atomic replace failure、删除失效、替换失效、并发 reindex 和脱敏诊断。

## residual_risks

1. qmd index 的 deterministic rebuild 可能依赖 tokenizer、locale、排序规则或工具
   版本。即使 Type DD 固定 digest 字段，不同平台仍可能生成字节不同但语义等价的
   SQLite，需要实现层定义 canonical build 或语义校验。

2. readonly 包下把 projection 写入本地 mount state 会改善分发安全，但会让二次导出
   的语义更复杂：导出的到底是原始包，还是带接收方重建 index 的新包。

3. 若 qmd index 重建需要额外模型、embedding 或 provider，离线接收方可能无法完成
   projection。Type DD 应保持 qmd 重建不依赖 provider payload；若确实需要外部
   provider，必须降级为 not qmd-ready 并给出诊断。

4. 全局 qmd projection 可能聚合多本书。单本书替换或删除时的局部失效必须避免
   影响其他书，同时不能留下孤儿 document id。

5. 过度保守的 freshness 判定会导致频繁 reindex；过度宽松则会使用 stale index。
   需要测试 fixtures 覆盖等价输入、微小配置变更和 schema 升级。
