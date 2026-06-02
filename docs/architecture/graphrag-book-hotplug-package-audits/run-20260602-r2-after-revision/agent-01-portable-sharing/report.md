# agent-01-portable-sharing R2 复审报告

## scenario

用户把一本已完成书复制给另一位用户。接收方只复制单本书目录后查询，不复制发送方
`graph_vault/catalog`、`graph_vault/sources`、全局 qmd index、batch run records、
provider payload、provider logs 或 secrets。

复审对象为修订后的
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。复审场景限定为
portable sharing（可移植分享）和 copy-only import（仅目录复制导入）。

## reused_fixed_baseline

本次 R2 复审复用既有
`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-01-portable-sharing/baseline.yaml`。
固定 10 维如下，未新增、删除、重命名任何维度，未改变任何 `passCriteria`。

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
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-01-portable-sharing/baseline.yaml`
- baseline SHA-256 before report write:
  `6b11491058f988048c1a02b78b908bf5d8abcdec62c3bc24e0981ea77d162bf9`
- baseline expected SHA-256 after report write:
  `6b11491058f988048c1a02b78b908bf5d8abcdec62c3bc24e0981ea77d162bf9`
- integrity result: 通过。R2 只新增 `report.md`，未覆盖或修改 `baseline.yaml`。
- confidentiality result: 通过。复审未读取 provider payload、provider secrets、
  `.env`、runtime recovery payload 或外部私密材料。

## findings

### 1. portable_closure

结论：通过。

修订版明确 `graph_vault/books/{bookId}` 是权威包根目录，并把 `source/`、
`input/`、`qmd/`、`graphrag/output/`、`graphrag/runs/`、`state/` 纳入目标目录
布局。`completenessRule` 要求包根包含验证、查询、导出和重挂载所需文件，`files`
section 要求必需文件使用 package-relative path（包内相对路径）。

R1 中目录级枚举、半复制、symlink、hardlink、路径逃逸和未知文件规则不足的问题，
已通过 `atomicPackageLifecycle`、`securityExportPolicy.pathSafety` 和
`mountScanTransactionModel.validationPipeline` 补齐。接收方不再依赖 sibling
source、catalog、batch run 或发送方绝对路径。

### 2. manifest_authority

结论：通过。

修订版明确 `BOOK_MANIFEST.json` 是单本书包的挂载权威
（mount authority），`graph_vault/catalog` 与全局索引只是 mount scan 的派生投影
（derived projection）。`mountScanner.authoritativeInput` 只列出
`graph_vault/books/*/BOOK_MANIFEST.json`，旧 `distribution_manifest.json` 只作为
迁移输入和 legacy evidence，不作为 hot-plug 权威。

checksum sidecars、`PUBLISH_READY.json` 和 manifest validation 共同决定是否进入
projection。该设计满足 baseline 对 Manifest 挂载权威的要求。

### 3. receiver_empty_vault_query

结论：通过。

修订版补齐了接收方空 Vault（empty vault）路径。`mountLifecycle.installByCopy`
定义复制、扫描、投影和 readiness gate 顺序；`readinessGates` 区分 `mounted`、
`mounted_not_qmd_ready`、`mounted_not_graphrag_ready`、`query_ready` 和
`incompatible` 等状态；`graphragReadyGate.queryEntrypoint` 规定 query command 按
`bookId` 从已提交 mount projection 解析到当前 `packageGeneration` 的
`graphrag/output`。

qmd index 缺失时，`qmdReadyGate.rebuildPolicy` 规定在
`graph_vault/catalog/qmd-book-projections/{bookId}` 重建本地投影，且不写入 readonly
包。GraphRAG 查询在 gate 失败时返回稳定诊断，并且不会隐式触发 provider calls。

### 4. identity_conflict

结论：部分通过。

修订版保留并强化了关键冲突规则：同 `bookId` 不同 `sourceHash` 必须
`fail_closed`，同 `sourceHash` 不同 `bookId` 必须报告 duplicate candidate，不得
静默覆盖接收方已有书。`sameBookIdNewGeneration` 也被限定为完整验证后替换。

剩余缺口是身份字段语义仍不够完整。`bookId`、`sourceHash`、`canonicalTitle`、
`titleSlug`、`packageVersion` 和 `packageGeneration` 都被列为必需字段，但文档尚未
定义 `packageVersion` 与 `packageGeneration` 的边界、`canonicalTitle`/`titleSlug`
是否只用于展示或也参与冲突诊断，以及同 `bookId`、同 `sourceHash`、不同
`packageVersion` 时是升级、重导出、修复包还是并存候选。

### 5. checksum_integrity

结论：通过。

修订版要求 `BOOK_MANIFEST.json`、manifest checksum sidecars、`PUBLISH_READY.json`
和文件级 `bytes`、`sha256`、`required` 一起通过验证后才允许投影。缺文件、
checksum mismatch、path traversal、symlink escape、corrupt sidecar 等状态均进入
`quarantine_mount_candidate` 或等价 fail-closed 状态。

`mountScanTransactionModel` 规定先构建 projection plan，再原子提交派生 catalog 和
qmd projection。验证失败不得更新 derived catalog 或查询索引，满足完整性与篡改
校验要求。

### 6. path_portability

结论：通过。

修订版把 package-relative path、vault-local runtime path 和 provenance-only 外部
路径分开处理。`securityExportPolicy.pathSafety` 要求拒绝绝对路径、父目录逃逸、
symlink escape 和 package 外 hardlink；`manifestFieldClassification` 明确
`absoluteLocalPath`、`userHomePath`、provider request/response 和 token 等字段为
forbidden。

R1 对 `packageRoot` 可能泄漏发送方绝对路径的担忧已基本消除：导出和 mount
validation 要求 package-relative closure，接收方运行态位置由本地 vault 解析。
实现时仍需把该约束落到 schema validator，禁止 manifest 内出现发送方用户名或
绝对目录。

### 7. query_readiness_gate

结论：通过。

修订版给出了 qmd-ready 与 GraphRAG-ready 两套门禁。GraphRAG 最低 artifact 闭包
（minimum artifact closure）已列出 output manifest、identity map、context、
stats、documents/text_units/entities/relationships/communities/community_reports
parquet 以及 `graphrag/output/lancedb`。producer lineage schema、stage order、
artifact-lineage binding 和 schema compatibility inputs 也已定义。

该设计不再把 query-ready 判断推给下游工具错误，而是在投影前形成可测试的
readiness gate。

### 8. privacy_exclusion

结论：通过。

修订版从 denylist 扩展为 allowlist-first export（允许清单优先导出）。provider
requests、provider responses、logs、corrupt artifacts、runtime recovery payload、
`.env`、secret、credential、token、key、debug、trace 和本地系统文件均被默认
排除或 fail closed。producer evidence 只能导出脱敏摘要，raw prompts、raw
responses、headers、request bodies、response bodies、environment 和 absolute paths
均为 forbidden。

secret scan 诊断只允许输出 path、pattern id 和 byte range class，不输出命中文本。
这满足 baseline 对 provider payload/secrets 排除和 scanner 不读取、不修改 provider
payload roots 的要求。

### 9. receiver_state_isolation

结论：通过。

修订版将共享包默认设为 readonly。接收方本地诊断、mount 状态、查询缓存、qmd
projection 和 scan transaction state 分别写入
`graph_vault/.local/book-runtime/{bookId}`、
`graph_vault/catalog/qmd-book-projections/{bookId}` 和
`graph_vault/catalog/mount-scans`，不进入可分发 package closure。

`immutablePackagePolicy` 明确 runtime writes 不写入 package root。该设计保护包校验
闭包，满足接收方运行状态隔离要求。

### 10. implementable_tests

结论：通过。

修订版列出了模块边界：manifest、mount scanner、package lifecycle、readiness
gates、security、migration、export、import。`testContracts` 覆盖 copy-only import、
empty-vault mounted、missing publish marker、atomic rename、scanner crash、partial
projection prevention、privacy exclusion、secret/path/symlink fail-closed、identity
conflict、`reindex_on_mount`、qmd freshness invalidation、GraphRAG minimum closure
和 legacy migration。

这些契约足以让实现者编写 baseline 要求的自动化测试，包括 copy-only import、
empty-vault query、checksum mismatch、conflict、privacy exclusion 和
reindex_on_mount。

## pass_fail

总体结论：通过，附一个非阻塞性身份语义澄清项。

| baseline id | R2 结果 | 判定摘要 |
| --- | --- | --- |
| `portable_closure` | 通过 | 单目录闭包、半复制隔离和包内路径规则已补齐。 |
| `manifest_authority` | 通过 | `BOOK_MANIFEST.json` 是唯一挂载权威。 |
| `receiver_empty_vault_query` | 通过 | 空 Vault 复制、扫描、投影与查询入口已闭合。 |
| `identity_conflict` | 部分通过 | 核心冲突 fail-closed 已满足；版本与标题字段语义仍需澄清。 |
| `checksum_integrity` | 通过 | manifest、sidecar、文件级校验和事务投影满足要求。 |
| `path_portability` | 通过 | 绝对路径、发送方路径和路径逃逸均被禁止。 |
| `query_readiness_gate` | 通过 | GraphRAG 与 qmd readiness gates 已可测试。 |
| `privacy_exclusion` | 通过 | provider payload、secrets、logs 和 raw evidence 默认不可导出。 |
| `receiver_state_isolation` | 通过 | readonly 包与接收方本地 runtime/projection state 已分离。 |
| `implementable_tests` | 通过 | 模块边界、状态、失败模式和测试契约足够实现自动化测试。 |

R2 阻塞性判定：无阻塞性失败项。

## criteria_delta_from_r1

baseline criteria（基准条件）未发生变化；R2 未新增、删除、重命名维度，也未修改
`passCriteria`。变化只来自 Type DD 修订后的设计内容。

- R1 `portable_closure` 的部分通过，R2 升级为通过。新增的
  `atomicPackageLifecycle`、`PUBLISH_READY.json`、path safety 和 quarantine policy
  补齐了单目录闭包与半复制隔离。
- R1 `manifest_authority` 已通过，R2 继续通过。修订版进一步强化了
  transaction-based projection。
- R1 `receiver_empty_vault_query` 未通过，R2 升级为通过。新增 readiness gates、
  qmd projection rebuild policy 和 GraphRAG query entrypoint。
- R1 `identity_conflict` 部分通过，R2 仍为部分通过。核心冲突规则已满足，但
  `packageVersion`、`packageGeneration` 与标题字段语义仍需实现前澄清。
- R1 `checksum_integrity` 部分通过，R2 升级为通过。新增 checksum last commit、
  changed-set validation、path traversal、symlink escape 和 atomic projection。
- R1 `path_portability` 部分通过，R2 升级为通过。新增 manifest field
  classification、absolute path rejection 和 provenance-only 外部路径约束。
- R1 `query_readiness_gate` 部分通过，R2 升级为通过。新增 GraphRAG minimum
  artifact closure、producer lineage binding 和 compatibility inputs。
- R1 `privacy_exclusion` 部分通过，R2 升级为通过。新增 allowlist-first export、
  denylist defense、secret scan 和 producer evidence redaction。
- R1 `receiver_state_isolation` 部分通过，R2 升级为通过。新增 readonly package、
  `.local/book-runtime`、mount scan state 和 qmd projection state。
- R1 `implementable_tests` 部分通过，R2 升级为通过。新增模块边界和覆盖主要失败
  模式的 test contracts。

## required_design_changes

R2 未发现必须先修改 Type DD 才能进入实现的阻塞性设计变更。

实现前建议完成一项非阻塞性澄清：为 `identity` section 增加字段语义表，明确
`packageVersion` 与 `packageGeneration` 的区别、同身份不同版本的替换策略、
`canonicalTitle`/`titleSlug` 的展示与诊断用途，以及修复包、升级包、重导出包的
冲突处理优先级。

## residual_risks

- source EPUB 默认随包分发仍有授权风险。`sourceRedactionModes` 已提供
  `normalized_input_only`，但默认策略需要在产品层确认。
- 不同操作系统的文件系统大小写、LanceDB 版本和 parquet reader 兼容性仍可能造成
  接收方 visible-but-not-query-ready（可见但不可查询）状态。
- 大书在 `reindex_on_mount` 下可能产生明显等待时间。设计已有 projection rebuild
  policy，但实现需要提供进度和可重试诊断。
- `packageRoot`、provenance 和 diagnostics 的路径脱敏需要由 schema validator 和
  secret scanner 双重执行，不能只依赖文档约束。
- R2 只复审 Type DD 设计，不证明现有脚本已经实现这些契约。实现阶段仍需以
  `testContracts` 建立自动化回归测试。
