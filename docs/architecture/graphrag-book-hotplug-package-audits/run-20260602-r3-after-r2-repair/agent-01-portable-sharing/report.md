# agent-01-portable-sharing R3 复审报告

## scenario

用户把一本已完成书复制给另一位用户。接收方只复制单本书目录后查询，不复制发送方
`graph_vault/catalog`、`graph_vault/sources`、全局 qmd index、batch run
records、provider payload、provider logs 或 secrets。

复审对象为修订后的
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。复审场景限定为
portable sharing（可移植分享）和 copy-only import（仅目录复制导入）。

## reused_fixed_baseline

本次 R3 复审复用既有
`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-01-portable-sharing/baseline.yaml`。
固定 10 维如下，未新增、删除、重排、重命名任何维度，未改变任何
`passCriteria`。

1. `portable_closure`: 单目录可移植闭包。
2. `manifest_authority`: Manifest 挂载权威。
3. `receiver_empty_vault_query`: 接收方空 Vault 查询。
4. `identity_conflict`: 身份与冲突处理。
5. `checksum_integrity`: 完整性与篡改校验。
6. `path_portability`: 路径可移植性。
7. `query_readiness_gate`: 查询就绪门禁。
8. `privacy_exclusion`: 隐私与 Provider 排除。
9. `receiver_state_isolation`: 接收方运行状态隔离。
10. `implementable_tests`: 可实施测试契约。

## baseline_integrity_check

