# scenario

当前场景为：将现有 `graph_vault/books` 中 38 本完成书与 34 个历史
残留目录迁移到单本书热插拔布局（hot-plug package layout）。

复审边界为目标 Type DD：
`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`。本复审只检查
修订后的设计是否满足固定基线（fixed baseline），不读取 provider request、
provider response、provider payload、secrets、凭据、日志载荷或 provider cache。

# reused_fixed_baseline

本轮复用 R3 目录中已经存在的固定 baseline。

- baseline 路径：
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/agent-10-migration-cleanup/baseline.yaml`
- baseline SHA-256：
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`

固定 10 维如下，维度、顺序和 `passCriteria` 均沿用 baseline：

1. `current_vs_residue_classification`
2. `migration_source_of_truth`
3. `package_layout_transform`
4. `checksum_manifest_regeneration`
5. `residue_quarantine_policy`
6. `idempotent_migration`
7. `conflict_and_duplicate_handling`
8. `rollback_and_audit_trail`
9. `catalog_projection_cleanup`
10. `executable_migration_tests`

# baseline_integrity_check

Baseline 完整性检查通过。

- R3 baseline SHA-256 为
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`。
- R3 baseline 与 R2 `agent-10-migration-cleanup/baseline.yaml` 内容一致。
- R3 baseline 与初始 `agent-10-migration-cleanup/baseline.yaml` 内容一致。
- baseline 仍为 10 个维度，未新增、删除、重排、重命名维度。
- 未改变任何 `passCriteria`。
- 本轮只新增 `report.md`，未覆盖或修改 `baseline.yaml`。
- 复审未读取 provider payload、secrets、凭据或日志载荷。

# findings

## 1. `current_vs_residue_classification`

判定：通过。

Type DD 保留当前快照：72 个 book 目录、38 本完成书、34 个历史残留
目录，并记录完成书与残留目录的实际形态差异。`currentVsResidueClassification`
给出可执行完成书判定字段：有效 `distribution_manifest.json` 与 sidecars、
`qmd/qmd_build_manifest.json`、`output/qmd_output_manifest.json`、canonical
normalized input、producer run evidence。残留判定覆盖无有效 manifest、缺少
`qmd`、缺少 output manifest、旧 `bookId` 与不完整 checkpoint。

共享 `sourceHash` 的目录通过优先级规则处理：被 completed run manifest 和有效
legacy manifest 引用的目录胜出，其余进入 residue candidates。该规则足以防止
未分类目录被误迁移为 hot-plug authoritative package。

## 2. `migration_source_of_truth`

判定：通过。

迁移原则明确要求在身份歧义或闭包缺失时 fail closed。完成书闭包要求
legacy manifest、checksum sidecars、qmd build manifest、GraphRAG output
manifest、canonical input 与 producer run evidence 共同成立。
`distributionManifestMigration` 还要求迁移 source closure，并在成功的
`BOOK_MANIFEST.json` audit 前保留旧 `distribution_manifest.json` 作为 legacy
evidence。

该设计没有以目录名或单一文件作为迁移权威，而是以 manifest、sidecars、qmd、
output、runs、input 与 source closure 的一致组合为源权威。

## 3. `package_layout_transform`

判定：部分通过。

目标布局已明确：`source/`、`input/`、`qmd/`、`graphrag/output/`、
`graphrag/runs/`、`state/` 均位于 `graph_vault/books/{bookId}` 内；
import/build staging roots、runtime state roots 与 package root 也有明确边界。
`BOOK_MANIFEST.json.files` 要求 package-relative paths，安全策略拒绝绝对路径、
parent traversal、symlink escape 与 hardlink outside package。

剩余缺口是兼容桥（compatibility bridge）生命周期仍不完整。Type DD 允许
legacy `output/` 与 `runs/` 在一个 migration version 中通过 symlink 或
locator 保持兼容，但未定义 locator/symlink 文件名、是否进入 manifest files
闭包、校验方式、删除触发条件、版本过期后的强制行为，以及 mount scanner 如何
禁止同时读取 legacy path 与新 path。因此布局主路径可实现，但兼容桥还未满足
baseline 对生命周期规则的完整要求。

## 4. `checksum_manifest_regeneration`

判定：通过。

`atomicPackageLifecycle.publishProtocol` 固定生成顺序：先在 staging root 写入
package files，再生成 required package file checksums，再从 package-relative
paths 生成 `BOOK_MANIFEST.json`，随后生成 manifest sidecars 与
`PUBLISH_READY.json`，最后 fsync 并原子 rename 到 live root。迁移规则也明确
要求所有 move 或 copy 后重新生成 package-relative file entries 和 checksums。

该顺序禁止移动、复制、重命名或 redaction 后复用旧布局 checksum。manifest
checksum、checksum metadata、publish marker 与 files 闭包在目标布局中重新
形成校验权威。

## 5. `residue_quarantine_policy`

判定：通过。

`residuePolicy` 将默认动作定义为 `quarantine_without_delete`，archive root 为
`graph_vault/.archive/book-residues`，repair report 写入
`graph_vault/catalog/book-package-migrations/residue-report.yaml`。scanner rule
要求 residue candidates 不挂载，普通 mount scan 忽略它们，除非 repair command
显式指定。

R3 还通过 `quarantineAndRepairStateMachine` 与 `upgradePathMatrix` 强化了残留
状态：duplicate residue、partial qmd、partial GraphRAG、unsupported unknown
均有显式 quarantine、repair 或 fail-closed 路径。历史残留在 repair contract
通过前不会被删除、覆盖、导出、投影为可查询或参与 catalog 权威。

## 6. `idempotent_migration`

判定：通过。

迁移原则要求 idempotent、auditable、reversible until commit，并在身份歧义或
闭包缺失时 fail closed。`migrationStateMachine` 覆盖 discovered、
classified_current、classified_residue、staging_created、files_copied、
manifest_generated、checksums_regenerated、validated、published、mounted、
residue_quarantined、repair_required、migration_failed 与 rolled_back。

配合 staging publish、lock/lease、stale staging cleanup、last-good projection 与
failed replacement 规则，迁移工具可识别已迁移、部分迁移、中断失败、
legacy-only、residue 与已发布状态。重复运行不会暴露半成品，也不会在未通过完整
校验前改变已验证 package identity。

## 7. `conflict_and_duplicate_handling`

判定：通过。

Type DD 覆盖 baseline 中的主要冲突类型：
`sameBookIdDifferentSourceHash` fail closed，
`sameSourceHashDifferentBookId` 记录 duplicate candidate，共享 `sourceHash` 的
多目录按 completed run manifest 与有效 legacy manifest 确定胜出者，同源残留
进入 residue candidates。目标目录替换由
`deletionAndReplacement.sameBookIdNewGeneration`、`failedReplacement` 与
`manualConflictDecisionWorkflow.conflictTypes.package_generation_replace` 约束。

R3 新增 `manualConflictDecisionWorkflow`，定义 decision root、状态、record
字段、冲突类型、fail-closed pending rule 与测试。`conflictIndex` 和
`compatibilityDiagnostics` 提供稳定诊断入口。人工决策入口、fail-closed 行为与
稳定诊断已满足固定基线。

## 8. `rollback_and_audit_trail`

判定：部分通过。

Type DD 已有迁移证据目录与 evidence files：plan、classification、copy-map、
manifest-diff、validation、commit-record。`rollbackContract` 覆盖 before
publish、after publish before projection、after projection commit 与不可回滚
情形。R3 还通过 `artifactSchemaConversionMatrix.migrationToolEvidence` 增加
`migrationToolVersion`、`migrationStartedAt`、`migrationCompletedAt`、
`inputSha256`、`outputSha256`、`failureCode` 等字段。

剩余缺口是 baseline 要求的审计字段没有集中落入 migration evidence schema。
`migrationEvidence.requiredFields` 仍未显式要求 per-file 或 per-directory 的
`beforePath`、`afterPath`、`beforeHash`、`afterHash`、迁移工具版本、开始/完成
时间、`decisionStatus`、`failureReason`、`rollbackPlan` 和
`legacyEvidenceRetained`。现有 copy-map 与 artifact evidence 可推断部分信息，
但固定基线要求的是可审计记录的显式字段。

## 9. `catalog_projection_cleanup`

判定：通过。

`mountScanTransactionModel` 将 catalog 与 qmd projection 建模为 generation-based
transaction。mount scan 从 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
readiness gates 与 scan validation results 派生 `books.yaml`、`sources.yaml`、
`document-identity-map.yaml`、`graph-capabilities.yaml` 与 qmd projection。

`deletionAndReplacement.staleProjectionCleanup` 要求 absent book root 的
projection entries 在同一次 atomic commit 中移除。`staleProjectionInvalidation`
覆盖 packageGeneration、manifestSha256、checksum、schema、package root 删除、
qmd freshness 与 GraphRAG lineage binding 变化。R3 的
`catalogProjectionSchemas` 还禁止 derived catalog 读取 batch run state、provider
roots、global input 或绝对 source paths。迁移后的 catalog cleanup 闭包成立。

## 10. `executable_migration_tests`

判定：通过。

Type DD 已足够具体，使实现者可编写 baseline 要求的迁移测试：

- 38 本完成书与 34 个历史残留目录可按固定 criteria 分类。
- 残留目录通过 residue policy、quarantine state machine 与 upgrade path matrix
  进入隔离、repair、archive 或 fail-closed 状态。
- 中断重试、重复运行、stale lock takeover 与 staging cleanup 有状态机和测试矩阵。
- checksum 重建由 publish protocol、manifest sidecars、artifact metadata 与
  validator checksum order 约束。
- 冲突处理由 conflict index 与 manual conflict decision workflow 覆盖。
- catalog cleanup 由 mount scan transaction 与 stale projection invalidation 覆盖。
- provider payload 不读取由 security export policy 与 sensitive material taxonomy
  覆盖，且 scanner/migration policy 明确为 `no_raw_provider_payload_reads`。

# pass_fail

总体结论：部分通过（partial pass）。

R3 Type DD 已满足 8 个固定维度；仍未完全通过的维度为
`package_layout_transform` 与 `rollback_and_audit_trail`。主要缺口集中在 legacy
compatibility bridge 生命周期，以及迁移审计字段的显式完整性。

| baseline id | R3 判定 | 摘要 |
| --- | --- | --- |
| `current_vs_residue_classification` | 通过 | 38/34 快照、完成书 criteria、残留 criteria 与共享 `sourceHash` 优先级明确。 |
| `migration_source_of_truth` | 通过 | 迁移源权威由 manifest、sidecars、qmd、output、runs、input 与 source closure 共同构成。 |
| `package_layout_transform` | 部分通过 | 目标布局和 package-relative paths 明确；compatibility locator/symlink 生命周期未闭合。 |
| `checksum_manifest_regeneration` | 通过 | staging、files checksum、manifest、sidecars、publish marker 与原子 publish 顺序明确。 |
| `residue_quarantine_policy` | 通过 | 残留默认 quarantine，不挂载、不导出、不投影，repair/archive 需显式流程。 |
| `idempotent_migration` | 通过 | 状态机、staging、locks、cleanup 与 last-good projection 支撑中断重跑。 |
| `conflict_and_duplicate_handling` | 通过 | duplicate、same bookId/sourceHash、residue promotion 与 package replacement 有人工决策入口。 |
| `rollback_and_audit_trail` | 部分通过 | rollback contract 已有；migration evidence 缺少 baseline 要求的显式 before/after 字段。 |
| `catalog_projection_cleanup` | 通过 | mount scan 事务化重建 catalog/qmd projections，并同 commit 清理 stale entries。 |
| `executable_migration_tests` | 通过 | 设计足以落地 38/34、隔离、重试、checksum、冲突、catalog cleanup 与 no-payload-read 测试。 |

# criteria_delta_from_r2

| baseline id | R2 判定 | R3 判定 | delta |
| --- | --- | --- | --- |
| `current_vs_residue_classification` | 通过 | 通过 | 无回退；R3 继续满足 38/34 分类和 sourceHash 优先级。 |
| `migration_source_of_truth` | 通过 | 通过 | 无回退；R3 继续以组合闭包作为迁移权威。 |
| `package_layout_transform` | 部分通过 | 部分通过 | 仍未闭合 compatibility locator/symlink 的生命周期。 |
| `checksum_manifest_regeneration` | 通过 | 通过 | 无回退；R3 的 validator 和 artifact metadata 进一步强化校验闭包。 |
| `residue_quarantine_policy` | 通过 | 通过 | 无回退；R3 通过 quarantine/repair state machine 和 upgrade path matrix 强化残留状态。 |
| `idempotent_migration` | 通过 | 通过 | 无回退；R3 增加 lock/lease 与 stale staging cleanup 支撑恢复。 |
| `conflict_and_duplicate_handling` | 部分通过 | 通过 | R3 新增 manual conflict decision workflow，补齐人工决策 schema、状态和测试。 |
| `rollback_and_audit_trail` | 部分通过 | 部分通过 | R3 新增 migration tool evidence，但 migration evidence required fields 仍不完整。 |
| `catalog_projection_cleanup` | 通过 | 通过 | 无回退；R3 新增 catalog projection schemas 和 forbidden inputs。 |
| `executable_migration_tests` | 部分通过 | 通过 | R3 已足够支撑 required migration tests，尤其是 manual conflict、sensitive material 和 upgrade path 测试。 |

# required_design_changes

1. 补齐 compatibility bridge contract。明确 legacy `output/` 与 `runs/` 的
   locator/symlink 文件名、路径、manifest files 闭包规则、checksum 规则、允许的
   layout version、删除或失效触发条件，以及 scanner 禁止新旧路径双读的规则。

2. 扩展 `migrationEvidence.requiredFields`。至少加入 `beforePath`、`afterPath`、
   `beforeHash`、`afterHash`、`migrationToolVersion`、`migrationStartedAt`、
   `migrationCompletedAt`、`decisionStatus`、`failureReason`、`rollbackPlan` 与
   `legacyEvidenceRetained`。若字段位于 `copy-map.yaml`、`manifest-diff.yaml` 或
   artifact evidence 中，应在 Type DD 中显式声明 schema 和引用关系。

3. 明确迁移期人类 metadata 保护规则。重复运行或 replacement migration 遇到
   已存在 `metadata/` 时，应定义 preserve、merge、manual decision 或 fail-closed
   行为，并在 migration evidence 中记录决策。

# residual_risks

- 兼容桥生命周期不明确时，实现可能同时读取 legacy `output/` 与
  `graphrag/output/`，导致 files 闭包、checksum 与 query-ready evidence 不一致。
- 迁移审计字段不完整时，事故复盘（postmortem）、rollback 验证和批量迁移差异
  核查会依赖隐式推断，而不是稳定记录。
- 目标目录已存在且包含人工 `metadata/` 时，若实现只按 package replacement
  处理，可能覆盖接收方新增 metadata 或产生不可追踪 merge。
- 严格 fail-closed 会提高 38 本批量迁移中的阻塞率；repair report、manual
  decision 和 residue quarantine 需要在实现中保持可查询但不可挂载的清晰状态。
- 自动化测试虽然可从 Type DD 落地，但实现阶段仍应使用 fixture 明确覆盖
  compatibility bridge、per-file before/after audit、metadata preservation 和
  provider payload no-read 断言。
