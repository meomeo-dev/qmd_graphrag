# qmd_graphrag 单本书热插拔包实现审计 R5 报告

- agentId: `agent-2-batch-backfill`
- scenario: `batch backfill / 38 包 + 34 residue 迁移清理`
- overallStatus: `partial`（部分通过）
- baselineCount: `10`
- passed: `4`
- partial: `5`
- failed: `1`

## 1. `current_vs_residue_classification` / 当前书与历史残留分类

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:846`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:863`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:344`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:450`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:579`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:217`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
- 发现:
  - Type DD（类型设计）已定义 current/residue 判定字段、优先级和诊断码；
    `classifyBookDirectory()` 也据此输出 `migrationState`、`diagnostics`、
    `mayGenerateBookManifest`。
  - 非合格目录不会直接生成 `BOOK_MANIFEST.json`；`backfill` 主循环对
    `mayGenerateBookManifest=false` 的目录会 fail-closed（默认拒绝）。
  - 但 sourceHash 冲突的“优先级”只被写入冲突记录，没有反向收敛到
    `candidates` 集合。`createHotplugMigrationRun()` 仍按
    `mayGenerateBookManifest` 直接挑选候选，导致同源且同样“完整”的目录
    仍可能进入 authoritative package（权威包）回填流程。
- 修复建议:
  - 在生成 `candidates` 前先应用冲突裁决，给冲突目录落
    `pending_manual_decision` 或 `residue_quarantined`，
    再排除出 batch backfill。

## 2. `migration_source_of_truth` / 迁移源权威

- status: `pass`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:847`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:852`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1309`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1326`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:367`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:413`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:657`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:217`
  - `test/graphrag-book-hotplug-catalog.test.ts:340`
- 发现:
  - 迁移源权威（source of truth）被绑定为
    `distribution_manifest.json` 与 sidecars、canonical input、
    source closure、`qmd_build_manifest.json`、
    `qmd_output_manifest.json`、producer evidence、
    artifact checksum evidence 的组合。
  - `distribution_manifest` 缺失、sidecar 缺失、canonical input 缺失、
    source closure 缺失、artifact checksum 缺失时，会阻断自动生成
    `BOOK_MANIFEST.json`。
  - producer lineage 缺失不会放行 query-ready（查询就绪）状态，而是降级为
    `visible_not_query_ready`，与契约一致。
- 修复建议:
  - 保持现状；补一条缺失 `qmd` 或缺失 `output manifest` 的回归用例，
    固定当前 gate（闸门）行为。

## 3. `package_layout_transform` / 包布局转换完整性

- status: `pass`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:644`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:659`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:295`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:296`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:445`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:466`
  - `scripts/graphrag/book-hotplug-package.mjs:206`
  - `scripts/graphrag/book-hotplug-package.mjs:233`
  - `scripts/graphrag/book-hotplug-package.mjs:356`
  - `scripts/graphrag/book-hotplug-package.mjs:414`
  - `scripts/graphrag/book-hotplug-package.mjs:584`
- 发现:
  - Type DD（类型设计）明确了 `source/`、`input/`、`qmd/`、
    `graphrag/output/`、`graphrag/runs/`、`state/` 的迁移目标与兼容桥接
    （compatibility bridge）规则。
  - 实现通过 `ensureLegacyLayoutCompatibility()` 将 legacy 布局补齐到
    hotplug 布局，并把 artifact path（工件路径）重写到
    `graphrag/output/`。
  - `BOOK_MANIFEST.mount.packageRoot="."`，`files` 闭包全部使用
    package-relative（包相对）路径，符合固定基准。
- 修复建议:
  - 保持现状；后续若引入 bridge（桥接）自动清理，可补 bridge 生命周期
    的显式 evidence（证据）字段。

## 4. `checksum_manifest_regeneration` / Manifest 与校验重建

