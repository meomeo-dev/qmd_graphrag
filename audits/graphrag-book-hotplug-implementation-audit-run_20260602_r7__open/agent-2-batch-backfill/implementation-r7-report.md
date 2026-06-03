# qmd_graphrag 单本书热插拔实现审计 R7 报告

- agentId: `agent-2-batch-backfill`
- scenario: `batch backfill / 38 包 + 34 residue 迁移清理`
- fixedBaseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r7__open/agent-2-batch-backfill/fixed-baseline.yaml`
- sourceBaseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r5__open/agent-2-batch-backfill/baseline.yaml`
- sourceBaselineSha256:
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`
- overallStatus: `partial`
- baselineCount: `10`
- passed: `6`
- partial: `4`
- failed: `0`

本轮严格复用 R6 Agent 2 的固定 10 维基准。R6 目录没有独立
`fixed-baseline.yaml`，其 report/summary 指向 R5 baseline；本轮已将该
baseline 固化为 `fixed-baseline.yaml`，未新增、重命名或重排基准。
本轮未修改生产代码、测试或设计文档；仅写入本 R7 审计目录。

## 重点结论

- same `bookId` different `sourceHash` conflict（同书 ID 不同源哈希冲突）
  已从 R6 缺口推进为实现级 fail closed：`migration_book_id_source_hash_conflict`
  由 migration state 记录，backfill 将其视作 hard identity conflict，并有
  focused test 覆盖不重写 `BOOK_MANIFEST.json` 和 `PUBLISH_READY.json`。
- duplicate source hash（同源哈希不同书 ID）仍 fail closed；focused test
  证明不会生成 `BOOK_MANIFEST.json`。
- marker-last（发布标记最后写入）仍成立：新包路径先移除旧 marker，再写
  manifest，写入 quality/runtime gates 后才写 `PUBLISH_READY.json`；live
  validation 失败会移除 marker。
- 真实 vault 最新 evidence 是 `hotplug-backfill-20260602223718973`，比用户给出
  的核对 ID 更新，但关键计数一致：72 scanned、38 candidates/skipped、
  34 residues/conflicts、0 processed、0 failed，catalog 为 38/38/38/30。
- 仍为 `partial` 的原因是 staged resume、事务式 rollback、global qmd
  projection cleanup 与完整自动化矩阵没有闭环；`--only-missing` 跳过路径也
  主要依赖 marker 存在性，而不是强制验证现存包。

## 真实 Vault 证据

- userProvidedMigrationId: `hotplug-backfill-20260602211359498`
- latestObservedMigrationId: `hotplug-backfill-20260602223718973`
- migrationCount: `17`
- classification.counts.totalDirectories: `72`
- classification.counts.candidates: `38`
- classification.counts.alreadyMigrated: `38`
- classification.counts.residueQuarantined: `34`
- commit-record.processed: `0`
- commit-record.skipped: `38`
- commit-record.failed: `0`
- validation.packageResults: field present, `0` entries for skipped run
- residue-report.residues: `34`
- book-conflicts.items: `34`
- conflict code: `migration_source_hash_prefix_conflict = 34`
- catalog: `books=38`, `sources=38`, `documentIdentities=38`,
  `graphCapabilities=30`
- stale catalog references: `sources=0`, `documentIdentities=0`,
  `graphCapabilities=0`
- package marker sidecars: `38/38` complete, `missingCount=0`
- real package validation scan: `validated=38`, `failed=0`
- forbidden package residue scan: `forbiddenPathPackageCount=0`
- qmd projection evidence: `qmd-projection.yaml=false`,
  `qmd-book-projections=false`

## 逐项判定

### 1. `current_vs_residue_classification` / 当前书与历史残留分类

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:366`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:452`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:476`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:649`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:693`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602223718973/classification.yaml`
- 发现:
  - 最新真实 vault 72 个目录稳定分类为 38 个 `already_migrated` 和
    34 个 `residue_quarantined`。
  - residue 全部 `mayGenerateBookManifest=false`，并写入 residue report，
    未被提升为 mount/query/catalog 权威包。

### 2. `migration_source_of_truth` / 迁移源权威

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:390`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:412`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:414`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:416`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:418`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:312`
  - `test/graphrag-book-hotplug-catalog.test.ts:340`
- 发现:
  - gate 覆盖 `distribution_manifest.json` sidecars、canonical input、
    source closure、producer lineage、artifact checksums、qmd build manifest
    与 GraphRAG output manifest。
  - 缺 source closure 时 `run.candidates` 为 0，且不会生成
    `BOOK_MANIFEST.json`。

### 3. `package_layout_transform` / 包布局转换完整性

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-package.mjs:194`
  - `scripts/graphrag/book-hotplug-package.mjs:206`
  - `scripts/graphrag/book-hotplug-package.mjs:356`
  - `scripts/graphrag/book-hotplug-package.mjs:508`
  - `scripts/graphrag/book-hotplug-package.mjs:584`
  - `scripts/graphrag/book-hotplug-package.mjs:629`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602223718973/copy-map.yaml`
- 发现:
  - source、input、qmd、GraphRAG output/runs 和 state 的包内目标均为
    package-relative（包相对）路径。
  - `mount.packageRoot="."`，manifest files closure 不依赖 sibling catalog
    或 source root。

### 4. `checksum_manifest_regeneration` / Manifest 与校验重建

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-json-sidecars.mjs:17`
  - `scripts/graphrag/book-hotplug-package.mjs:484`
  - `scripts/graphrag/book-hotplug-package.mjs:494`
  - `scripts/graphrag/book-hotplug-package.mjs:690`
  - `scripts/graphrag/book-hotplug-package.mjs:713`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:167`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:187`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:356`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:205`
