# agent-01-portable-sharing R5 固定基准复审报告

## scenario

用户把一本已完成书复制给另一位用户。接收方只复制单本书目录后查询，
不复制发送方 `graph_vault/catalog`、`graph_vault/sources`、全局 qmd
index、batch run records、provider payload、provider logs、`.env` 或 secrets。

复审对象：

- 主文档：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 规范性补充文档（normative supplement）：
  `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

## reused_fixed_baseline

本次 R5 复审复用固定 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-01-portable-sharing/baseline.yaml`

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
- R4 同 agent baseline SHA-256:
  `6b11491058f988048c1a02b78b908bf5d8abcdec62c3bc24e0981ea77d162bf9`
- integrity result: 通过。R5 baseline 与 R4、R3 同 agent baseline 字节一致。
  本次复审未覆盖、修改、重排或重命名 `baseline.yaml`。
- confidentiality result: 通过。复审只读取目标 Type DD、R3 规范性补充文档、
  固定 baseline 和公开审计报告；未读取 provider payload、secrets、`.env`、
  凭据、日志 payload、runtime recovery payload 或私有运行数据。

## findings

### 1. portable_closure

结论：通过。

主文档满足单目录可移植闭包（portable closure）。`targetContract.packageRoot`
要求 `graph_vault/books/{bookId}` 包含验证、查询、导出和重挂载所需文件，
并明确不得依赖 sibling source 或 catalog roots。`targetDirectoryLayout` 将
`BOOK_MANIFEST.json`、manifest checksum sidecars、`source/`、`input/`、
`qmd/`、`graphrag/output/`、`graphrag/runs/` 和脱敏 `state/` 纳入包根。

R3 补充文档未削弱闭包要求。`qmdAvailabilityAndReexportPolicy` 明确本地 qmd
projection 默认不混入原包；只有显式 repack 才创建新 `packageGeneration` 并
重算 manifest 与 sidecars。因此接收方复制单目录后，不需要发送方外部 source、
input、catalog、batch run state 或绝对路径。

### 2. manifest_authority

结论：通过。

主文档明确 `BOOK_MANIFEST.json` 是单本书挂载权威（mount authority），
checksum sidecars 与 `PUBLISH_READY.json` 共同参与可见性判断。
`mountScanner.authoritativeInput` 只接受
`graph_vault/books/*/BOOK_MANIFEST.json`，全局 catalog、全局 qmd index 和
retrieval index 均为可重建投影（derived projections）。

旧 `distribution_manifest.json` 只能作为迁移输入或 legacy evidence，不能成为
hot-plug 挂载权威。R3 补充的 schema upgrade matrix 与 migration evidence
schema 维持该边界，未把旧 manifest、外部 catalog 或外部索引提升为权威状态。

### 3. receiver_empty_vault_query

结论：通过。

主文档覆盖接收方空 Vault（empty vault）路径。`mountLifecycle.installByCopy`
规定复制完整书目录、扫描 manifest、提交 catalog/qmd projection、通过 readiness
gate 后才允许查询。`readinessGates.packageStates` 与兼容性 outcome 能表达
`mounted`、`mounted_not_qmd_ready`、`mounted_not_graphrag_ready`、
`visible_not_query_ready`、`quarantined` 和 `incompatible` 等状态。

当 `queryReady` 为真时，GraphRAG 查询入口通过已提交 mount projection 解析
`bookId`、当前 `packageGeneration` 和包内 `graphrag/output`。缺失书级 qmd index
时，主文档和 R3 补充均要求在接收方本地 projection root 重建，不要求发送方全局
qmd index、catalog 或 batch records。

### 4. identity_conflict

结论：通过。

主文档满足核心冲突行为：同 `bookId` 不同 `sourceHash` fail closed，同
`sourceHash` 不同 `bookId` 报告 duplicate candidate。`conflictIndex` 与
`manualConflictDecisionWorkflow` 防止候选包静默覆盖接收方已有书。

R3 补充文档补齐身份字段语义。`identityFieldSemantics` 明确 `bookId`、
`sourceHash`、`packageVersion`、`packageGeneration`、`canonicalTitle` 和
`titleSlug` 的稳定性、生成来源、可变性、冲突角色和替换规则。`canonicalTitle`
与 `titleSlug` 被限定为展示或诊断定位字段，`packageVersion` 被限定为
schema/layout 兼容性字段，`packageGeneration` 用于同 `bookId` 的替换世代。
该设计满足 baseline 对身份语义明确性和 fail-closed 冲突处理的要求。

