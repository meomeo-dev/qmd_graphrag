# agent-04-damaged-package R2 复审报告

## scenario

用户复制中断导致缺文件、checksum 损坏、半包目录混入
`graph_vault/books`。典型状态包括缺少 `BOOK_MANIFEST.json`、缺少
manifest checksum sidecar、缺少 `files.required=true` 的 artifact、manifest
或文件内容损坏、bytes 不匹配、旧 `distribution_manifest.json` 目录混入
`books/`、空目录或临时目录被 mount scanner 扫描到。

复审对象为修订后的
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。复审未读取
provider payload、provider secrets、provider request/response、`.env`、日志
payload 或其他敏感载荷。

## reused_fixed_baseline

本次 R2 复审复用既有固定基线：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-04-damaged-package/baseline.yaml`

固定 10 个维度如下，未新增、删除、重命名任何维度，未改变任何
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
| R2 baseline 是否存在 | Pass |
| R2 baseline 是否复用 R1 固定基线 | Pass |
| R1/R2 baseline 文件比较 | Pass，`cmp` 结果一致 |
| baseline SHA-256 | `567daaa2eecdeba3d6c6f86ca06452f533e0d7fe4d8db775a8ef20f119ce96b6` |
| 维度数量 | Pass，仍为 10 个 |
| 维度 id 顺序 | Pass，未新增、删除、重命名或重排 |
| passCriteria | Pass，未改变 |
| baseline.yaml 覆盖状态 | Pass，本复审只写入 `report.md` |
| 敏感载荷读取状态 | Pass，未读取 provider payload/secrets/log payload |

## findings

### F-01 incomplete_copy_detection：Pass

修订版已经把复制中断的核心门禁前移到 package visibility（包可见性）阶段。
`mountScanner.requiredBehavior` 规定 copied book directory 必须等
`BOOK_MANIFEST.json` 与 checksum sidecars 通过后才接受；`atomicPackageLifecycle`
进一步要求缺少有效 `BOOK_MANIFEST.json`、`BOOK_MANIFEST.json.sha256`、
`BOOK_MANIFEST.json.sha256.meta.json` 或 `PUBLISH_READY.json` 的目录不得
mount-visible。

`incompletePackagePolicy` 将 `missingManifest` 记录为
`ignored_with_diagnostic`，将 `missingPublishMarker` 记录为 `incomplete_copy`，
将 `missingRequiredFile`、`pathTraversal`、`symlinkEscape` 和 `corruptSidecar`
送入隔离或 fail-closed 路径。该设计满足缺 manifest、缺 sidecar、缺 required
artifact 时不得投影 catalog、qmd index 或 GraphRAG query-ready 状态的基线要求。

剩余细节属于 validator 契约维度：错误码和 required directory 的精确映射尚未
完全结构化，但不改变本维度的 fail-closed 结论。

### F-02 checksum_fail_closed：Partial

修订版明确 checksum gate（校验门禁）必须在 derived catalog mutation 之前执行。
`checksumLastCommitRule` 规定 manifest sidecar mismatch 必须 fail closed 并阻止
projection；`staleProjectionInvalidation` 将 checksum validation failure 列为
移除 query-ready capability 的触发条件；query/list 只能读取已提交 generation。

仍未完全满足固定判据。`bookManifestSchema.files` 要求 `bytes` 与 `sha256` 字段，
但 `validationPipeline` 只明确写到 required file presence 与 checksums，没有把
文件级 bytes mismatch、`PUBLISH_READY.json.byteCount` mismatch、manifest 内
`checksums.manifestSha256` 与 sidecar 不一致作为独立 fail-closed 条件。文档也未
定义 JSON canonicalization、sidecar 内容格式和 `BOOK_MANIFEST.json.sha256`、
`checksums.manifestSha256`、`PUBLISH_READY.json.manifestSha256` 三者的一致性
验证顺序。因此 checksum 损坏方向正确，但可实施判据仍不完整。

### F-03 half_package_isolation：Pass

修订版为半包目录提供了足够的隔离边界。没有 publish marker 的目录被标记为
`incomplete_copy`，没有 manifest 的目录被 `ignored_with_diagnostic`，有 manifest
但缺文件或 checksum 失败的目录进入隔离路径。scanner 在生成 projection plan 前
完成验证，失败 package 被标记为 `not_mounted` 或 `not_query_ready`，不得污染其他
有效 package 的投影。

旧 `distribution_manifest.json` 只被定义为迁移输入和 legacy evidence，不是
hot-plug mount authority。迁移残留通过 `residuePolicy` 默认
`quarantine_without_delete`，normal mount scan 不会把 residue candidate 当作已挂载
书。文档同时要求 scanner failure 不得 mutate provider payload roots，并把 runtime
diagnostics 放到 package root 外部，满足不删除用户文件、不移动到 provider payload
roots、不污染 derived catalog 的要求。

### F-04 atomic_import_protocol：Pass

R1 中直接复制与 import staging 的协议缺口已被修订版补齐。文档定义
`importStagingRoot`、`buildStagingRoot`、`liveRoot`、`runtimeStateRoot` 与
`quarantineRoot`，并规定先在 staging root 写入 package files、生成 file
checksums、生成 `BOOK_MANIFEST.json`、生成 manifest sidecars、写入
`PUBLISH_READY.json`、fsync 文件和父目录，再 atomic rename 到 live root。

直接复制模式也被收束为 marker-and-validation 模式：用户可复制目录到
`books/{bookId}`，但只有 publish markers 和 checksums 全部验证通过后才挂载。
缺少 `PUBLISH_READY.json` 的目录只能作为 `incomplete_copy` 诊断，不能成功投影。
该设计满足原子导入协议（atomic import protocol）的固定判据。

### F-05 quarantine_state_model：Partial

修订版新增了 `quarantineRoot`、`runtimeStateRoot`、`packageStates`、scan
generation state、`incompletePackagePolicy` 和 failure rule，比 R1 的单一
`quarantine_mount_candidate` 动作名更完整。缺文件、checksum mismatch、路径逃逸
和 corrupt sidecar 均有隔离方向；schema incompatible 也被限制为
`visible_not_query_ready` 或 `incompatible`，不能 query-ready。

固定判据仍未完全满足。文档没有给出互斥且可持久化的 quarantine record schema，
也没有把 `missingManifest`、`missingPublishMarker`、`missingRequiredFile`、
`checksumMismatch`、`incompatibleSchema`、`sameBookIdDifferentSourceHash`、
`sameSourceHashDifferentBookId` 和 copy-in-progress 统一到同一状态机。诊断位置
已有方向，但缺少每种状态的 retry condition、clear condition、归档规则和用户可见
恢复入口。schema incompatible 与 identity conflict 也没有明确是否属于 quarantine
state、diagnostic-only state 或 visible-not-query-ready state。

### F-06 no_partial_projection：Pass

修订版已经建立事务化投影（transactional projection）边界。mount scan 先枚举
candidate、验证 manifest schema、路径、required files、checksums、identity
conflicts 和 compatibility，再构建 projection plan；catalog 与 qmd projection
写入 staging root、checksum、fsync 后原子替换，current-generation pointer 最后
更新。

损坏包验证失败时，该 package 被标记为 `not_mounted` 或 `not_query_ready`，不得
产生部分 catalog entry、部分 qmd projection 或 GraphRAG locator。checksum 失败、
schema 变化、root 删除、qmd freshness 变化和 GraphRAG lineage binding 变化都会在
同一 projection commit 中移除 query-ready capability。上一代 reader view 只在
last-good root 仍存在且仍有效时可读，不能用 stale query-ready 掩盖当前损坏包。

### F-07 recovery_repair_contract：Partial

修订版已经给出恢复方向。`copyInstallModel.repairRule` 规定对 incomplete candidate
重新复制完整包必须幂等，scanner 只有在完整 validation 成功后才记录新 generation。
迁移模型也包含 `repair_required`、`migration_failed`、rollback contract 和 residue
repair report。恢复过程不要求读取 provider payload，也不依赖未声明的原始 batch
payload。

固定判据仍未闭合。文档没有系统说明用户补齐缺失文件、替换损坏 sidecar、重新生成
manifest、重新导出 package 或重新复制目录之后，scanner 如何清除旧 quarantine
record、覆盖旧 diagnostics、归档历史错误、重新生成 catalog/qmd projection，以及
恢复失败时如何保持 previous state。恢复入口是自动下一次扫描、显式 repair 命令、
import 命令还是 migration 命令，也没有统一契约。

### F-08 diagnostics_without_secrets：Partial

修订版显著强化了敏感信息边界。`securityExportPolicy` 采用 allowlist-first，
拒绝 provider requests、provider responses、logs、runtime recovery payload、
`.env`、secret、credential、token、key、debug、trace 和绝对本地路径。
`manifestFieldClassification` 将 `absoluteLocalPath`、`providerRequestPayload`、
`providerResponsePayload`、`apiKey`、`bearerToken` 和 `userHomePath` 标记为
forbidden。secret scan diagnostics 也不得包含命中文本。

但 damaged package diagnostics（损坏包诊断）的结构仍不够具体。固定判据要求诊断
包含缺失路径、checksum 差异类型、schema 错误和状态转移原因；Type DD 当前只说明
有 mount diagnostics、validation results 和 restricted `diagnostics.errorCode`，
没有定义普通损坏诊断的 allowed fields、redaction rule、checksum expected/observed
呈现方式、package-relative path 约束、异常堆栈处理和绝对私人路径剥离规则。因此
保密方向通过，诊断内容契约仍为部分满足。

### F-09 implementable_validator_contract：Partial

修订版提供了 validator 的重要骨架。`validationPipeline` 定义枚举 liveRoot、读取
publish markers 和 manifest sidecars、验证 schema、验证 package-relative paths、
验证 required file presence 和 checksums、验证 identity conflicts 与 schema
compatibility、生成 projection plan、原子提交 projection。`pathSafety` 也定义拒绝
absolute path、parent traversal、symlink escape 和 package 外 hardlink。

仍缺可直接编码的 validator contract。文档没有定义 validator 输入、输出对象、
错误码集合、错误严重级别、诊断多错误合并、短路条件、deterministic traversal
顺序、unknown file 处理、case conflict 处理、safe internal symlink 的解析规则、
manifest JSON canonicalization、manifest sidecar 顺序、bytes 校验规则和
`PUBLISH_READY.json` 的校验语义。实现者仍可能写出彼此不兼容的 damaged package
validator。

### F-10 damaged_package_tests：Fail

修订版的 `testContracts` 已覆盖 valid copy、delete、missing `PUBLISH_READY.json`、
staging atomic rename、scanner crash、partial projection prevention、privacy
exclusion、path/symlink fail-closed、identity conflict、qmd freshness 和 GraphRAG
minimum closure。这些测试对损坏包场景有帮助。

固定判据要求的专项损坏包矩阵仍未出现。当前测试契约没有显式覆盖缺
`BOOK_MANIFEST.json`、缺 `BOOK_MANIFEST.json.sha256`、缺
`BOOK_MANIFEST.json.sha256.meta.json`、缺 required artifact、manifest checksum
mismatch、文件 checksum mismatch、bytes mismatch、半复制目录、旧
`distribution_manifest.json`-only 目录、恢复后重新挂载，以及禁止 catalog 污染的
逐项断言。该维度仍未通过。

## pass_fail

总体判定：Fail。修订版已经解决 R1 中原子导入、半包可见性和事务投影的主要缺口，
但固定 10 维基准中仍有 5 个部分满足项和 1 个未通过项，不能判定为 damaged
package 场景生产级通过。

| baseline id | R2 结果 | 判定摘要 |
| --- | --- | --- |
| `incomplete_copy_detection` | Pass | 缺 manifest、sidecar、required file 均不能投影，且有诊断或隔离状态。 |
| `checksum_fail_closed` | Partial | checksum fail-closed 方向明确，但 bytes、sidecar 一致性和校验顺序未完全定义。 |
| `half_package_isolation` | Pass | 半包、旧 manifest-only 和 residue 不会污染 catalog，也不移动到 provider roots。 |
| `atomic_import_protocol` | Pass | staging、`PUBLISH_READY.json`、fsync 和 atomic rename 已定义。 |
| `quarantine_state_model` | Partial | 有隔离位置和状态方向，但缺互斥持久化状态机、retry 与 clear 条件。 |
| `no_partial_projection` | Pass | projection plan 与 atomic commit 防止部分 catalog/qmd/GraphRAG 投影。 |
| `recovery_repair_contract` | Partial | 重新复制的恢复方向存在，但补齐、重生成 manifest、重导出后的恢复闭包不足。 |
| `diagnostics_without_secrets` | Partial | 隐私边界强，但普通损坏诊断的字段、脱敏和状态转移原因未结构化。 |
| `implementable_validator_contract` | Partial | pipeline 与路径规则存在，但 validator I/O、错误码和校验细节不足。 |
| `damaged_package_tests` | Fail | 未覆盖固定判据要求的完整损坏包测试矩阵。 |

## criteria_delta_from_r1

baseline criteria（固定判据）无变化。R2 复审使用与 R1 完全相同的 10 个
dimension id、name 与 `passCriteria`；没有新增、删除、重命名维度，也没有改变
任何 pass criteria。变化只来自 Type DD 修订后的设计内容。

| baseline id | R1 结果 | R2 结果 | 变化 |
| --- | --- | --- | --- |
| `incomplete_copy_detection` | Partial | Pass | 新增 visibility rule、`PUBLISH_READY.json` 和 incomplete package policy。 |
| `checksum_fail_closed` | Partial | Partial | fail-closed 强化，但 bytes 与 sidecar 一致性仍不足。 |
| `half_package_isolation` | Partial | Pass | 新增 staging、residue quarantine、runtime state 外置和 no projection 边界。 |
| `atomic_import_protocol` | Fail | Pass | 新增 staging、manifest-last、checksum-last、fsync 和 atomic rename。 |
| `quarantine_state_model` | Fail | Partial | 新增隔离根和状态方向，但状态机、retry、clear 仍不足。 |
| `no_partial_projection` | Partial | Pass | 新增 generation-based transaction 和 stale projection invalidation。 |
| `recovery_repair_contract` | Fail | Partial | 新增重新复制幂等恢复方向，但恢复闭包仍不完整。 |
| `diagnostics_without_secrets` | Partial | Partial | 隐私边界增强，但 damaged diagnostics schema 仍不足。 |
| `implementable_validator_contract` | Partial | Partial | validation pipeline 增强，但 validator 结构化契约仍不足。 |
| `damaged_package_tests` | Fail | Fail | 新增少量相关测试，但未覆盖固定损坏包矩阵。 |

## required_design_changes

1. 增加 damaged package validator error taxonomy（损坏包验证错误分类）。至少包括
   `missing_manifest`、`missing_manifest_sidecar`、`corrupt_manifest_sidecar`、
   `manifest_sidecar_mismatch`、`manifest_internal_sha_mismatch`、
   `publish_marker_missing`、`publish_marker_mismatch`、`missing_required_file`、
   `file_sha256_mismatch`、`file_bytes_mismatch`、`structural_path_error`、
   `schema_incompatible`、`identity_conflict`、`copy_in_progress` 和
   `legacy_manifest_only`。

2. 固化 checksum 与 bytes 校验顺序。明确先验证
   `BOOK_MANIFEST.json.sha256`，再解析 manifest，比较
   `checksums.manifestSha256` 与 sidecar，验证
   `PUBLISH_READY.json.manifestSha256`、`fileCount`、`byteCount`，最后按稳定顺序
   校验每个 required file 的 bytes 与 sha256。

3. 定义 manifest canonicalization（规范化）和 sidecar 格式。说明 checksum 是对
   原始文件字节、canonical JSON 还是 pretty-printed JSON 计算；明确 sidecar 文件
   是否允许额外字段，以及 `.sha256.meta.json` 是否进入自校验闭包。

4. 建立 quarantine state machine（隔离状态机）。把缺文件、checksum mismatch、
   schema incompatible、identity conflict 和 copy-in-progress 统一到互斥状态，
   并为每种状态定义持久化位置、诊断字段、retry condition、clear condition、
   归档条件和用户可见恢复入口。

5. 补全 recovery repair contract（恢复与修复契约）。分别定义补齐缺文件、重新复制
   完整目录、重新生成 manifest、重新导出 package 后的 scanner 行为、旧诊断清理
   规则、catalog/qmd projection 重建规则和失败回退规则。

6. 定义 damaged diagnostics schema（损坏诊断结构）。允许记录 package-relative
   path、error code、状态转移原因、checksum 差异类型和 schema error summary；
   禁止记录 provider payload、secret、绝对私人路径、用户 home path、源内容片段、
   原始异常堆栈和未授权 payload 摘要。

7. 给 validator 定义结构化 I/O。建议输出
   `{status, packageState, projectionAllowed, queryReadyAllowed, errors,
   warnings, recoveryHint, observedDigest}`，并定义多错误合并、短路条件、稳定遍历
   顺序、unknown file、case conflict、symlink、hardlink 和空目录处理规则。

8. 扩展 damaged package tests。测试必须逐项覆盖缺 manifest、缺 sidecar、缺
   required artifact、manifest checksum mismatch、文件 checksum mismatch、bytes
   mismatch、半复制目录、旧 manifest-only 目录、修复后重新 mount、stale projection
   invalidation 和禁止 catalog/qmd/GraphRAG partial projection。

## residual_risks

- 直接复制到 live root 时，用户文件系统可能先复制 `PUBLISH_READY.json` 再复制大型
  artifacts；当前校验能阻止投影，但会产生短暂 incomplete/quarantine 诊断，需要
  实现层避免误导用户。

- Atomic rename 只在同一文件系统边界内可靠。跨设备导入、网络盘和同步盘仍需要
  import command 检测并降级为 staging copy 加完成标志。

- Last-good reader view 有助于查询稳定性，但若当前 live root 已损坏，UI/CLI 必须
  清楚展示 unavailable 或 damaged reason，避免用户误解为新复制包已成功。

- Checksum 闭包只能证明文件与 manifest 一致，不能证明 GraphRAG artifacts 语义
  正确；仍需要 schema validation、lineage binding 和 query-ready gate 配合。

- 大量半包或坏包同时出现时，诊断文件可能膨胀。Type DD 尚未定义 damaged
  diagnostics retention、size cap、summary index 和清理策略。
