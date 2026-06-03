# GraphRAG 单本书热插拔 Batch Backfill 实现审计 R12 报告

## 审计边界

- runId: `20260602_r12`
- agentId: `agent-2-batch-backfill`
- 固定基准（fixed baseline）:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r12__open/agent-2-batch-backfill/fixed-baseline.yaml`
- fixedBaselineSha256:
  `1d15ad741b3425cba731459cae844c9d7d4879f5f9386003d1c8ad2a33acfc41`
- 基准策略（baseline policy）:
  使用指定 `fixed-baseline.yaml`，未新增、改名、重排或改写基准。
- 审计范围:
  - `scripts/graphrag/backfill-hotplug-packages.mjs`
  - `scripts/graphrag/book-hotplug-migration-state.mjs`
  - `scripts/graphrag/book-hotplug-migration-executor.mjs`
  - `scripts/graphrag/book-hotplug-package.mjs`
  - `scripts/graphrag/book-hotplug-durable-writer.mjs`
  - `test/graphrag-book-hotplug-backfill.test.ts`
  - 真实 `graph_vault` 的只读分类、包校验和既有迁移证据

## 总体结论

- overallStatus: `pass`
- baselineCount: `10`
- passed: `10`
- partial: `0`
- failed: `0`

R11 中 Agent 2 剩余的 batch/backfill 发现已关闭。`--only-missing`
路径在跳过前验证已发布包（pre-skip validation），验证失败会
fail-closed，不会把损坏包当作已迁移包跳过。`--resume-interrupted`
与 `--rollback-interrupted` 已提供可执行恢复路径（executable recovery
path），并写入 `execution-record.json` 及 sidecars。真实 `graph_vault`
复核显示 38 个已发布包均验证通过，当前候选状态全部为
`already_migrated`，既有迁移运行记录显示已完成书被跳过而非重跑。

## R11 发现关闭状态

1. `backfill --only-missing` 跳过前验证已发布包: `closed`

   `backfill-hotplug-packages.mjs` 在 `onlyMissing && !force` 分支中要求
   `BOOK_MANIFEST.json`、manifest sidecars 与 `PUBLISH_READY.json`
   存在后，仍调用 `validateExistingHotplugPackage`。验证失败时写失败
   quality/runtime gate、记录 `packageResults.status="failed"`，并以
   非零退出。测试 `only-missing verifies existing package before skipping`
   覆盖 manifest 不重写、skip 前验证和 stale sidecar fail-closed。

2. `--resume-interrupted` 可执行恢复路径: `closed`

   `book-hotplug-migration-executor.mjs` 对 `partial_migration` 执行
   staging root 检查、受保护 metadata 检查、删除未提交 staging，
   然后主 backfill 重新分类并继续生成已验证 package。测试
   `resume-interrupted removes uncommitted staging and completes backfill`
   覆盖 staging 删除、package 完成发布和 execution record 落盘。

3. `--rollback-interrupted` 可执行恢复路径: `closed`

   executor 对 `failed_interrupted` 删除 publish marker 与未提交 staging，
   并在 live manifest 无法通过 package validator 时删除该 invalid
   manifest 及 sidecars。测试
   `rollback-interrupted removes invalid live manifest before backfill`
   覆盖 invalid manifest 删除、重新 backfill 和发布完成。

4. 失败 fail-closed: `closed`

   当前测试覆盖 duplicate source hash、same bookId different sourceHash、
   stale manifest sidecar、受保护 staging metadata、publish marker
   directory fsync failure。对应结果均为不发布、不跳过损坏包或退出非零。
   durable writer 在目录 fsync 不确定时删除已 rename 的 publish marker，
   防止半提交 marker 可见。

5. 真实 `graph_vault` 不重跑已完成书: `closed`

   只读分类显示 `totalDirectories=72`、`candidates=38`、`residues=34`、
   `already_migrated=38`、`partial_migration=0`、
   `failed_interrupted=0`。38 个已发布包全部通过
   `validateBookHotplugPackage`，无 incomplete hotplug marker。既有
   `hotplug-backfill-20260603033036320` 迁移证据记录
   `processed=0`、`skipped=38`、`failed=0`。

## 固定基准逐项判定

| id | status | 结论 |
| --- | --- | --- |
| `current_vs_residue_classification` | `pass` | 分类器区分 `already_migrated`、`legacy_only`、`partial_migration`、`failed_interrupted`、`repair_required` 与 `residue_quarantined`。真实 vault 当前为 38 个已迁移候选与 34 个 residue。 |
| `migration_source_of_truth` | `pass` | manifest 生成受 distribution manifest sidecars、canonical input、source closure、qmd manifest、GraphRAG output manifest、producer evidence 与 artifact checksums 约束。 |
| `package_layout_transform` | `pass` | copy-map 与 manifest 使用 package-relative 的 `source/`、`input/`、`qmd/`、`graphrag/output/`、`graphrag/runs/`、`state/` 布局，validator 强制 `mount.packageRoot="."`。 |
| `checksum_manifest_regeneration` | `pass` | `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、sidecars、内嵌 manifest checksum、publish marker checksum、文件 checksum 均重新计算并校验。 |
| `residue_quarantine_policy` | `pass` | 34 个历史 residue 不生成 publish marker，不挂载、不投影、不删除；冲突记录将同源前缀 residue 保持隔离。 |
| `idempotent_migration` | `pass` | already-migrated 路径 verify-only；`--only-missing` 先验证再跳过；partial/failed interrupted 需要显式 flag，执行恢复或 blocked fail-closed。 |
| `conflict_and_duplicate_handling` | `pass` | duplicate source hash、same bookId different sourceHash、manifest identity mismatch、staging/live root conflict 均有稳定诊断和 fail-closed 行为。 |
| `rollback_and_audit_trail` | `pass` | 迁移证据包含 classification、copy-map、manifest-diff、checkpoint、resume-plan、rollback-record、commit-record；恢复执行写 `execution-record.json` 与 sidecars。 |
| `catalog_projection_cleanup` | `pass` | catalog rebuild 只从 validator 通过的 published package 派生；真实 evidence 中 38 个已发布包跳过，34 个 residue 未进入投影。 |
| `executable_migration_tests` | `pass` | backfill 测试覆盖 verify-only、only-missing validation、resume、rollback、protected metadata、fsync failure 与冲突 fail-closed。 |

