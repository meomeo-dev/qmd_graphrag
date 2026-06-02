# agent-01-portable-sharing R4 复审报告

## scenario

用户把一本已完成书复制给另一位用户。接收方只复制单本书目录后查询，不复制
发送方 `graph_vault/catalog`、`graph_vault/sources`、全局 qmd index、
batch run records、provider payload、provider logs、`.env` 或 secrets。

复审对象：

- 主文档：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 规范性补充文档（normative supplement）：
  `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

## reused_fixed_baseline

本次 R4 复审复用本目录既有 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-01-portable-sharing/baseline.yaml`

固定 10 维如下。未新增、删除、重排、重命名任何维度，未改变任何
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

- baseline SHA-256:
  `6b11491058f988048c1a02b78b908bf5d8abcdec62c3bc24e0981ea77d162bf9`
- R3 同 agent baseline SHA-256:
  `6b11491058f988048c1a02b78b908bf5d8abcdec62c3bc24e0981ea77d162bf9`
- integrity result: 通过。R4 baseline 与 R3 同 agent baseline 字节一致；本次
  复审未覆盖、修改、重排或重命名 `baseline.yaml`。
- confidentiality result: 通过。复审只读取目标 Type DD、R3 规范性补充文档、
  baseline 和上一轮审计报告；未读取 provider payload、provider secrets、
  `.env`、runtime recovery payload 或其他敏感执行材料。

## findings

### 1. portable_closure

结论：通过。

主文档满足单目录可移植闭包（portable closure）。`targetContract.packageRoot`
要求 `graph_vault/books/{bookId}` 包含验证、查询、导出和重挂载所需文件，不依赖
sibling source 或 catalog roots。`targetDirectoryLayout` 将 manifest、checksum
sidecars、`source/`、`input/`、`qmd/`、`graphrag/output/`、`graphrag/runs/`
和脱敏 `state/` 纳入包根。

R3 补充未削弱闭包要求，并通过 `qmdAvailabilityAndReexportPolicy` 明确本地 qmd
projection 默认不混入原包；只有显式 repack（重新打包）才创建新
`packageGeneration` 并重算 manifest 与 sidecars。因此复制单目录后，接收方不需要
发送方外部 source、input、catalog 或 batch run state。

### 2. manifest_authority

结论：通过。

主文档明确 `BOOK_MANIFEST.json` 是单本书挂载权威，checksum sidecars 与
`PUBLISH_READY.json` 共同参与可见性判断。`mountScanner.authoritativeInput`
只接受 `graph_vault/books/*/BOOK_MANIFEST.json`，`graph_vault/catalog`、全局
qmd index 和 retrieval index 均为可重建投影。

主文档还规定旧 `distribution_manifest.json` 只能作为迁移输入或 legacy evidence，
不能作为 hot-plug 挂载权威。R3 补充的 upgrade matrix 和 migration evidence schema
继续保持此边界，未把旧 manifest、全局 catalog 或外部索引提升为权威状态。

### 3. receiver_empty_vault_query

结论：通过。

主文档覆盖接收方空 Vault（empty vault）路径。`mountLifecycle.installByCopy`
规定复制完整目录、扫描 manifest、提交 catalog/qmd projection、通过 readiness gate
后才查询。`readinessGates.packageStates` 与冲突/兼容性 outcome 能表达
`mounted`、更细的 mounted-not-ready 状态、`visible_not_query_ready`、
`quarantined` 和 `incompatible`。

当 `queryReady` 为真时，GraphRAG 查询入口通过已提交 mount projection 解析
`bookId`、当前 `packageGeneration` 和包内 `graphrag/output`。缺失书级 qmd index
时，主文档与 R3 补充均要求在接收方本地 projection root 重建，不要求发送方全局
qmd index 或 batch records。

### 4. identity_conflict

结论：通过。

主文档满足核心冲突行为：同 `bookId` 不同 `sourceHash` fail closed，同
`sourceHash` 不同 `bookId` 报告 duplicate candidate，并通过 `conflictIndex` 与
`manualConflictDecisionWorkflow` 防止覆盖接收方已有书。

