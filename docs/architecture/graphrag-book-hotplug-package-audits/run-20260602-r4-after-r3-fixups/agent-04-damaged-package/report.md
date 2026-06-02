# agent-04-damaged-package R4 复审报告

## scenario

用户复制中断导致缺文件、checksum 损坏、半包目录混入
`graph_vault/books`。复审重点是缺少 `BOOK_MANIFEST.json`、缺少 checksum
sidecar、缺少 required artifact、manifest 或文件 checksum 损坏、bytes 不匹配、
正在复制的半包目录、旧 `distribution_manifest.json`-only 目录、空目录或临时目录
被 mount scanner 扫描到时，系统是否 fail closed，是否隔离诊断，是否禁止部分
catalog、qmd index 或 GraphRAG query-ready 投影。

复审对象包括主 Type DD：

`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`

以及规范性补充 Type DD：

`docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

本次复审未读取 provider payload、provider secrets、provider request/response、
`.env`、日志 payload 或其他敏感载荷。

## reused_fixed_baseline

本次 R4 复审复用目标目录中已存在的固定 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/agent-04-damaged-package/baseline.yaml`

baseline SHA-256：

`567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6`

固定 10 个维度如下。未新增、删除、重排、重命名维度，未改变任何
`passCriteria`。

| 序号 | id | name |
| --- | --- | --- |
| 1 | `incomplete_copy_detection` | 复制中断缺文件识别 |
| 2 | `checksum_fail_closed` | Checksum 损坏 Fail Closed |
| 3 | `half_package_isolation` | 半包目录隔离 |
| 4 | `atomic_import_protocol` | 原子导入协议 |
| 5 | `quarantine_state_model` | 隔离状态模型 |
| 6 | `no_partial_projection` | 禁止部分投影 |
| 7 | `recovery_repair_contract` | 恢复与修复契约 |
| 8 | `diagnostics_without_secrets` | 无敏感信息诊断 |
| 9 | `implementable_validator_contract` | 可实施验证器契约 |
| 10 | `damaged_package_tests` | 损坏包自动化测试 |

## baseline_integrity_check

| 检查项 | 结果 |
| --- | --- |
| R4 baseline 是否存在 | Pass |
| baseline SHA-256 | `567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6` |
| 是否复用 R3 agent-04 baseline | Pass，R3 与 R4 SHA-256 一致 |
| 维度数量 | Pass，仍为 10 个 |
| 维度 id 顺序 | Pass，未新增、删除、重排或重命名 |
| `passCriteria` | Pass，未改变 |
| `baseline.yaml` 覆盖状态 | Pass，本次未覆盖 baseline，只新增 `report.md` |
| 敏感载荷读取状态 | Pass，未读取 provider payload、secrets 或日志 payload |

## findings

### F-01 `incomplete_copy_detection`：Pass

主文档满足复制中断缺文件识别要求。`targetContract.mountScanner` 规定 copied
book directory 只有在 `BOOK_MANIFEST.json` 与 checksum sidecars 验证通过后才可
被接受；scanner failure 只产生 mount diagnostics，不得 mutate provider payload
roots。`atomicPackageLifecycle.visibilityRule` 进一步要求缺少有效
`BOOK_MANIFEST.json`、`BOOK_MANIFEST.json.sha256`、
`BOOK_MANIFEST.json.sha256.meta.json` 或 `PUBLISH_READY.json` 的目录必须被
mount scanner 忽略。

`targetDirectoryLayout.required` 定义必需目录和必需根文件，
`bookManifestSchema.files` 要求 required package file 以 package-relative path、
bytes、sha256 和 required 标记进入文件闭包。`incompletePackagePolicy` 覆盖
missing manifest、missing publish marker、missing required file、checksum
mismatch、path traversal、symlink escape 和 corrupt sidecar。R3 补充文档的
`scannerNoReadContracts` 限定 scanner 只读取 manifest、sidecar、publish marker
及文件元数据，不以 provider payload 判断 readiness。损坏 candidate 不会投影
catalog、qmd index 或 GraphRAG query-ready 状态。

### F-02 `checksum_fail_closed`：Pass

主文档满足 checksum 损坏 fail closed 要求。`checksumLastCommitRule` 规定
manifest checksum sidecar 写在 `BOOK_MANIFEST.json` 之后，任意 sidecar mismatch
必须 fail closed 并阻止 projection。`quarantineAndRepairStateMachine` 给出确定性
checksum order：先验证 file bytes，再验证 file sha256，再验证 sidecar 内容和
metadata，再验证 `BOOK_MANIFEST.json` 与 `BOOK_MANIFEST.json.sha256`，最后验证
`PUBLISH_READY.json.manifestSha256`。