### 5. checksum_integrity

结论：通过。

主文档要求 `BOOK_MANIFEST.json`、manifest sidecars、`PUBLISH_READY.json`、
文件级 `bytes`、`sha256` 和 `required` 标记全部验证通过后，mount scanner
才可更新 derived catalog 或查询索引。缺文件、复制中断、bytes mismatch、
sha mismatch、corrupt sidecar、path traversal、symlink escape 和 forbidden
sensitive material 均进入 quarantine 或 fail-closed 路径。

`mountScanTransactionModel` 要求先验证 candidate set，再构建 projection plan，
最后原子提交投影；失败扫描保留 last-good generation。R3 补充文档没有降低该
门槛，并补充迁移 evidence 不得依赖 provider payload 或绝对路径。

### 6. path_portability

结论：通过。

主文档区分 package-relative path、vault-local runtime path 和 provenance-only
外部路径。`securityExportPolicy.pathSafety` 要求拒绝绝对路径、父目录逃逸、
symlink escape 和包外 hardlink；安全内部 symlink 也必须显式列入并
checksum-bound。

R3 补充进一步规定 `BOOK_MANIFEST.mount.packageRoot` 永远是包内 locator，
值为 `.`；接收方 live vault 绝对路径只能作为 scan-local state，不能进入
`BOOK_MANIFEST.json`。因此接收方无需拥有发送方用户名、绝对路径、
`graph_vault/input`、`graph_vault/sources` 或发送方 symlink 目标。

### 7. query_readiness_gate

结论：通过。

主文档明确 mounted 与 query-ready 是不同状态。GraphRAG readiness gate 要求最低
artifact closure，包括 output manifest、text unit identity、context、stats、
documents/text_units/entities/relationships/communities/community_reports
parquet 和 `graphrag/output/lancedb`。qmd gate 要求 included index valid 或
外部 projection fresh。

主文档的 `graphRagArtifactMetadataContract` 要求每个 GraphRAG 产物绑定 role、
schema、checksum、producer lineage 与 validation granularity。R3 补充的
`qmdAvailabilityAndReexportPolicy` 与 `qmdDiagnosticsSchema` 明确 qmd 状态、
本地重建和诊断边界。schema 不兼容、lineage 缺失、embedding dimension mismatch、
stale generation、cross-book path 或 qmd freshness mismatch 均不得投影为
query-ready。

### 8. privacy_exclusion

结论：通过。

主文档采用 allowlist-first export。provider requests、provider responses、
raw prompts、raw completions、token usage details、logs、debug、trace、
corrupt files、runtime recovery payload、`.env`、`.npmrc`、`.netrc`、SSH keys、
TLS private keys 和 credentials 默认不可导出。

R3 补充通过 `providerSensitiveClassExtensions` 和 `scannerNoReadContracts`
明确 provider caches、provider auth config、credential stores 和 reversible
provider interactions 也不可导出、不可列入文件闭包、不可作为 query-ready 证明。
importer、mount scanner、compatibility checker 和 query gate 均有 `mustNotRead`
敏感根约束。

### 9. receiver_state_isolation

结论：通过。

主文档把共享包默认设为 readonly。接收方导入诊断、mount 状态、查询缓存、scan
transaction state、qmd projection 和 rebuild 结果写入本地位置，例如
`graph_vault/.local/book-runtime/{bookId}`、`graph_vault/catalog/mount-scans` 和
`graph_vault/catalog/qmd-book-projections/{bookId}`。

R3 补充明确本地 qmd projection 默认不进入 re-export closure；显式 repack 才创建
新 `packageGeneration`，并通过 staging、manifest 重算和 sidecars 重写发布。
该设计不会破坏原复制包的校验闭包。

### 10. implementable_tests

结论：通过。

主文档给出明确模块边界：manifest validator、mount scanner、lifecycle、
readiness gates、security policy、migration、catalog projection、quarantine
repair、upgrade paths、qmd rebuild、GraphRAG artifact metadata、sensitive
material policy 和 manual conflict decision。

