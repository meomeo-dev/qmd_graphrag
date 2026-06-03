# Agent 2 runtime-compat 重跑后实施审计

## 范围

- Agent：`agent-2-batch-backfill`
- 场景（scenario）：当前 38 本完成书与 34 个历史残留目录迁移到
  热插拔布局。
- 固定基准（fixed baseline）：
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-2-batch-backfill/baseline.yaml`
- 基准 SHA256：
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`
- 最新真实迁移证据（latest real migration evidence）：
  `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602174142049`

本次复审严格复用既有 10 维基准，未新增、删除、重命名或调整任何
`passCriteria`。未修改生产代码（production code）、baseline 文件或真实
`graph_vault`。

## 结论

总体状态（overall status）：`partial`。

当前真实 backfill 结果已经满足以下重点要求：

- `backfill-hotplug-packages` 已在真实 vault 中产出 38 个可验证热插拔包。
- 最新迁移 evidence 完整，`plan/classification/copy-map/manifest-diff/
  checkpoint/validation/commit-record/residue-report/book-conflicts`
  全部存在且 sidecar 校验通过。
- 34 个历史残留目录维持 `residue_quarantined`，未被 mount、未进入
  catalog 权威。
- 38 个 `state/hotplug-quality-gate.json` 全部为 `passed`，且
  `copyDistributionAllowed=true`。
- 38 个 `graphrag/output/runtime-compatibility.json` 全部存在，且当前内容
  均为 `compatibilityStatus=compatible`。
- catalog 当前重建结果稳定：`books=38`、`distinct identities=38`、
  `graph capabilities=30`，无 stale 引用。

当前仍未达到 `pass` 的原因集中在 4 个维度：

1. 幂等迁移（idempotent migration）对 `already_migrated` 的
   `--force` 重跑仍不是 verify-only。
2. 冲突处理（conflict handling）真实证据只完整覆盖 34 个
   `migration_source_hash_prefix_conflict`，未执行证明完整冲突矩阵。
3. 回滚与审计轨迹（rollback and audit trail）虽然 evidence 完整，
   但 backfill 仍直接改写 live root，缺少 staging-first rollback 证明。
4. 可执行迁移测试（executable migration tests）当前目标测试文件存在
   2 个失败用例，无法支撑该维度通过。

## 关键事实

### 真实 `graph_vault` 状态

- `graph_vault/books` 目录总数：72
- 含 `BOOK_MANIFEST.json` 的热插拔包：38
- `validateBookHotplugPackage`：38/38 通过
- `state/hotplug-quality-gate.json`：38/38 为 `passed`
- `state/hotplug-runtime-gate.json`：
  - `query_ready`：30
  - `visible_not_query_ready`：8
- `graphrag/output/runtime-compatibility.json`：38/38 存在且可读，
  38/38 为 `compatible`
- `BOOK_MANIFEST.graphrag.queryReady`：
  - `true`：30
  - `false`：8
- 这 8 个 `queryReady=false` 包与最新 `validation.yaml` 中的
  `producerProvenanceStatus=missing_marked_not_query_ready` 一一对应
  （1:1 correspondence）

### 最新真实迁移 evidence

`hotplug-backfill-20260602174142049` 记录：

- `totalDirectories=72`
- `candidates=38`
- `residues=34`
- `alreadyMigrated=38`
- `residueQuarantined=34`
- `partialMigration=0`
- `failedInterrupted=0`
- `copyMapEntries=38`
- `copyMapFileEntries=70493`
- `manifestDiffEntries=38`
- `manifestDiffCommitted=38`
- `conflictReportCount=34`
- `conflictCode=migration_source_hash_prefix_conflict` 仅 1 类
- `catalogRebuild.bookCount=38`
- `catalogRebuild.identityCount=38`
- `catalogRebuild.capabilityCount=30`

最新 evidence 中：

- 7 份 migration 级 YAML (`plan` 等) 的 `.sha256` 与
  `.sha256.meta.json` 均存在且匹配。
- 顶层 `residue-report.yaml`、`book-conflicts.yaml` 的 sidecar 也存在且匹配。

## 重点复核

### 1. `backfill-hotplug-packages` 与迁移 evidence：通过

实现与真实结果在该项上对齐。

- `classification.yaml` 稳定给出 38 个 `already_migrated` 与
  34 个 `residue_quarantined`。
