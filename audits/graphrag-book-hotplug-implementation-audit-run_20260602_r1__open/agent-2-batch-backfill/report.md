# agent-2-batch-backfill 实施审计报告

## scenario

场景假设为：已有 38 本完成书需要批量 backfill、批量校验、批量分发，
并且目录中可能仍混有历史残留目录（residue directories）。本报告只复核
当前实现是否满足固定 10 维基准，不新增、删除、重排、重命名审计维度，
也不修改通过标准（passCriteria）。

## audit_scope

仅审计以下材料与代码：

- `docs/architecture/graphrag-book-hotplug-package.README.md`
- `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml`
- `src/cli/qmd.ts`
- `src/integrations/python-bridge.ts`
- `src/graphrag/book-hotplug-catalog.ts`
- `src/graphrag/settings-projection.ts`
- `scripts/graphrag/book-hotplug-package.mjs`
- `scripts/graphrag/backfill-hotplug-packages.mjs`
- `test/cli-graphrag-route.test.ts`
- `test/unified-query.test.ts`

未读取其他实现文件作为审计证据。

## reused_fixed_baseline

本轮复用固定 baseline（fixed baseline）：

`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r1__open/agent-2-batch-backfill/baseline.yaml`

复用来源：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/agent-10-migration-cleanup/baseline.yaml`

本地 baseline SHA-256：

`3754841ae8300fd9651d4137fab9ebab88946538ee1c8f00d83e039f1ec08282`

说明：

- 本地 `baseline.yaml` 为来源 baseline 的字节级复制（byte-identical copy）。
- 本轮未新增、删除、重排、重命名任何 baseline 维度。
- 本轮未改变任何 `passCriteria`。
- `agent-2-batch-backfill` 只是本次实施审计角色名；固定标准直接复用迁移清理
  场景的既有 10 维基准。

## baseline_integrity_check

| 检查项 | 结果 |
| --- | --- |
| 固定 baseline 文件存在 | pass |
| baseline 维度数量 | pass，10 个 |
| baseline 标准是否变更 | pass，未变更 |
| baseline 来源是否明确 | pass |
| baseline 是否覆盖写入 | pass，本轮只新增 `report.md` |

## findings

### 1. `current_vs_residue_classification` | 当前书与历史残留分类

通过标准：

Type DD 明确定义如何从现有目录中区分 38 本完成书、34 个历史残留目录、
重名或同源候选，并给出可执行判定字段、优先级和失败诊断；未分类目录不得
被误迁移为 hot-plug authoritative package。

结论：`partial`

证据：

- 设计合同已要求 38/34 分类和 fail-closed 行为：
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1897-1900`，
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1098-1149`。
- 当前批量 backfill 只通过 5 个文件存在性判定“完成书”：
  `scripts/graphrag/backfill-hotplug-packages.mjs:55-75`。
- 非完成目录被静默跳过，不会被直接迁移为权威包；但 scoped implementation
  没有把它们显式分类为 residue、repair candidate 或 duplicate，也没有输出
  稳定诊断。

判定理由：

实现已经具备“避免误迁移”的最小白名单，但没有完成 baseline 要求的显式分类、
优先级和诊断闭环。

### 2. `migration_source_of_truth` | 迁移源权威

通过标准：

迁移以现有 `distribution_manifest.json`、校验 sidecars、qmd、output、runs、
input 和 source closure 的一致组合为源权威，明确哪些文件缺失时禁止自动
生成 `BOOK_MANIFEST.json`。

结论：`fail`

证据：

- 设计合同要求在缺少 `distribution_manifest.json.sha256`、canonical input、
  source closure、artifact file checksums 等关键证据时禁止生成权威 manifest：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1104-1149`。
- 当前 `isCompletedLegacyBook()` 只检查 5 个文件，不检查 `.sha256` sidecars、
  source closure、producer lineage 或 artifact checksums：
  `scripts/graphrag/backfill-hotplug-packages.mjs:55-75`。