测试契约覆盖 copy-only import、empty-vault query、缺 `PUBLISH_READY.json`、
checksum mismatch、path/symlink escape、privacy exclusion、identity conflict、
`reindex_on_mount`、GraphRAG minimum closure、query gate 负例和 manual conflict
pending state。R3 补充又增加 identity semantics、upgrade fixtures、scanner
no-read、qmd diagnostics、re-export/repack 和 bridge lifecycle 测试，足以让
实现者编写 baseline 要求的自动化测试。

## pass_fail

总体结论：通过。主文档与 R3 规范性补充文档合并评估后，portable sharing 的
复制、挂载、查询、完整性校验、隐私排除、冲突处理和接收方状态隔离闭包成立。

| baseline id | R5 结果 | 判定摘要 |
| --- | --- | --- |
| `portable_closure` | 通过 | 单目录闭包、包内相对路径和默认 re-export 闭合。 |
| `manifest_authority` | 通过 | `BOOK_MANIFEST.json` 及 sidecars 是唯一挂载权威。 |
| `receiver_empty_vault_query` | 通过 | 空 Vault 复制后可 mounted 或 visible-not-query-ready，query-ready 后可查询。 |
| `identity_conflict` | 通过 | 身份字段语义明确，冲突 fail closed 且不覆盖已有书。 |
| `checksum_integrity` | 通过 | 文件级校验、manifest 校验、sidecar 校验和事务投影满足要求。 |
| `path_portability` | 通过 | 包内路径、vault-local 路径和 provenance-only 外部路径边界明确。 |
| `query_readiness_gate` | 通过 | qmd 与 GraphRAG 查询就绪门禁及负例可实施。 |
| `privacy_exclusion` | 通过 | provider payload、secrets、logs 和 runtime payload 默认排除且 scanner 不读取。 |
| `receiver_state_isolation` | 通过 | readonly 包与接收方本地运行态、projection、rebuild 写入分离。 |
| `implementable_tests` | 通过 | baseline 所需自动化测试均有模块边界、状态和失败契约支撑。 |

## criteria_delta_from_previous_run

baseline criteria（基准条件）无变化。R5 baseline 与 R4 同 agent baseline SHA-256
相同，且字节一致；未新增、删除、重排、重命名任何维度，未改变任何
`passCriteria`。

结果变化：无回退。上一轮 R4 portable sharing 已通过，本轮 R5 固定基准复跑仍为
通过。10 个 baseline 维度均保持通过。R3 规范性补充文档继续作为身份语义、scanner
no-read、qmd availability/re-export、qmd diagnostics 和 compatibility bridge
lifecycle 的规范性补充来源。

## required_design_changes

本轮未发现阻塞 R5 通过的必需设计变更。

后续实现前应保持以下非阻塞一致性要求：

- 将 R3 规范性补充中的 `identityFieldSemantics` 强引用到主 Type DD 的
  manifest identity schema，避免实现者只读主文档时遗漏身份字段语义。
- 将 `visible_not_query_ready` 与 `mounted_not_qmd_ready`、
  `mounted_not_graphrag_ready` 的状态映射固化到实现层枚举，避免 CLI、UI 和
  catalog projection 使用不一致状态族。
- 将 scanner no-read 约束固化为 filesystem fixture 和 denylist 测试，确认实现
  不会为计算 readiness 误读 provider roots、credential stores 或 runtime payload
  roots。

## residual_risks

- 原始 EPUB 随包分发仍可能有授权风险。设计已有 `sourceRedactionModes`，但产品
  策略仍需明确何时使用 `include_source_epub` 或 `normalized_input_only`。
- 不同操作系统的大小写规则、SQLite、LanceDB、parquet reader、GraphRAG runtime
  版本差异仍可能导致包在接收方变为 visible-not-query-ready。
- 大书在 `reindex_on_mount` 下可能产生明显等待时间。设计已有外部 projection 和
  稳定 qmd diagnostics，但实现层仍需要进度、取消和重试体验。
- R3 补充作为独立规范性文档存在；若未来维护只修改主 Type DD，身份语义、scanner
  no-read 或 re-export 规则可能漂移。后续实现任务应建立双文档一致性检查。