稳定错误码覆盖 `file_bytes_mismatch`、`file_sha256_mismatch`、
`sidecar_target_mismatch`、`manifest_sha256_mismatch` 与
`publish_marker_mismatch`。`readinessGates.staleProjectionInvalidation` 将 checksum
validation failure 列为 query-ready capability 失效触发条件，并要求在同一
projection commit 中移除 query-ready，避免旧 catalog 状态掩盖当前损坏。

### F-03 `half_package_isolation`：Pass

主文档满足半包目录隔离要求。直接复制目录只有在 publish marker 和 checksums 全部
验证通过后才可 mount；没有 `PUBLISH_READY.json` 的目录被报告为
`incomplete_copy`，有 manifest 但缺 required file 或 checksum 失败的目录进入
quarantine mount candidate。

旧 `distribution_manifest.json` 被限定为 migration input 或 legacy evidence，不是
hot-plug mount authority。`versionAndMigrationModel` 与 `upgradePathMatrix` 将
legacy manifest、partial qmd、partial GraphRAG、duplicate residue 和 unknown root
区分为 migration、repair、visible-not-query-ready、residue quarantine 或
fail-closed 结果。`residuePolicy.defaultAction` 是 `quarantine_without_delete`；
normal mount scan 忽略 residue candidate，且不会删除用户文件或移动到 provider
payload roots。R3 补充的 `compatibilityBridgeLifecycle` 也要求 legacy bridge
package-relative、临时化、checksum-bound，防止半包污染派生 catalog。

### F-04 `atomic_import_protocol`：Pass

主文档满足原子导入协议要求。`atomicPackageLifecycle.publishProtocol` 明确先在
`importStagingRoot` 或 `buildStagingRoot` 写入 package files，生成 file checksums，
生成 `BOOK_MANIFEST.json`，生成 manifest sidecars，写入 `PUBLISH_READY.json`，
fsync 文件、sidecar、父目录和 staging root，随后 atomic rename 到 live root，
最后运行 mount scanner。

直接复制与 staged import 的关系也已定义：direct copy 可用，但 scanner 只把
publish markers 与 checksums 全部验证通过的目录视为 mount-visible；缺 marker 或
校验失败时只产生 mount candidate diagnostics。`lockLeaseAndStagingCleanup` 覆盖
scanner 在 publisher 写 staging、rename during enumeration、manifest changes after
validation 等并发边界，确保 scanner 不会在非稳定目录上做成功投影。

### F-05 `quarantine_state_model`：Pass

主文档满足隔离状态模型要求。`quarantineAndRepairStateMachine` 定义持久化位置
`graph_vault/catalog/book-quarantine`，状态包括 `detected`、`quarantined`、
`repair_requested`、`repair_staging`、`repair_validating`、`repair_succeeded`、
`repair_failed`、`cleared` 和 `archived`。单条记录通过单一 `state` 字段保持互斥，
并通过 `reasonCode` 与 `validatorErrorCode` 表达缺文件、checksum mismatch、
schema incompatible、copy-in-progress 等原因。

identity conflict 由 `catalogProjectionSchemas.conflictIndex` 与
`manualConflictDecisionWorkflow` 持久化，并在 pending decision 时 fail closed。
record schema 明确 package-relative affected paths、manifest digest、publish marker
digest、repair attempts、clear condition 与 diagnostic digest。repair diagnostics
写入 catalog 或 local runtime roots，不写回 package checksum 闭包，因此 quarantine
不会破坏分发包完整性。

### F-06 `no_partial_projection`：Pass

主文档满足禁止部分投影要求。`mountScanTransactionModel.validationPipeline` 要求先
枚举 candidate，验证 publish marker、manifest sidecars、schema、路径、required
files、checksum、identity conflict 和 compatibility，再 build projection plan。
catalog 与 qmd projection 写入 staging root、checksummed、fsynced 后 atomic replace，
current generation pointer 最后更新。

任何损坏包验证失败时，该 package 只能成为 `not_mounted`、`not_query_ready`、
`quarantined`、`incompatible` 或 pending manual decision，不得产生部分 catalog
entry、部分 qmd projection、部分 GraphRAG locator 或 stale query-ready 标志。
`staleProjectionInvalidation`、`qmdRebuildTransaction` 与
`graphRagArtifactMetadataContract.negativeTests` 共同覆盖 stale generation、
cross-book path 和 partial projection 风险。

### F-07 `recovery_repair_contract`：Pass

主文档满足恢复与修复契约要求。`copyInstallModel.repairRule` 规定重新复制完整包到
incomplete candidate 必须幂等，scanner 只有在 full validation 成功后才记录新
generation。`repairClosure.acceptedInputs` 覆盖 full replacement package、重新生成
`BOOK_MANIFEST.json` 与 sidecars、恢复缺失 required files，以及 source-redacted
repair policy。

