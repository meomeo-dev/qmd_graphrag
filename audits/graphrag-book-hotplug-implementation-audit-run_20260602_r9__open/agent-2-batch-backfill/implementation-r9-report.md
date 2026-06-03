# qmd_graphrag 单本书热插拔实现审计 R9 报告

- agentId: `agent-2-batch-backfill`
- scenario: `batch backfill / 38 完成书 + 34 residue`
- fixedBaseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r9__open/agent-2-batch-backfill/fixed-baseline.yaml`
- reusedFrom:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r8__open/agent-2-batch-backfill/fixed-baseline.yaml`
- overallStatus: `partial`
- baselineCount: `10`
- passed: `8`
- partial: `2`
- failed: `0`

本轮严格逐字复用 R8 Agent 2 的固定基准，不新增、删除、重排或重命名任一
基准项。审计仅读取当前实现、测试与真实 `graph_vault` 证据，并仅在本审计目录
写入产物。

## 总结结论

当前实现对 38 本完成书与 34 个 residue 的 backfill 主路径已经稳定，真实最新
migration evidence 为 `hotplug-backfill-20260603001029161`，分类结果是
`38 already_migrated / 34 residue_quarantined / 0 partial_migration /
0 failed_interrupted / 0 repair_required`。真实包验证 `38/38` 通过，
query-ready runtime gate `30/30` 通过，catalog 当前为 `books=38`、
`document-identity-map=38`、`graph-capabilities=30`，且 residue 投影数均为 0。

R8 中 `catalog_projection_cleanup` 的高优先级发现
“只读查询在包内写 `.lock`”在当前实现中已关闭：`capability-catalog` 对包内
manifest、artifact、producer runs 改用 `readHotplugPackageUnknown()` 的只读
路径，不再走 durable lock reader；对应测试明确断言
`loadGraphQueryCapabilities()` 后包内 `.lock` 为空；真实
`find graph_vault/books -name '*.lock'` 结果也为空。

总体仍为 `partial`，原因只剩两类缺口：

1. `idempotent_migration` 仍缺 `partial_migration` 从 copy-map checkpoint
   实际恢复，以及 `failed_interrupted` 明确 resume/restart 决策后的执行闭环
   证据。
2. `rollback_and_audit_trail` 仍缺 live-root staging-first atomic rename、
   fsync、last-good root rollback restore 的实现或测试闭环。

另，`catalog_projection_cleanup` 的 `.lock` 问题已关闭，但合同要求的
`graph_vault/catalog/qmd-projection.yaml` 与
`graph_vault/catalog/qmd-book-projections/{bookId}` 全局 qmd projection cleanup
在当前实现与真实 vault 中仍未见独立证据，因此该项保持 `partial`。

## 真实 Vault 证据

- latestObservedMigrationId: `hotplug-backfill-20260603001029161`
- migrationCount: `19`
- totalDirectories: `72`
- candidates: `38`
- residues: `34`
- alreadyMigrated: `38`
- partialMigration: `0`
- failedInterrupted: `0`
- repairRequired: `0`
- residueQuarantined: `34`
- manifestCount: `38`
- publishMarkerCount: `38`
- qualityGateCount: `38`
- runtimeGateCount: `38`
- queryReadyManifestCount: `30`
- validateBookHotplugPackage: `checked=38 passed=38 failed=0`
- validateHotplugRuntimeQueryGate: `checked=30 passed=30 failed=0`
- catalog counts: `books=38 documentIdentity=38 graphCapabilities=30`
- residueProjectedInCatalog: `0/0/0`
- package-internal forbidden scan:
  `.lock/provider-requests/provider-responses/logs/debug/.env/.durable-recovery.jsonl = 0`

## 逐项判定

### 1. `current_vs_residue_classification` / 当前书与历史残留分类

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:452`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:456`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:698`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603001029161/classification.yaml`
  - `graph_vault/catalog/book-package-migrations/residue-report.yaml`
- 结论:
  - 当前实现可稳定区分 `already_migrated`、`residue_quarantined`、
    `partial_migration`、`failed_interrupted`、`repair_required`。
  - 真实 vault 当前 72 个目录被分类为 38 个已迁移包和 34 个 residue，
    residue 均 `mayGenerateBookManifest=false`。
- 残余风险:
  - 未见新的未分类目录样本；当前风险主要在未来引入新的 legacy 形态时的扩展性。