- `buildBookHotplugManifest()` 会先尝试复制 legacy source closure；如果源闭包
  缺失，仍会继续构建 manifest，`sourcePathFromPackage()` 退化到
  `source/source.epub`，`sourceBytes` 可为 `0`：
  `scripts/graphrag/book-hotplug-package.mjs:132-166`，
  `scripts/graphrag/book-hotplug-package.mjs:366-375`，
  `scripts/graphrag/book-hotplug-package.mjs:429-564`。

判定理由：

实现没有落实设计中的 fail-closed source-of-truth gate。当前逻辑更接近
“best effort fabricate package authority”，不满足基准。

### 3. `package_layout_transform` | 包布局转换完整性

通过标准：

Type DD 对 `source`、`input`、`qmd`、`graphrag/output`、`graphrag/runs`、
`state` 和 `import` 的迁移目标、保留方式、兼容 locator 或 symlink 生命周期
有明确规则，且所有目标路径均为 package-relative。

结论：`partial`

证据：

- 实现已把 legacy `output` 复制到 `graphrag/output`，把 `runs` 复制到
  `graphrag/runs`，把 `job.yaml`、`artifacts.yaml`、`checkpoints.yaml` 复制到
  `state/`，且 manifest files entries 均为 package-relative：
  `scripts/graphrag/book-hotplug-package.mjs:144-166`，
  `scripts/graphrag/book-hotplug-package.mjs:290-336`，
  `scripts/graphrag/book-hotplug-package.mjs:461-564`。
- 但 CLI GraphRAG query 仍把 `dataDir` 指向旧布局
  `books/{bookId}/output`，而不是 `books/{bookId}/graphrag/output`：
  `src/cli/qmd.ts:3328-3334`，
  `src/cli/qmd.ts:3438-3441`。
- 相关测试也仍大量使用旧的 `books/${bookId}/output/*` 路径约定：
  `test/cli-graphrag-route.test.ts:257-314`，
  `test/unified-query.test.ts:280-332`。

判定理由：

迁移写入侧已经朝热插拔布局靠拢，但消费侧仍残留旧路径假设，说明布局转换
没有真正闭环。

### 4. `checksum_manifest_regeneration` | Manifest 与校验重建

通过标准：

迁移后必须重新生成 `BOOK_MANIFEST.json`、manifest checksum、checksum metadata
和 files 闭包；任何移动、复制、重命名或 redaction 后的旧 checksum 不得被
复用为目标布局校验。

结论：`pass`

证据：

- backfill 每次写入 manifest / publish marker 时都重新写正文、`.sha256` 与
  `.sha256.meta.json`：
  `scripts/graphrag/backfill-hotplug-packages.mjs:30-53`，
  `scripts/graphrag/backfill-hotplug-packages.mjs:101-114`。
- manifest files 闭包中的文件和目录 checksum 全部由当前包内内容重新计算：
  `scripts/graphrag/book-hotplug-package.mjs:191-239`，
  `scripts/graphrag/book-hotplug-package.mjs:290-336`。
- validator 会校验 manifest sidecar、embedded sha、publish marker sha、
  文件 bytes、文件 sha、目录 sha：
  `scripts/graphrag/book-hotplug-package.mjs:607-717`。

判定理由：

在“写新 manifest 与校验 sidecars”这一维度上，实现满足基准。

### 5. `residue_quarantine_policy` | 历史残留隔离策略

通过标准：

Type DD 定义历史残留目录的隔离、可见性、archive 或 repair 状态，禁止在未
通过 repair contract 前删除、覆盖、导出、投影为可查询或参与 catalog 权威。

结论：`fail`

证据：