- status: `pass`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:657`
  - `scripts/graphrag/book-hotplug-package.mjs:484`
  - `scripts/graphrag/book-hotplug-package.mjs:506`
  - `scripts/graphrag/book-hotplug-package.mjs:690`
  - `scripts/graphrag/book-hotplug-package.mjs:710`
  - `scripts/graphrag/book-hotplug-package.mjs:713`
  - `scripts/graphrag/book-hotplug-package.mjs:900`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:121`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:143`
- 发现:
  - 回填时会先重建 `files` 闭包，再计算
    `manifestSha256`、`manifestContentSha256`、
    `publishMarkerSha256`，并重写 sidecar（校验侧车）与 meta sidecar。
  - validator（校验器）同时验证外部 `.sha256`、嵌入式 checksum、
    `PUBLISH_READY.json` 与文件条目 hash（哈希），旧 checksum 不会被直接复用。
  - `--force` 对已验证 package（包）走 verify-only（仅验证）路径，不会在
    无迁移动作时重写 manifest，符合幂等语义。
- 修复建议:
  - 保持现状；可增加一条显式断言，比较迁移前 legacy checksum 与迁移后
    hotplug checksum 必然不同。

## 5. `residue_quarantine_policy` / 历史残留隔离策略

- status: `pass`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:892`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:899`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1072`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1172`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:775`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:788`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:217`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:96`
  - `scripts/graphrag/book-hotplug-residue-quarantine.mjs:145`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
- 发现:
  - Type DD（类型设计）将 residue（历史残留）默认动作固定为
    `quarantine_without_delete`，并声明 repair（修复）前不得 mount、export、
    project。
  - 实现会为 residue 生成 `residue-report.yaml`，明确
    `mountAllowed=false`、`exportAllowed=false`、
    `deletePerformed=false`。
  - 对已回填目录中的 provider payload（提供方载荷）、日志、`.lock`、
    `.corrupt-*` 等敏感残留，`quarantineForbiddenHotplugPackageResidues()`
    还会做物理隔离，不会把它们挂入 package closure（包闭包）。
- 修复建议:
  - 保持现状；后续若引入 repair workflow（修复工作流），建议把 residue 的
    state transition（状态迁移）记录到统一 quarantine state store。

## 6. `idempotent_migration` / 幂等迁移

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:825`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:887`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1466`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1513`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:415`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:449`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:197`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:305`
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
- 发现:
  - `already_migrated` 的 verify-only（仅验证）重跑已被测试覆盖；有效包在
    `--force` 下不会重写 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`
    或 runtime compatibility（运行时兼容）文件。
  - `classifyBookDirectory()` 也能识别 `partial_migration`、
    `failed_interrupted`、`legacy_only` 等状态，并输出 `rerunBehavior`。
  - 但 `backfill-hotplug-packages.mjs` 主循环没有消费这些状态；即便冲突记录要求
    `resume_required`，只要 `mayGenerateBookManifest=true`，脚本仍会直接写
    live root（在线目录）。这使 timeout（超时）或中断后的恢复更多依赖重跑，
    而不是 staged resume（分阶段恢复）。
- 修复建议:
  - 在主循环中阻断 `partial_migration`、`failed_interrupted`、
    `migration_target_live_root_exists`，改为显式 resume/restart 决策。
  - 真正启用 `.staging/book-hotplug-migrations/{bookId}` 的 checkpoint（检查点）
    与恢复路径，使幂等不只停留在状态判定层。

## 7. `conflict_and_duplicate_handling` / 冲突与重复处理

- status: `fail`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:87`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:103`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1756`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1806`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:453`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:577`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:599`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:610`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:197`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:240`
- 发现:
  - 契约要求 `sameBookIdDifferentSourceHash` 与
    `sameSourceHashDifferentBookId` 走 manual decision
    （人工决策）/ fail-closed（默认拒绝）流程。
  - 当前实现只会把 sourceHash prefix conflict（前缀冲突）与 duplicate source
    hash 记录到 `book-conflicts.yaml`；`createHotplugMigrationRun()` 仍把所有
    `mayGenerateBookManifest=true` 的目录放入 `candidates`。
  - `backfill-hotplug-packages.mjs` 没有读取冲突决策目录，也没有
    `pending_manual_decision` gate（决策闸门）。因此，冲突“被记录”但没有被
    “阻断”，不满足 baseline（固定基准）的 fail-closed 要求。
  - `sameBookIdDifferentSourceHash` 的专门检测在 migration scanner
    （迁移扫描器）中也未实现。
- 修复建议:
  - 先实现 `graph_vault/catalog/book-conflict-decisions` 的 durable
    decision record（持久决策记录），再让 batch backfill 仅处理
    `decisionStatus=accepted` 的候选。
  - 将冲突索引前移为 candidate filter（候选过滤器），而不是仅做 audit
    evidence（审计证据）输出。
  - 补齐 `sameBookIdDifferentSourceHash`、
    `sameSourceHashDifferentBookId`、completed-vs-residue 同前缀、
    target live root exists 的自动化测试。

