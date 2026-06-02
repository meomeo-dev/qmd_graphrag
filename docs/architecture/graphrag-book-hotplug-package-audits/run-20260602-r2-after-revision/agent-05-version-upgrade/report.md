# agent-05-version-upgrade R2 复审报告

## scenario

旧 schema 书包跨版本升级到新 qmd/GraphRAG artifact schema。复审对象为修订后的
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`，重点验证旧
`distribution_manifest.json`、旧目录布局、旧 qmd index schema 与旧 GraphRAG
artifact schema 是否能升级为以 `BOOK_MANIFEST.json` 为权威的新热插拔包。

## reused_fixed_baseline

本轮复审复用 R2 目录中已存在的固定基准：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-05-version-upgrade/baseline.yaml`

baseline SHA-256:

`50eea87bc68cbd3bb809e56cecb4797e9b89bc47a0c50b16396fa879b585c8f8`

固定 10 维如下，未新增、删除、重命名维度，未改变 `passCriteria`：

1. `legacy_version_detection`
2. `migration_path_matrix`
3. `artifact_schema_conversion`
4. `identity_stability`
5. `checksum_reclosure`
6. `rollback_atomicity`
7. `compatibility_diagnostics`
8. `producer_lineage_preservation`
9. `privacy_preservation`
10. `upgrade_testability`

## baseline_integrity_check

R2 目录中的 `baseline.yaml` 在复审前已存在，本报告未覆盖该文件。R2 baseline
与 R1 `agent-05-version-upgrade/baseline.yaml` 的 SHA-256 相同，字节级比较一致。
本轮只新增 `report.md`。

复审未读取 provider payload、secrets、日志 payload、recovery payload 或本地凭据。

## findings

### 1. `legacy_version_detection`: 部分通过

修订版新增 `versionAndMigrationModel`，定义 `compatibilityMatrix`、
`migrationStateMachine` 和 `currentVsResidueClassification`。这些内容能区分当前
完成书目录与历史 residue，并能把缺失 manifest、缺失 qmd、缺失 output manifest
等目录归入 residue 或 repair 路径。

不足是旧版本识别仍偏向当前 `distribution_manifest.json` 迁移。文档没有完整定义
旧 `BOOK_MANIFEST.json`、旧 `layoutVersion`、旧 qmd index schema、旧 GraphRAG
artifact schema 的检测规则，也没有把 `unknown`、`unsupported`、`repairable`、
`current` 固化为可机器读取的分类状态。因此该维度未达到全量跨版本识别标准。

### 2. `migration_path_matrix`: 未通过

修订版列出了兼容矩阵维度，包括 `packageSchemaVersion`、`layoutVersion`、
`qmdIndexSchema`、`graphRagArtifactSchema`、parquet、LanceDB 和 producer lineage。
它也列出了可能结果，如 `mount_as_is`、`rebuild_qmd_projection`、
`visible_not_query_ready` 和 `fail_closed`。

但该矩阵仍不是可执行升级路径矩阵。文档没有按每个受支持旧版本列出迁移目标、
前置条件、转换步骤、失败状态和不可升级诊断。当前内容只能说明应考虑哪些维度，
不能让实现者判断某个旧 schema version 应走哪条确定路径。

### 3. `artifact_schema_conversion`: 部分通过

修订版新增 `qmdReadyGate` 与 `graphragReadyGate`，明确 GraphRAG 最小 artifact
闭包、lineage binding、parquet schema digest、LanceDB schema digest、embedding
dimension 等 query-ready 输入。旧 artifact 不兼容时可以进入
`schema_incompatible`、`dimension_incompatible` 或非 query-ready 状态。

不足是文档仍未定义 artifact 转换决策表。GraphRAG parquet、LanceDB、reports、
stats、context 文件和 qmd index 在跨 schema 升级时应原样兼容、重写、schema
convert、从 input 重建、保留为 legacy evidence，还是失效，仍缺少逐类规则。
因此 query-ready gate 有改善，但 schema conversion contract 仍不完整。

