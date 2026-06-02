# agent-01-portable-sharing R6 固定基准审计报告

## scenario

用户把一本已完成书复制给另一位用户。接收方只复制单本书目录后查询，
不复制发送方 `graph_vault/catalog`、`graph_vault/sources`、全局 qmd
index、batch run records、provider payload、provider logs、`.env`、凭据
或 secrets。

审计对象：

- 主 Type DD：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 规范性补充文档（normative supplements）：
  `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- 规范性补充文档（normative supplements）：
  `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

## reused_fixed_baseline

本次 R6 审计复用固定 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-01-portable-sharing/baseline.yaml`

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

- R6 baseline SHA-256:
  `6b11491058f988048c1a02b78b908bf5d8abcdec62c3bc24e0981ea77d162bf9`
- R5 同 agent baseline SHA-256:
  `6b11491058f988048c1a02b78b908bf5d8abcdec62c3bc24e0981ea77d162bf9`
- integrity result: 通过。R6 baseline 与上一轮 R5 固定 baseline 字节一致。
  本次审计未覆盖、修改、重排或重命名 `baseline.yaml`。
- confidentiality result: 通过。审计只读取目标 Type DD、R3/R5 规范性补充
  Type DD、固定 baseline 和公开审计报告；未读取 provider payload、
  secrets、`.env`、凭据、日志 payload、runtime recovery payload 或私有
  运行数据。

## findings

### 1. portable_closure

结论：通过。

主 Type DD 要求 `graph_vault/books/{bookId}` 是单本书包权威根目录，包根
必须包含验证、查询、导出和重挂载所需全部文件，且不得依赖 sibling
source、catalog root、batch state 或发送方绝对路径。目标目录布局将
`BOOK_MANIFEST.json`、checksum sidecars、`source/`、`input/`、`qmd/`、
`graphrag/output/`、`graphrag/runs/`、脱敏 `state/` 和 `metadata/`
纳入包闭包（package closure）。

R3 补充维持 readonly 包与本地 qmd projection 的边界，默认再导出只包含
原 package closure；显式 repack 才生成新 `packageGeneration` 并重算
manifest 与 sidecars。R5 补充的 staged importer pre-publish validation
进一步要求完整复制、路径、checksum、schema、身份冲突和敏感字段全部通过后
才允许发布。复制单目录后的闭包仍成立。

### 2. manifest_authority

结论：通过。

主 Type DD 固定 `BOOK_MANIFEST.json` 为单本书挂载权威（mount authority），
`BOOK_MANIFEST.json.sha256`、`.sha256.meta.json` 和 `PUBLISH_READY.json`
参与可见性判断。mount scanner 的 authoritative input 仅为
`graph_vault/books/*/BOOK_MANIFEST.json`；全局 catalog、全局 qmd index 和
retrieval index 均为可重建投影。

旧 `distribution_manifest.json` 只能作为迁移输入或 legacy evidence，不能作为
hot-plug 挂载权威。R5 的 manifest-first direct query resolver 明确 catalog
projection 只是 cache；缺失、stale 或与 manifest digest 不一致时，不能覆盖
manifest、hash、schema 或 lineage 失败。因此 R5 未削弱 manifest 权威，反而补齐
了直接查询场景下的权威边界。

### 3. receiver_empty_vault_query

结论：通过。

主 Type DD 覆盖接收方空 Vault（empty vault）路径：复制完整书目录、mount
scanner 校验 manifest 与 checksum、提交 catalog/qmd projection，并在 readiness
gate 通过后允许查询。package states 能表达 `mounted`、
`mounted_not_qmd_ready`、`mounted_not_graphrag_ready`、`query_ready`、
`quarantined` 和 `incompatible`。

R5 补充进一步解决空 catalog 查询：manifest-first resolver 可在 catalog
projection 缺失时，从包内 `BOOK_MANIFEST.json`、sidecars、GraphRAG artifact
entries、artifact metadata rows 和 redacted producer lineage summaries 计算
`query_ready` 或 `visible_not_query_ready`。provider roots 缺失不会导致
query gate 失败，且 query-ready 为真时可执行 GraphRAG 查询。

### 4. identity_conflict

结论：通过。

主 Type DD 定义同 `bookId` 不同 `sourceHash` 为 fail closed，同 `sourceHash`
不同 `bookId` 为 duplicate candidate，并通过 conflict index 与 manual conflict
decision workflow 防止候选包覆盖接收方已有书。

R3 补充明确 `bookId`、`sourceHash`、`canonicalTitle`、`titleSlug`、
`packageVersion` 与 `packageGeneration` 的稳定性、生成来源、可变性和冲突角色。
R5 的 migration conflict decision table 继续要求同 `bookId` 不同 `sourceHash`
fail closed、同 `sourceHash` 不同 `bookId` duplicate candidate 不挂载，并要求
已有 live root 不得被隐式覆盖。身份与冲突语义满足固定 criteria。

### 5. checksum_integrity

结论：通过。

主 Type DD 要求 manifest checksum、sidecars、`PUBLISH_READY.json`、文件级
`bytes`、`sha256` 和 `required` 标记通过后，mount scanner 才可更新 derived
catalog 或查询索引。缺文件、复制中断、bytes mismatch、sha mismatch、
corrupt sidecar、path traversal、symlink escape 和 forbidden sensitive material
均进入 quarantine 或 fail-closed 路径。

R5 的 importer pre-publish validation 将 checksum 与 byte count 校验前移到
staged import 发布前；direct directory copy 仍必须在 mount scan 通过后才投影。
GraphRAG artifact gate state machine 规定 checksum mismatch 进入 quarantined，
且 catalog projection effect 为 remove 或 never project。校验失败不更新查询面。

### 6. path_portability

结论：通过。

主 Type DD 区分 package-relative path、vault-local runtime path 与
provenance-only 外部路径。export 与 mount validation 必须拒绝绝对路径、父目录
逃逸、symlink escape 和包外 hardlink；内部 symlink 也必须显式列入并
checksum-bound。

R3 补充规定 `BOOK_MANIFEST.mount.packageRoot` 永远是值为 `.` 的包内 locator，
接收方 live vault 绝对路径只能作为 scan-local state。R5 manifest sensitivity
schema 又将 `userHomePath`、`absoluteLocalPath`、`originalAbsoluteSourcePath`、
`createdBy.cwd`、`createdBy.username` 和 path-like `producerRunIds` 列为 forbidden
或 fail-closed。接收方无需拥有发送方用户名、绝对路径、`graph_vault/input`、
`graph_vault/sources` 或发送方 symlink 目标。

### 7. query_readiness_gate

结论：通过。

主 Type DD 清楚区分 mounted 与 query-ready。GraphRAG readiness gate 要求最低
artifact closure，包括 output manifest、text unit identity、context、stats、
documents/text_units/entities/relationships/communities/community_reports
parquet 与 `graphrag/output/lancedb`；qmd gate 要求 included index valid 或外部
projection fresh。

R5 补充增强了 gate 的可实施性。manifest-first resolver 要求验证 manifest
checksum sidecars、包内 GraphRAG artifact paths、required file entries、
artifact metadata rows、producer lineage summaries 和 schema compatibility 后才
计算 readiness。GraphRAG artifact gate state machine 固定 copied、candidate、
validating、validated、mounted、query_ready、visible_not_query_ready、
quarantined 和 rolled_back 的状态与诊断。stale catalog 不能强制 query-ready。

### 8. privacy_exclusion

结论：通过。

主 Type DD 采用 allowlist-first export，并默认排除 provider requests、
provider responses、raw prompts、raw completions、token usage details、logs、
debug、trace、corrupt files、runtime recovery payload、`.env`、`.npmrc`、
`.netrc`、SSH keys、TLS private keys 和 credentials。

R3 补充定义 provider caches、provider auth config、credential stores 与可逆
provider interactions 不可导出、不可列入文件闭包、不可作为 query-ready 证明。
R5 manifest sensitivity schema 将 manifest 未知字段 fail closed，并对
provider payload、full command line、cwd、environment、hostname、username、
stack trace、matched secret text 和 raw log line 建立 forbidden/redacted 边界。
R5 fixed baseline tests 还要求 importer、mount scanner、compatibility checker
和 query gate 均不读取 provider roots。

### 9. receiver_state_isolation

结论：通过。

主 Type DD 将共享包默认设为 readonly。接收方导入诊断、mount 状态、查询缓存、
scan transaction state、qmd projection 和 rebuild 结果写入本地位置，例如
`graph_vault/.local/book-runtime/{bookId}`、`graph_vault/catalog/mount-scans`
和 `graph_vault/catalog/qmd-book-projections/{bookId}`，不写回包校验闭包。

R3 补充要求本地 qmd projection 默认不进入再导出闭包；显式 repack 才创建新
`packageGeneration`。R5 importer pre-publish validation 要求 staged import 失败
时 live root 不变，诊断写入本地 runtime state，不能写入 distributable package
closure。接收方运行状态隔离满足 criteria。

### 10. implementable_tests

结论：通过。

主 Type DD 已给出 manifest validator、mount scanner、package lifecycle、
readiness gates、security policy、migration、catalog projection、qmd rebuild、
GraphRAG artifact metadata、sensitive material policy 和 manual conflict decision
等模块边界，并列出 copy-only import、empty-vault query、checksum mismatch、
identity conflict、privacy exclusion、reindex_on_mount 和 GraphRAG query-ready
负例测试。

R3 补充提供 identity semantics、scanner no-read、qmd diagnostics、re-export 与
bridge lifecycle fixtures。R5 fixed baseline test contracts 进一步给出 manifest
forbidden field、staged importer pre-publish validation、direct copy invalid
candidate、qmd availability matrix、manifest-first direct query、stale catalog、
artifact gate、migration source truth 和 conflict fail-closed 测试。实现者可据此
编写固定 baseline 要求的自动化测试。

## pass_fail

总体结论：通过。主 Type DD、R3 规范性补充文档与 R5 规范性补充文档合并评估后，
portable sharing 场景的复制、挂载、空 Vault 查询、完整性校验、身份冲突、
路径可移植性、隐私排除、接收方状态隔离和可测试性闭包成立。

| baseline id | R6 结果 | 判定摘要 |
| --- | --- | --- |
| `portable_closure` | 通过 | 单目录包含验证、挂载、查询和再导出必需闭包。 |
| `manifest_authority` | 通过 | `BOOK_MANIFEST.json` 及 sidecars 是唯一挂载权威。 |
| `receiver_empty_vault_query` | 通过 | 空 Vault 复制后可 mounted 或 visible-not-query-ready，query-ready 后可查询。 |
| `identity_conflict` | 通过 | 身份字段语义明确，冲突 fail closed 且不覆盖已有书。 |
| `checksum_integrity` | 通过 | manifest、sidecars、文件 sha256、bytes 与 required 标记足以 fail closed。 |
| `path_portability` | 通过 | 包内路径、vault-local 路径和 provenance-only 外部路径边界明确。 |
| `query_readiness_gate` | 通过 | qmd 与 GraphRAG readiness gate 明确，stale catalog 不可强制 query-ready。 |
| `privacy_exclusion` | 通过 | provider payload、secrets、logs 和 runtime payload 默认排除且 scanner 不读取。 |
| `receiver_state_isolation` | 通过 | readonly 包与接收方 runtime、projection、diagnostics、rebuild 写入分离。 |
| `implementable_tests` | 通过 | 固定 baseline 所需测试均有模块、输入输出、失败状态和 fixture 契约支撑。 |

## criteria_delta_from_previous_run

baseline criteria（基准条件）无变化。R6 baseline 与上一轮 R5 同 agent baseline
SHA-256 相同，且字节一致；未新增、删除、重排、重命名任何维度，未改变任何
`passCriteria`。

结果变化：无回退。上一轮 R5 同 agent 审计已通过，本轮 R6 在纳入 R5 规范性补充
文档后仍为通过。10 个固定 baseline 维度均保持通过。

设计证据变化：

- R5 `manifestSensitivitySchema` 强化 `privacy_exclusion`、`path_portability`
  和 `checksum_integrity`，未知 manifest 字段 fail closed。
- R5 `importerPrePublishValidationContract` 强化 `portable_closure`、
  `checksum_integrity` 和 `receiver_state_isolation`，staged import 在 live-root
  rename 前先完成兼容性与敏感字段验证。
- R5 `manifestFirstDirectQueryResolver` 强化 `receiver_empty_vault_query`、
  `manifest_authority` 和 `query_readiness_gate`，catalog projection 缺失时仍可
  由 manifest 与包内 artifact 决定 readiness。
- R5 `fixedBaselineTestContracts` 强化 `implementable_tests`，但不新增任何审计
  维度或 criteria。

## required_design_changes

本轮未发现阻塞 R6 通过的必需设计变更。

后续实现前应保持以下非阻塞一致性要求：

- 将 R5 规范性补充中的 manifest sensitivity、pre-publish validation、
  manifest-first query 和 fixed baseline test contracts 强引用到主 Type DD 的
  `implementationPlan`，避免实现者只读主文档时遗漏 R5 约束。
- 将 `visible_not_query_ready` 与 `mounted_not_qmd_ready`、
  `mounted_not_graphrag_ready` 的状态映射固化到实现层枚举，避免 CLI、UI、
  catalog projection 与 manifest-first resolver 使用不同状态族。
- 将 provider no-read 约束实现为 filesystem fixture 与 denylist/allowlist 测试，
  确认 importer、mount scanner、compatibility checker 和 query gate 不会为
  readiness 读取 provider roots、credential stores 或 runtime payload roots。

## residual_risks

- 原始 EPUB 随包分发仍可能有授权风险。设计已有 source redaction mode，但产品
  策略仍需明确何时使用 `include_source_epub` 或 `normalized_input_only`。
- 不同操作系统的大小写规则、SQLite、LanceDB、parquet reader 和 GraphRAG
  runtime 版本差异仍可能让包在接收方变为 `visible_not_query_ready`。
- 大书在 `reindex_on_mount` 下可能产生等待时间。设计已有外部 projection、
  canonical idempotency key 和 bounded diagnostics，但实现层仍需要进度、取消
  与重试体验。
- R3/R5 作为独立规范性补充文档存在；若未来维护只修改主 Type DD，身份语义、
  scanner no-read、manifest-first query 或 pre-publish validation 规则可能漂移。
  后续实现任务应建立主文档与补充文档的一致性检查。
