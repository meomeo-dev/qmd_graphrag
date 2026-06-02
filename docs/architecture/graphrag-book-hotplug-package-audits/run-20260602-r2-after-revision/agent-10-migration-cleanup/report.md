# agent-10-migration-cleanup R2 复审报告

## scenario

审计场景（scenario）为：将当前 `graph_vault/books` 中 38 本完成书与
34 个历史残留目录迁移到单本书热插拔布局（hot-plug package layout）。
完成书当前具备 `input/`、`output/`、`qmd/`、`runs/`、
`distribution_manifest.json` 及校验 sidecars 等迁移证据；历史残留目录
可能缺少 `qmd/`、`output/` 或 `distribution_manifest.json`，并可能与
完成书共享 `sourceHash` 或目录前缀。

本复审只评估修订后的 Type DD 是否足以约束迁移设计；未读取 provider
request、provider response、secrets、payload logs 或其他敏感 payload。

## reused_fixed_baseline

本复审复用 R2 目录中已存在的固定基准文件：

- 路径：`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/agent-10-migration-cleanup/baseline.yaml`
- SHA-256：
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`

固定 10 维如下，维度名称、顺序与 `passCriteria` 均未变更：

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

## baseline_integrity_check

Baseline 完整性检查（integrity check）通过。

- R2 baseline SHA-256 为
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`。
- R2 baseline 与 R1 `agent-10-migration-cleanup/baseline.yaml` 内容一致。
- 未新增、删除、重命名 baseline 维度。
- 未改变任何 `passCriteria`。
- 本次只新增 `report.md`，未覆盖 `baseline.yaml`。

## findings

### 1. `current_vs_residue_classification`

判定：通过。

修订版保留了当前快照：72 个 book 目录、38 本完成书、34 个历史残留目录，
并记录残留可能缺少 `qmd`、`output` 与 `distribution_manifest.json`。
新增的 `currentVsResidueClassification` 将完成书判定落到可执行字段：
有效 `distribution_manifest.json` 及 sidecars、`qmd/qmd_build_manifest.json`、
`output/qmd_output_manifest.json`、canonical normalized input、producer run
evidence。残留判定也覆盖无有效 manifest、缺少 `qmd`、缺少 output manifest、
旧 `sourceHash` bookId 与不完整 checkpoint。

该维度相对 R1 的关键改进是加入优先级规则（priority rule）：多个目录共享
`sourceHash` 时，由 completed run manifest 与有效 legacy manifest 引用的目录
胜出，其余作为 residue candidates。该规则可防止未分类目录被误迁移为
hot-plug authoritative package。

### 2. `migration_source_of_truth`

判定：通过。

修订版明确 migration from current distribution manifests to hot-plug packages
必须在身份不明确或闭包缺失时 fail closed。完成书 criteria 要求 legacy
manifest、checksum sidecars、qmd build manifest、GraphRAG output manifest、
input canonical normalized file 与 producer run evidence 的组合闭包。
`distributionManifestMigration` 仍保留旧 `distribution_manifest.json` 作为
legacy evidence，直到下一次成功的 `BOOK_MANIFEST.json` audit。

该设计满足“源权威（source of truth）”要求：迁移不是凭目录名或单一文件生成
`BOOK_MANIFEST.json`，而是以 manifest、sidecars、qmd、output、runs、input
和 source closure 的一致组合为条件。

### 3. `package_layout_transform`

判定：部分通过。

修订版清楚规定目标布局：`source/`、`input/`、`qmd/`、
`graphrag/output/`、`graphrag/runs/`、`state/` 均位于
`graph_vault/books/{bookId}` 内，manifest files 也要求 package-relative
paths。迁移规则明确 source closure 从 `graph_vault/sources/{bookId}` 移入
`source/`，GraphRAG `output/` 移至 `graphrag/output/`，producer runs 移至
`graphrag/runs/`，`job.yaml`、`checkpoints.yaml`、`artifacts.yaml` 移入
`state/`，`input/` 继续作为 canonical normalized input root。