### 4. `identity_stability`: 部分通过

修订版保留了 `bookId`、`sourceHash`、`canonicalTitle`、`titleSlug`、
`packageGeneration` 等 identity 字段，并继续要求同 `bookId` 不同 `sourceHash`
fail closed、同 `sourceHash` 不同 `bookId` 报告 duplicate candidate。

不足是升级审计没有记录 identity 旧值与新值。旧包可能缺少 `canonicalTitle`、
`normalizedHash` 或使用旧规范化算法；若升级器重算字段，文档未要求记录旧值、
新值、重算原因、算法版本和冲突策略。该缺口仍可能造成 identity 语义静默漂移。

### 5. `checksum_reclosure`: 基本通过

修订版明确迁移完成后重新生成 package-relative file entries 和 checksums；
`atomicPackageLifecycle` 要求先生成文件校验，再生成 `BOOK_MANIFEST.json` 与 manifest
checksum sidecars。mount scanner 只接受有效的 `BOOK_MANIFEST.json`、sidecars 与
`PUBLISH_READY.json`。

剩余不足是旧 `distribution_manifest.json.sha256`、旧 sidecar、旧 artifact checksum
的 legacy evidence 地位仍可更明确。当前设计已实质上阻止旧 checksum 授权新挂载，
但建议在 `versionAndMigrationModel` 中显式声明旧 checksum 只能作为
`legacyEvidence`，不能参与新包 mount authority。

### 6. `rollback_atomicity`: 通过

修订版新增 `atomicPackageLifecycle`，定义 import/build staging roots、publish
marker、checksum-last commit、atomic rename、visibility rule 和 locking。
`versionAndMigrationModel.rollbackContract` 进一步定义 publish 前、publish 后
projection 前、projection commit 后的回滚策略。

这些规则能保证失败时旧书包或 last-good projection 仍可见，且 mount scanner 不会
把缺少 `BOOK_MANIFEST.json` sidecars 或 `PUBLISH_READY.json` 的升级中目录投影为
query-ready。

### 7. `compatibility_diagnostics`: 部分通过

修订版增加 scan state、validation results、projection plan、migration evidence
和 gate failure diagnostics。qmd 与 GraphRAG readiness gates 也包含
`projection_failed`、`schema_incompatible`、`artifact_checksum_failed` 等状态。

不足是兼容诊断还没有形成完整机器可读诊断 schema。baseline 要求不兼容、缺失文件、
旧 schema 未支持、需要重建、重建失败和工具版本不足均有稳定状态，并保留在
`import/`、`state/runtime` 或等价明确位置。修订版提供了位置和部分状态，但缺少
`unsupported_legacy_schema`、`rebuild_required`、`tool_version_too_old` 等明确诊断
枚举及字段契约。

### 8. `producer_lineage_preservation`: 部分通过

修订版强化了 producer lineage schema，要求 GraphRAG artifact 与 producer run
output hash 双向绑定，并要求导出的 producer evidence 是脱敏的 package-relative
summary。新增 `migrationEvidence` 也记录 old/new manifest digest、复制、跳过和
排除文件。

不足是 migration evidence 仍未要求迁移工具版本、转换步骤、artifact conversion
decision、重建 artifact、旧 evidence 缺失原因，以及“不得伪造 producer 成功记录”
的显式约束。旧 run evidence、createdBy、artifact provenance、source provenance
和 migration tool evidence 的保全规则仍需合并成可测试契约。

### 9. `privacy_preservation`: 部分通过

修订版新增 allowlist-first export policy，明确排除 provider requests、provider
responses、secrets、logs、recovery payload、debug 与 trace 文件，并规定 producer
evidence redaction。manifest field classification 也禁止 provider payload、api key、
token 和本地绝对路径进入 manifest。

不足是升级扫描边界仍不够显式。baseline 要求升级扫描和导出均不得读取或复制
provider payload、secrets、logs、recovery payload 和本地凭据。当前安全策略主要
覆盖 export 与 mount validation；`versionAndMigrationModel` 未明确 migration
scanner 只能按路径和类型记录排除项，不得读取敏感内容，也未规定旧包中敏感路径的
隔离或诊断状态。

