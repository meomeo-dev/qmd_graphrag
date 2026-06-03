# qmd_graphrag 单本书热插拔实现审计 R8 报告

- agentId: `agent-2-batch-backfill`
- scenario: `batch backfill / 38 包 + 34 residue 迁移清理`
- fixedBaseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r8__open/agent-2-batch-backfill/fixed-baseline.yaml`
- sourceBaseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r7__open/agent-2-batch-backfill/fixed-baseline.yaml`
- fixedBaselineSha256:
  `1d15ad741b3425cba731459cae844c9d7d4879f5f9386003d1c8ad2a33acfc41`
- overallStatus: `partial`
- baselineCount: `10`
- passed: `7`
- partial: `3`
- failed: `0`

本轮严格复用 R7 Agent 2 的固定 10 维基准，`fixed-baseline.yaml` 与
R7 文件 SHA-256 完全一致，未新增、删除、重命名或重排任何维度。
本轮不修改业务实现文件；只读取代码、测试与真实 evidence，并写入本审计目录。

## 重点结论

- 真实 vault 最新 migration evidence 为
  `hotplug-backfill-20260602232707767`：72 个目录中 38 个
  `already_migrated`、34 个 `residue_quarantined`，0 个
  `partial_migration`，0 个 `failed_interrupted`，0 个 `repair_required`。
- `validateBookHotplugPackage` 对真实 38 个包复扫通过 `38/38`。
  初次带 catalog 查询的混合扫描超时后，在
  `book-0cf221e296c1-9475aa81/graphrag/runs/...yaml.lock` 发现一个由
  durable reader 路径留下的包内 `.lock`；已将该 lock 内容保存在本审计目录
  `observed-readonly-query-stale-lock.json`，并清除该审计副作用后复扫为
  `38/38` 通过，`find graph_vault/books -name '*.lock'` 为空。
- query-ready（查询就绪）包为 30 本，`validateHotplugRuntimeQueryGate`
  对 30 本全部通过。其余 8 本 `manifest_not_query_ready` 是 manifest 中显式
  not-query-ready 状态，不应计入 runtime query gate 失败。
- 最新 catalog 文件中 `books=38`、`document-identity-map=38`、
  `graph-capabilities=30`，34 个 residue 在 books catalog、identity、
  graph capabilities 中投影数均为 0。
- producer run semantic binding（生产运行语义绑定）已进入 runtime gate 与
  package validation 路径，负例测试覆盖 forged artifactIds 与 forged
  provider fingerprint。
- 仍为 `partial` 的原因：staged resume/failed interrupted 的执行恢复仍未闭环，
  live-root atomic publish/rollback restore 缺实现证明，且 `loadGraphQueryCapabilities`
  的部分读取路径仍可通过 durable YAML reader 在包内创建 `.lock`，不满足
  package-only read-only（包内只读）原则。

## 真实 Vault 证据

- latestObservedMigrationId: `hotplug-backfill-20260602232707767`
- migrationCount: `18`
- classification.counts.totalDirectories: `72`
- classification.counts.candidates: `38`
- classification.counts.alreadyMigrated: `38`
- classification.counts.residueQuarantined: `34`
- classification.counts.partialMigration: `0`
- classification.counts.failedInterrupted: `0`
- residue-report.residues: `34`
- residue mountAllowed/exportAllowed/deletePerformed true count: `0/0/0`
- marker counts: `BOOK_MANIFEST=38`, `PUBLISH_READY=38`,
  `hotplug-quality-gate=38`, `hotplug-runtime-gate=38`
- package validation scan after cleanup: `checked=38`, `passed=38`, `failed=0`
- runtime gate scan for query-ready packages: `checked=30`, `passed=30`, `failed=0`
- catalog direct file scan: `books=38`, `documentIdentity=38`,
  `graphCapabilities=30`, `residueProjected=0`
- package internal lock scan after cleanup: `0`
- observed audit-side-effect lock evidence:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r8__open/agent-2-batch-backfill/observed-readonly-query-stale-lock.json`

## 逐项判定

### 1. `current_vs_residue_classification` / 当前书与历史残留分类

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:366`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:452`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:476`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:649`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602232707767/classification.yaml`
- 发现:
  - 最新真实 vault 72 个目录稳定分类为 38 个 `already_migrated` 和
    34 个 `residue_quarantined`。
  - residue 全部 `mayGenerateBookManifest=false`，未被提升为
    authoritative package。

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
  - gate 覆盖 `distribution_manifest.json` sidecars、canonical input、source
    closure、producer lineage、artifact checksums、qmd build manifest 与
    GraphRAG output manifest。
  - 缺 source closure 时不会生成 `BOOK_MANIFEST.json`。