- `validation.yaml` 记录 source-of-truth 所需诊断、canonical input、
  source closure、producer provenance 与 artifact checksums。
- `manifest-diff.yaml` 为 38 个包记录旧
  `distribution_manifest.json` 与新 `BOOK_MANIFEST.json` 的 hash。
- `commit-record.yaml` 记录 38 个 processed 包、0 failed，
  并保留 `rollbackAvailable=true` 与 `legacyEvidencePreserved=true`。

### 2. 残留隔离（residue quarantine）与冲突证据：部分通过

真实结果满足“残留不晋升（no residue promotion）”。

- `residue-report.yaml` 中 34 个残留全部为：
  `mountAllowed=false`、`exportAllowed=false`、`deletePerformed=false`
- `book-conflicts.yaml` 中 34 条冲突全部是
  `migration_source_hash_prefix_conflict`
- 默认动作（default action）稳定为
  `keep_completed_quarantine_residue`

未达 `pass` 的原因：

- 真实 evidence 仅完整证明了 prefix-conflict 一类。
- `migration_duplicate_source_hash`、
  `migration_target_live_root_exists`、
  `migration_staging_target_exists`、
  `migration_target_generation_conflict` 等冲突族没有对应的真实执行证明。

### 3. 质量门（quality gate）与 runtime-compatibility 输出：通过

当前真实产物满足该次复核重点。

- 38/38 `hotplug-quality-gate.json` 为 `passed`
- 38/38 `copyDistributionAllowed=true`
- 38/38 `runtime-compatibility.json` 存在
- 38/38 `runtime-compatibility.json` 的
  `compatibilityStatus=compatible`
- 8 个 lineage 缺失包没有被错误标成 `query_ready`，而是稳定停在
  `visible_not_query_ready`

这说明当前质量门（quality gate）与 runtime gate 没有把 lineage 缺口
错误投影为可查询（queryable）状态。

### 4. catalog rebuild：真实结果通过，可执行证明未闭环

真实 vault 当前 catalog 投影正确：

- `books.yaml`：38
- `document-identity-map.yaml`：38 条，且 `distinct canonicalBookId=38`
- `graph-capabilities.yaml`：30
- `books -> identities` 无缺失引用
- `books -> capabilities` 无 stale 引用

但当前测试并非全绿（all green）：

- `test/graphrag-book-hotplug-catalog.test.ts`
  当前结果为 `6 passed, 2 failed`
- 失败用例：
  - `rebuilds graph capability catalog from BOOK_MANIFEST package`
  - `rebuilds stale catalog projection from current package manifests`

因此，本轮只能判定“真实结果通过”，不能判定“catalog rebuild 的执行证明
完全闭环”。

### 5. 幂等与 `--force` 重跑 identity stability：部分通过

这里是本轮最重要的未完成项。

#### 默认 rerun（临时副本）结论

在临时目录（temporary copy）中，对 2 个已迁移包和 1 个残留目录执行：

- `node scripts/graphrag/backfill-hotplug-packages.mjs --state-root ... --rebuild-catalog`

结果：

- 2 个 `already_migrated` 包被 `skipped`
- 目标 manifest 文本未变化
- `runtime-compatibility.json` 文本未变化
- `packageGeneration` 未变化
- `identity.createdAt` 未变化

这证明默认 rerun 路径具备 verify-only 行为。

#### `--force` 重跑结论

同一临时副本执行：

- `node scripts/graphrag/backfill-hotplug-packages.mjs --state-root ... --force --rebuild-catalog`

结果：

- `packageGeneration` 保持稳定
- `queryReady` 保持稳定
- 但 `identity.createdAt` 改变
- `BOOK_MANIFEST.json` 文本改变
- `runtime-compatibility.json` 文本改变
- 执行最终以 `durable_checksum_mismatch` 失败，目标为
  `graphrag/output/artifact-metadata.json`

该失败发生在临时副本（copied root），说明 `--force` 路径对已有 durable
sidecar 的处理仍然脆弱（fragile）。这不是对真实 `graph_vault` 的直接故障
证明，但足以说明 `--force` 不能作为“verify-only rerun”证据。

#### 最新真实 run 的进一步证据

根据 `commit-record.yaml`：

- `processed=38`
- `skipped=[]`
- 同时 `classification.yaml` 里 `alreadyMigrated=38`

据此可合理推断（inference）：最新真实 run 使用了 `--force` 或等价的
非 `only-missing` 路径。

