# agent-04-damaged-package R3 复审报告

## scenario

用户复制中断导致缺文件、checksum 损坏、半包目录混入
`graph_vault/books`。典型风险包括缺少 `BOOK_MANIFEST.json`、缺少
manifest checksum sidecar、缺少 required artifact、manifest 或文件内容损坏、
bytes 不匹配、正在复制的半包目录、旧 `distribution_manifest.json`-only 目录、
空目录或临时目录被 mount scanner 扫描到。

复审对象为修订后的
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。本次复审未读取
provider payload、provider secrets、provider request/response、`.env`、日志
payload 或其他敏感载荷。

## reused_fixed_baseline

本次 R3 复审复用本目录既有固定基线：

[baseline.yaml](</Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-04-damaged-package/baseline.yaml>)

baseline SHA-256：

`567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6`

固定 10 个维度如下，未新增、删除、重命名或重排维度，未改变任何
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
| R3 baseline 是否存在 | Pass |
| baseline SHA-256 | `567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6` |
| R3 baseline 是否复用 R2 固定基线 | Pass，R2/R3 SHA-256 一致 |
| 维度数量 | Pass，仍为 10 个 |
| 维度 id 顺序 | Pass，未新增、删除、重命名或重排 |
| passCriteria | Pass，未改变 |
| baseline.yaml 覆盖状态 | Pass，本次只写 `report.md` |
| 敏感载荷读取状态 | Pass，未读取 provider payload/secrets/log payload |

## findings

### F-01 `incomplete_copy_detection`：Pass

修订版满足复制中断缺文件识别要求。`mountScanner.requiredBehavior` 明确 copied
book directory 只有在 `BOOK_MANIFEST.json` 与 checksum sidecars 验证通过后才可被
接受；`atomicPackageLifecycle.visibilityRule` 进一步要求缺少有效
`BOOK_MANIFEST.json`、`BOOK_MANIFEST.json.sha256`、
`BOOK_MANIFEST.json.sha256.meta.json` 或 `PUBLISH_READY.json` 的目录必须被忽略。

`targetDirectoryLayout.required` 定义必需目录和必需文件根，`bookManifestSchema.files`
要求每个 required package file 以 package-relative path、bytes、sha256 和
required 标记进入文件闭包。`incompletePackagePolicy` 将缺 manifest、缺 publish
marker、缺 required file、corrupt sidecar、path traversal 和 symlink escape 映射到
诊断或隔离路径。损坏候选不得投影 catalog、qmd index 或 GraphRAG query-ready
状态。

### F-02 `checksum_fail_closed`：Pass

修订版满足 checksum 损坏 fail closed 要求。`checksumLastCommitRule` 规定 manifest
checksum sidecar 写在 `BOOK_MANIFEST.json` 之后，sidecar mismatch 必须 fail
closed 并阻止 projection。`quarantineAndRepairStateMachine.validatorContract`
补充了可执行校验顺序：先验证文件 bytes，再验证文件 sha256，再验证 sidecar 内容和
sidecar metadata，再验证 `BOOK_MANIFEST.json` 字节与
`BOOK_MANIFEST.json.sha256`，最后验证 `PUBLISH_READY.json.manifestSha256` 与
manifest checksum 一致。

稳定错误码包含 `file_bytes_mismatch`、`file_sha256_mismatch`、
`sidecar_target_mismatch`、`manifest_sha256_mismatch` 和
`publish_marker_mismatch`。`mountScanTransactionModel.failureRule` 要求单个 package
验证失败时只把该 package 标记为 `not_mounted` 或 `not_query_ready`，不得污染其他
有效包。`staleProjectionInvalidation` 将 checksum validation failure 列为移除
query-ready capability 的触发条件，避免旧 catalog 状态掩盖当前损坏。

### F-03 `half_package_isolation`：Pass

修订版满足半包目录隔离要求。直接复制目录只有在 publish marker 和 checksum 全部
通过后才可挂载；缺少 `PUBLISH_READY.json` 的目录被报告为 `incomplete_copy`，有
manifest 但缺 required file 或 checksum 失败的目录进入隔离诊断。scanner 在
projection plan 生成前完成验证，失败 candidate 不得进入 derived catalog。