- baseline path:
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-01-portable-sharing/baseline.yaml`
- baseline SHA-256:
  `6b11491058f988048c1a02b78b908bf5d8abcdec62c3bc24e0981ea77d162bf9`
- integrity result: 通过。R3 复用了该目录中已有 `baseline.yaml`，未覆盖、修改、
  重排或重命名 baseline 内容。
- confidentiality result: 通过。复审未读取 provider payload、provider secrets、
  `.env`、runtime recovery payload 或外部私密材料。

## findings

### 1. portable_closure

结论：通过。

修订版明确 `graph_vault/books/{bookId}` 是权威包根目录，并要求包根包含验证、
挂载、qmd 查询、GraphRAG 查询、再次导出和重挂载所需的完整闭包
（portable closure）。`targetDirectoryLayout` 将 `BOOK_MANIFEST.json`、
manifest sidecars、`source/`、`input/`、`qmd/`、`graphrag/output/`、
`graphrag/runs/` 和脱敏后的 `state/` 放入单本书包内。

`bookManifestSchema.files` 要求每个必需文件使用 package-relative path（包内相对
路径），并记录 `bytes`、`sha256`、`required`、`producerRunId` 与
`sensitivity`。`catalogProjectionSchemas.forbiddenInputs` 明确派生 catalog 不得
依赖 batch run state、外部 provider roots、`graph_vault/input/**` 或发送方绝对
路径。该设计满足单目录复制给接收方后的闭包要求。

### 2. manifest_authority

结论：通过。

修订版把 `BOOK_MANIFEST.json` 及其 checksum sidecars 设为单本书挂载权威
（mount authority）。`mountScanner.authoritativeInput` 只接受
`graph_vault/books/*/BOOK_MANIFEST.json`，`graph_vault/catalog`、全局 qmd index
和 retrieval index 只作为可重建投影（derived projection）。

旧 `distribution_manifest.json` 只作为迁移输入或 legacy evidence，不能作为
hot-plug 挂载权威。`PUBLISH_READY.json`、manifest checksum sidecars 和 mount scan
transaction 共同决定是否投影为 mounted 或 query-ready。

### 3. receiver_empty_vault_query

结论：通过。

修订版覆盖接收方空 Vault（empty vault）路径。`mountLifecycle.installByCopy`
定义复制完整目录、扫描 manifest、提交 catalog/qmd projection、通过 readiness
gate 后查询的顺序。`readinessGates.packageStates` 区分 `mounted`、
`mounted_not_qmd_ready`、`mounted_not_graphrag_ready`、`query_ready`、
`quarantined` 和 `incompatible`。

GraphRAG 查询入口通过已提交 mount projection 解析 `bookId`、当前
`packageGeneration` 和包内 `graphrag/output`，并在 gate 失败时返回稳定诊断，不
隐式调用 provider。缺失书级 qmd index 时，`qmdReadyGate.rebuildPolicy` 允许在
接收方本地 `graph_vault/catalog/qmd-book-projections/{bookId}` 重建投影。

### 4. identity_conflict

结论：部分通过。

核心冲突规则已满足。修订版要求同 `bookId` 不同 `sourceHash` fail closed，同
`sourceHash` 不同 `bookId` 作为 duplicate candidate 报告；`conflictIndex`、
`manualConflictDecisionWorkflow` 和 `failClosedRule` 规定模糊身份、重复来源、
残留提升和 package generation replacement 在未形成 durable decision record 前
不得 mounted 或 query-ready，因此不会静默覆盖接收方已有书。

剩余缺口是身份字段语义仍未完全明文化。文档列出 `bookId`、`sourceHash`、
`canonicalTitle`、`titleSlug`、`packageVersion` 和 `packageGeneration`，并说明
`bookId` 识别 package、`sourceHash` 识别 source content，但尚未给出
`packageVersion` 与 `packageGeneration` 的边界、`canonicalTitle`/`titleSlug`
是否仅用于展示与诊断、同 `bookId` 同 `sourceHash` 不同 `packageVersion` 时是
升级包、重导出包、修复包还是替换候选。该项未达到 baseline 中“语义明确”的全部
要求。

### 5. checksum_integrity

结论：通过。

修订版要求 `BOOK_MANIFEST.json`、manifest checksum sidecars、`PUBLISH_READY.json`
和文件级 `bytes`、`sha256`、`required` 标记全部验证通过后才能更新 derived
catalog 或查询索引。缺文件、复制中断、sha mismatch、bytes mismatch、corrupt
sidecar、path traversal、symlink escape 和 forbidden sensitive material 均进入
quarantine 或 fail-closed 状态。

`mountScanTransactionModel` 规定先验证 candidate set，再构建 projection plan，
最后原子提交 catalog 与 qmd projection。失败扫描保留 last-good generation，不暴露
partial projection。

### 6. path_portability

结论：通过。

修订版区分 package-relative path、vault-local runtime path 和 provenance-only
外部路径。`securityExportPolicy.pathSafety` 要求拒绝绝对路径、父目录逃逸、
symlink escape 和包外 hardlink；安全内部 symlink 只有在显式列入且 checksum-bound
时才允许。

`manifestFieldClassification` 与 `sensitiveMaterialTaxonomy` 将
`absoluteLocalPath`、`userHomePath`、`originalInboxPath`、`tempDirectoryPath` 和
`shellCommandCwd` 归为 forbidden 或 private path。接收方不需要发送方用户名、
绝对路径、`graph_vault/input`、`graph_vault/sources` 或 symlink 目标。

### 7. query_readiness_gate

结论：通过。

修订版明确 mounted 与 query-ready 是不同状态。GraphRAG readiness gate 要求最低
artifact closure（最小产物闭包），包括 output manifest、text unit identity、
context、stats、documents/text_units/entities/relationships/communities/
community_reports parquet 和 `graphrag/output/lancedb`。

R3 修订进一步补充 `graphRagArtifactMetadataContract`，要求每个 GraphRAG 产物具备
role、schema、checksum、producer lineage、validation granularity 和 closure
digest。schema 不兼容、lineage 缺失、embedding dimension 不匹配、stale
generation 和 cross-book path 均不得投影为 query-ready。

### 8. privacy_exclusion

结论：通过。

修订版采用 allowlist-first export（允许清单优先导出）。provider requests、
provider responses、raw prompts、raw completions、token usage details、logs、
debug、trace、corrupt files、runtime recovery payload、`.env`、`.npmrc`、
`.netrc`、SSH keys、TLS private keys 和 credentials 默认不可导出。

`sensitiveMaterialTaxonomy.scannerReadPolicy` 明确 import 先读 manifest 与
sidecars 且不读取 sensitive roots，mount scan 不读取 provider roots 或 runtime
payload roots，migration 不读取 raw provider payload，query gate 失败时不发起
provider calls。该设计满足 provider payload/secrets 排除要求。

### 9. receiver_state_isolation

结论：通过。

修订版把共享包默认设为 readonly。接收方诊断、mount 状态、查询缓存、qmd
projection、scan transaction state 和 rebuild 结果写入本地运行态位置，例如
`graph_vault/.local/book-runtime/{bookId}`、
`graph_vault/catalog/mount-scans` 和
`graph_vault/catalog/qmd-book-projections/{bookId}`。

`immutablePackagePolicy` 与 `qmdRebuildTransaction` 均要求运行态写入和重建 SQLite
不进入 package root。该设计保护复制包的校验闭包，满足接收方运行状态隔离。

### 10. implementable_tests

结论：通过。

修订版给出明确模块边界、输入输出、失败状态和测试契约。`implementationPlan`
覆盖 manifest、mount scanner、lifecycle、readiness gates、security、migration、
catalog projection、quarantine repair、large library scan、upgrade paths、qmd
rebuild、GraphRAG artifact metadata、sensitive material policy 和 manual conflict
decision。

`testContracts` 覆盖 copy-only import、empty-vault mounted、删除后卸载、缺失
`PUBLISH_READY.json`、atomic rename、scanner crash、partial projection
prevention、checksum/path/symlink/secret fail-closed、identity conflict、
`reindex_on_mount`、qmd freshness invalidation、GraphRAG minimum closure 和
manual conflict pending state。实现者可据此编写 baseline 要求的自动化测试。

## pass_fail

总体结论：部分通过。portable sharing 的复制、挂载、查询、隐私排除和本地状态隔离
闭包已经成立；仍有 1 个身份字段语义澄清项阻止 10 维全量通过。

| baseline id | R3 结果 | 判定摘要 |
| --- | --- | --- |
| `portable_closure` | 通过 | 单目录闭包和包内相对路径满足要求。 |
| `manifest_authority` | 通过 | `BOOK_MANIFEST.json` 及 sidecars 是挂载权威。 |
| `receiver_empty_vault_query` | 通过 | 空 Vault 复制、扫描、投影与查询入口闭合。 |
| `identity_conflict` | 部分通过 | 冲突 fail-closed 已满足；身份版本字段语义仍需明文化。 |
| `checksum_integrity` | 通过 | 文件级校验、sidecar 校验和事务投影满足要求。 |
| `path_portability` | 通过 | 发送方绝对路径、外部根和路径逃逸被禁止。 |
| `query_readiness_gate` | 通过 | qmd 与 GraphRAG 查询就绪门禁可测试。 |
| `privacy_exclusion` | 通过 | provider payload、secrets、logs 和 runtime payload 默认排除。 |
| `receiver_state_isolation` | 通过 | readonly 包与接收方本地运行态写入分离。 |
| `implementable_tests` | 通过 | 所需 copy-only、empty-vault、checksum、conflict、privacy 和 reindex 测试可实施。 |

## criteria_delta_from_r2

baseline criteria（基准条件）未发生变化；R3 未新增、删除、重排、重命名维度，也未
修改 `passCriteria`。变化只来自 Type DD 在 R2 后新增或补强的设计内容。

- R2 `portable_closure` 已通过，R3 继续通过。R3 新增的 catalog projection schema
  与 sensitive material taxonomy 进一步限制派生输入和导出闭包。
- R2 `manifest_authority` 已通过，R3 继续通过。R3 进一步固定 catalog projection
  字段来源，降低旧 catalog 或 batch state 被误当权威的风险。
- R2 `receiver_empty_vault_query` 已通过，R3 继续通过。R3 新增 qmd rebuild
  transaction 和 GraphRAG artifact metadata，使空 Vault 查询门禁更可实施。
- R2 `identity_conflict` 为部分通过，R3 仍为部分通过。R3 新增 manual conflict
  decision workflow，已补强 fail-closed 和不覆盖接收方已有书；但
  `packageVersion`、`packageGeneration`、`canonicalTitle`、`titleSlug` 的字段语义
  仍未完全明文化。
- R2 `checksum_integrity` 已通过，R3 继续通过。R3 新增 quarantine repair
  validator、stable error codes 和 artifact metadata contract。
- R2 `path_portability` 已通过，R3 继续通过。R3 新增 private path 分类与 scanner
  no-read policy。
- R2 `query_readiness_gate` 已通过，R3 继续通过。R3 新增逐产物 metadata rows、
  validation granularity 和 negative tests。
- R2 `privacy_exclusion` 已通过，R3 继续通过。R3 新增 provider cache、usage
  details、`.npmrc`、`.netrc`、SSH/TLS key 等敏感材料分类。
- R2 `receiver_state_isolation` 已通过，R3 继续通过。R3 新增 qmd rebuild
  transaction，明确 SQLite 重建写在包外 projection root。
- R2 `implementable_tests` 已通过，R3 继续通过。R3 新增多项专项测试矩阵和模块
  边界，使测试契约更完整。

## required_design_changes

达到 10 维全量通过前，需要补充一个身份字段语义表：

- 明确 `bookId`、`sourceHash`、`canonicalTitle`、`titleSlug`、`packageVersion` 和
  `packageGeneration` 的定义、稳定性、生成来源和是否参与冲突判定。
- 明确同 `bookId`、同 `sourceHash`、不同 `packageVersion` 的处理：升级包、
  修复包、重导出包、替换候选或并存候选。
- 明确 `canonicalTitle` 与 `titleSlug` 是展示字段、诊断字段、slug collision
  输入，还是参与 package identity。
- 明确 `packageVersion` 与 manifest `schemaVersion`、`layoutVersion`、
  compatibility schema version 和 `packageGeneration` 的区别。

除上述身份语义项外，本场景未发现必须重写 portable sharing 闭包、manifest authority、
checksum、path portability、query readiness、privacy exclusion、receiver state
isolation 或 test contract 的阻塞性设计变更。

## residual_risks

- source EPUB 默认随包分发仍有授权风险。`sourceRedactionModes` 已提供
  `normalized_input_only`，但默认导出策略需要在产品层确认。
- 不同操作系统的大小写规则、SQLite、LanceDB、parquet reader 和 GraphRAG runtime
  版本差异仍可能导致 visible-not-query-ready（可见但不可查询）。
- 大书在 `reindex_on_mount` 下可能带来明显等待时间。设计已有本地 projection
  transaction，但实现需要提供进度、重试和可取消诊断。
- path、provenance 和 diagnostics 脱敏必须由 schema validator、secret scanner 和
  scanner no-read policy 共同执行，不能只依赖文档约束。
- R3 只复审 Type DD 设计，不证明现有脚本已经实现这些契约。实现阶段仍需以
  `testContracts` 建立自动化回归测试。
