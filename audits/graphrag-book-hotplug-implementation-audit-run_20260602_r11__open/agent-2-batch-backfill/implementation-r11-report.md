# GraphRAG 单本书热插拔实现审计 R11 报告

## 审计上下文

- runId: `20260602_r11`
- agentId: `agent-2-batch-backfill`
- baseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r11__open/agent-2-batch-backfill/fixed-baseline.yaml`
- baselinePolicy:
  逐字复用固定 10 维基准（fixed 10-baseline policy），未新增、删除、
  改名或重排任一基准。
- 审计范围：
  - `docs/architecture/graphrag-book-hotplug-package.README.md`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml`
  - `scripts/graphrag/backfill-hotplug-packages.mjs`
  - `scripts/graphrag/book-hotplug-package.mjs`
  - `scripts/graphrag/book-hotplug-creation-identity.mjs`
  - `scripts/graphrag/batch-epub-workflow.mjs`
  - `test/graphrag-book-hotplug-backfill.test.ts`
  - `test/graphrag-book-hotplug-creation-gate.test.ts`
- 独立复核（independent verification）：
  - 引用并复核用户已给通过证据：creation gate、backfill、runtime gate、
    catalog、qmd projection、runtime hardening、`tsc`、真实 backfill
    `--only-missing`。
  - 本轮独立复跑：
    `npm exec -- vitest run test/graphrag-book-hotplug-backfill.test.ts test/graphrag-book-hotplug-creation-gate.test.ts`
    ，结果为 `2` 个文件、`6` 个测试全部通过。

## 总体结论

- overallStatus: `partial`
- baselineCount: `10`
- passed: `8`
- partial: `2`
- failed: `0`

本轮补丁没有使 Agent 2 在 batch/backfill/migration 维度退化。
`--only-missing` 的 verify-only 跳过前验证（pre-skip validation）、
质量门刷新（gate refresh）不改 `BOOK_MANIFEST.files` 闭包，以及
已迁移包不重写 manifest/publish marker，这些点现在有合同、实现和测试的
一致证据。

但 R10 中 Agent 2 的两个 partial 结论并未真正关闭：

1. `idempotent_migration` 仍缺 `partial_migration` /
   `failed_interrupted` 的执行级恢复（executable resume/restart）。
2. `rollback_and_audit_trail` 仍缺失败后恢复 live root / catalog
   projection generation 的执行闭环（rollback executor）。

因此，本轮结论是“未恶化（no regression），但未闭环（not closed）”。

## R10 跟踪结论

1. `idempotent_migration`：未关闭，但已补强 already-migrated 路径。
   `backfill-hotplug-packages.mjs` 现在在 `--only-missing` 跳过前先执行
   `validateBookHotplugPackage`，并只刷新
   `state/hotplug-quality-gate.json` /
   `state/hotplug-runtime-gate.json`。对应实现位于
   `scripts/graphrag/backfill-hotplug-packages.mjs:320-376`。
   `test/graphrag-book-hotplug-backfill.test.ts:223-298`
   证明 manifest 不重写、sidecar 损坏时 fail-closed。

2. `rollback_and_audit_trail`：未关闭，但证据记录更完整。
   `resume-plan.yaml` 与 `rollback-record.yaml` 已被纳入规范和实现，
   对应合同位于
   `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1326-1368`
   ，实现位于
   `scripts/graphrag/book-hotplug-migration-state.mjs:824-999`。
   真实运行
   `hotplug-backfill-20260603023040784`
   的 `resume-plan.yaml` / `rollback-record.yaml`
   也已落盘，但仍是 evidence-first，不是 restore-first。

## 逐项判定

1. `current_vs_residue_classification` — `pass`

   `classifyBookDirectory` 能区分 `already_migrated`、`legacy_only`、
   `partial_migration`、`failed_interrupted`、`repair_required`、
   `residue_quarantined`，并写出稳定诊断与 `rerunBehavior`，
   见 `scripts/graphrag/book-hotplug-migration-state.mjs:465-500`。
   真实 `classification.yaml` 记录：
   `totalDirectories=72`、`candidates=38`、`residues=34`、
   `alreadyMigrated=38`、`residueQuarantined=34`、
   `partialMigration=0`、`failedInterrupted=0`。

