# qmd_graphrag 单本书热插拔实现审计 R6 报告

- agentId: `agent-2-batch-backfill`
- scenario: `batch backfill / 38 包 + 34 residue 迁移清理`
- fixedBaseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r5__open/agent-2-batch-backfill/baseline.yaml`
- baselineSha256:
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`
- overallStatus: `partial`
- baselineCount: `10`
- passed: `5`
- partial: `5`
- failed: `0`

本轮严格复用 R5 Agent 2 固定 10 维基准。未新增、重命名或重排基准。
本轮未修改生产代码、测试或 docs；仅写入本 R6 审计目录。

## 重点结论

- duplicate/source-hash conflict（重复源哈希冲突）已 fail closed：
  `migration_duplicate_source_hash` 会在 live 写入前阻断，focused test
  证明未生成 `BOOK_MANIFEST.json` 或 `PUBLISH_READY.json`。
- `--force` 对已验证包已走 `verified_existing`，不重写
  `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
  `runtime-compatibility.json`。
- backfill 写入顺序为 marker-last（发布标记最后写入）：先移除旧
  `PUBLISH_READY.json`，写入 manifest 和 gates 后才写新 publish marker；
  live validation 失败会移除 publish marker。
- 迁移 evidence（证据）包含 `skipped`、`failed`、`packageResults` 字段。
- 真实 vault 最新回填证据为 38 discovered/skipped、0 failed、
  34 residues/conflicts；catalog 当前为 38/38/30
  （books/sources/graph capabilities）。

仍保持 `partial` 的原因是：sameBookIdDifferentSourceHash 尚未见专门执行
检测；partial/interrupted migration 仍是阻断或诊断，没有 staged resume；
rollback 仍缺 staging-first 事务证明；qmd projection cleanup 未实现；固定
基准要求的完整自动化矩阵仍未闭环。

## 真实 Vault 证据

- latestMigrationId: `hotplug-backfill-20260602211359498`
- `classification.counts.totalDirectories`: `72`
- `classification.counts.candidates`: `38`
- `classification.counts.residues`: `34`
- `classification.counts.alreadyMigrated`: `38`
- `classification.counts.residueQuarantined`: `34`
- `commit-record.processed`: `0`
- `commit-record.skipped`: `38`
- `commit-record.failed`: `0`
- `validation.packageResults`: field present, `0` entries for skipped run
- `residue-report.residues`: `34`
- `book-conflicts.items`: `34`
- conflict code: `migration_source_hash_prefix_conflict = 34`
- catalog: `books=38`, `sources=38`, `documentIdentities=38`,
  `graphCapabilities=30`
- package marker sidecars: `missingCount=0`
- forbidden package residue scan: `forbiddenPathPackageCount=0`

## 1. `current_vs_residue_classification` / 当前书与历史残留分类

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:344`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:415`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:422`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:579`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:623`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602211359498/classification.yaml`
- 发现:
  - 真实 vault 72 个目录稳定分类为 38 个 `already_migrated` 和
    34 个 `residue_quarantined`。
  - 34 个 residue 全部 `mayGenerateBookManifest=false`，未被提升为
    authoritative package（权威包）。
  - source-hash prefix conflict 已记录到 conflict report，并由 backfill
    执行 gate 处理；该冲突矩阵的完整性在第 7 项单独判定。

## 2. `migration_source_of_truth` / 迁移源权威

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:367`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:380`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:393`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:408`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:272`
  - `test/graphrag-book-hotplug-catalog.test.ts:340`
- 发现:
  - source-of-truth gate（源权威闸门）要求
    `distribution_manifest.json`、sidecars、canonical input、source
    closure、artifact checksum、qmd build manifest 和 GraphRAG output
    manifest。
  - 缺 source closure 的测试保持 fail closed，`run.candidates` 为 0，
    且不会生成 `BOOK_MANIFEST.json`。
  - producer lineage 缺失不会提升为 query-ready，而是进入 not-query-ready
    语义。

## 3. `package_layout_transform` / 包布局转换完整性

- status: `pass`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:644`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:657`
  - `scripts/graphrag/book-hotplug-package.mjs:508`
  - `scripts/graphrag/book-hotplug-package.mjs:538`
  - `scripts/graphrag/book-hotplug-package.mjs:569`
  - `scripts/graphrag/book-hotplug-package.mjs:584`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602211359498/copy-map.yaml`
- 发现:
  - Type DD 规定 source、input、qmd、`graphrag/output`、
    `graphrag/runs`、state 的迁移目标与 checksum regeneration。
  - manifest 使用 `mount.packageRoot="."`，files closure（文件闭包）为
    package-relative（包相对）路径。
  - 真实 vault 包内 source 已存在于 `source/source.epub`，示例包
    `book-00474fb29e5e-59d02d41` 的 package source closure 可直接解析。

## 4. `checksum_manifest_regeneration` / Manifest 与校验重建

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-package.mjs:484`
  - `scripts/graphrag/book-hotplug-package.mjs:494`
  - `scripts/graphrag/book-hotplug-package.mjs:690`
  - `scripts/graphrag/book-hotplug-package.mjs:713`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:147`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:167`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:316`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts`
- 发现:
  - manifest checksum、content checksum、publish marker checksum 均由新
    package content 重新计算。
  - backfill live 写入为 marker-last：先删除旧 marker，写 manifest；只有
    package validation 和 gate 写入完成后才写 `PUBLISH_READY.json`。
  - forged runtime compatibility digest 和 artifact metadata 缺行测试均
    fail closed。

## 5. `residue_quarantine_policy` / 历史残留隔离策略