旧 `distribution_manifest.json` 被限定为 migration input 或 legacy evidence，不是
hot-plug mount authority。`versionAndMigrationModel` 与 `upgradePathMatrix` 将
legacy manifest、partial qmd、partial GraphRAG、duplicate residue 和 unknown root
区分为 migration、repair、visible-not-query-ready、residue quarantine 或
fail-closed 结果。`residuePolicy.defaultAction` 为 `quarantine_without_delete`，
normal mount scan 不会删除用户文件，也不会把半包移动到 provider payload roots。

### F-04 `atomic_import_protocol`：Pass

修订版满足原子导入协议要求。`atomicPackageLifecycle` 定义 `importStagingRoot`、
`buildStagingRoot`、`liveRoot`、`quarantineRoot` 和 `runtimeStateRoot`，并明确先在
staging root 写入 package files、生成 file checksums、生成
`BOOK_MANIFEST.json`、生成 manifest sidecars、写入 `PUBLISH_READY.json`、fsync
文件和父目录，再 atomic rename 到 live root。

直接复制与 staged import 的关系也已定义。直接复制保持用户友好，但 scanner 只把
publish markers 和 checksums 全部验证通过的目录视为 mount-visible；缺 marker 或
校验失败的目录只能成为 mount candidate diagnostics。`lockLeaseAndStagingCleanup`
还补充了 scanner 与 publisher 并发、rename during enumeration、stale staging
cleanup 等测试边界，阻止 scanner 在非稳定目录上做成功投影。

### F-05 `quarantine_state_model`：Pass

修订版满足隔离状态模型要求。`quarantineAndRepairStateMachine` 定义持久化位置
`graph_vault/catalog/book-quarantine`，状态包括 `detected`、`quarantined`、
`repair_requested`、`repair_staging`、`repair_validating`、`repair_succeeded`、
`repair_failed`、`cleared` 和 `archived`。单条 quarantine record 只能处于一个
state，并通过 `reasonCode` 与 `validatorErrorCode` 表达互斥损坏原因。

缺文件和 checksum mismatch 由 validator error codes 覆盖；schema incompatible
由 `incompatible_schema` 和 readiness gate 覆盖；identity conflict 由
`conflictIndex` 与 `manualConflictDecisionWorkflow` 持久化并 fail closed；copy in
progress 由 missing publish marker、incomplete copy 和 staging visibility rule
覆盖。record schema 明确 package-relative affected paths、manifest/publish marker
digest、repairAttempts、clearCondition 和 diagnosticDigest。`repairClosure` 定义
重试输入、成功条件和失败保留规则，runtime diagnostics 不写入 package checksum
闭包，因此 quarantine 不破坏分发包完整性。

### F-06 `no_partial_projection`：Pass

修订版满足禁止部分投影要求。`mountScanTransactionModel` 明确 scanner 先枚举候选、
验证 publish marker、manifest sidecars、schema、路径、required files、checksum、
identity conflict 和 compatibility，再生成 projection plan。catalog 与 qmd
projection 写入 staging root、checksummed、fsynced，然后 atomic replace；current
generation pointer 最后更新。

任何损坏包验证失败时，该 package 只能成为 `not_mounted`、`not_query_ready`、
`quarantined`、`incompatible` 或 pending manual decision，不得产生部分 catalog
entry、部分 qmd projection、部分 GraphRAG locator 或 stale query-ready 标志。
`staleProjectionInvalidation` 覆盖 packageGeneration、manifestSha256、checksum、
schema、root deletion、qmd freshness 和 GraphRAG lineage binding 变化，并要求在同一
projection commit 中移除 query-ready capability。

### F-07 `recovery_repair_contract`：Pass

修订版满足恢复与修复契约要求。`copyInstallModel.repairRule` 规定重新复制完整包到
incomplete candidate 必须幂等，scanner 只有在 full validation 成功后才记录新
generation。`quarantineAndRepairStateMachine.repairClosure.acceptedInputs` 覆盖
full replacement package、重新生成 `BOOK_MANIFEST.json` 与 sidecars、恢复缺失
required files，以及 source-redacted repair policy。

恢复成功只能在 fresh mount 相同 validator pipeline 通过并提交新 projection
generation 后成立；恢复失败保留原 quarantine record，并追加 bounded repair attempt
record，不删除 last-good projection。该恢复路径不要求读取 provider payload，也不
依赖未声明的 batch state。