### 10. `upgrade_testability`: 部分通过

修订版新增明确模块边界，包括 `book-package-migration.mjs`、
`book-readiness-gates.mjs`、`book-package-lifecycle.mjs` 和 security 模块；同时提供
migration state machine 与 test contracts。测试已覆盖当前 manifest 生成 draft
`BOOK_MANIFEST.json`、legacy migration idempotency、当前 38 本与 34 个 residue
分类、provider payload exclusion、qmd reindex on mount 和 GraphRAG query-ready
artifact-lineage binding。

不足是固定 baseline 要求的专项测试还没有逐项落地。仍缺少明确的 unsupported
migration、checksum mismatch during migration、rollback、rebuild qmd index、
GraphRAG schema incompatible 和 privacy exclusion during upgrade 的测试名称、
输入 fixture、预期状态与输出诊断。

## pass_fail

总体结论：未通过（fail）。

修订版显著改善了 R1 中的原子发布、readiness gate、大库扫描和安全导出问题，但
跨版本升级的核心准入项仍未闭合。尤其是 `migration_path_matrix` 仍缺少按旧版本
展开的可执行矩阵，`artifact_schema_conversion` 仍缺少逐类 artifact 转换规则。

| baseline id | R2 结果 | 判定摘要 |
| --- | --- | --- |
| `legacy_version_detection` | 部分通过 | 有 current/residue 分类，但缺少 unknown、unsupported、repairable、current 的完整旧版本检测状态。 |
| `migration_path_matrix` | 未通过 | 只有矩阵维度和 outcome，没有每个受支持旧版本的目标、前置条件、步骤和失败诊断。 |
| `artifact_schema_conversion` | 部分通过 | readiness gate 已增强，但 parquet、LanceDB、reports、stats、context、qmd index 的转换策略仍未逐类定义。 |
| `identity_stability` | 部分通过 | 冲突规则存在，缺少 identity old/new/reason/algorithm audit record。 |
| `checksum_reclosure` | 基本通过 | 新 checksum 闭包已定义，旧 checksum 只能作为 legacy evidence 的表述需显式化。 |
| `rollback_atomicity` | 通过 | staging、publish marker、atomic rename、last-good projection 和 rollback contract 已覆盖。 |
| `compatibility_diagnostics` | 部分通过 | 有部分 gate 状态和 evidence 文件，缺少完整诊断枚举和字段契约。 |
| `producer_lineage_preservation` | 部分通过 | artifact-lineage binding 改善明显，migration tool evidence 与不得伪造 producer 成功记录仍不足。 |
| `privacy_preservation` | 部分通过 | export/mount 隐私规则较完整，migration scanner 不读取敏感内容的规则仍需显式化。 |
| `upgrade_testability` | 部分通过 | 模块、状态机和部分测试存在，缺少固定 baseline 要求的升级专项测试矩阵。 |

## criteria_delta_from_r1

R1 结论为未通过。R2 相比 R1 的准入变化如下：

| baseline id | R1 状态 | R2 状态 | delta |
| --- | --- | --- | --- |
| `legacy_version_detection` | 部分通过 | 部分通过 | 新增 current/residue 分类，但旧 schema 分类仍不完整。 |
| `migration_path_matrix` | 未通过 | 未通过 | 新增矩阵维度和 outcomes，但仍无逐版本路径行。 |
| `artifact_schema_conversion` | 未通过 | 部分通过 | 新增 readiness gates 和兼容输入，仍缺 artifact 转换决策表。 |
| `identity_stability` | 部分通过 | 部分通过 | 冲突规则未变强，仍缺 identity migration record。 |
| `checksum_reclosure` | 部分通过 | 基本通过 | 新增原子发布与 sidecar commit 规则，旧 checksum evidence 表述仍需补强。 |
| `rollback_atomicity` | 未通过 | 通过 | staging、atomic publish、rollback 和 scanner visibility 已补齐。 |
| `compatibility_diagnostics` | 部分通过 | 部分通过 | 诊断位置和部分状态增加，但机器可读枚举仍不完整。 |
| `producer_lineage_preservation` | 部分通过 | 部分通过 | lineage binding 和 migration evidence 增强，迁移工具证据仍不足。 |
| `privacy_preservation` | 部分通过 | 部分通过 | export 隐私规则增强，升级扫描不读取敏感内容仍未明示。 |
| `upgrade_testability` | 未通过 | 部分通过 | 增加模块、状态机和部分测试，仍缺升级专项 fixture 契约。 |