2. `migration_source_of_truth` — `pass`

   `mayGenerateBookManifest` 受 distribution manifest sidecars、
   canonical input、source closure、qmd build manifest、
   GraphRAG output manifest、producer evidence、artifact checksums 共同约束，
   任一关键条件缺失即 fail-closed，见
   `scripts/graphrag/book-hotplug-migration-state.mjs:360-463`。
   运行期创建路径复用同一 source-truth gate，见
   `scripts/graphrag/batch-epub-workflow.mjs:10233-10249`。
   source closure 还会在创建期核验并复制到
   `graph_vault/sources/{bookId}`，见
   `scripts/graphrag/batch-epub-workflow.mjs:10172-10186`。

3. `package_layout_transform` — `pass`

   hotplug authoritative layout 已固定为 package-relative 的
   `source/`、`input/`、`qmd/`、`graphrag/output/`、
   `graphrag/runs/`、`state/`。copy-map 明确 legacy
   `output/` / `runs/` / loose state 到新路径的映射，见
   `scripts/graphrag/book-hotplug-migration-state.mjs:760-787`。
   manifest 校验也强制 `mount.packageRoot="."`，见
   `scripts/graphrag/book-hotplug-package.mjs:745-749`。

4. `checksum_manifest_regeneration` — `pass`

   `BOOK_MANIFEST.json`、`PUBLISH_READY.json` 及 sidecars
   会重新生成并重新校验；manifest 内嵌 checksum、sidecar checksum、
   publish marker checksum、逐文件 checksum 都会被验证，见
   `scripts/graphrag/book-hotplug-package.mjs:696-713`、
   `716-921`。
   `test/graphrag-book-hotplug-backfill.test.ts:278-298`
   证明旧 sidecar 被篡改后不会被复用，而是直接失败。

5. `residue_quarantine_policy` — `pass`

   Type DD 与 README 明确无 `BOOK_MANIFEST.json` /
   `PUBLISH_READY.json` 的历史目录不是 hotplug 包，不挂载、不投影、
   不作为权威状态，见
   `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:170-202`、
   `docs/architecture/graphrag-book-hotplug-package.README.md:73-74`。
   实现会把这类目录分类为 `residue_quarantined`，并在
   `residue-report.yaml` 中保留修复入口而不删除 legacy evidence，
   见 `scripts/graphrag/book-hotplug-migration-state.mjs:958-1000`。

6. `idempotent_migration` — `partial`

   已关闭的部分：

   - already-migrated rerun 走 verify-only，不重写
     `BOOK_MANIFEST.json` / `PUBLISH_READY.json`，见
     `scripts/graphrag/backfill-hotplug-packages.mjs:393-430` 与
     `test/graphrag-book-hotplug-backfill.test.ts:172-221`。
   - `--only-missing` 在 skip 前强制验证既有 package，并刷新 gate，
     但 gate 文件不进入 `BOOK_MANIFEST.files` 闭包，见
     `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:303-335`、
     `scripts/graphrag/book-hotplug-package.mjs:376-399`。

   仍未关闭的部分：

   - `partial_migration` / `failed_interrupted` 只有分类、`rerunBehavior`、
     `resume-plan.yaml` 与 `rollback-record.yaml`，见
     `scripts/graphrag/book-hotplug-migration-state.mjs:465-500`、
     `824-957`。
   - `backfill-hotplug-packages.mjs` 没有读取 copy-map/checkpoint 来执行
     `resume_from_copy_map_after_staging_validation`，也没有显式
     `--resume` / `--restart` 路径。
   - `test/graphrag-book-hotplug-catalog.test.ts:340-423`
     只验证 evidence 生成，不验证真正恢复执行。

7. `conflict_and_duplicate_handling` — `pass`

   冲突表可稳定输出
   `migration_duplicate_source_hash`、
   `migration_book_id_source_hash_conflict`、
   `migration_manifest_identity_mismatch`、
   `migration_source_hash_prefix_conflict` 等诊断，见
   `scripts/graphrag/book-hotplug-migration-state.mjs:504-655`。
   backfill 会对 hard identity conflict 直接 fail-closed，见
   `scripts/graphrag/backfill-hotplug-packages.mjs:290-319`。
   自动化测试覆盖同源双目录与同 `bookId` 异 `sourceHash` 两类主冲突，
   见 `test/graphrag-book-hotplug-backfill.test.ts:141-166`、
   `336-400`。