R3 补充补齐了 R3 复审中遗留的身份语义缺口。`identityFieldSemantics` 明确
`bookId`、`sourceHash`、`packageVersion`、`packageGeneration`、`canonicalTitle`
和 `titleSlug` 的稳定性、生成来源、可变性、冲突角色和替换规则。其规则把
`canonicalTitle` 与 `titleSlug` 限定为展示/诊断定位字段，把
`packageVersion` 限定为 schema/layout 兼容性字段，把 `packageGeneration` 用于同
`bookId` 的替换世代。因此 baseline 要求的身份字段语义和冲突 fail-closed 均满足。

### 5. checksum_integrity

结论：通过。

主文档要求 `BOOK_MANIFEST.json`、manifest sidecars、`PUBLISH_READY.json`、文件级
`bytes`、`sha256` 和 `required` 标记全部验证通过后，mount scanner 才能更新
derived catalog 或查询索引。缺文件、复制中断、bytes mismatch、sha mismatch、
corrupt sidecar、path traversal、symlink escape 和 forbidden sensitive material
均会进入 quarantine 或 fail-closed 路径。

`mountScanTransactionModel` 要求先验证 candidate set，再构建 projection plan，最后
原子提交投影；失败扫描保留 last-good generation。R3 补充没有降低该门槛，并补充
迁移 evidence 不得依赖 provider payload 或绝对路径。

### 6. path_portability

结论：通过。

主文档区分 package-relative path、vault-local runtime path 和 provenance-only
外部路径。`securityExportPolicy.pathSafety` 要求拒绝绝对路径、父目录逃逸、
symlink escape 和包外 hardlink；安全内部 symlink 也必须显式列入并 checksum-bound。

R3 补充进一步规定 `BOOK_MANIFEST.mount.packageRoot` 永远是包内 locator，值为
`.`；接收方 live vault 绝对路径只能作为 scan-local state，不能进入
`BOOK_MANIFEST.json`。因此接收方无需拥有发送方用户名、绝对路径、
`graph_vault/input`、`graph_vault/sources` 或发送方 symlink 目标。

### 7. query_readiness_gate

结论：通过。

主文档明确 mounted 与 query-ready 是不同状态。GraphRAG readiness gate 要求最低
artifact closure，包括 output manifest、text unit identity、context、stats、
documents/text_units/entities/relationships/communities/community_reports parquet
和 `graphrag/output/lancedb`。qmd gate 要求 included index 或外部 projection fresh。

R3 补充通过 `qmdAvailabilityAndReexportPolicy`、`qmdDiagnosticsSchema` 和主文档的
`graphRagArtifactMetadataContract` 支撑可实施门禁。schema 不兼容、lineage 缺失、
embedding dimension mismatch、stale generation、cross-book path 或 qmd freshness
mismatch 均不得投影为 query-ready。

### 8. privacy_exclusion

结论：通过。

主文档采用 allowlist-first export。provider requests、provider responses、raw
prompts、raw completions、token usage details、logs、debug、trace、corrupt files、
runtime recovery payload、`.env`、`.npmrc`、`.netrc`、SSH keys、TLS private keys
和 credentials 默认不可导出。

R3 补充通过 `providerSensitiveClassExtensions` 和 `scannerNoReadContracts` 明确
provider caches、provider auth config、credential stores 和 reversible provider
interactions 也不可导出、不可作为 query-ready 证明。importer、mount scanner、
compatibility checker 和 query gate 均有 `mustNotRead` 敏感根约束。

### 9. receiver_state_isolation

结论：通过。

主文档把共享包默认设为 readonly。接收方导入诊断、mount 状态、查询缓存、scan
transaction state、qmd projection 和 rebuild 结果写入本地位置，例如
`graph_vault/.local/book-runtime/{bookId}`、`graph_vault/catalog/mount-scans` 和
`graph_vault/catalog/qmd-book-projections/{bookId}`。

R3 补充明确本地 qmd projection 默认不进入 re-export closure；显式 repack 才创建
新 `packageGeneration`，并通过 staging、manifest 重算和 sidecars 重写发布。该设计
不会破坏原复制包的校验闭包。

### 10. implementable_tests

结论：通过。

主文档给出明确模块边界：manifest validator、mount scanner、lifecycle、
readiness gates、security policy、migration、catalog projection、quarantine repair、
upgrade paths、qmd rebuild、GraphRAG artifact metadata、sensitive material policy
和 manual conflict decision。