## 8. `rollback_and_audit_trail` / 回滚与审计记录

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:863`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:887`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:213`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:240`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:623`
  - `scripts/graphrag/book-hotplug-migration-state.mjs:821`
  - `scripts/graphrag/book-hotplug-quality-gate.mjs:171`
  - `src/job-state/durable-state-store.ts:1163`
  - `src/job-state/durable-state-store.ts:1235`
- 发现:
  - 当前实现会生成 `plan.yaml`、`classification.yaml`、`copy-map.yaml`、
    `manifest-diff.yaml`、`validation.yaml`、`commit-record.yaml`、
    `residue-report.yaml`、`book-conflicts.yaml`，基本具备 batch backfill
    审计可见性。
  - `copy-map.yaml` 已含 before/after path、sha256、bytes、rollbackAction；
    `commit-record.yaml` 也保留失败项与 `catalogRebuild` 结果。
  - 但 final contracts（最终契约）要求的多项字段尚未完整落地，例如
    old/new normalized hash、old/new producerRunIds、before/after packageRoot、
    before/after artifact hash sets。
  - 更关键的是，本脚本并未真正采用 staging + rollback（暂存加回滚）发布；
    live root 被直接写入。`durable-state-store` 能清理 stale lock（陈旧锁），
    但它保护的是 durable file（耐久文件）写入，不等同于迁移级 rollback。
- 修复建议:
  - 按 final migrationEvidenceSchema（迁移证据模式）补全字段。
  - 将 batch backfill 改为 staging-first（先暂存）流程，记录 fencing token
    （围栏令牌）与 resume checkpoint，并在 timeout/异常时保留可恢复 staging。

## 9. `catalog_projection_cleanup` / Catalog 投影清理

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:630`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:681`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:942`
  - `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml:974`
  - `src/graphrag/book-hotplug-catalog.ts:128`
  - `src/graphrag/book-hotplug-catalog.ts:195`
  - `src/graphrag/book-hotplug-catalog.ts:305`
  - `src/graphrag/book-hotplug-catalog.ts:479`
  - `scripts/graphrag/backfill-hotplug-packages.mjs:309`
  - `test/graphrag-book-hotplug-catalog.test.ts:370`
- 发现:
  - `rebuildCatalogFromBookHotplugPackages()` 会从当前
    `BOOK_MANIFEST.json + PUBLISH_READY.json` 集合重建 `books.yaml`、
    `sources.yaml`、`document-identity-map.yaml`、
    `graph-capabilities.yaml`，并在 stale（过期）时整体覆盖旧投影。
  - stale 目录投影的删除行为已有测试覆盖，符合“从 manifest 重建并清掉旧投影”
    的核心要求。
  - 但审计对象中没有实现 `graph_vault/catalog/qmd-projection.yaml` 或
    qmd projection cache（投影缓存）的同步清理逻辑；final contract（最终契约）
    把它列为可选 cache（缓存）之一，但当前 backfill/catalog cleanup
    尚未覆盖。
- 修复建议:
  - 把 qmd projection cache 的 stale detection（过期检测）与 invalidation
    （失效）纳入 `--rebuild-catalog` 的同一事务，或在后置清理阶段显式执行。

## 10. `executable_migration_tests` / 可执行迁移测试

- status: `partial`
- 证据路径:
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1265`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1274`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1800`
  - `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml:1806`
  - `test/graphrag-book-hotplug-backfill.test.ts:128`
  - `test/graphrag-book-hotplug-catalog.test.ts:278`
  - `test/graphrag-book-hotplug-catalog.test.ts:340`
  - `test/graphrag-book-hotplug-catalog.test.ts:370`
  - `test/graphrag-book-hotplug-catalog.test.ts:573`
  - `test/graphrag-book-hotplug-catalog.test.ts:623`
- 发现:
  - 已覆盖的自动化场景包括：`--force` verify-only、不提升 residue、
    source closure 缺失 fail-closed、stale catalog rebuild、
    provider payload 拒绝、producer runs 缺失不产出 graph capability。
  - 仍缺失固定基准直接要求的关键场景：冲突/重复人工决策、partial/interrupted
    migration resume（恢复）、stale lock takeover（陈旧锁接管）、
    staging cleanup（暂存清理）、checksum regeneration（校验重建）边界、
    38/34 代表性 batch 场景。
- 修复建议:
  - 追加最小集成测试矩阵，优先补冲突 fail-closed、超时/中断恢复、
    qmd projection cleanup 与 stale lock recovery。

## 结论

本轮实现对 38 本已迁移包的 verify-only（仅验证）重跑、34 个 residue
（历史残留）的“逻辑隔离”、manifest-first（Manifest 优先）catalog 重建，
以及敏感残留物理隔离，已经具备较强的可用性。当前最主要缺口不是
source-of-truth（源权威）或 checksum regeneration（校验重建），而是
conflict/manual-decision（冲突/人工决策）没有真正变成执行门槛，以及
timeout/interruption（超时/中断）后的恢复还没有进入 staging-first
（先暂存）事务模型。

按固定基准判定，本审计结论为 `partial`（部分通过）。