### 3. `package_layout_transform` / 包布局转换完整性

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-package.mjs:716`
  - `scripts/graphrag/book-hotplug-package.mjs:748`
  - `scripts/graphrag/book-hotplug-package.mjs:793`
  - `scripts/graphrag/book-hotplug-package.mjs:865`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602232707767/copy-map.yaml`
- 发现:
  - source、input、qmd、GraphRAG output/runs 和 state 的目标布局均为包内
    package-relative 路径。
  - `mount.packageRoot="."`，manifest files closure 不依赖 sibling catalog。

### 4. `checksum_manifest_regeneration` / Manifest 与校验重建

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-package.mjs:693`
  - `scripts/graphrag/book-hotplug-package.mjs:716`
  - `scripts/graphrag/book-hotplug-package.mjs:749`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:167`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:187`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:356`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:477`
- 发现:
  - manifest embedded checksum、sidecars、runtime compatibility、artifact
    metadata 与 publish marker checksum 均按当前包内容重建或验证。
  - 新包发布保持 marker-last；live validation 失败会移除 publish marker。

### 5. `residue_quarantine_policy` / 历史残留隔离策略

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:17`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:96`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:693`
  - `graph_vault/catalog/book-package-migrations/residue-report.yaml`
- 发现:
  - 34 个 residue 均为 `quarantine_without_delete`，且
    `mountAllowed=false`、`exportAllowed=false`、`deletePerformed=false`。
  - catalog 直接文件扫描显示 residue 未进入 books catalog、identity 或
    graph capabilities。

### 6. `idempotent_migration` / 幂等迁移

- status: `partial`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:452`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:481`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:126`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:264`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:296`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:327`
  - `test/graphrag-book-hotplug-backfill.test.ts:169`
- 发现:
  - `--force` 对已验证包走 `verified_existing`，focused test 证明不重写
    manifest、publish marker、runtime compatibility。
  - 真实 vault 当前 38 个包可验证且最新 backfill evidence 为 38 skipped、0
    failed。
  - 缺口：`partial_migration` staged resume、`failed_interrupted` 显式恢复、
    用户 metadata 冲突防覆盖和 corrupt existing package with marker 的
    `--only-missing` 自动重验仍未完整闭环。

### 7. `conflict_and_duplicate_handling` / 冲突与重复处理

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:435`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:557`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:590`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:606`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:156`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:225`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:266`
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
  - `test/graphrag-book-hotplug-backfill.test.ts:220`
- 发现:
  - sameSourceHashDifferentBookId、sameBookIdDifferentSourceHash、source-hash
    prefix conflict、partial/target/live-root conflict 均有稳定诊断。
  - backfill 将 duplicate 与 hard identity conflict fail closed，focused tests
    覆盖 duplicate sourceHash 与 same bookId different sourceHash。

### 8. `rollback_and_audit_trail` / 回滚与审计记录

- status: `partial`
- 证据路径:
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
  - 缺口：candidate validation 使用临时 staging root，但最终 backfill 仍直接
    写 live root；没有 staging-first atomic rename、fsync、rollback restore
    的实现证明。

### 9. `catalog_projection_cleanup` / Catalog 投影清理

- status: `partial`
- 证据路径:
  - `src/graphrag/book-hotplug-catalog.ts:302`
  - `src/graphrag/book-hotplug-catalog.ts:404`
  - `src/graphrag/book-hotplug-catalog.ts:446`
  - `src/graphrag/book-hotplug-catalog.ts:459`
  - `src/graphrag/capability-catalog.ts:361`
  - `src/graphrag/book-package-layout.ts:41`
  - `src/job-state/durable-state-store.ts:406`
  - `src/job-state/durable-state-store.ts:980`
- 发现:
  - rebuild 后 catalog direct file scan 为 `books=38`、`identity=38`、
    `graphCapabilities=30`，residue stale 引用为 0。
  - 缺口：global qmd projection / qmd-book-projections cleanup 仍无实现或
   真实 evidence。
  - 新缺口：`loadGraphQueryCapabilities()` 的部分读取路径使用
    `readYamlUnknownDurable()`，会通过 `withDurableFileLock()` 在包内 manifest
    或 run YAML 旁创建 `.lock`。本审计在真实 vault 观察到该副作用并保留证据，
    虽已清理，但实现不满足包内只读查询不得产生 durable lock 的要求。

### 10. `executable_migration_tests` / 可执行迁移测试

- status: `pass`
- 证据路径:
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
  - `test/graphrag-book-hotplug-backfill.test.ts:169`
  - `test/graphrag-book-hotplug-backfill.test.ts:220`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `test/graphrag-book-hotplug-catalog.test.ts:340`
  - `test/graphrag-book-hotplug-catalog.test.ts:370`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:221`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:400`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:477`