- 发现:
  - manifest embedded checksum、manifest sidecars、runtime compatibility、
    artifact metadata、publish marker checksum 均按当前包内容生成。
  - 新包 backfill 写入顺序为 marker-last；live validation 失败会移除
    publish marker。
  - runtime compatibility digest forged 与 artifact metadata 缺字段测试均
    fail closed。

### 5. `residue_quarantine_policy` / 历史残留隔离策略

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:17`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:96`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:110`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:845`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `graph_vault/catalog/book-package-migrations/residue-report.yaml`
- 发现:
  - 34 个 residue 均保持 `mountAllowed=false`、`exportAllowed=false`、
    `deletePerformed=false`。
  - 当前包 forbidden residue scan 为 0；未发现 provider payload、`.env`、
    `.lock`、`.corrupt-*` 等禁带路径进入 book package。

### 6. `idempotent_migration` / 幂等迁移

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1153`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1176`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1183`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:452`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:481`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:296`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:327`
  - `test/graphrag-book-hotplug-backfill.test.ts:169`
- 发现:
  - `--force` 对已验证包走 `verified_existing`，focused test 证明不重写
    manifest、publish marker、runtime compatibility。
  - 真实 vault 最新 evidence 为 38 skipped、0 failed；只读 validator 扫描
    38 个包均通过。
  - 缺口：partial/interrupted staged resume 未实现；用户 metadata 冲突防覆盖
    未测试；`--only-missing` skip 主要检查 marker/sidecar 存在性。

### 7. `conflict_and_duplicate_handling` / 冲突与重复处理

- status: `pass`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:87`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1219`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1268`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1275`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:435`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:557`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:156`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:225`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:266`
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
  - `test/graphrag-book-hotplug-backfill.test.ts:220`
- 发现:
  - same sourceHash different bookId 会产生 `migration_duplicate_source_hash`
    并阻断 publish。
  - same bookId different sourceHash 会产生
    `migration_book_id_source_hash_conflict`，backfill 视为 hard identity
    conflict，即使现有包有效也不会重写。
  - 真实 vault 当前 34 个 conflict 均为 source-hash prefix conflict，全部
    对应 residue，不影响 38 个已迁移包。
  - 注意：classification 中 hard conflict 的 `mayGenerateBookManifest` 计算仍可
    能先于 diagnostic 追加，执行层已补救，但分类语义可进一步收敛。

