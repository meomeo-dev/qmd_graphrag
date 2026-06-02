# agent-04-damaged-package R6 固定基准设计审计报告

## scenario

用户复制中断导致缺文件、checksum 损坏、半包目录混入
`graph_vault/books`。

审计对象为以下规范性 Type DD 文档：

- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

本报告只评估设计文档是否满足固定 10 个 `passCriteria`。未评估代码实现，
未读取 provider payload、provider requests、provider responses、secrets、
`.env`、凭据、日志 payload 或私有运行数据。

## reused_fixed_baseline

复用固定 baseline：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-04-damaged-package/baseline.yaml`

baseline SHA-256：

`567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6`

固定维度如下。未新增、删除、重排或重命名审计维度，未创建新基准。

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
| baseline 文件存在 | Pass |
| baseline SHA-256 | `567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6` |
| 与 R5 同场景 baseline SHA-256 一致 | Pass |
| 维度数量 | Pass，10 个 |
| 维度 id 顺序 | Pass，未重排 |
| 维度名称 | Pass，未重命名 |
| `passCriteria` 文本 | Pass，未改变 |
| baseline 修改状态 | Pass，未修改 `baseline.yaml` |
| 敏感载荷读取状态 | Pass，未读取 provider payload、secrets、`.env`、凭据或日志 payload |

## findings

### F-01 `incomplete_copy_detection`: Pass

主 Type DD 要求 copied book directory 只有在 `BOOK_MANIFEST.json` 与 checksum
sidecars 验证通过后才可被 mount scanner 接受。`visibilityRule` 明确缺少有效
`BOOK_MANIFEST.json`、`BOOK_MANIFEST.json.sha256`、
`BOOK_MANIFEST.json.sha256.meta.json` 或 `PUBLISH_READY.json` 的目录必须被
scanner 忽略。`bookManifestSchema.files` 要求每个 required package file
使用 package-relative path、bytes、sha256 与 required 标记进入闭包。

R5 补充文档进一步规定 direct directory copy 的 live-root candidate 初始状态为
`copied_unvalidated`，只有 mount scan validation 成功后才能投影 catalog。
结论：缺 manifest、缺 sidecar、缺必需目录或缺 required file 的复制中断目录只会
成为未挂载 damaged candidate，不会产生 catalog、qmd index 或 GraphRAG
query-ready 投影。

### F-02 `checksum_fail_closed`: Pass

主 Type DD 的 `checksumLastCommitRule` 要求 manifest checksum sidecars 在
`BOOK_MANIFEST.json` 之后写入，任意 sidecar mismatch 必须 fail closed 并阻止
projection。`quarantineAndRepairStateMachine.validatorContract.checksumOrder`
定义了 file bytes、file sha256、file sidecar、sidecar metadata、
`BOOK_MANIFEST.json.sha256` 与 `PUBLISH_READY.json.manifestSha256` 的校验顺序。

稳定错误码覆盖 `file_bytes_mismatch`、`file_sha256_mismatch`、
`sidecar_target_mismatch`、`manifest_sha256_mismatch` 与
`publish_marker_mismatch`。R5 的 GraphRAG artifact gate 将 checksum mismatch
转入 `quarantined`，catalog projection effect 为 `remove_or_never_project`。
结论：manifest sidecar、manifestSha256、文件级 sha256 或 bytes 任一失败时，
设计要求 fail closed，且旧 catalog 状态不能掩盖损坏。

### F-03 `half_package_isolation`: Pass

主 Type DD 将缺 `PUBLISH_READY.json` 的目录分类为 `incomplete_copy`，将缺
required file、checksum mismatch、path traversal、symlink escape 与 corrupt
sidecar 分类为 `quarantine_mount_candidate`。直接复制目录必须在 publish marker
和 checksum 验证通过后才能 mount。旧 `distribution_manifest.json` 只可作为
migration input 或 legacy evidence，不是 hot-plug mount authority。

迁移和 residue 规则要求 legacy-only、partial qmd、partial GraphRAG、duplicate
residue 和 unknown root 隔离为 repair、visible-not-query-ready、
residue quarantine 或 fail-closed 状态。默认动作为
`quarantine_without_delete`，normal mount scan 忽略 residue candidate。结论：
正在复制、临时目录名、空目录、部分层级或旧 manifest-only 半包不会被删除，不会
移动到 provider payload roots，也不会污染 derived catalog。

### F-04 `atomic_import_protocol`: Pass

主 Type DD 定义 staged import 与 build staging 的发布顺序：先在 staging root
写入 package files，生成 file checksums，生成 `BOOK_MANIFEST.json`，生成
manifest sidecars，写入 `PUBLISH_READY.json`，fsync 文件、sidecars、父目录和
staging root，再 atomic rename 到 live root 并运行 mount scanner。

R5 补充文档强化 importer-controlled publish：staged import 必须先完成 manifest
schema、manifest checksum sidecar、package-relative paths、symlink/hardlink
escape、required file、file checksum、bytes、schema compatibility、identity
conflict、manifest sensitivity 与 producer evidence redaction 校验，随后写入
`IMPORT_VALIDATED.json` 并通过 fencing token 发布。direct copy 不是 staged
import，验证失败只产生 fail-closed candidate diagnostic。结论：scanner 不会在
复制过程中的非稳定目录上做成功投影。

### F-05 `quarantine_state_model`: Pass

主 Type DD 定义 `graph_vault/catalog/book-quarantine` 为持久化隔离状态根，
状态包括 `detected`、`quarantined`、`repair_requested`、`repair_staging`、
`repair_validating`、`repair_succeeded`、`repair_failed`、`cleared` 与
`archived`。单条记录通过 `state` 字段保持互斥，通过 `reasonCode`、
`validatorErrorCode`、`affectedPaths`、`manifestSha256`、
`publishMarkerSha256`、`repairAttempts` 与 `clearCondition` 表达诊断、重试和
清除条件。

缺文件、checksum mismatch、schema incompatible、copy-in-progress 均有稳定分类。
identity conflict 由 conflict index 与 manual decision workflow fail closed。
诊断写入 catalog 或 local runtime state，不写入 package root，也不改变 package
checksum 闭包。结论：隔离状态模型满足互斥、持久化、诊断位置、重试条件、清除
条件和 checksum 闭包保护要求。

### F-06 `no_partial_projection`: Pass

`mountScanTransactionModel.validationPipeline` 要求先枚举 candidate，再验证 publish
marker、manifest sidecars、schema、package-relative paths、required file、
checksums、identity conflicts 与 compatibility，之后才构建 projection plan。
catalog 与 qmd projection 写入 staging root、checksummed、fsynced 后 atomic
replace，current-generation pointer 最后更新。失败 scan 保留 last-good reader
view。

`staleProjectionInvalidation` 要求 packageGeneration、manifestSha256、checksum
validation failure、schema compatibility change、package root deletion、qmd
freshness input change 与 GraphRAG lineage binding change 在同一 projection
commit 中移除 query-ready capability。R5 的 GraphRAG gate 明确 copied、
candidate、validating 与 quarantined 状态均不可 query。结论：损坏包不会产生部分
catalog entry、部分 qmd projection、部分 GraphRAG locator 或 stale query-ready
标志；已有投影必须失效或标记 unavailable，且原因可追踪。

### F-07 `recovery_repair_contract`: Pass

主 Type DD 的 `copyInstallModel.repairRule` 要求重新复制完整包覆盖 incomplete
candidate 必须幂等，scanner 只有在 full validation 成功后记录新 generation。
`repairClosure.acceptedInputs` 覆盖 full replacement package、重新生成
`BOOK_MANIFEST.json` 和 sidecars、恢复缺失 required files，以及 source-redacted
repair policy。恢复成功必须通过 fresh mount 使用的同一 validator pipeline，并
提交新 projection generation；恢复失败保留原 quarantine record 并追加 bounded
repair attempt record。

R3 `scannerNoReadContracts` 与 `missingSensitiveRootsRule` 要求 importer、mount
scanner、compatibility checker、migration scanner 与 query gate 不读取 provider
payload、credential stores、runtime logs 或 raw recovery payloads。结论：补齐缺
文件、重新复制、重新生成 manifest 或重新导出后的恢复路径明确，不依赖 provider
payload 或未声明 batch state。

### F-08 `diagnostics_without_secrets`: Pass

主 Type DD 要求 `affectedPaths` 为 package-relative，禁止 absolute paths、
secret text、provider payload 与 raw log content。validator diagnostics 有
`maxDiagnosticBytesPerBook`、`maxAffectedPathsPerBook` 与 redacted bounded
summary 限制。`securityExportPolicy` 禁止 `.env`、provider requests、provider
responses、logs、debug、trace、durable recovery payload、secret、credential、
token 和 key 类路径进入可分发闭包。

R3 补充文档禁止 scanner、compatibility checker 与 query gate 读取 raw provider
request/response、raw prompts、raw completions、credentials 与 raw logs。R5
`manifestSensitivitySchema` 要求 unknown fields fail closed，并禁止 provider
payload、absolute local path、exception stack trace、matched secret text 与 raw
log line 出现在 manifest 或 diagnostics。结论：诊断可包含缺失路径、checksum
差异类型、schema 错误和状态转移原因，但不得读取或记录敏感信息。

### F-09 `implementable_validator_contract`: Pass

设计给出了可实施的 validator 输入、输出、路径规则、遍历规则、校验顺序和错误
分类。输入包括 package root、`BOOK_MANIFEST.json`、manifest sidecars、
`PUBLISH_READY.json`、file entries、required artifacts 与 checksum sidecars。
输出包括 validation results、projection plan、commit record、quarantine
record、catalog projections 与 diagnostic digest。

`securityExportPolicy.pathSafety` 定义 package-relative only、reject absolute
paths、reject parent traversal、reject symlink escape 与 reject hardlink outside
package。`validatorContract.checksumOrder` 和 `stableErrorCodes` 可直接驱动
manifest validator、mount scanner 与 import staging tests。R5 staged importer 的
required pre-publish checks 与 stable import diagnostics 补齐 importer 边界。
结论：实现者可以编写确定性的 manifest validator、mount scanner 和 import
staging 测试。

### F-10 `damaged_package_tests`: Pass

主 Type DD 的 `damagedPackageTests.requiredCases` 覆盖 missing
`BOOK_MANIFEST.json`、missing `PUBLISH_READY.json`、missing manifest sidecar、
missing required GraphRAG artifact、file bytes mismatch、sha256 mismatch、
sidecar target mismatch、corrupt YAML/JSON metadata、symlink escape、path
traversal、forbidden secret pattern、failed repair keeps quarantine 与
successful repair commits new generation。

R5 `fixedBaselineTestContracts` 增补 direct copy invalid candidate fail closed、
mount scanner no-read provider roots、staged importer compatibility validation
before publish、checksum mismatch quarantines candidate、stale catalog cannot
force query-ready、partial migration resume 与 catalog cleanup after quarantine。
旧 manifest-only、partial legacy root 与 unsupported legacy schema 由 schema
upgrade fixtures 覆盖。结论：固定判据要求的缺 manifest、缺 sidecar、缺 required
artifact、manifest checksum mismatch、文件 checksum mismatch、bytes mismatch、
半复制目录、旧 manifest-only 目录、恢复后重新挂载和禁止 catalog 污染均有自动化
测试契约覆盖。

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

总体结论：Pass。主 Type DD、R3 补充 Type DD 与 R5 补充 Type DD 作为整体满足
固定 10 个 `passCriteria`。

## criteria_delta_from_previous_run

与上一轮同场景审计
`run-20260602-r5-fixed-baseline-rerun/agent-04-damaged-package/report.md` 相比：

| 项目 | Delta |
| --- | --- |
| baseline SHA-256 | 无变化，仍为 `567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6` |
| baseline 维度数量 | 无变化，仍为 10 个 |
| baseline 维度顺序 | 无变化 |
| baseline 维度名称 | 无变化 |
| `passCriteria` 文本 | 无变化 |
| Pass/Fail 结果 | 无变化，10 项均为 Pass |
| 规范性补充文档 | R5 fixups 新纳入本轮评估，补强 staged import、direct copy、manifest sensitivity、GraphRAG gate 和 fixed baseline tests |

本轮未新增审计维度、删除审计维度、重排审计维度、重命名审计维度或创建新基准。

## required_design_changes

无强制设计变更。

进入实现阶段时必须保持以下设计约束不降级：

- `PUBLISH_READY.json`、manifest sidecars、file checksums、file bytes 与 required
  files 必须全部验证后才能投影。
- staged import 必须在 live-root rename 前完成 importer pre-publish validation；
  direct copy 失败必须只产生 fail-closed candidate diagnostics。
- quarantine、repair diagnostics、import diagnostics 与 local runtime state 不得写入
  package checksum 闭包。
- scanner、compatibility checker、migration scanner 与 query gate 不得读取 provider
  payload、secrets、credentials、raw logs、raw prompts 或 raw completions。
- damaged package fixtures 必须绑定稳定错误码和 projection non-mutation 断言。

## residual_risks

| 风险 | 性质 | 说明 |
| --- | --- | --- |
| 实现未审计 | 非设计阻断 | 本报告只审计 Type DD，不证明代码已实现这些契约。 |
| 文件系统原子性 | 非设计阻断 | atomic rename、fsync、lock lease、fencing token 与 generation pointer 需要按目标平台验证。 |
| 大包 checksum 成本 | 非设计阻断 | 设计已有 changed-set 与 audit mode，但实现仍需证明性能预算和 fail-closed 行为。 |
| 诊断脱敏一致性 | 非设计阻断 | 设计禁止敏感载荷读取和记录，仍需测试覆盖 validator、scanner、importer、query gate 的所有输出路径。 |
| legacy 分类实现 | 非设计阻断 | legacy-only、partial qmd、partial GraphRAG 与 duplicate residue 已有设计矩阵，仍需 fixture 驱动验证。 |

这些残余风险不改变本次固定 10 维设计审计结论。