剩余缺口在兼容桥（compatibility bridge）生命周期。Type DD 允许 `output/`
和 `runs/` 在一个 migration version 中通过 symlink 或 locator 兼容，但未规定
symlink 与 locator 的具体文件名、是否进入 manifest files 闭包、何时强制删除、
以及 mount scanner 如何避免同时读取 legacy path 与新 path。布局转换主规则
已满足，但兼容桥仍需要更细 contract 才能完全可实现。

### 4. `checksum_manifest_regeneration`

判定：通过。

修订版补齐了 R1 缺失的生成顺序。`publishProtocol` 要求先在 staging root
写入 package files，再生成所有 required package file checksums，然后从
package-relative paths 生成 `BOOK_MANIFEST.json`，再生成 manifest sidecars 和
`PUBLISH_READY.json`，最后 fsync 并原子 rename 到 live root。迁移规则要求所有
move 之后重新生成 package-relative file entries 和 checksums。

该顺序防止移动、复制、重命名或 redaction 后复用旧 checksum。manifest sidecar
也在 manifest 写入后生成，sidecar mismatch fail closed 且阻止 projection。

### 5. `residue_quarantine_policy`

判定：通过。

修订版新增 `residuePolicy`：默认动作是 `quarantine_without_delete`，archive
root 为 `graph_vault/.archive/book-residues`，repair report 写入
`graph_vault/catalog/book-package-migrations/residue-report.yaml`。scanner rule
明确 residue candidates 不挂载，并在正常 mount scan 中忽略，除非 repair
command 显式指定。

该设计满足“不删除、不覆盖、不导出、不投影为可查询、不参与 catalog 权威”的
核心要求。R1 中“不自动删除但未隔离”的缺口已补齐。

### 6. `idempotent_migration`

判定：通过。

修订版将幂等性（idempotency）提升为 `versionAndMigrationModel` 的原则：
迁移必须 idempotent、auditable、reversible until commit，并在身份歧义或闭包
缺失时 fail closed。`migrationStateMachine` 覆盖 discovered、
classified_current、classified_residue、staging_created、files_copied、
manifest_generated、checksums_regenerated、validated、published、mounted、
residue_quarantined、repair_required、migration_failed、rolled_back。

这些状态足以让实现识别已迁移、部分迁移、中断失败、legacy-only 或 residue
状态。配合 staging publish protocol，重复运行可避免重复移动文件、破坏 checksum、
覆盖已验证 package identity。

### 7. `conflict_and_duplicate_handling`

判定：部分通过。

修订版已有挂载期与迁移期冲突基础：`sameBookIdDifferentSourceHash` fail closed，
`sameSourceHashDifferentBookId` report duplicate candidate，多个目录共享
`sourceHash` 时由 completed run manifest 与有效 distribution manifest 引用者
胜出，其余作为 residue candidates。`incompletePackagePolicy` 也覆盖 checksum
mismatch、missing required file、path traversal、symlink escape 等 quarantine。

仍不足的是 baseline 要求人工决策入口（manual decision entry）和稳定诊断。
Type DD 说明 duplicate candidate 与 repair_required，但未定义人工确认记录的
schema、允许的决策值、审批后如何继续迁移、目标目录已存在且 generation 冲突时的
迁移期处理细节。该维度比 R1 明显改进，但未完全闭合。

### 8. `rollback_and_audit_trail`

判定：部分通过。

修订版新增 `migrationEvidence` 与 `rollbackContract`。证据文件包括 plan、
classification、copy-map、manifest-diff、validation、commit-record；字段包括
migrationId、sourceBookId、targetBookId、sourceHash、oldManifestSha256、
newManifestSha256、copiedFiles、skippedFiles、excludedFiles、residueAction、
rollbackAvailable。回滚策略覆盖 before publish、after publish before
projection、after projection commit，以及不可回滚情形。

