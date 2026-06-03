# Agent 2 实施审计 R4

## 范围

- Agent：`agent-2-batch-backfill`
- 场景（scenario）：
  当前 38 本完成书与 34 个历史残留目录迁移到热插拔布局。
- 固定基准（fixed baseline）：
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-2-batch-backfill/baseline.yaml`
- 基准 SHA256：
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`

`r3` 目录内存在 `baseline.yaml`、`report.md`、`summary.json`、
`post-fix-*` 与 `post-runtime-compat-rerun-20260602-*` 文件，未见单独
`criteria` 文件。本轮固定 10 维审计基准完全取自 `baseline.yaml`，并以
`r3` 既有 summary/report 校准判定口径，未新增、删除、重命名或重排任何
baseline 维度。

本轮仅执行只读检查（read-only inspection）与临时目录验证
（temporary clone verification）。未修改生产代码、测试或真实
`graph_vault`。

## 结论

总体状态（overall status）：`partial`。

本轮重点复核的 4 个最近修复项，均已得到直接证据支持：

- 脚本侧 `validateRuntimeCompatibility(files)` 语义 digest 校验已落地，
  且伪造 digest 的 fail-closed 测试通过。
- 临时 clone 上
  `backfill-hotplug-packages --force --rebuild-catalog --fail-fast`
  以 `exit 0` 完成。
- 真实 vault catalog 当前为
  `books/sources/identities/capabilities = 38/38/38/30`。
- forbidden residue scan 结果为 `0`，未发现 package 内部禁带残留。

仍未达到 `pass` 的原因集中在 4 个固定基准维度：