恢复成功只能在 fresh mount 使用的同一 validator pipeline 通过并提交新 projection
generation 后成立；恢复失败保留原 quarantine record，并追加 bounded repair attempt
record，不删除 last-good projection。R3 补充的 `scannerNoReadContracts` 与
`missingSensitiveRootsRule` 明确恢复与 readiness 不得依赖 provider payload、credential
store、raw logs 或未声明 batch state。

### F-08 `diagnostics_without_secrets`：Pass

主文档和 R3 补充文档满足无敏感信息诊断要求。`recordSchema.affectedPathsRule`
要求 affected paths 必须 package-relative，禁止 absolute paths、secret text、
provider payload 和 raw log content。`validatorContract.ioLimits` 约束单本书诊断大小
与 affected path 数量，stdout/stderr 只能是 redacted bounded summary。

`securityExportPolicy`、`sensitiveMaterialTaxonomy`、`providerSensitiveClassExtensions`
和 `scannerNoReadContracts` 共同禁止读取或记录 provider requests、provider
responses、provider cache、raw prompts、raw completions、credentials、absolute
private paths、runtime debug traces 和 raw recovery payloads。checksum 差异、schema
错误和状态转移原因均通过稳定错误码、compatibility diagnostics、quarantine
transitions 与 bounded qmd diagnostics 表达。

### F-09 `implementable_validator_contract`：Pass

主文档满足可实施验证器契约要求。validator 输入由 package root、
`BOOK_MANIFEST.json`、`PUBLISH_READY.json`、manifest sidecars、checksum sidecars、
target directory layout 和 manifest `files` 闭包组成；输出由 validation results、
projection plan、commit record、quarantine record、catalog projections 与 diagnostics
digest 组成。

可执行细节覆盖路径规则、遍历规则、校验顺序和错误分类：
`securityExportPolicy.pathSafety` 定义 package-relative、absolute path、parent
traversal、symlink escape 与 hardlink escape 规则；`validatorContract.checksumOrder`
定义 bytes、sha256、sidecar、manifest 和 publish marker 顺序；
`stableErrorCodes` 定义损坏、敏感信息、schema 与 lineage 错误分类。R3 补充文档将
`BOOK_MANIFEST.mount.packageRoot` 收紧为 `"."`，并给出 importer、mount scanner、
compatibility checker 和 query gate 的 no-read contract。实现者可据此编写确定性的
manifest validator、mount scanner 和 import staging 测试。

### F-10 `damaged_package_tests`：Pass

主文档满足损坏包自动化测试要求。`damagedPackageTests.requiredCases` 覆盖 missing
`BOOK_MANIFEST.json`、missing `PUBLISH_READY.json`、missing manifest sidecar、
missing required GraphRAG artifact、file bytes mismatch、sha256 mismatch、sidecar
target mismatch、corrupt YAML/JSON metadata、symlink escape、path traversal、
forbidden secret pattern、failed repair keeps quarantine 和 successful repair commits
new generation。

固定判据中的剩余场景由全局测试契约与 upgrade fixtures 补齐：`implementationPlan`
要求 damaged package validator 对每类 checksum、sidecar、path、symlink、sensitive
material 和 lineage failure 发出稳定错误码；要求缺 `PUBLISH_READY.json` 永不
mounted，staging package 只有 atomic rename 后可见，projection commit 只暴露 old
or new generation，never partial。`schemaVersionUpgradeMatrix.fixtureContracts` 与
`upgradePathMatrix` 覆盖 old manifest-only、partial legacy root、unsupported legacy
schema、恢复后重新挂载和禁止 catalog 污染。

## pass_fail

总体判定：Pass。主 Type DD 与规范性 R3 补充 Type DD 在固定 10 维 baseline 下均满足
agent-04 damaged package 场景的生产设计判据。

| baseline id | R4 结果 | 判定摘要 |
| --- | --- | --- |
| `incomplete_copy_detection` | Pass | 缺 manifest、sidecar、required file 或必需目录不会投影。 |
| `checksum_fail_closed` | Pass | manifest、sidecar、file sha256、bytes 与 publish marker 校验失败均 fail closed。 |
| `half_package_isolation` | Pass | 半包、旧 manifest-only 与 residue 被隔离，不删除用户文件，不污染 catalog。 |
| `atomic_import_protocol` | Pass | staging、publish marker、fsync、atomic rename 与 direct-copy 门禁已定义。 |
| `quarantine_state_model` | Pass | 持久化 state、reason、error code、retry、clear 与 repair closure 已定义。 |
| `no_partial_projection` | Pass | generation transaction、last-good view 与 stale invalidation 阻止部分投影。 |
| `recovery_repair_contract` | Pass | 补齐、重复制、重生成 manifest 或 replacement package 后按同一 validator 恢复。 |
| `diagnostics_without_secrets` | Pass | 诊断使用 package-relative path、错误分类和状态原因，禁止敏感 payload。 |
| `implementable_validator_contract` | Pass | 输入、输出、错误码、路径规则、校验顺序和 no-read contract 足够具体。 |
| `damaged_package_tests` | Pass | 损坏包矩阵、legacy fixtures、repair fixtures 与 projection tests 覆盖固定判据。 |