### 8. `rollback_and_audit_trail` / 回滚与审计记录

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:214`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:863`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:722`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:747`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:811`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:832`
  - `scripts/graphrag/book-hotplug-publish-gate.mjs:27`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:187`
- 发现:
  - evidence 包含 `plan.yaml`、`classification.yaml`、`copy-map.yaml`、
    `manifest-diff.yaml`、`checkpoint.yaml`、`validation.yaml`、
    `commit-record.yaml`、`residue-report.yaml`、`book-conflicts.yaml`。
  - 最新 evidence 明确包含 `skipped`、`failed`、`packageResults` 字段。
  - 缺口：candidate validation 使用临时 staging root，但最终 backfill 仍直接写
    live root；没有 staging-first atomic rename/rollback restore 证明。

### 9. `catalog_projection_cleanup` / Catalog 投影清理

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:326`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:403`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:961`
  - `src/graphrag/book-hotplug-catalog.ts:302`
  - `src/graphrag/book-hotplug-catalog.ts:404`
  - `src/graphrag/book-hotplug-catalog.ts:446`
  - `src/graphrag/book-hotplug-catalog.ts:459`
  - `test/graphrag-book-hotplug-catalog.test.ts:370`
- 发现:
  - catalog rebuild 会重建 `books.yaml`、`sources.yaml`、
    `document-identity-map.yaml`、`graph-capabilities.yaml`。
  - 真实 catalog 当前为 `38/38/38/30`，stale source、identity、capability 引用
    均为 0。
  - 缺口：final contracts 和主 Type DD 均要求 global qmd projection /
    qmd-book-projections；当前实现和真实 vault 均未见该投影或 cleanup evidence。

### 10. `executable_migration_tests` / 可执行迁移测试

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1212`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1297`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1353`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1886`
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
  - `test/graphrag-book-hotplug-backfill.test.ts:169`
  - `test/graphrag-book-hotplug-backfill.test.ts:220`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `test/graphrag-book-hotplug-catalog.test.ts:340`
  - `test/graphrag-book-hotplug-catalog.test.ts:370`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:205`
- 发现:
  - 本轮验证通过：
    - `test/graphrag-book-hotplug-backfill.test.ts`: 3 passed
    - `test/graphrag-book-hotplug-catalog.test.ts`: 8 passed
    - `test/graphrag-book-hotplug-runtime-gate.test.ts`: 2 passed
  - 覆盖面包括 duplicate conflict、same bookId conflict、verify-only、
    residue quarantine、source closure fail closed、catalog stale cleanup、
    runtime digest mismatch、artifact metadata 缺字段。
  - 缺口：38/34 批量 fixture、中断恢复、用户 metadata 冲突、staging mismatch、
    stale lock takeover、durable manual-decision matrix 尚未自动化。

## Findings

1. `idempotent_migration` / medium:
   partial/interrupted 状态已有分类和 evidence，但没有 staged resume 或显式
   resume/restart execution path。
2. `idempotent_migration` / medium:
   `--only-missing` skip branch 以 marker/sidecar 存在性为主，未强制执行
   `validateExistingHotplugPackage()`；真实 vault 当前 38/38 验证通过，但实现路径
   仍可能跳过损坏现存包。
3. `rollback_and_audit_trail` / medium:
   缺 staging-first live publish、fsync、atomic rename、rollback restore 的实现证明。
4. `catalog_projection_cleanup` / medium:
   qmd projection / qmd-book-projections cleanup 未实现或无 evidence。
5. `conflict_and_duplicate_handling` / low:
   sameBookIdDifferentSourceHash 执行层已阻断，但 classification 层的
   `mayGenerateBookManifest` 与后追加 diagnostic 存在语义不一致风险。
6. `executable_migration_tests` / low:
   focused tests 已通过，但固定基准要求的完整迁移矩阵尚未自动化。

## Commands Run

- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-book-hotplug-backfill.test.ts`
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-book-hotplug-catalog.test.ts`
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-book-hotplug-runtime-gate.test.ts`
- read-only Node checks for latest real vault migration evidence, catalog counts,
  marker sidecars, package validation, and forbidden package residue scan.