### 2. `migration_source_of_truth` / 迁移源权威

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:445`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:727`
  - `test/graphrag-book-hotplug-catalog.test.ts:340`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603001029161/validation.yaml`
- 结论:
  - 迁移 eligibility 同时要求 distribution manifest、canonical input、
    source closure、qmd build manifest、GraphRAG output manifest、producer
    evidence 与 artifact checksum 证据。
  - 缺 source closure 时 fail closed，不生成 `BOOK_MANIFEST.json`。
- 残余风险:
  - 未发现新的 fail-open 路径。

### 3. `package_layout_transform` / 包布局转换完整性

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-package.mjs:693`
  - `scripts/graphrag/book-hotplug-package.mjs:748`
  - `scripts/graphrag/book-hotplug-package.mjs:817`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603001029161/copy-map.yaml`
- 结论:
  - 目标布局覆盖 `source/`、`input/`、`qmd/`、`graphrag/output/`、
    `graphrag/runs/`、`state/`，且 manifest 使用 package-relative 路径。
  - `mount.packageRoot='.'` 仍满足合同的相对路径要求。
- 残余风险:
  - 未见对 layout contract 的破坏。

### 4. `checksum_manifest_regeneration` / Manifest 与校验重建

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-package.mjs:676`
  - `scripts/graphrag/book-hotplug-package.mjs:701`
  - `scripts/graphrag/book-hotplug-package.mjs:716`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:247`
  - `graph_vault/books/book-00474fb29e5e-59d02d41/BOOK_MANIFEST.json`
- 结论:
  - `BOOK_MANIFEST.json`、manifest sidecars、publish marker checksum、artifact
    checksum 与 runtime compatibility 绑定均按当前包内容重建和验证。
  - `validateBookHotplugPackage` 对 manifest embedded checksum、sidecars、
    required files、artifact metadata 和 runtime compatibility 做闭环校验。
- 残余风险:
  - 未见复用旧 checksum 的证据。

### 5. `residue_quarantine_policy` / 历史残留隔离策略

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:17`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:96`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `graph_vault/catalog/book-package-migrations/residue-report.yaml`
- 结论:
  - residue 维持 `quarantine_without_delete`，`mountAllowed=false`、
    `exportAllowed=false`、`deletePerformed=false`。
  - forbidden package residue 包括 `.lock`、`.env`、provider payload、
    logs/debug、`.durable-recovery.jsonl` 等，命中则迁出到 quarantine。
- 残余风险:
  - 当前策略偏保守；repair contract 仍需后续专门验证。

### 6. `idempotent_migration` / 幂等迁移

- status: `partial`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:481`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:483`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:485`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:126`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:327`
  - `test/graphrag-book-hotplug-backfill.test.ts:169`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603001029161/commit-record.yaml`
- 结论:
  - 已迁移有效包会走 `verified_existing`，重复运行不重写 manifest、
    publish marker 或 runtime compatibility。
  - 最新真实 backfill migration 以 `already_migrated` 方式跳过 38 个包，
    `failed=0`。
  - 状态分类中已显式区分 `partial_migration` 与 `failed_interrupted`。
- 残余风险:
  - 缺 `partial_migration resumes from copy-map` 的执行级测试/实证。
  - 缺 `failed_interrupted requires explicit decision` 之后恢复执行的闭环证据。

### 7. `conflict_and_duplicate_handling` / 冲突与重复处理

- status: `pass`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:531`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:557`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:590`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:606`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:151`
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
  - `test/graphrag-book-hotplug-backfill.test.ts:220`
- 结论:
  - duplicate source hash、same bookId different sourceHash、prefix conflict、
    target exists conflict 均 fail closed，并生成稳定 conflict code。
  - 对 hard identity conflict，不会因为已有 live root 而放宽检查。
- 残余风险:
  - 当前未见手工决策入口的执行流，但 fail-closed 行为已满足本基准。

### 8. `rollback_and_audit_trail` / 回滚与审计记录