进一步只读统计显示，真实 38 个包全部满足：

- `identity.packageGeneration` 的时间部分早于 `identity.createdAt`

示例：

- `book-00474fb29e5e-59d02d41`
  - `packageGeneration=20260602171026313-00474fb29e5e`
  - `createdAt=2026-06-02T17:41:45.339Z`

这说明真实强制重跑保留了 `packageGeneration`，但仍然重写了 manifest。

因此，`force` 路径目前最多只能证明：

- generation 保持稳定
- query-ready 分类保持稳定

它不能证明：

- `already_migrated` 强制重跑是 verify-only
- 重跑不会改写已验证 package 的 manifest / runtime 侧输出

## 10 维结果

### `current_vs_residue_classification`: `pass`

72 个目录被稳定分类为 38 个当前完成书和 34 个残留目录，未出现未分类目录
被错误晋升为权威包（authoritative package）。

### `migration_source_of_truth`: `pass`

最新 `validation.yaml` 为全部 72 个目录记录了 source-of-truth 判定字段。
34 个残留的 `mayGenerateBookManifest=false`，未产生 live
`BOOK_MANIFEST.json`。

### `package_layout_transform`: `pass`

真实 38 个包全部通过 `validateBookHotplugPackage`，说明 source/input/qmd/
`graphrag/output`/`graphrag/runs`/state 的目标布局可被 validator 接受。

### `checksum_manifest_regeneration`: `pass`

`manifest-diff.yaml` 中 38/38 为 `checksumRegenerated=true`，
真实 38 个包 validator 全通过，runtime-compatibility 与 artifact metadata
均存在。

### `residue_quarantine_policy`: `pass`

34 个残留全部维持 quarantine 语义：不可 mount、不可 export、未删除。

### `idempotent_migration`: `partial`

默认 rerun 已验证为 verify-only；但真实最新 run 对 38 个
`already_migrated` 包执行了重处理，且 `--force` 路径会改写 manifest /
runtime 输出，不能视为“已验证 identity 完全不变”。

### `conflict_and_duplicate_handling`: `partial`

34 个 prefix-conflict 已有稳定证据；其余冲突族尚无真实执行证明。

### `rollback_and_audit_trail`: `partial`

evidence 完整，sidecar 完整，但 backfill 仍直接改写 live root，尚无
staging-first rollback 的执行证明。

### `catalog_projection_cleanup`: `pass`

真实 catalog 当前与 38 个包、30 个 query-ready capabilities 一致，无 stale
引用。该项的真实结果满足基准。

### `executable_migration_tests`: `partial`

`tsc --noEmit` 通过，但当前目标测试文件并未全绿。已有一部分可执行合同
（executable contracts），尚不足以关闭该维度。

## 阻塞项（blocking findings）

1. `already_migrated` 的强制重跑（force rerun）不是 verify-only。
   真实最新 evidence 中 38 个已迁移包被重新 processed，且 manifest
   `createdAt` 晚于 generation 时间。
2. `test/graphrag-book-hotplug-catalog.test.ts` 当前有 2 个失败用例，
   阻塞 `executable_migration_tests` 达到 `pass`。
3. backfill 仍缺少 staging-first rollback 的执行证明，阻塞
   `rollback_and_audit_trail` 达到 `pass`。

## 残余风险（residual risks）

1. `--force` 路径当前更接近“原地重写（in-place rewrite）”而不是
   “verify-only rerun”。运维若把它当作无副作用重跑，会高估安全边界。
2. 临时副本上的 `durable_checksum_mismatch` 说明 sidecar/durable 写入路径
   对复制根目录（copied root）的鲁棒性不足。
3. catalog 的真实结果当前正确，但其最小 fixture 重建链路尚未稳定通过，
   对后续回归保护不够。
4. 当前真实冲突 evidence 只覆盖 prefix-conflict，无法代表完整冲突矩阵。

## 决策

本轮 Agent 2 复审结果维持 `partial`。

真实 backfill 结果、迁移 evidence、残留隔离、质量门状态、runtime gate
状态、runtime-compatibility 输出与当前 catalog 投影均已达到可审计状态。
阻止结论升级为 `pass` 的核心问题不是“真实产物已失效”，而是
`already_migrated` 的强制重跑语义、rollback 证明与可执行测试矩阵仍未闭环。