## criteria_delta_from_r3

baseline criteria 无变化。R4 使用与 R3 agent-04 相同的 10 个 dimension id、name 与
`passCriteria`；未新增、删除、重命名、重排维度，也未改变任何 pass criteria。R3 与
R4 baseline SHA-256 均为：

`567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6`

R4 变化只来自复审范围增加规范性补充文档
`graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`。该补充文档没有放宽 damaged
package 的 fail-closed 规则，反而补强了 package-relative mount locator、scanner
no-read contract、schema upgrade fixtures、qmd diagnostics、re-export/repack staging
和 compatibility bridge lifecycle。

| baseline id | R3 结果 | R4 结果 | delta |
| --- | --- | --- | --- |
| `incomplete_copy_detection` | Pass | Pass | 无 criteria 变化；R3 fixups 补强 scanner no-read。 |
| `checksum_fail_closed` | Pass | Pass | 无 criteria 变化；checksum order 与 fail-closed 规则保持。 |
| `half_package_isolation` | Pass | Pass | 无 criteria 变化；bridge lifecycle 补强 legacy 半包隔离。 |
| `atomic_import_protocol` | Pass | Pass | 无 criteria 变化；repack 也被要求走 staging publish。 |
| `quarantine_state_model` | Pass | Pass | 无 criteria 变化；identity 与 migration diagnostics 更明确。 |
| `no_partial_projection` | Pass | Pass | 无 criteria 变化；qmd availability matrix 保持非 partial 行为。 |
| `recovery_repair_contract` | Pass | Pass | 无 criteria 变化；sensitive roots 不得成为恢复依赖。 |
| `diagnostics_without_secrets` | Pass | Pass | 无 criteria 变化；provider sensitive classes 与 no-read contract 增强。 |
| `implementable_validator_contract` | Pass | Pass | 无 criteria 变化；packageRoot `"."` 与 actor read rules 更可实施。 |
| `damaged_package_tests` | Pass | Pass | 无 criteria 变化；upgrade fixtures 与 qmd diagnostics tests 补强覆盖。 |

## required_design_changes

无阻断性 required design changes。按固定 baseline，主 Type DD 与 R3 规范性补充文档已
满足 agent-04 damaged package 场景。

实现落地时必须保持以下已通过的设计边界，避免实现偏离：

1. 将 validator error codes 固化为共享枚举，scanner、quarantine repair、CLI/UI
   diagnostics 和测试不得各自定义不兼容错误码。
2. 将 bytes、file sha256、sidecar、manifest sha256 与 publish marker 校验实现为
   单一 validator pipeline；任一失败都必须 fail closed。
3. 将 damaged package fixture matrix 拆成可复用用例，分别断言不 mounted、不
   query-ready、不写 partial projection、last-good view 保持可读。
4. 将 diagnostics redaction 与 no-read contract 做成共享安全层，禁止实现为了
   debug 读取 provider payload、credential store、raw logs 或 absolute private path。
5. 将 direct copy、staged import、repair repack 和 qmd projection rebuild 都纳入
   generation-based transaction，禁止任何流程绕过 atomic publish 或 projection commit。

## residual_risks

1. 本次复审对象是设计文档，不包含代码实现审计；实现阶段仍需验证所有 validator、
   scanner、repair 和 projection modules 是否严格遵守同一状态机。
2. `damagedPackageTests` 中的 generic `sha256 mismatch` 在实现时必须拆成 manifest
   checksum mismatch、file checksum mismatch、sidecar target mismatch 和 publish
   marker mismatch，避免测试粒度不足。
3. normal scan 允许 unchanged packages 使用 digest metadata；实现必须正确触发
   suspicious metadata 与 audit mode，否则外部磁盘腐坏可能延迟到周期审计才暴露。
4. compatibility bridge、legacy locator 与 symlink 支持必须保持临时、package-relative
   和 checksum-bound；任何默认导出 bridge 的实现都会重新引入半包污染风险。
5. qmd rebuild 和 repair diagnostics 写在 package 外部；实现需保证这些 local state 不被
   re-export 为新 package，除非显式 repack 并生成新的 packageGeneration。
