# agent-2-batch-backfill 实施审计报告

## 审计范围

- 固定 baseline:
  `audits/graphrag-book-hotplug-implementation-audit-run_20260602_r2__open/agent-2-batch-backfill/baseline.yaml`
- baseline SHA-256:
  `3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`
- baseline 维度数量: 10
- baseline `agentId`: `agent-10-migration-cleanup`
- 本轮审计角色: `agent-2-batch-backfill`

本轮只读代码、文档、测试与必要命令输出；未修改 baseline，未修改实现代码。

## 复核命令

- `node scripts/graphrag/backfill-hotplug-packages.mjs --state-root graph_vault --fail-fast`
  - `discovered: 38`
  - `processed: 0`
  - `skipped: 38`
  - `failed: 0`
- `validateBookHotplugPackage` 只读复核真实 `graph_vault/books`
  - `totalDirs: 72`
  - `manifestDirs: 38`
  - `validManifestDirs: 38`
  - `residuesWithoutManifest: 34`
  - `invalidManifestCount: 0`
- `state/artifacts.yaml` 旧路径残留复核
  - `stateArtifactsWithLegacyOutputPath: 0`
- catalog 残留复核
  - `graph_vault/catalog/books.yaml`: `items: 72`, `staleBookIds: 34`
  - `graph_vault/catalog/document-identity-map.yaml`: `items: 72`,
    `staleBookIds: 34`
  - `graph_vault/catalog/graph-capabilities.yaml`: `items: 320`,
    `uniqueBookIds: 64`, `staleBookIds: 26`

已知验证可接受为本轮证据：强制 backfill
`node scripts/graphrag/backfill-hotplug-packages.mjs --state-root graph_vault --force --fail-fast`
曾完成 `processed: 38`, `failed: 0`；真实 38 个 manifest 包校验为 `38/38 ok`；
`state/artifacts.yaml` 中 `books/{bookId}/output` 旧路径残留为 `0`。

## Baseline 结果

### 1. `current_vs_residue_classification`

result: partial

证据：

- 设计定义了迁移状态、当前书与残留目录判定字段、优先级和残留策略：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:825-898`。
- 最终合同定义了 source-of-truth 失败闭合表和 38/34 场景：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1098-1152`,
  `1225-1304`。
- 当前 `backfill` 只用 5 个存在性条件筛选完成书：
  `scripts/graphrag/backfill-hotplug-packages.mjs:55-75`。
- 真实目录复核显示 72 个目录中 38 个有 `BOOK_MANIFEST.json` 与
  `PUBLISH_READY.json`，34 个没有 manifest，没有被误生成权威包。

判定：

实现具备避免误迁移的白名单筛选，但未对 34 个残留目录落盘
`residue_quarantined`、`repair_required`、重复源或冲突分类诊断，因此只部分满足。

### 2. `migration_source_of_truth`

result: fail

证据：