- 设计合同明确要求 residue / repair / quarantine 的状态和默认行为：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1244-1304`。
- 当前 scoped implementation 中没有 residue quarantine state、archive record、
  repair record 或 manual decision record 的落盘实现。
- `discoverLegacyBooks()` 只是静默跳过不满足 completed 规则的目录：
  `scripts/graphrag/backfill-hotplug-packages.mjs:65-75`。
- `book-hotplug-catalog.ts` 只会忽略缺少有效 manifest / publish marker 的目录：
  `src/graphrag/book-hotplug-catalog.ts:104-135`。

判定理由：

“不会被投影”不等于“已被隔离并具备 repair contract”。当前实现缺少 baseline
要求的残留隔离状态管理。

### 6. `idempotent_migration` | 幂等迁移

通过标准：

迁移脚本可重复运行，并能识别已迁移、部分迁移、失败中断和 legacy-only 状态；
重复运行不会重复移动文件、破坏 checksum、覆盖用户新增 metadata 或改变已验证
package identity。

结论：`fail`

证据：

- backfill 的 skip 条件只识别“manifest + sidecars + publish marker 全齐”这一种
  已迁移状态：
  `scripts/graphrag/backfill-hotplug-packages.mjs:144-156`。
- 设计合同要求识别 `already_migrated`、`partial_migration`、
  `failed_interrupted`、`legacy_only` 四类状态，并有 copy-map / checkpoint：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1153-1218`。
- 当前 manifest 的 `createdAt` 和 `packageGeneration` 默认由当前时间生成：
  `scripts/graphrag/book-hotplug-package.mjs:439-473`。
- 因此，当目标目录处于“部分迁移”而不是“完整迁移”时，重跑 backfill 可能生成
  新的 `packageGeneration`，破坏“验证后 identity 不变”的合同。

判定理由：

当前实现只有“缺了就重写，齐了就跳过”的弱幂等，不满足设计基准要求的状态识别
与 rerun contract。

### 7. `conflict_and_duplicate_handling` | 冲突与重复处理

通过标准：

对 `sameBookIdDifferentSourceHash`、`sameSourceHashDifferentBookId`、
同源多目录、完成书与残留目录同前缀、目标目录已存在等冲突给出 fail-closed
行为、人工决策入口和稳定诊断。

结论：`fail`

证据：