1. 幂等迁移（idempotent migration）在 `--force` 路径下仍会重写
   `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、
   `runtime-compatibility.json` 与 `identity.createdAt`。
2. 冲突处理（conflict handling）真实证据仍只完整覆盖 34 个
   `migration_source_hash_prefix_conflict`。
3. 回滚与审计轨迹（rollback and audit trail）证据已完整，但 backfill
   仍不是 staging-first publish。
4. 可执行迁移测试（executable migration tests）focused tests 已全绿，
   但完整合同矩阵仍未自动化证明。

## 重点复核结果

### 1. 运行时兼容 digest（runtime compatibility semantic digest）：通过

脚本侧 digest 校验位于：

- `scripts/graphrag/book-hotplug-runtime-compatibility.mjs:136-199`
- `src/graphrag/book-hotplug-runtime-compatibility-digests.ts:76-129`
- `src/graphrag/book-hotplug-runtime-gate.ts:266-326`

脚本校验与运行时校验都要求以下 4 个 digest 字段一致：

- `outputManifestSchemaDigest`
- `parquetSchemaDigest`
- `lancedbSchemaDigest`
- `artifactMetadataSchemaDigest`

`test/graphrag-book-hotplug-runtime-gate.test.ts:206-279` 当前通过，
验证伪造 `parquetSchemaDigest` 后：

- `validateHotplugRuntimeQueryGate` fail-closed；
- `validateBookHotplugPackage` fail-closed；
- `loadGraphQueryCapabilities` 返回 0。

这说明语义 digest 已不再是仅落盘、不参与判定的装饰字段。

### 2. `--force --rebuild-catalog --fail-fast`：通过

在 APFS clone 的临时副本
`/tmp/qmd-agent2-audit-r4-IcJMMj/graph_vault` 上执行：

`node scripts/graphrag/backfill-hotplug-packages.mjs --state-root /tmp/qmd-agent2-audit-r4-IcJMMj/graph_vault --force --rebuild-catalog --fail-fast`

结果：

- 进程退出码：`0`
- `processed=38`
- `failed=0`
- `classification: already_migrated=38, residue_quarantined=34`
- `manifest-diff entries=38, committed=38`
- `copy-map entries=38, file entries=70493, pending=0`
- `catalogRebuild: books=38, identities=38, capabilities=30`

因此，用户点名的命令级修复已经通过。

### 3. 真实 catalog `38/38/38/30`：通过

基于真实 `graph_vault` 的只读统计：

- `books.yaml`: 38
- `sources.yaml`: 38
- `document-identity-map.yaml`: 38 条，且
  `distinct canonicalBookId = 38`
- `graph-capabilities.yaml`: 30

同时未观察到 stale 引用：

- `staleBooks = []`
- `staleIdentityRefs = []`
- `staleCapabilityRefs = []`

这与 `src/graphrag/book-hotplug-catalog.ts:305-456` 的重建逻辑一致，
也与 `test/graphrag-book-hotplug-catalog.test.ts` 当前 8/8 通过的结果一致。

### 4. forbidden residue scan：通过

按照
`scripts/graphrag/book-hotplug-residue-quarantine.mjs:17-28,95-145`
中的同一 forbidden path 模式，对真实 `graph_vault/books/*` 进行只读扫描。

结果：

- `forbiddenPathPackageCount = 0`

这意味着当前 38 个 package 内未发现 `.env`、`provider-requests/`、
`provider-responses/`、`.durable-recovery.jsonl`、`.DS_Store`、
`*.corrupt-*` 等禁带残留。

## 真实 vault 证据摘要

- `graph_vault/books` 目录总数：72
- 含 `BOOK_MANIFEST.json` 的 package：38
- `state/hotplug-quality-gate.json`：
  38/38 为 `passed` 且 `copyDistributionAllowed=true`
- `graphrag/output/runtime-compatibility.json`：
  38/38 存在，38/38 为 `compatibilityStatus=compatible`
- `BOOK_MANIFEST.graphrag.queryReady`：
  `true=30`，`false=8`
- forbidden residue scan：
  `0`
- 最新真实迁移证据（latest real migration evidence）：
  `graph_vault/catalog/book-package-migrations/migrations/hotplug-backfill-20260602182957235`

最新真实迁移证据包含且 sidecar 校验通过：

- `plan.yaml`
- `classification.yaml`
- `copy-map.yaml`
- `manifest-diff.yaml`
- `checkpoint.yaml`
- `validation.yaml`
- `commit-record.yaml`
- 顶层 `residue-report.yaml`
- 顶层 `book-conflicts.yaml`

最新真实迁移证据摘要：

- `classification: already_migrated=38, residue_quarantined=34`
- `sourceTruthEntries=72`
- `mayGenerateBookManifest=true: 38`
- `mayGenerateBookManifest=false: 34`
- `producerMissingMarkedNotQueryReady=8`
- `processed=38, skipped=0, failed=0`
- `manifestDiffEntries=38, committed=38`
- `copyMapEntries=38, fileEntries=70493, pending=0`
- `residueReportCount=34`
- `conflictReportCount=34`
- `conflictCode = migration_source_hash_prefix_conflict` 仅 1 类

## 基准结果

### `current_vs_residue_classification`: `pass`

72 个目录被稳定分类为：

- `already_migrated = 38`
- `residue_quarantined = 34`

34 个残留目录全部 `mayGenerateBookManifest=false`，未被错误提升为
authoritative hotplug package。

### `migration_source_of_truth`: `pass`

`validation.yaml` 为 72 个目录记录了 source-of-truth 判定字段。
关键缺失会阻止 `mayGenerateBookManifest`。producer lineage 缺失的 8 个包被
稳定标记为 `missing_marked_not_query_ready`，并保持
`queryReady=false`。此外，runtime compatibility semantic digest 现在已被
脚本校验与运行时校验共同执行，伪造 digest 时可稳定 fail-closed。

### `package_layout_transform`: `pass`

最新真实 `copy-map.yaml` 为 38 个 package 记录 package-relative 映射，
累计 70493 个逐文件条目，`pending=0`。source、input、qmd、
`graphrag/output`、`graphrag/runs` 与 `state` 的目标布局都有明确映射，
且临时 clone 上 `--force --rebuild-catalog --fail-fast` 成功完成。

### `checksum_manifest_regeneration`: `pass`

最新真实 `manifest-diff.yaml` 记录 38 个条目，38/38 为
`checksumRegenerated=true` 且 `decisionStatus=committed`。真实 38 个 package
当前均具备 `runtime-compatibility.json` 且状态为 `compatible`。伪造
digest 的 fail-closed 测试通过，说明 checksum 与 runtime digest
不是仅写入不验证的弱证据。

### `residue_quarantine_policy`: `pass`

顶层 `residue-report.yaml` 记录 34 个残留目录，保持：

- `mountAllowed=false`
- `exportAllowed=false`
- `deletePerformed=false`

真实 forbidden residue scan 为 `0`，说明当前 package 内已无禁带残留。

### `idempotent_migration`: `partial`

命令级修复已经成立：临时 clone 上
`--force --rebuild-catalog --fail-fast` 通过，`failed=0`。

但按固定基准的幂等要求，本项仍不足以升为 `pass`。将真实 vault 与临时
clone 的 `--force` 结果逐本对比后：

- `BOOK_MANIFEST.json` 文本变化：38/38
- `PUBLISH_READY.json` 文本变化：38/38
- `runtime-compatibility.json` 文本变化：38/38
- `identity.createdAt` 变化：38/38
- `identity.packageGeneration` 保持稳定：38/38
- `graphrag.queryReady` 保持稳定：38/38

因此，`--force` 路径当前更接近“原地重发布（in-place republish）”，
而不是“无副作用重验（verify-only rerun）”。

### `conflict_and_duplicate_handling`: `partial`

实现代码已经具备以下冲突码分支：

- `migration_source_hash_prefix_conflict`
- `migration_duplicate_source_hash`
- `migration_staging_target_exists`
- `migration_target_generation_conflict`
- `migration_target_live_root_exists`

但最新真实证据完整覆盖的只有 34 个
`migration_source_hash_prefix_conflict`。其他冲突族仍缺真实执行证明或专门
自动化测试，因此本项保持 `partial`。

### `rollback_and_audit_trail`: `partial`

证据质量已有明显提高：

- 7 份 migration 级 YAML 与 2 份顶层报告 sidecar 全部有效；
- `copy-map.yaml` 记录 38 个 package、70493 个逐文件条目；
- `commit-record.yaml` 记录
  `rollbackAvailable=true`、`legacyEvidencePreserved=true`。

但 `scripts/graphrag/backfill-hotplug-packages.mjs:113-136,223-256`
仍是在 candidate validation 通过后直接写 live root 下的
`BOOK_MANIFEST.json`、`PUBLISH_READY.json` 与 gate 文件，尚无
staging-first publish / rollback 的执行证明。

### `catalog_projection_cleanup`: `pass`

真实 vault catalog 当前为 `38/38/38/30`，无 stale 引用。临时 clone 的
`--force --rebuild-catalog --fail-fast` 也返回
`bookCount=38, identityCount=38, capabilityCount=30`。同时，
`test/graphrag-book-hotplug-catalog.test.ts` 中的 stale catalog cleanup
用例当前已通过。

### `executable_migration_tests`: `partial`

Focused test 现状：

- `tsc --noEmit`：通过
- `test/graphrag-book-hotplug-runtime-gate.test.ts`：1/1 通过
- `test/graphrag-book-hotplug-catalog.test.ts`：8/8 通过

本项较 `r3` 明显改善，但按固定基准仍未完全闭环，原因是以下矩阵仍未由
自动化直接证明：

- 38 完成书 / 34 残留目录的批量迁移 fixture
- 中断重试（interrupted retry）
- `--force` 重跑下 identity stability 的合同化断言
- 全冲突矩阵（full conflict matrix）

## 残余风险

1. `--force` 当前已能稳定跑通，但它会重写已验证 package 的 manifest、
   publish marker、runtime compatibility 与 `identity.createdAt`。
2. 真实冲突证据目前只完整覆盖 prefix conflict。非 prefix 冲突族虽有代码
   分支，但尚未执行证明。
3. backfill 仍直接写 live root，缺少 staging-first rollback 证据链。
4. digest 语义在脚本实现与运行时实现之间仍存在双份逻辑；当前行为已通过
   focused test 对齐，但后续维护仍有漂移风险（drift risk）。
5. 对真实 vault 逐本直接执行 validator sweep 时，曾命中一次 LanceDB
   临时 `.lock` 文件在读取前消失的 `ENOENT`。本轮未将其记为 package
   failure，因为 temp clone force rerun、focused tests 与 forbidden scan
   均已通过，但 live-root 读时竞态仍值得单独留意。

## 命令

- `shasum -a 256 audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-2-batch-backfill/baseline.yaml`
- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit`
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-book-hotplug-runtime-gate.test.ts`
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/graphrag-book-hotplug-catalog.test.ts`
- `cp -cR graph_vault /tmp/qmd-agent2-audit-r4-IcJMMj/graph_vault`
- `node scripts/graphrag/backfill-hotplug-packages.mjs --state-root /tmp/qmd-agent2-audit-r4-IcJMMj/graph_vault --force --rebuild-catalog --fail-fast`
- 只读 Node 脚本：统计真实 `graph_vault` 的 package、quality gate、
  runtime compatibility、catalog 与 forbidden residue scan
- 只读 Node 脚本：校验最新真实 migration evidence 的 sidecar 与计数
- 只读 Node 脚本：校验临时 clone migration evidence 与 catalog rebuild
- 只读 Node 脚本：逐本比较真实 vault 与临时 clone 的 force rerun 结果
