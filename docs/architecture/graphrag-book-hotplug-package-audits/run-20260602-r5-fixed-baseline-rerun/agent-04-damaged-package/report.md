# agent-04-damaged-package R5 固定基准审计报告

## scenario

用户复制中断导致缺文件、checksum 损坏、半包目录混入
`graph_vault/books`。

审计对象包括主 Type DD：

`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`

以及规范性补充 Type DD：

`docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`

固定场景覆盖缺少 `BOOK_MANIFEST.json`、缺少 checksum sidecar、缺少
`required=true` artifact、manifest checksum mismatch、文件 checksum mismatch、
bytes mismatch、正在复制的半包目录、旧 `distribution_manifest.json`-only 目录、
空目录或临时目录。审计仅判断设计文档是否满足固定 10 个
`passCriteria`，不评估代码实现。

本次审计未读取 provider payload、provider requests、provider responses、
secrets、`.env`、凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

本次 R5 审计复用指定固定 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/agent-04-damaged-package/baseline.yaml`

baseline SHA-256：

`567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6`

固定 10 个维度如下。未新增、删除、重排或重命名审计维度，未创建新基准，
未修改 `baseline.yaml`。

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
| R5 baseline 是否存在 | Pass |
| baseline SHA-256 | `567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6` |
| 是否复用固定同场景 baseline | Pass，R5、R4、R3 同场景 baseline SHA-256 一致 |
| 维度数量 | Pass，仍为 10 个 |
| 维度 id 顺序 | Pass，未新增、删除、重排或重命名 |
| `passCriteria` | Pass，未改变 |
| `baseline.yaml` 覆盖状态 | Pass，本次未修改 baseline |
| 敏感载荷读取状态 | Pass，未读取 provider payload、secrets、`.env` 或日志 payload |

## findings

### F-01 `incomplete_copy_detection`：Pass

主文档满足复制中断缺文件识别要求。`targetContract.mountScanner` 要求
copied book directory 只有在 `BOOK_MANIFEST.json` 与 checksum sidecars 验证
通过后才可被接受；scanner failure 只产生 mount diagnostics，不得 mutate
provider payload roots。`atomicPackageLifecycle.visibilityRule` 要求缺少有效
`BOOK_MANIFEST.json`、`BOOK_MANIFEST.json.sha256`、
`BOOK_MANIFEST.json.sha256.meta.json` 或 `PUBLISH_READY.json` 的目录被
mount scanner 忽略。

`targetDirectoryLayout.required` 定义必需目录和必需根文件。
`bookManifestSchema.files` 要求每个 required package file 使用 package-relative
path、bytes、sha256 和 required 标记进入文件闭包。`incompletePackagePolicy`
覆盖 missing manifest、missing publish marker、missing required file、checksum
mismatch、path traversal、symlink escape 和 corrupt sidecar。R3 补充文档的
`scannerNoReadContracts` 限定 scanner 只读取 manifest、sidecar、publish marker
及文件元数据，不用 provider payload 判断 readiness。

结论：缺文件或复制中断 candidate 不会投影 catalog、qmd index 或 GraphRAG
query-ready 状态。

### F-02 `checksum_fail_closed`：Pass

主文档满足 checksum 损坏 fail closed 要求。`checksumLastCommitRule` 规定
manifest checksum sidecar 写在 `BOOK_MANIFEST.json` 之后，任意 sidecar
mismatch 必须 fail closed 并阻止 projection。`quarantineAndRepairStateMachine`
给出确定性 checksum order：先验证 file bytes，再验证 file sha256，再验证
sidecar 内容和 metadata，再验证 `BOOK_MANIFEST.json` 与
`BOOK_MANIFEST.json.sha256`，最后验证 `PUBLISH_READY.json.manifestSha256`。

稳定错误码覆盖 `file_bytes_mismatch`、`file_sha256_mismatch`、
`sidecar_target_mismatch`、`manifest_sha256_mismatch` 与
`publish_marker_mismatch`。`readinessGates.staleProjectionInvalidation` 将
checksum validation failure 列为 query-ready capability 失效触发条件，并要求在
同一 projection commit 中移除 query-ready。

结论：manifest sidecar、manifestSha256、文件级 sha256 或 bytes 任一校验失败
时，设计要求 fail closed，且不会用旧 catalog 状态掩盖损坏。

### F-03 `half_package_isolation`：Pass

主文档满足半包目录隔离要求。直接复制目录只有在 publish marker 和 checksums
全部验证通过后才可 mount；没有 `PUBLISH_READY.json` 的目录被报告为
`incomplete_copy`，有 manifest 但缺 required file 或 checksum 失败的目录进入
quarantine mount candidate。

旧 `distribution_manifest.json` 被限定为 migration input 或 legacy evidence，
不是 hot-plug mount authority。`versionAndMigrationModel` 与 `upgradePathMatrix`
将 legacy manifest、partial qmd、partial GraphRAG、duplicate residue 和 unknown
root 区分为 migration、repair、visible-not-query-ready、residue quarantine 或
fail-closed 结果。`residuePolicy.defaultAction` 是
`quarantine_without_delete`；normal mount scan 忽略 residue candidate。

结论：半包、临时目录、空目录、结构不完整目录或 legacy-only 目录不会被删除、
不会移动到 provider payload roots，也不会污染 derived catalog。

### F-04 `atomic_import_protocol`：Pass

主文档满足原子导入协议要求。`atomicPackageLifecycle.publishProtocol` 明确先在
`importStagingRoot` 或 `buildStagingRoot` 写入 package files，生成 file
checksums，生成 `BOOK_MANIFEST.json`，生成 manifest sidecars，写入
`PUBLISH_READY.json`，fsync 文件、sidecar、父目录和 staging root，随后 atomic
rename 到 live root，最后运行 mount scanner。

直接复制与 staged import 的关系也已定义：direct copy 可用，但 scanner 只把
publish markers 与 checksums 全部验证通过的目录视为 mount-visible；缺 marker
或校验失败时只产生 mount candidate diagnostics。`lockLeaseAndStagingCleanup`
覆盖 scanner 在 publisher 写 staging、rename during enumeration、manifest
changes after validation 等并发边界。

结论：scanner 不会在复制过程中的非稳定目录上做成功投影。

### F-05 `quarantine_state_model`：Pass

主文档满足隔离状态模型要求。`quarantineAndRepairStateMachine` 定义持久化位置
`graph_vault/catalog/book-quarantine`，状态包括 `detected`、`quarantined`、
`repair_requested`、`repair_staging`、`repair_validating`、
`repair_succeeded`、`repair_failed`、`cleared` 和 `archived`。单条记录通过
单一 `state` 字段保持互斥，并通过 `reasonCode` 与 `validatorErrorCode` 表达
缺文件、checksum mismatch、schema incompatible、copy-in-progress 等原因。

identity conflict 由 `catalogProjectionSchemas.conflictIndex` 与
`manualConflictDecisionWorkflow` 持久化，并在 pending decision 时 fail closed。
record schema 明确 package-relative affected paths、manifest digest、publish
marker digest、repair attempts、clear condition 与 diagnostic digest。repair
diagnostics 写入 catalog 或 local runtime roots，不写回 package checksum 闭包。

结论：隔离状态可持久化、互斥、可诊断、可重试并可清除，且 quarantine 不破坏包
checksum 闭包。

### F-06 `no_partial_projection`：Pass

主文档满足禁止部分投影要求。`mountScanTransactionModel.validationPipeline`
要求先枚举 candidate，验证 publish marker、manifest sidecars、schema、路径、
required files、checksum、identity conflict 和 compatibility，再 build
projection plan。catalog 与 qmd projection 写入 staging root、checksummed、
fsynced 后 atomic replace，current generation pointer 最后更新。

任何损坏包验证失败时，该 package 只能成为 `not_mounted`、
`not_query_ready`、`quarantined`、`incompatible` 或 pending manual decision。
`staleProjectionInvalidation` 要求 package generation、manifestSha256、checksum
validation failure、schema compatibility change、package root deletion、qmd
freshness change 与 GraphRAG lineage change 在同一 projection commit 中移除
query-ready capability。

结论：损坏包不得产生部分 catalog entry、部分 qmd projection、部分 GraphRAG
locator 或 stale query-ready 标志；已有投影必须失效或标记 unavailable，且原因
可追踪。

### F-07 `recovery_repair_contract`：Pass

主文档满足恢复与修复契约要求。`copyInstallModel.repairRule` 规定重新复制完整包
到 incomplete candidate 必须幂等，scanner 只有在 full validation 成功后才记录
新 generation。`repairClosure.acceptedInputs` 覆盖 full replacement package、
重新生成 `BOOK_MANIFEST.json` 与 sidecars、恢复缺失 required files，以及
source-redacted repair policy。

恢复成功只能在 fresh mount 使用的同一 validator pipeline 通过并提交新
projection generation 后成立；恢复失败保留原 quarantine record，并追加 bounded
repair attempt record，不删除 last-good projection。R3 补充的
`scannerNoReadContracts` 与 `missingSensitiveRootsRule` 明确恢复与 readiness
不得依赖 provider payload、credential store、raw logs 或未声明 batch state。

结论：补齐缺文件、重新复制、重新生成 manifest 或重新导出后的恢复路径明确，
且不要求读取 provider payload。

### F-08 `diagnostics_without_secrets`：Pass

主文档和 R3 补充文档满足无敏感信息诊断要求。
`recordSchema.affectedPathsRule` 要求 affected paths 必须 package-relative，
禁止 absolute paths、secret text、provider payload 和 raw log content。
`validatorContract.ioLimits` 约束单本书诊断大小与 affected path 数量，
stdout/stderr 只能是 redacted bounded summary。

`securityExportPolicy`、`sensitiveMaterialTaxonomy`、
`providerSensitiveClassExtensions` 和 `scannerNoReadContracts` 共同禁止读取或记录
provider requests、provider responses、provider cache、raw prompts、raw
completions、credentials、absolute private paths、runtime debug traces 和 raw
recovery payloads。checksum 差异、schema 错误和状态转移原因均通过稳定错误码、
compatibility diagnostics、quarantine transitions 与 bounded qmd diagnostics 表达。

结论：损坏包诊断可包含缺失路径、checksum 差异类型、schema 错误和状态转移原因，
但不得读取或记录敏感载荷。

### F-09 `implementable_validator_contract`：Pass

主文档满足可实施验证器契约要求。validator 输入由 package root、
`BOOK_MANIFEST.json`、`PUBLISH_READY.json`、manifest sidecars、checksum
sidecars、target directory layout 和 manifest `files` 闭包组成；输出由
validation results、projection plan、commit record、quarantine record、catalog
projections 与 diagnostics digest 组成。

可执行细节覆盖路径规则、遍历规则、校验顺序和错误分类：
`securityExportPolicy.pathSafety` 定义 package-relative、absolute path、parent
traversal、symlink escape 与 hardlink escape 规则；
`validatorContract.checksumOrder` 定义 bytes、sha256、sidecar、manifest 和
publish marker 顺序；`stableErrorCodes` 定义损坏、敏感信息、schema 与 lineage
错误分类。R3 补充文档将 `BOOK_MANIFEST.mount.packageRoot` 收紧为 `"."`，并给出
importer、mount scanner、compatibility checker 和 query gate 的 no-read contract。

结论：实现者可据此编写确定性的 manifest validator、mount scanner 和 import
staging 测试。

### F-10 `damaged_package_tests`：Pass

主文档满足损坏包自动化测试要求。`damagedPackageTests.requiredCases` 覆盖
missing `BOOK_MANIFEST.json`、missing `PUBLISH_READY.json`、missing manifest
sidecar、missing required GraphRAG artifact、file bytes mismatch、sha256
mismatch、sidecar target mismatch、corrupt YAML/JSON metadata、symlink escape、
path traversal、forbidden secret pattern、failed repair keeps quarantine 和
successful repair commits new generation。

固定判据中的剩余场景由全局测试契约与 upgrade fixtures 补齐：
`implementationPlan.testContracts` 要求 damaged package validator 对每类 checksum、
sidecar、path、symlink、sensitive material 和 lineage failure 发出稳定错误码；
要求缺 `PUBLISH_READY.json` 永不 mounted，staging package 只有 atomic rename 后
可见，projection commit 只暴露 old or new generation，never partial。
`schemaVersionUpgradeMatrix.fixtureContracts` 与 `upgradePathMatrix` 覆盖 old
manifest-only、partial legacy root、unsupported legacy schema、恢复后重新挂载和
禁止 catalog 污染。

结论：缺 manifest、缺 sidecar、缺 required artifact、manifest checksum
mismatch、文件 checksum mismatch、bytes mismatch、半复制目录、旧 manifest-only
目录、恢复后重新挂载和禁止 catalog 污染均有测试契约覆盖。

## pass_fail

| 序号 | id | 结果 |
| --- | --- | --- |
| 1 | `incomplete_copy_detection` | Pass |
| 2 | `checksum_fail_closed` | Pass |
| 3 | `half_package_isolation` | Pass |
| 4 | `atomic_import_protocol` | Pass |
| 5 | `quarantine_state_model` | Pass |
| 6 | `no_partial_projection` | Pass |
| 7 | `recovery_repair_contract` | Pass |
| 8 | `diagnostics_without_secrets` | Pass |
| 9 | `implementable_validator_contract` | Pass |
| 10 | `damaged_package_tests` | Pass |

总体结论：Pass。两份设计文档作为整体满足固定 10 个 passCriteria。

## criteria_delta_from_previous_run

与上一轮可用同场景审计
`run-20260602-r4-after-r3-fixups/agent-04-damaged-package/report.md` 相比：

| 项目 | Delta |
| --- | --- |
| baseline SHA-256 | 无变化，仍为 `567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6` |
| baseline 维度数量 | 无变化，仍为 10 个 |
| baseline 维度顺序 | 无变化 |
| passCriteria 文本 | 无变化 |
| Pass/Fail 结果 | 无变化，10 项均为 Pass |
| 规范性补充文档纳入状态 | 无变化，R3 fixups 作为规范性补充一起评估 |

本轮没有新增审计维度、删除审计维度、重排审计维度、重命名审计维度或创建新基准。

## required_design_changes

无强制设计变更。主 Type DD 与 R3 规范性补充文档已覆盖固定基准要求的
损坏包识别、checksum fail closed、半包隔离、原子导入、隔离状态、禁止部分投影、
恢复修复、无敏感信息诊断、可实施 validator 契约和损坏包测试契约。

建议在进入实现阶段时保持以下设计约束不降级：

- `PUBLISH_READY.json`、manifest sidecar 和 file closure 必须全部验证后才能投影。
- quarantine、repair diagnostics 和 local runtime state 不得写入 package checksum
  闭包。
- scanner、compatibility checker 和 query gate 不得读取 provider payload、secrets、
  raw logs 或 absolute private paths。
- damaged package fixtures 必须逐项绑定稳定错误码和 projection non-mutation 断言。

## residual_risks

| 风险 | 性质 | 说明 |
| --- | --- | --- |
| 实现未审计 | 非设计阻断 | 本报告只审计 Type DD，不证明代码已实现这些契约。 |
| 事务边界依赖文件系统语义 | 非设计阻断 | atomic rename、fsync、lock lease 和 generation pointer 需要实现层按平台验证。 |
| 大包 checksum 成本 | 非设计阻断 | 设计已有 changed-set 与 audit mode，但实现需证明性能预算和 fail-closed 行为。 |
| 诊断脱敏一致性 | 非设计阻断 | 设计禁止敏感载荷读取和记录，仍需测试覆盖 reporter、validator、scanner 的全部输出路径。 |
| legacy 迁移分类 | 非设计阻断 | legacy-only、partial qmd、partial GraphRAG 和 duplicate residue 已有矩阵，但实现需要 fixture 驱动验证。 |

这些残余风险不改变本次固定 10 维设计审计结论。