剩余缺口是 baseline 明确要求 before/after path、hash、迁移工具版本、时间、
决策状态和失败原因。修订版字段已有 old/new manifest hash 与 copy evidence，
但未显式要求每个文件或目录的 before/after path、before/after hash、
toolVersion、startedAt/completedAt、decisionStatus、failureReason。审计与回滚
方向已成立，但 schema 还需补齐这些字段。

### 9. `catalog_projection_cleanup`

判定：通过。

修订版在 `mountScanTransactionModel` 中定义 generation-based transaction。
mount scan 派生 `books.yaml`、`sources.yaml`、`document-identity-map.yaml`、
`graph-capabilities.yaml` 与 `qmd-projection.yaml`，并在 atomic commit 中替换。
`deletionAndReplacement.staleProjectionCleanup` 要求 committed candidate set 中
不存在的 book root 对应 projection entries 在同一次 atomic commit 中移除。

`staleProjectionInvalidation` 进一步规定 packageGeneration、manifestSha256、
checksum failure、schema compatibility、package root deletion、qmd freshness
input 与 GraphRAG lineage binding 变化都会在同一 projection commit 中移除
query-ready capability。该维度满足迁移后旧投影移除或标记 stale 的要求。

### 10. `executable_migration_tests`

判定：部分通过。

修订版测试契约新增三项关键覆盖：legacy migration across interruption and rerun
必须幂等；当前 38 本完成书可与 34 个历史 residue directories 分离分类；
provider payloads、logs、corrupt artifacts 和 runtime recovery files 不进入导出包。
同时已有 atomic rename、missing `PUBLISH_READY.json` 不挂载、scanner crash 保留
last-good projection、同 bookId 不同 sourceHash fail closed、GraphRAG
query-ready artifact-lineage binding 等测试。

不足是 baseline 要求的专项迁移测试未全部逐项落地：34 个残留目录隔离后的
archive/repair 可见性、checksum 重建不复用旧布局 hash、重复运行不覆盖用户新增
metadata、catalog cleanup 移除旧 path、duplicate/manual decision、target
directory already exists 等仍未成为明确测试 case。该维度可指导初步实现，但仍需
细化测试矩阵。

## pass_fail

总体结论：部分通过（partial pass）。

修订后的 Type DD 已补齐 R1 中最关键的迁移状态机、残留隔离、staging/atomic
publish、manifest/checksum 重建和 catalog cleanup contract。尚未完全通过的点
集中在兼容桥生命周期、人工冲突决策入口、审计字段完整性和迁移专项测试矩阵。

| baseline id | R2 结果 | 判定摘要 |
| --- | --- | --- |
| `current_vs_residue_classification` | 通过 | 已有 38/34 快照、完成书/残留 criteria、共享 `sourceHash` 优先级。 |
| `migration_source_of_truth` | 通过 | 迁移以 manifest、sidecars、qmd、output、runs、input、source closure 组合闭包为权威。 |
| `package_layout_transform` | 部分通过 | 目标布局和 package-relative paths 明确；兼容 symlink/locator 生命周期仍不足。 |
| `checksum_manifest_regeneration` | 通过 | staging、manifest-last、checksum sidecar、PUBLISH_READY 与原子 publish 顺序明确。 |
| `residue_quarantine_policy` | 通过 | 残留默认 quarantine_without_delete，普通 scanner 忽略，repair 显式触发。 |
| `idempotent_migration` | 通过 | 状态机覆盖中断、重跑、失败、回滚、残留隔离与已发布状态。 |
| `conflict_and_duplicate_handling` | 部分通过 | fail-closed 与 duplicate candidate 有规则；人工决策 schema 和目标目录冲突细节不足。 |
| `rollback_and_audit_trail` | 部分通过 | 已有 evidence files 与 rollback contract；缺少 before/after path、toolVersion、时间和失败原因等显式字段。 |
| `catalog_projection_cleanup` | 通过 | mount scan 事务化并在同一 commit 中清理 stale projection。 |
| `executable_migration_tests` | 部分通过 | 新增 38/34 与幂等测试；残留隔离、checksum 重建、manual conflict、catalog cleanup 仍需专项 case。 |