## required_design_changes

1. 将 `compatibilityMatrix` 扩展为逐版本 `supportedMigrations` 表。每行必须包含旧
   package schema、旧 layout、旧 qmd index schema、旧 GraphRAG artifact schema、
   迁移目标、前置条件、转换步骤、失败状态和不可升级诊断。

2. 固化 legacy classification schema。至少定义 `unknown`、`unsupported`、
   `repairable`、`current`、`residue`、`current_hotplug_package` 的检测规则和输出
   诊断。

3. 增加 artifact conversion decision table。对 GraphRAG parquet、LanceDB、
   reports、stats、context、qmd index、qmd build manifest 分别定义
   `carry_forward`、`rewrite_manifest_only`、`schema_convert`、
   `rebuild_from_input`、`legacy_evidence_only`、`invalidate_not_query_ready` 的
   适用条件。

4. 增加 identity migration record。记录 `bookId`、`sourceHash`、
   `canonicalTitle`、`normalizedHash`、`producerRunIds` 的旧值、新值、计算方法、
   工具版本、变更原因和冲突处理。

5. 显式声明旧 checksum sidecars 和旧 distribution manifest digest 只能作为
   `legacyEvidence`。新挂载必须只由 `BOOK_MANIFEST.json`、新 file entries、新
   manifest checksum metadata 与 publish marker 授权。

6. 定义机器可读 compatibility diagnostic schema。覆盖
   `unsupported_legacy_schema`、`missing_required_file`、`rebuild_required`、
   `rebuild_failed`、`tool_version_too_old`、`artifact_schema_incompatible`、
   `privacy_excluded_path_detected` 等状态，并指定存放位置。

7. 补强 `migrationEvidence`。增加 migration tool name/version、startedAt、
   finishedAt、conversion steps、artifact decisions、rebuilt artifacts、skipped
   artifacts、missing legacy evidence 和 no-fabricated-producer-success 约束。

8. 在 migration 模型中明确隐私扫描边界。升级器不得读取 provider payload、
   secrets、logs、recovery payload 和本地凭据内容；发现旧路径时只能隔离或记录
   路径级诊断，不能复制到新 manifest 文件闭包。

9. 补充升级专项测试契约。测试必须覆盖 supported migration、unsupported
   migration、checksum mismatch、rollback、rebuild qmd index、GraphRAG schema
   incompatible、privacy exclusion during upgrade，并写明 fixture 输入和预期诊断。

## residual_risks

- 旧 GraphRAG artifact 若缺少 schema metadata，升级器可能无法可靠判定
  carry-forward 是否安全，只能保守降级为 not query-ready。
- qmd index 或 GraphRAG output 重建可能依赖原始 source、normalized input、模型
  配置和 provider 可用性；在隐私排除和离线环境下，升级结果可能只能部分可查询。
- 若缺少逐版本 migration matrix，实现者可能把未知旧版本误判为可迁移，导致新
  manifest 闭包看似有效但查询语义不一致。
- migration evidence 若不记录 identity 旧值与 artifact decision，后续审计难以
  解释升级后产物来自旧 producer、迁移器还是本地重建。
- 隐私规则目前偏 export/mount。旧目录中混入敏感 payload 时，升级实现若扫描内容
  而不是路径级排除，仍有泄露风险。