- 固定合同要求缺失 `distribution_manifest.json.sha256`、canonical input、
  source closure、artifact checksums 等关键证据时禁止生成权威
  `BOOK_MANIFEST.json`:
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1098-1152`。
- `isCompletedLegacyBook()` 不检查 checksum sidecars、source closure、
  canonical input、producer lineage 或 artifact checksum:
  `scripts/graphrag/backfill-hotplug-packages.mjs:55-75`。
- `buildBookHotplugManifest()` 会先复制现有 source/output/runs/state，但 source
  为空时 `sourcePathFromPackage()` 可退化为 `source/source.epub`，`sourceBytes`
  可为 `0`，validator 未把该缺失作为 manifest 生成前的 fail-closed gate:
  `scripts/graphrag/book-hotplug-package.mjs:180-219`,
  `419-428`, `482-625`, `668-787`。

判定：

当前迁移源权威检查不足，仍可能在关键证据不完整时生成权威包。

### 3. `package_layout_transform`

result: partial

证据：

- 包生成器把 legacy `output` 复制到 `graphrag/output`，把 `runs` 复制到
  `graphrag/runs`，把 `job.yaml`、`artifacts.yaml`、`checkpoints.yaml`
  复制到 `state/`:
  `scripts/graphrag/book-hotplug-package.mjs:192-219`。
- `state/artifacts.yaml` 中 legacy `books/{bookId}/output` 路径会被重写为
  `books/{bookId}/graphrag/output`:
  `scripts/graphrag/book-hotplug-package.mjs:141-178`。
- manifest file entries 使用 package-relative path:
  `scripts/graphrag/book-hotplug-package.mjs:243-279`, `342-388`。
- validator 复核 38 个真实包全部通过；旧 output 路径残留为 `0`。

缺口：

- 没有实现独立 import、staging、兼容 locator / symlink 生命周期。
- legacy `output/`、`runs/`、根级 `artifacts.yaml` 等仍作为兼容证据保留，
  缺少迁移版本到期后的清理状态。

判定：

核心目标布局已可用，但迁移目标、保留方式和兼容生命周期未完整闭环。

### 4. `checksum_manifest_regeneration`

result: pass

证据：

- `backfill` 写入 `BOOK_MANIFEST.json`、`PUBLISH_READY.json` 及各自
  `.sha256`、`.sha256.meta.json`:
  `scripts/graphrag/backfill-hotplug-packages.mjs:30-53`, `101-114`。
- `book-hotplug-package` 重新计算文件、目录 checksum 和 manifest embedded
  checksum:
  `scripts/graphrag/book-hotplug-package.mjs:82-88`, `281-291`,
  `468-480`, `645-665`。
- validator 校验 manifest sidecar、embedded checksum、publish marker、
  file bytes、file sha、directory sha:
  `scripts/graphrag/book-hotplug-package.mjs:668-787`。
- `artifact-metadata.json` 也重新生成 closure digest 并被 validator 校验：
  `scripts/graphrag/book-hotplug-artifact-metadata.mjs:129-217`。
- 真实 38 个 manifest 包 `38/38 ok`。

判定：

manifest、sidecar、publish marker、文件闭包和 artifact metadata 均按当前布局重建。

### 5. `residue_quarantine_policy`

result: fail

证据：

- 设计要求 residue 默认 `quarantine_without_delete`，并记录 archive/repair 状态：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:892-898`。
- 最终合同要求 34 个 residue 目录默认 quarantine，并禁止未修复前替换或挂载：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1244-1304`。
- 当前 `discoverLegacyBooks()` 对不满足完成条件的目录静默跳过：
  `scripts/graphrag/backfill-hotplug-packages.mjs:65-75`。
- `mountScanBookPackages()` 会把缺 manifest 的目录列为 failed，但没有写
  quarantine、archive、repair 记录：
  `scripts/graphrag/book-hotplug-package.mjs:789-821`。

判定：

残留目录没有被误迁移，但也没有进入可审计的隔离（quarantine）状态。

### 6. `idempotent_migration`

result: partial

证据：

- 非强制 backfill 在当前 38 个已迁移包上可重复运行，结果为
  `processed: 0`, `skipped: 38`, `failed: 0`。
- skip 条件仅检查 manifest、manifest sidecars 和 publish marker：
  `scripts/graphrag/backfill-hotplug-packages.mjs:146-159`。
- 设计要求识别 `already_migrated`、`partial_migration`、
  `failed_interrupted`、`legacy_only`，并通过 copy-map/checkpoint 恢复：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1153-1218`。
- `packageGeneration` 默认由当前时间和 source hash 生成；`--force` 或部分迁移
  重试可生成新 generation:
  `scripts/graphrag/book-hotplug-package.mjs:510-511`。

判定：

已迁移完整包的普通 rerun 跳过成立，但缺少部分迁移、失败中断、legacy-only
状态识别和 identity 保护。

### 7. `conflict_and_duplicate_handling`

result: fail

证据：

- 合同列出 source-hash 前缀冲突、target live root 已存在、staging 已存在、
  same bookId different sourceHash、same sourceHash different bookId 等冲突：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1219-1304`。
- 当前 `backfill` 不建立 by-sourceHash 或 by-bookId 冲突索引，只按目录逐个处理：
  `scripts/graphrag/backfill-hotplug-packages.mjs:135-195`。
- 当前实现没有 `book-conflict-decisions`、manual decision record 或稳定冲突诊断。
- `book-hotplug-catalog.ts` 只扫描有效 manifest，不输出冲突索引：
  `src/graphrag/book-hotplug-catalog.ts:123-140`, `250-401`。

判定：

冲突场景尚未实现 fail-closed 行为或人工决策入口。

### 8. `rollback_and_audit_trail`

result: fail

证据：

- 设计要求迁移 evidence 包含 plan、classification、copy-map、manifest-diff、
  validation、commit-record，并包含 before/after path、hash、工具版本、时间、
  状态和 rollback 信息：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:863-891`。