## criteria_delta_from_r1

R1 到 R2 的主要变化如下：

- `residue_quarantine_policy`：从未通过提升为通过。R2 新增
  `residuePolicy`，明确 quarantine、archive root、repair report 与 scanner
  ignore 规则。
- `idempotent_migration`：从未通过提升为通过。R2 新增
  `migrationStateMachine`，覆盖中断、重跑、失败和回滚状态。
- `rollback_and_audit_trail`：从未通过提升为部分通过。R2 已有迁移证据与回滚
  合约，但审计字段还不完全满足 baseline。
- `checksum_manifest_regeneration`：从部分通过提升为通过。R2 通过 staging 与
  atomic publish 明确 manifest/checksum 生成顺序。
- `catalog_projection_cleanup`：从部分通过提升为通过。R2 定义 mount scan
  transaction 与 stale projection cleanup。
- `current_vs_residue_classification`：从部分通过提升为通过。R2 增加可执行
  classification criteria 与 sourceHash priority rule。
- `migration_source_of_truth`：从部分通过提升为通过。R2 补充 missing closure
  fail-closed 原则与完成书判定闭包。
- `package_layout_transform`：仍为部分通过。R2 布局更明确，但 compatibility
  symlink/locator lifecycle 仍未闭合。
- `conflict_and_duplicate_handling`：仍为部分通过。R2 增加 sourceHash 去重规则，
  但人工决策入口未定义。
- `executable_migration_tests`：仍为部分通过。R2 增加关键迁移测试，但测试矩阵
  未覆盖 baseline 的所有迁移失败与 cleanup 场景。

## required_design_changes

1. 补充 compatibility bridge contract。明确 legacy `output/` 与 `runs/` 的
   locator/symlink 文件名、是否写入 `BOOK_MANIFEST.json.files`、有效 layout
   version、删除时机，以及 scanner 禁止新旧路径双读的规则。

2. 补充人工冲突决策 schema。至少定义 decision record 路径、字段、允许值、
   决策者、时间、reason、affected bookIds/sourceHashes、后续迁移动作，以及
   未决时 fail-closed 的稳定诊断。

3. 补充目标目录已存在的迁移期处理。区分 same generation already validated、
   newer generation present、stale partial staging、checksum mismatch live root、
   previous failed migration 等情形，并定义 idempotent 行为。

4. 扩展 `migrationEvidence.requiredFields`。显式加入 beforePath、afterPath、
   beforeHash、afterHash、toolVersion、startedAt、completedAt、decisionStatus、
   failureReason、rollbackPlan、legacyEvidenceRetained。

5. 补充 checksum metadata contract。明确
   `BOOK_MANIFEST.json.sha256.meta.json` 是否记录 migrationId、toolVersion、
   oldManifestSha256、redaction/exclusion summary 与 source closure digest。

6. 扩展迁移专项测试矩阵。增加 34 残留目录隔离、residue repair report、
   checksum 重建不复用旧 hash、重复运行不覆盖人工 metadata、target directory
   already exists、duplicate manual decision、catalog stale path cleanup、provider
   payload 不读取等独立测试。

## residual_risks

- 兼容桥若未严格限定生命周期，后续实现可能同时读取 legacy `output/` 与
  `graphrag/output/`，导致 files 闭包和 query-ready 证据不一致。
- 人工冲突决策未成 schema 时，duplicate candidate 可能长期停留在诊断状态，
  难以批量完成 38/34 迁移。
- 审计字段未显式包含工具版本、时间、失败原因和 before/after path/hash，会削弱
  事故复盘（postmortem）和 rollback 可验证性。
- 测试契约仍偏功能摘要，若实现者只按现有 testContracts 编写测试，可能漏掉残留
  archive/repair 可见性、目标目录已存在和 catalog stale cleanup 的边界。
- 严格 fail-closed 会提高迁移失败率；需要 repair report 与人工决策入口配套，
  否则 38 本完成书中任何 sidecar 或 lineage 小缺口都可能阻塞批量迁移。