## 验证证据

- 固定基准 checksum:
  `shasum -a 256 audits/graphrag-book-hotplug-implementation-audit-run_20260602_r12__open/agent-2-batch-backfill/fixed-baseline.yaml`
  返回
  `1d15ad741b3425cba731459cae844c9d7d4879f5f9386003d1c8ad2a33acfc41`。
- 目标测试:
  `npm exec -- vitest run test/graphrag-book-hotplug-backfill.test.ts --reporter=verbose`
  结果为 1 个测试文件、8 个测试全部通过。
- 真实 vault 只读分类:
  `totalDirectories=72`、`candidates=38`、`residues=34`、
  `already_migrated=38`、`partial_migration=0`、
  `failed_interrupted=0`、`invalidPublishedCount=0`。
- 真实 vault publish marker 检查:
  `publishedWithRequiredSkipFiles=38`、`incompleteHotplugMarkers=0`。
- 既有迁移证据:
  `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603033036320/commit-record.yaml`
  记录 `decisionStatus=committed`、`processed=0`、`skipped=38`、
  `failed=0`。

## 剩余发现

无剩余发现（no remaining findings）。

## 验证限制

真实 `graph_vault` 复核未执行会写 quality gate、runtime gate 或 migration
evidence 的 live backfill 命令；本轮采用只读分类、包 validator、marker
完整性检查和既有迁移 evidence 证明已完成书不会被重跑。