### F-08 `diagnostics_without_secrets`：Pass

修订版满足无敏感信息诊断要求。`quarantineAndRepairStateMachine.recordSchema`
要求记录 `reasonCode`、`validatorErrorCode`、`affectedPaths`、manifest digest、
publish marker digest、clear condition 和 diagnostic digest；`affectedPathsRule`
明确 affected paths 必须是 package-relative，禁止 absolute paths、secret text、
provider payload 和 raw log content。

`securityExportPolicy`、`sensitiveMaterialTaxonomy` 和 scanner read policy 共同禁止
读取或记录 provider requests、provider responses、provider payload logs、secrets、
credentials、absolute private paths、runtime debug traces 和 raw prompt/completion
payload。checksum 差异通过稳定错误码表达，schema 错误通过
`incompatible_schema`、corrupt metadata 测试和 compatibility diagnostics 表达，状态
转移原因通过 quarantine transitions 与 reason code 表达。

### F-09 `implementable_validator_contract`：Pass

修订版满足可实施验证器契约要求。validator 输入由 `mountScanner.authoritativeInput`、
`targetDirectoryLayout`、`bookManifestSchema`、`PUBLISH_READY.json`、manifest
sidecars 和 package files 闭包组成；scanner 输出由 validation results、
projection plan、commit record、quarantine record 和 catalog projections 组成。

可执行细节已覆盖：`validationPipeline` 定义遍历和校验阶段；`pathSafety` 定义
package-relative、absolute path、parent traversal、symlink escape 和 hardlink escape
规则；`validatorContract.checksumOrder` 定义 sidecar 与 bytes/sha256 校验顺序；
`stableErrorCodes` 定义损坏、敏感信息、schema 和 lineage 错误分类；`ioLimits` 定义
诊断大小边界。实现者可以据此编写确定性的 manifest validator、mount scanner、
import staging 和 quarantine repair 测试。

### F-10 `damaged_package_tests`：Pass

修订版满足损坏包自动化测试要求。`quarantineAndRepairStateMachine.damagedPackageTests`
明确覆盖 missing `BOOK_MANIFEST.json`、missing `PUBLISH_READY.json`、missing
manifest sidecar、missing required GraphRAG artifact、file bytes mismatch、sha256
mismatch、sidecar target mismatch、corrupt YAML/JSON metadata、symlink escape、path
traversal、forbidden secret pattern、failed repair keeps quarantine 和 successful
repair commits new generation。

固定判据中的剩余场景由全局测试契约补齐：staged copy 只有 atomic rename 后可见；
missing `PUBLISH_READY.json` 永不 mounted；scanner crash 保留 last-good projection；
projection commit 暴露 old or new generation，never partial；legacy
`distribution_manifest.json` 与 historical residue 通过 upgrade path matrix 和 38/34
classification case 覆盖；damaged validator 对 checksum、sidecar、path、symlink、
sensitive material 和 lineage failure 发出稳定错误码；quarantine repair 只有 full
validator pass 和新 projection generation commit 后才成功。

## pass_fail

总体判定：Pass。R3 修订版在 R2 基础上补齐 checksum/bytes/sidecar 校验顺序、
quarantine and repair state machine、稳定错误码、无敏感信息诊断结构、可实施
validator contract 和 damaged package 专项测试矩阵。固定 10 维基线均满足。

| baseline id | R3 结果 | 判定摘要 |
| --- | --- | --- |
| `incomplete_copy_detection` | Pass | 缺 manifest、sidecar、required file 和必需目录不会投影。 |
| `checksum_fail_closed` | Pass | manifest、sidecar、file sha256、bytes 和 publish marker 校验失败均 fail closed。 |
| `half_package_isolation` | Pass | 半包、旧 manifest-only 和 residue 被隔离，不删除用户文件，不污染 catalog。 |
| `atomic_import_protocol` | Pass | staging、publish marker、fsync、atomic rename 和 direct copy 门禁已定义。 |
| `quarantine_state_model` | Pass | 持久化 state、reason、error code、retry、clear 和 repair closure 已定义。 |
| `no_partial_projection` | Pass | generation transaction 和 stale invalidation 阻止部分 catalog/qmd/GraphRAG 投影。 |
| `recovery_repair_contract` | Pass | 补齐、重复制、重生成 manifest 或 replacement package 后按同一 validator 恢复。 |
| `diagnostics_without_secrets` | Pass | 诊断记录 package-relative path、错误分类和状态原因，禁止敏感 payload。 |
| `implementable_validator_contract` | Pass | 输入、输出、错误码、路径规则、校验顺序和测试边界足够具体。 |
| `damaged_package_tests` | Pass | 固定损坏包矩阵由 damaged tests、upgrade tests 和 projection tests 覆盖。 |