- 设计合同已经定义迁移冲突决策表：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1219-1304`。
- 当前 backfill 实现逐目录独立处理，没有跨目录比较 sourceHash / bookId 的逻辑：
  `scripts/graphrag/backfill-hotplug-packages.mjs:133-191`。
- `book-hotplug-catalog.ts` 只从已存在 manifest 投影 catalog，不生成 conflict
  index、不写 manual decision record：
  `src/graphrag/book-hotplug-catalog.ts:210-347`。

判定理由：

批量 backfill 的核心风险之一就是重复 / 冲突；当前 scoped implementation
没有落地这一层。

### 8. `rollback_and_audit_trail` | 回滚与审计记录

通过标准：

Type DD 要求迁移产生可审计记录，包含 before/after path、hash、迁移工具版本、
时间、决策状态和失败原因；失败时能回滚或保留可恢复 staging，且不删除 legacy
evidence。

结论：`partial`

证据：

- backfill 会为写出的 sidecar 生成最小审计字段：
  `operationId`、`runnerSessionId`、`commitState`、`committedAt`：
  `scripts/graphrag/backfill-hotplug-packages.mjs:35-48`。
- manifest 会保留 `legacyEvidence` 字段，至少记录
  `distribution_manifest.json`、legacy `output/`、legacy `runs/` 是否存在：
  `scripts/graphrag/book-hotplug-package.mjs:555-562`。
- 但 scoped implementation 中没有 before/after path-hash map、staging root、
  rollback primitive、失败恢复记录或明确的 migration evidence root。

判定理由：

有最小写入证据，但离 baseline 要求的可恢复 staging 和完整审计记录还差一整层。

### 9. `catalog_projection_cleanup` | Catalog 投影清理

通过标准：

迁移完成后 catalog、document identity map、graph capabilities、global qmd
projection 等派生状态由 mount scan 重建；旧投影中的残留书、缺失书或过期路径
必须被移除或标记 stale。

结论：`partial`

证据：

- `rebuildCatalogFromBookHotplugPackages()` 能从热插拔包重建
  `books.yaml`、`sources.yaml`、`document-identity-map.yaml`、
  `graph-capabilities.yaml`：
  `src/graphrag/book-hotplug-catalog.ts:210-347`。
- CLI 在 fresh vault 查询前会重建 managed `graph_vault/settings.yaml`，测试已覆盖：
  `src/cli/qmd.ts:3365-3367`，
  `src/cli/qmd.ts:5247-5253`，
  `src/graphrag/settings-projection.ts:361-451`，
  `test/cli-graphrag-route.test.ts:846-875`。
- 但 catalog rebuild 只在核心投影文件缺失时触发，不处理“文件存在但 stale”：
  `src/graphrag/book-hotplug-catalog.ts:335-347`。
- scoped implementation 中也没有 global qmd projection cleanup 的实现证据。

判定理由：

已经具备“missing 时自愈”的一部分恢复能力，但还没有完成 stale cleanup 和
全量投影重建合同。

### 10. `executable_migration_tests` | 可执行迁移测试

通过标准：

Type DD 足够具体，使实现者能编写 38 完成书批量迁移、34 残留目录隔离、
中断重试、checksum 重建、重复运行、冲突处理、catalog cleanup 和 provider
payload 不读取的自动化测试。

结论：`fail`

证据：

- 当前测试覆盖了 GraphRAG CLI 路由、单书选择和 fresh-vault settings projection：
  `test/cli-graphrag-route.test.ts:827-875`。
- 当前测试也覆盖了统一查询能力加载的一部分路径，但仍大量依赖旧
  `books/{bookId}/output/*` 布局：
  `test/unified-query.test.ts:280-332`。
- scoped tests 中没有 38 本批量 backfill、34 个 residue quarantine、
  interruption rerun、duplicate conflict、catalog cleanup after migration 的
  fixture 级实现。
- 设计合同明确要求这些用例：
  `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:1297-1304`，
  `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1897-1900`。

判定理由：

当前测试层没有覆盖本场景的关键批量闭环。

## pass_fail

总体判定：`fail`

统计：

- `pass`: 1
- `partial`: 4
- `fail`: 5

明细：

| 编号 | baseline id | 名称 | 结论 |
| --- | --- | --- | --- |
| 1 | `current_vs_residue_classification` | 当前书与历史残留分类 | `partial` |
| 2 | `migration_source_of_truth` | 迁移源权威 | `fail` |
| 3 | `package_layout_transform` | 包布局转换完整性 | `partial` |
| 4 | `checksum_manifest_regeneration` | Manifest 与校验重建 | `pass` |
| 5 | `residue_quarantine_policy` | 历史残留隔离策略 | `fail` |
| 6 | `idempotent_migration` | 幂等迁移 | `fail` |
| 7 | `conflict_and_duplicate_handling` | 冲突与重复处理 | `fail` |
| 8 | `rollback_and_audit_trail` | 回滚与审计记录 | `partial` |
| 9 | `catalog_projection_cleanup` | Catalog 投影清理 | `partial` |
| 10 | `executable_migration_tests` | 可执行迁移测试 | `fail` |

## implementation_gaps_to_fix

1. 在 backfill 前增加 source-of-truth gate：
   `distribution_manifest.json.sha256`、source closure、canonical input、
   producer lineage、artifact checksums 缺失时不得生成权威
   `BOOK_MANIFEST.json`。

2. 引入迁移状态机与 durable checkpoint：
   至少落地 `already_migrated`、`partial_migration`、
   `failed_interrupted`、`legacy_only`，并稳定保存 `copy-map`、
   `checkpoint`、`validation` 与 `commit-record`。

3. 把 GraphRAG runtime 消费路径统一到热插拔布局：
   CLI `dataDir` 不能继续指向 `books/{bookId}/output`，应与
   `BOOK_MANIFEST.graphrag.outputManifestPath` 和 `graphrag/output`
   保持一致。

4. 增加 residue quarantine / conflict handling 落盘实现：
   residue record、manual decision record、stable diagnostics、duplicate /
   conflict fail-closed。

5. 增加批量 fixture 测试：
   38 完成书批量 backfill、34 residue quarantine、rerun after interruption、
   conflict table、stale catalog cleanup。

## residual_risks

1. 现在可以为部分 legacy completed books 生成可校验的热插拔文件，但还不能把
   这件事当作“38 本批量可安全回填”。

2. 旧 `output/` 与新 `graphrag/output/` 双路径并存，会导致后续使用者误以为
   热插拔布局已经完全切换完成。

3. 缺少冲突与 residue 状态记录时，批量回填的失败分析和恢复动作无法稳定重放。