- status: `pass`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:892`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:17`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:96`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:110`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:139`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `graph_vault/catalog/book-package-migrations/residue-report.yaml`
- 发现:
  - 34 个 residue 全部保留 `mountAllowed=false`、`exportAllowed=false`、
    `deletePerformed=false`。
  - package 内 forbidden residue scan 为 0；未发现 provider payload、
    `.env`、`.lock`、`.corrupt-*` 等禁带路径。
  - 隔离动作为 `quarantine_without_delete`，未删除 legacy evidence。

## 6. `idempotent_migration` / 幂等迁移

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1153`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1169`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:415`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:443`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:117`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:287`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:324`
  - `test/graphrag-book-hotplug-backfill.test.ts:169`
- 发现:
  - `--force` 对 valid existing package（已验证现存包）已走
    `verified_existing`，focused test 证明 manifest、publish marker、
    runtime compatibility 文件均未重写。
  - 真实 vault 最新迁移证据显示 38 个已迁移包被 skipped，0 failed。
  - 但 `partial_migration` 与 `failed_interrupted` 仍主要是
    `resume_required` / fail-closed 诊断；尚未实现从 copy-map checkpoint
    staged resume（分阶段恢复）的可执行路径。

## 7. `conflict_and_duplicate_handling` / 冲突与重复处理

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:87`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1219`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1268`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1275`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:453`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:493`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:124`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:228`
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
- 发现:
  - duplicate source hash（同 sourceHash 不同 bookId）已由
    `migration_duplicate_source_hash` 记录，并在 `existingValidation == null`
    时阻断 backfill。
  - focused test 证明两个重复 source-hash legacy candidates 退出码为 1，
    `status=blocked_by_conflict`，且两个目录均未生成
    `BOOK_MANIFEST.json`。
  - 真实 vault 当前 34 个 conflict 均为 source-hash prefix conflict，对应
    34 个 residue。
  - 缺口：未见 `migration_book_id_source_hash_conflict` 的实现分支或测试；
    `book-conflict-decisions` durable decision workflow（持久决策工作流）
    仍未落地。因此本项不能升为 `pass`。

## 8. `rollback_and_audit_trail` / 回滚与审计记录

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:863`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:884`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:623`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:741`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:762`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:370`
  - `scripts/graphrag/book-hotplug-publish-gate.mjs:27`
- 发现:
  - evidence 包含 `plan.yaml`、`classification.yaml`、`copy-map.yaml`、
    `manifest-diff.yaml`、`checkpoint.yaml`、`validation.yaml`、
    `commit-record.yaml`、`residue-report.yaml`、`book-conflicts.yaml`。
  - 最新 evidence 明确包含 `skipped`、`failed`、`packageResults` 字段：
    `skipped=38`、`failed=0`、`packageResults` key present。
  - 缺口：candidate validation 使用临时 staging root，但最终 backfill 仍直接写
    live root；缺少 build staging root、fsync、atomic rename、rollback
    restore 的迁移级事务证明。

## 9. `catalog_projection_cleanup` / Catalog 投影清理

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:940`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1017`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1033`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:960`
  - `src/graphrag/book-hotplug-catalog.ts:302`
  - `src/graphrag/book-hotplug-catalog.ts:403`
  - `src/graphrag/book-hotplug-catalog.ts:442`
  - `src/graphrag/book-hotplug-catalog.ts:456`
  - `test/graphrag-book-hotplug-catalog.test.ts:370`
- 发现:
  - 真实 catalog 当前为 books/sources/identities/capabilities =
    `38/38/38/30`，无 stale book、identity 或 capability 引用。
  - 用户点名的 catalog 38/38/30（books/sources/capabilities）已满足。
  - `rebuildCatalogFromBookHotplugPackages()` 会从 manifest 和 publish marker
    重建 `books.yaml`、`sources.yaml`、`document-identity-map.yaml`、
    `graph-capabilities.yaml`。
  - 缺口：final contracts 仍列出 `qmd-projection.yaml`，当前实现和真实
    `graph_vault/catalog` 均未见 qmd projection cleanup。

## 10. `executable_migration_tests` / 可执行迁移测试

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1212`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1800`
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
  - `test/graphrag-book-hotplug-backfill.test.ts:169`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `test/graphrag-book-hotplug-catalog.test.ts:340`
  - `test/graphrag-book-hotplug-catalog.test.ts:370`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts`
- 发现:
  - 当前 focused tests 覆盖 duplicate source-hash fail-closed、`--force`
    `verified_existing`、residue 不提升、source closure 缺失 fail-closed、
    stale catalog cleanup、provider payload 拒绝、producer runs 缺失不投影、
    runtime compatibility forged digest fail-closed。
  - 缺口：固定基准要求的 38/34 批量 fixture、sameBookIdDifferentSourceHash、
    interrupted retry、staging cleanup、stale lock takeover、完整 conflict
    decision matrix 尚未自动化闭环。

## 验证命令

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit`
  passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-book-hotplug-backfill.test.ts`
  passed, 2 tests。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-book-hotplug-catalog.test.ts`
  passed, 8 tests。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-book-hotplug-runtime-gate.test.ts`
  passed, 2 tests。
- 只读 Node 检查：真实 vault migration evidence、catalog、package markers、
  forbidden residue scan。
- 全量临时 vault clone `--force --rebuild-catalog --fail-fast` 在 240 秒超时，
  未作为本轮结论证据；本轮采用 focused test 与真实 evidence 交叉验证。

## 结论

本轮用户点名的 duplicate/source-hash fail-closed、`--force`
`verified_existing`、marker-last、evidence 字段、真实 vault 38/34 与 catalog
38/38/30 均已得到直接证据支持。

按固定 10 维基准，当前实现仍存在事务恢复、完整冲突矩阵、qmd projection
cleanup 和自动化覆盖缺口。因此 R6 总体判定为 `partial`。