测试契约覆盖 copy-only import、empty-vault query、缺 `PUBLISH_READY.json`、
checksum mismatch、path/symlink escape、privacy exclusion、identity conflict、
`reindex_on_mount`、GraphRAG minimum closure、query gate 负例和 manual conflict
pending state。R3 补充又增加 identity semantics、upgrade fixtures、
scanner no-read、qmd diagnostics、re-export/repack 和 bridge lifecycle 测试，足以
让实现者编写 baseline 要求的自动化测试。

## pass_fail

总体结论：通过。主文档与 R3 规范性补充合并评估后，portable sharing 的复制、
挂载、查询、完整性校验、隐私排除、冲突处理和接收方状态隔离闭包成立。

| baseline id | R4 结果 | 判定摘要 |
| --- | --- | --- |
| `portable_closure` | 通过 | 单目录闭包、包内相对路径和默认 re-export 闭合。 |
| `manifest_authority` | 通过 | `BOOK_MANIFEST.json` 及 sidecars 是唯一挂载权威。 |
| `receiver_empty_vault_query` | 通过 | 空 Vault 复制后可进入 mounted 或可见但不可查询状态，query-ready 后可查询。 |
| `identity_conflict` | 通过 | R3 补充已明确身份字段语义和 fail-closed 冲突处理。 |
| `checksum_integrity` | 通过 | 文件级校验、manifest 校验、sidecar 校验和事务投影满足要求。 |
| `path_portability` | 通过 | 包内路径、vault-local 路径和 provenance-only 外部路径边界明确。 |
| `query_readiness_gate` | 通过 | qmd 与 GraphRAG 查询就绪门禁及负例可实施。 |
| `privacy_exclusion` | 通过 | provider payload、secrets、logs 和 runtime payload 默认排除且 scanner 不读取。 |
| `receiver_state_isolation` | 通过 | readonly 包与接收方本地运行态、projection、rebuild 写入分离。 |
| `implementable_tests` | 通过 | baseline 所需自动化测试均有模块边界、状态和失败契约支撑。 |

## criteria_delta_from_r3

baseline criteria（基准条件）无变化。R4 baseline 与 R3 同 agent baseline SHA-256
相同，且字节一致；未新增、删除、重排、重命名任何维度，未改变任何
`passCriteria`。

结果变化来自设计文档集合变化，而不是 criteria 变化：

- `identity_conflict` 从 R3 的“部分通过”变为 R4 的“通过”。R3 规范性补充新增
  `identityFieldSemantics`，明确 `bookId`、`sourceHash`、`packageVersion`、
  `packageGeneration`、`canonicalTitle` 和 `titleSlug` 的语义、稳定性与冲突角色。
- 总体结论从 R3 的“部分通过”变为 R4 的“通过”。
- 其他 9 个 baseline 维度保持通过；R3 补充仅加强 no-read、qmd re-export、upgrade
  fixtures、migration evidence 和 compatibility bridge 规则，未降低任何原有门槛。

## required_design_changes

本轮未发现阻塞 R4 通过的必需设计变更。

建议在实现前保持以下非阻塞要求：

- 将 R3 规范性补充中的 `identityFieldSemantics` 合并或强引用到主 Type DD 的
  manifest identity schema，避免实现者只读主文档时遗漏身份字段语义。
- 将 `visible_not_query_ready` 与 `mounted_not_qmd_ready`、
  `mounted_not_graphrag_ready` 的状态映射写入实现层枚举，避免 UI 或 CLI 产生两个
  不一致的不可查询状态族。
- 将 scanner no-read 约束固化为测试夹具（fixture）和 filesystem denylist 测试，
  确认实现不会为计算 readiness 误读 provider roots 或 runtime payload roots。

## residual_risks

- 原始 EPUB 随包分发仍可能有授权风险。设计已有 `sourceRedactionModes`，但默认产品
  策略仍需明确何时使用 `include_source_epub` 或 `normalized_input_only`。
- 不同操作系统的大小写规则、SQLite、LanceDB、parquet reader、GraphRAG runtime
  版本差异仍可能导致包在接收方变为 visible-not-query-ready。
- 大书在 `reindex_on_mount` 下可能产生明显等待时间。设计已有外部 projection 和稳定
  qmd diagnostics，但用户体验需要实现层进度与重试策略。
- R3 补充作为独立规范性文档存在；若未来维护只修改主 Type DD，身份语义、scanner
  no-read 或 re-export 规则可能出现漂移。应在后续实现任务中建立双文档一致性检查。