- status: `partial`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:722`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:741`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:832`
  - `scripts/graphrag/book-hotplug-publish-gate.mjs:27`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:167`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603001029161/plan.yaml`
  - `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260603001029161/commit-record.yaml`
- 结论:
  - migration evidence 目前覆盖 `plan/classification/copy-map/manifest-diff/
    checkpoint/validation/commit-record/residue-report`。
  - candidate validation 会在临时 staging root 中验证 manifest 与 publish
    marker。
- 残余风险:
  - backfill 最终仍直接写 live root，然后补写 publish marker；未见
    staging-first atomic rename 到 live root 的实现。
  - 未见 live-root 替换失败后的 rollback restore 或 fsync 闭环测试。

### 9. `catalog_projection_cleanup` / Catalog 投影清理

- status: `partial`
- 证据路径:
  - `src/graphrag/book-hotplug-catalog.ts:302`
  - `src/graphrag/book-hotplug-catalog.ts:404`
  - `src/graphrag/book-hotplug-catalog.ts:446`
  - `src/graphrag/capability-catalog.ts:366`
  - `src/graphrag/capability-catalog.ts:458`
  - `src/graphrag/book-hotplug-package-readonly.ts:5`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:221`
  - `test/graphrag-book-hotplug-catalog.test.ts:370`
- 结论:
  - `books.yaml`、`document-identity-map.yaml`、`graph-capabilities.yaml`
    当前可由 mounted package 重建，真实 catalog 为 `38/38/30`，residue
    投影为 0。
  - R8 的高优先级问题“只读查询路径会在包内生成 `.lock`”已关闭：
    `readPackageYaml()` 现在走 `readHotplugPackageUnknown()`，对应测试显式断言
    `loadGraphQueryCapabilities()` 后 `listLockFiles(bookRoot) === []`，真实
    `graph_vault/books` 中 `.lock` 也为 0。
- 残余风险:
  - 仍未见 `graph_vault/catalog/qmd-projection.yaml` 或
    `graph_vault/catalog/qmd-book-projections/{bookId}` 的 cleanup/rebuild
    实现与真实 vault 证据；依用户要求保持 `partial`。

### 10. `executable_migration_tests` / 可执行迁移测试

- status: `pass`
- 证据路径:
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:221`
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
  - `test/graphrag-book-hotplug-backfill.test.ts:169`
  - `test/graphrag-book-hotplug-backfill.test.ts:220`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `test/graphrag-book-hotplug-catalog.test.ts:370`
- 结论:
  - 本轮执行通过：
    `test/graphrag-book-hotplug-runtime-gate.test.ts` 5 tests、
    `test/graphrag-book-hotplug-backfill.test.ts` 3 tests、
    `test/graphrag-book-hotplug-catalog.test.ts` 8 tests。
  - 覆盖只读查询不写 `.lock`、重复运行 verify-only、duplicate/sourceHash
    conflict fail closed、residue quarantine、stale catalog rebuild 等关键场景。
- 残余风险:
  - partial 与 rollback 场景仍缺专门执行测试，已反映到对应基准项。

## 重点 Findings

### F1. `catalog_projection_cleanup` 中的包内 `.lock` 高发现已关闭

- severity: `closed`
- 证据路径:
  - `src/graphrag/capability-catalog.ts:366`
  - `src/graphrag/book-hotplug-package-readonly.ts:5`
  - `test/graphrag-book-hotplug-runtime-gate.test.ts:221`
  - `find graph_vault/books -type f -name '*.lock'`
- 结论:
  - 当前实现对包内只读读取不再使用 durable lock reader，真实 vault 也未见
    包内 `.lock` 残留。R8 的 high finding 应视为已关闭。

### F2. `partial_migration` / `failed_interrupted` 恢复闭环仍未证实

- severity: `medium`
- 证据路径:
  - `scripts/graphrag/book-hotplug-migration-state.mjs:483`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:485`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1218`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1225`
- 结论:
  - 状态机与 rerunBehavior 文案已经存在，但未见实际 resume/restart 执行链。

### F3. live-root 原子发布与 rollback restore 仍缺实现闭环

- severity: `medium`
- 证据路径:
  - `scripts/graphrag/backfill-hotplug-packages.mjs:167`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:188`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:357`
  - `scripts/graphrag/book-hotplug-publish-gate.mjs:27`
- 结论:
  - 当前仅对 candidate root 做预验证，真正提交仍不是合同要求的
    staged publish + atomic rename + fsync + rollback restore。

### F4. global qmd projection cleanup 仍缺实现或真实实证

- severity: `medium`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:326`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:403`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:961`
  - `src/graphrag/book-hotplug-catalog.ts:302`
- 结论:
  - 当前 catalog rebuild 仅实证了 books/sources/identity/capabilities，尚未
    覆盖合同中的全局 qmd projection cleanup。