## criteria_delta_from_r2

baseline criteria 无变化。R3 复审使用与 R2 相同的 10 个 dimension id、name 与
`passCriteria`；未新增、删除、重命名、重排维度，也未改变任何 pass criteria。
R2 与 R3 baseline SHA-256 均为
`567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6`。

变化只来自 Type DD 的设计内容修订。

| baseline id | R2 结果 | R3 结果 | 变化 |
| --- | --- | --- | --- |
| `incomplete_copy_detection` | Pass | Pass | 维持通过；R3 增强了 quarantine validator 与测试覆盖。 |
| `checksum_fail_closed` | Partial | Pass | 新增 bytes、file sha256、sidecar、manifest 和 publish marker 校验顺序。 |
| `half_package_isolation` | Pass | Pass | 维持通过；R3 增强 legacy/residue 与 staging cleanup 测试边界。 |
| `atomic_import_protocol` | Pass | Pass | 维持通过；R3 增强并发 publish 与 staging cleanup 测试边界。 |
| `quarantine_state_model` | Partial | Pass | 新增持久化 quarantine state machine、record schema、retry 和 clear condition。 |
| `no_partial_projection` | Pass | Pass | 维持通过；R3 明确 repair 成功才提交新 projection generation。 |
| `recovery_repair_contract` | Partial | Pass | 新增 repair inputs、成功/失败规则和 bounded attempts。 |
| `diagnostics_without_secrets` | Partial | Pass | 新增 diagnostics schema、package-relative paths 和 I/O limits。 |
| `implementable_validator_contract` | Partial | Pass | 新增 error codes、checksum order、sidecar 顺序和输出记录。 |
| `damaged_package_tests` | Fail | Pass | 新增 damaged package 专项测试，并由 upgrade/projection 测试补齐固定矩阵。 |

## required_design_changes

无阻断性 required design changes。按本固定 baseline，修订后的 Type DD 已满足
agent-04 damaged package 场景的生产设计判据。

实现落地时必须保持以下约束，避免实现偏离已通过的设计：

1. 将 `validatorContract.stableErrorCodes` 固化为共享枚举，validator、scanner、
   quarantine repair、CLI/UI diagnostics 和测试不得各自定义不兼容错误码。
2. 将 checksum order 写成单一 validator 流程，确保 bytes mismatch、file sha256
   mismatch、manifest sha256 mismatch 和 publish marker mismatch 都 fail closed。
3. 将 damaged package tests 拆成独立 fixture matrix，分别断言不挂载、不 query-ready、
   不写 partial catalog/qmd/GraphRAG projection，以及 repair 后重新 mount。
4. 将 diagnostics redaction 作为写入 quarantine record 前的强制步骤，禁止绝对私人
   path、provider payload、secret text 和 raw logs 进入诊断文件。

## residual_risks

- 直接复制到 live root 时，某些文件系统可能先复制 `PUBLISH_READY.json` 再复制大型
  artifacts；validator 会阻止投影，但 CLI/UI 需要把短暂 incomplete 或 quarantine
  诊断显示为 copy-in-progress 可能状态，避免用户误判。
- Atomic rename 只在同一文件系统内可靠。跨设备导入、网络盘和同步盘需要实现层降级
  为 staged copy、fsync、publish marker 和 scanner validation。
- Last-good reader view 能保护查询稳定性，但当前 live root 损坏时，用户界面必须
  明确显示 unavailable 或 damaged reason，不能把旧 query-ready 状态解释为新包成功。
- Checksum 闭包只能证明文件与 manifest 一致，不能证明 GraphRAG artifact 语义正确；
  schema validation、lineage binding 和 query-ready gate 仍必须执行。
- 大量半包或坏包同时出现时，quarantine diagnostics 可能膨胀；实现需要遵守
  `ioLimits`、retention 和 summary index，避免诊断系统反向影响正常扫描。