8. `rollback_and_audit_trail` — `partial`

   已补强的部分：

   - 迁移证据包含 `plan.yaml`、`copy-map.yaml`、`manifest-diff.yaml`、
     `checkpoint.yaml`、`validation.yaml`、`commit-record.yaml`、
     `resume-plan.yaml`、`rollback-record.yaml`、`residue-report.yaml`、
     `book-conflicts.yaml`，见
     `scripts/graphrag/book-hotplug-migration-state.mjs:974-1009`。
   - 真实
     `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603023040784/rollback-record.yaml`
     记录了 `preservePublishedBookIds=38`、`packageRoots=72`。
   - 创建与 backfill 的 publish 失败会移除 `PUBLISH_READY.json`
     与 sidecars，见
     `scripts/graphrag/batch-epub-workflow.mjs:10266-10357`、
     `test/graphrag-book-hotplug-backfill.test.ts:304-330`。

   仍未关闭的部分：

   - rollback 仍是 declarative policy，并没有目录级 restore executor。
   - `remove_new_live_root_and_restore_previous_projection_generation` /
     `restore_previous_projection_generation_if_current_package_invalid`
     仅出现在记录字段中，未见实际调用链。

9. `catalog_projection_cleanup` — `pass`

   catalog rebuild 只从通过 `validateBookHotplugPackage` 的 mounted
   package 重建，见 `scripts/graphrag/book-hotplug-package.mjs:929-960`。
   Type DD 明确 qmd projection rebuild 时会移除 stale roots，见
   `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1140-1166`。
   真实 backfill
   `hotplug-backfill-20260603023040784`
   的 catalog 结果为 `book/identity/capability=38/38/30`，
   与 34 个 residue 不入投影的规则一致。

10. `executable_migration_tests` — `pass`

    当前实现面已有可执行测试覆盖：

    - 创建质量门与 manifest/publish marker 发布次序：
      `test/graphrag-book-hotplug-creation-gate.test.ts`
    - already-migrated verify-only、`--only-missing` skip gate、
      fsync fail-closed、主冲突 fail-closed：
      `test/graphrag-book-hotplug-backfill.test.ts`
    - partial/interrupted 的 evidence 契约：
      `test/graphrag-book-hotplug-catalog.test.ts:340-423`

    需要说明的是，恢复执行测试缺失的直接原因是恢复执行器本身尚未实现。
    这已经体现在 `idempotent_migration` 与
    `rollback_and_audit_trail` 的 partial 判定中，不单独再降级本基准。

## 主要发现

1. `medium` — `idempotent_migration`

   `partial_migration` 与 `failed_interrupted` 仍停留在
   “可分类、可出证据、可提示人工决策”的层级，尚未形成可执行的
   resume/restart 闭环。

   建议：
   增加显式 `--resume` / `--restart` 执行路径，消费
   `copy-map.yaml`、`checkpoint.yaml`、`resume-plan.yaml`，
   并补齐 staging validation、metadata protection、
   package identity 不变式与 end-to-end 自动化测试。

2. `medium` — `rollback_and_audit_trail`

   `rollback-record.yaml` 已能记录 before/after、policy、packageRoots、
   preserve/remove 决策，但实际代码仍缺少
   live-root restore 与 projection generation restore 的执行器。

   建议：
   实现 rollback executor，覆盖以下失败点：
   manifest 已写但 publish marker 未提交、publish marker 已提交但 projection
   未提交、projection 已提交但校验失败，并为每个阶段补齐可执行测试。

## 关键证据

- 合同与状态快照：
  - `docs/architecture/graphrag-book-hotplug-package.README.md:51-74`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:118-202`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:303-335`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:748-825`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1288-1368`

- 关键实现：
  - `scripts/graphrag/backfill-hotplug-packages.mjs:320-376`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:378-430`
  - `scripts/graphrag/book-hotplug-package.mjs:376-399`
  - `scripts/graphrag/book-hotplug-package.mjs:716-927`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:465-500`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:706-1009`
  - `scripts/graphrag/batch-epub-workflow.mjs:10172-10377`

- 真实运行产物：
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603023040784/classification.yaml`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603023040784/resume-plan.yaml`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603023040784/rollback-record.yaml`

- 自动化测试：
  - `test/graphrag-book-hotplug-backfill.test.ts:172-330`
  - `test/graphrag-book-hotplug-creation-gate.test.ts:19-103`
  - `test/graphrag-book-hotplug-catalog.test.ts:340-423`