- 最终合同要求迁移 evidence schema 和 rerun checkpoint files：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:213-249`,
  `1206-1218`。
- `backfill` 只向 sidecar metadata 写入 checksum、targetLocator、operationId、
  committedAt 等有限信息：
  `scripts/graphrag/backfill-hotplug-packages.mjs:30-53`。
- `book-hotplug-package` manifest 仅记录 `legacyEvidence` 的 legacy manifest/output/runs
  locator:
  `scripts/graphrag/book-hotplug-package.mjs:617-623`。
- `durable-state-store.ts` 有通用 durable quarantine / recovery 机制，但没有
  book package migration 专用 evidence root、copy-map、rollback plan 或 commit record。

判定：

当前审计轨迹不足以恢复迁移过程，也不满足 rollback contract。

### 9. `catalog_projection_cleanup`

result: fail

证据：

- 设计要求 catalog、document identity map、graph capabilities、global qmd
  projection 等派生状态由 mount scan 重建，旧残留必须移除或标记 stale：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:940-1065`。
- 当前磁盘 catalog 仍含残留：
  `graph_vault/catalog/books.yaml` 有 `72` 项、`34` 个 stale bookId；
  `document-identity-map.yaml` 有 `72` 项、`34` 个 stale bookId；
  `graph-capabilities.yaml` 有 `320` 项、`64` 个 unique bookId、`26` 个 stale bookId。
- `ensureCatalogProjectionFromBookHotplugPackages()` 只在 core projection 缺失时重建；
  如果 `books.yaml` 和 `document-identity-map.yaml` 已存在则直接返回：
  `src/graphrag/book-hotplug-catalog.ts:403-415`。
- `loadGraphCapabilities()` 会做运行时 lineage 过滤，但不会清理已存在 stale
  catalog 文件：
  `src/graphrag/capability-catalog.ts:736-771`。

判定：

运行时可能过滤部分旧能力，但持久派生状态没有按 mount scan 清理，baseline 不通过。

### 10. `executable_migration_tests`

result: partial

证据：

- 设计已列出 migration cleanup 必测场景：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1346-1356`。
- 当前测试中存在 hotplug catalog 基础投影测试：
  `test/graphrag-book-hotplug-catalog.test.ts:21-115`。
- 未发现覆盖以下场景的自动化测试：38 完成书批量迁移、34 residue 隔离、
  source closure 缺失禁止 manifest、producer runs 缺失降级 not query ready、
  already_migrated verify-only、partial_migration copy-map 恢复、failed_interrupted
  显式决策、source-hash 冲突 fail-closed、target live root 已存在、用户 metadata
  冲突、catalog cleanup after quarantine。

判定：

设计可指导测试编写，但当前实现测试覆盖不足，不能证明迁移幂等和 cleanup 场景。

## 汇总

| baseline id | result |
| --- | --- |
| current_vs_residue_classification | partial |
| migration_source_of_truth | fail |
| package_layout_transform | partial |
| checksum_manifest_regeneration | pass |
| residue_quarantine_policy | fail |
| idempotent_migration | partial |
| conflict_and_duplicate_handling | fail |
| rollback_and_audit_trail | fail |
| catalog_projection_cleanup | fail |
| executable_migration_tests | partial |

overall_result: fail

结论：

当前实现已经能把真实 38 本完成书 backfill 成可校验的 hot-plug package，并且
34 个历史残留目录未被误生成 `BOOK_MANIFEST.json`。但是 migration cleanup
baseline 尚未通过：源权威 gate、残留隔离、冲突决策、迁移证据、rollback、
catalog 清理和可执行迁移测试仍不完整。

## 下一步修复建议

1. 增加独立迁移状态模块，输出
   `graph_vault/catalog/book-package-migrations/migrations/{migrationId}/`
   下的 `classification.yaml`、`copy-map.yaml`、`checkpoint.yaml`、
   `validation.yaml`、`commit-record.yaml`。
2. 在 backfill 前加入 source-of-truth gate：校验 distribution manifest sidecars、
   canonical input、source closure、producer lineage、artifact checksums；
   缺关键证据时只写 migration diagnostic，不写 live `BOOK_MANIFEST.json`。
3. 为 34 个 residual 目录写入 quarantine / repair 状态，不删除 legacy evidence，
   且禁止进入 catalog authoritative projection。
4. 实现 conflict index 和 manual decision record，覆盖 same bookId / same
   sourceHash / target exists / staging exists / source-hash prefix conflict。
5. 修改 catalog projection 逻辑，使 mount scan 能强制从 38 个有效 manifest
   重建 `books.yaml`、`document-identity-map.yaml`、`graph-capabilities.yaml`，
   并清除或标记 stale 旧条目。
6. 增加固定 baseline 对应测试，至少覆盖 38/34 批量迁移、重复运行、
   partial_migration、failed_interrupted、source closure 缺失、producer runs
   缺失、metadata conflict、catalog cleanup after quarantine。