- 发现:
  - 本轮运行 `tsc --noEmit` 通过。
  - 本轮运行 `test/graphrag-book-hotplug-runtime-gate.test.ts` 通过 5 tests，
    覆盖 query-ready validation without runtime locks、runtime compatibility
    forged digest、artifact metadata missing createdAt、producer run artifact
    binding forged、producer run provider fingerprint forged。
  - 结合既有 backfill 与 catalog tests，固定基准要求的主要 batch-backfill
    行为已有可执行测试；剩余未覆盖项已归入 idempotent/rollback partial。

## Findings

### F1. 只读查询路径仍可在单本书包内创建 `.lock`

- baselineId: `catalog_projection_cleanup`
- severity: `high`
- summary:
  - `loadGraphQueryCapabilities()` 相关读取路径仍使用 durable YAML reader。
    `readYamlUnknownDurable()` 会进入 `withDurableFileLock()`，对目标文件创建
    `${path}.lock`。本轮真实 vault 审计观察到
    `graphrag/runs/bootstrap-20260601172631-1wgupg-normalize.yaml.lock`，内容
    已保存到 audit 目录。该行为违反单本书热插拔包的只读查询不得在包内写
    lock/temp/recovery 文件的要求。
- evidencePaths:
  - `src/graphrag/capability-catalog.ts:361`
  - `src/graphrag/capability-catalog.ts:648`
  - `src/graphrag/book-package-layout.ts:41`
  - `src/job-state/durable-state-store.ts:406`
  - `src/job-state/durable-state-store.ts:980`
  - `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r8__open/agent-2-batch-backfill/observed-readonly-query-stale-lock.json`

### F2. partial/interrupted migration 只分类，尚未执行恢复闭环

- baselineId: `idempotent_migration`
- severity: `medium`
- summary:
  - `partial_migration` 与 `failed_interrupted` 已能分类并写入 conflict/evidence，
    但缺从 copy-map checkpoint staged resume 或 explicit resume/restart
    decision 到安全继续执行的实现路径。
- evidencePaths:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:452`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:481`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:590`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:606`

### F3. live-root atomic publish / rollback restore 仍缺实现证明

- baselineId: `rollback_and_audit_trail`
- severity: `medium`
- summary:
  - evidence 中有 rollback plan 与 copy-map，但 `backfillBookPackage()` 仍在 live
    book root 内直接写 manifest、quality/runtime gate 和 publish marker。缺
    staging-first build root、fsync、atomic rename、last-good live root restore
    的实现或测试证明。
- evidencePaths:
  - `scripts/graphrag/book-hotplug-publish-gate.mjs:27`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:167`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:187`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:339`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:356`

### F4. global qmd projection cleanup 仍无实现/evidence

- baselineId: `catalog_projection_cleanup`
- severity: `medium`
- summary:
  - books/source/document identity/graph capabilities 已可从 package manifest
    重建并清理 residue 投影，但 Type-DD/final contracts 提到的 global qmd
    projection 与 qmd-book-projections 派生状态未见实现或真实 vault evidence。
- evidencePaths:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:326`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:403`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:961`
  - `src/graphrag/book-hotplug-catalog.ts:302`

## Commands Run

- `npm exec -- tsc -p tsconfig.build.json --noEmit`
- `npx vitest run test/graphrag-book-hotplug-runtime-gate.test.ts --testTimeout 120000 --pool forks --poolOptions.forks.singleFork=true`
- read-only Node scan: true package markers and quality/runtime gate counts
- read-only Node scan: latest migration classification/residue report/catalog counts
- read-only Node scan: `validateBookHotplugPackage` over 38 real packages
- read-only Node scan: `validateHotplugRuntimeQueryGate` over 30 query-ready packages
- direct catalog file scan: residue projection count in books/identity/capabilities
- package-internal `.lock` scan before and after cleanup
