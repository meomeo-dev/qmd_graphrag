# Agent 2 Implementation Audit: batch-backfill / migration cleanup

## Scope

审计对象为单本书热插拔包在批量 backfill 与迁移清理场景下的实现状态。
重点验证当前 38 本完成书与 34 个历史残留目录是否能迁移到
`graph_vault/books/{bookId}` 热插拔布局，并确认 source-of-truth gate、
残留隔离、冲突处理、回滚证据、幂等重跑、catalog cleanup、以及书籍创建
过程的质量门（quality gate）是否足以保证单本书复制传播后的可用性。

固定审计基准读取自：

`audits/graphrag-book-hotplug-implementation-audit-run_20260602_r3__open/agent-2-batch-backfill/baseline.yaml`

本审计未修改代码、真实 `graph_vault` 数据或 baseline。

## Commands

- `sed -n '1,220p' .../agent-2-batch-backfill/baseline.yaml`
- `wc -l scripts/graphrag/backfill-hotplug-packages.mjs ...`
- `sed` / `rg` / `nl` 只读检查相关实现与测试文件。
- `npm exec -- tsc -p tsconfig.build.json --noEmit`
  - 结果：通过。
- `npx vitest run test/graphrag-book-hotplug-catalog.test.ts --testTimeout 120000`
  - 结果：通过，5 tests passed。
- 只读 Node 复核脚本：
  - `validateBookHotplugPackage` 对真实 vault 中 38 个有
    `BOOK_MANIFEST.json` 的目录全部通过。
  - 38 个 `state/hotplug-quality-gate.json` 均为 `passed` 且
    `copyDistributionAllowed: true`。
  - `createHotplugMigrationRun` 将 72 个目录分类为 38 个
    `already_migrated` 与 34 个 `residue_quarantined`。
  - catalog 当前为 38 books、38 identities、30 graph capabilities，
    无 stale book、无 missing book、无 stale capability。
  - 最新迁移证据目录包含 `plan.yaml`、`classification.yaml`、
    `copy-map.yaml`、`checkpoint.yaml`、`validation.yaml`、
    `commit-record.yaml` 及各自 sidecar。

## Evidence Snapshot

- `scripts/graphrag/book-hotplug-migration-state.mjs:300` 到 `371`
  实现 distribution manifest sidecar、qmd manifest、GraphRAG output
  manifest、canonical input、source closure、producer run evidence 与 artifact
  checksum 的分类诊断，并给出 `mayGenerateBookManifest`。
- `scripts/graphrag/book-hotplug-migration-state.mjs:375` 到 `443`
  生成 source-hash prefix conflict 与 duplicate source hash 冲突记录。
- `scripts/graphrag/book-hotplug-migration-state.mjs:490` 到 `643`
  写入迁移 plan、classification、copy-map、checkpoint、validation、
  commit-record、residue-report 与 book-conflicts。
- `scripts/graphrag/backfill-hotplug-packages.mjs:161` 到 `210`
  在 backfill 中检查 `mayGenerateBookManifest`，生成包后执行
  `validateBookHotplugPackage`，并写入 backfill 质量门。
- `scripts/graphrag/batch-epub-workflow.mjs:10120` 到 `10181`
  在书籍创建过程写入 `BOOK_MANIFEST.json` 前执行 pre-publish gate，
  写入后执行 package validation，并记录 `copyDistributionAllowed`。
- `src/graphrag/book-hotplug-catalog.ts:305` 到 `455`
  从 hotplug package 重建 books、sources、document identity 与 graph
  capabilities catalog。
- `test/graphrag-book-hotplug-catalog.test.ts:275` 到 `365`
  覆盖残留隔离与缺失 source closure fail-closed。
- `test/graphrag-book-hotplug-catalog.test.ts:367` 到 `480`
  覆盖 stale catalog cleanup。
- `test/graphrag-book-hotplug-catalog.test.ts:482` 以后覆盖创建质量门不进入
  package file closure。

真实 vault 只读复核结果：

```json
{
  "booksDirectories": 72,
  "packageValidation": { "totalWithManifest": 38, "ok": 38 },
  "qualityGates": { "total": 38, "passedCopyAllowed": 38 },
  "classification": {
    "totalDirectories": 72,
    "candidates": 38,
    "residues": 34,
    "states": { "already_migrated": 38, "residue_quarantined": 34 },
    "conflicts": 34,
    "residueGenerationAllowed": 0
  },
  "catalog": {
    "books": 38,
    "identities": 38,
    "capabilities": 30,
    "staleBooks": [],
    "missingBooks": [],
    "staleCapabilities": []
  }
}
```

## Baseline Results

| baseline id | result | judgement |
| --- | --- | --- |
| `current_vs_residue_classification` | pass | 72 个目录被稳定分类为 38 个当前完成书与 34 个残留目录；残留目录 `mayGenerateBookManifest` 全为 false，未被投影为 package authority。 |
| `migration_source_of_truth` | partial | distribution manifest、sidecar、qmd、GraphRAG output、canonical input、source closure、artifact checksum 已作为 gate；但 producer run evidence 目前主要通过诊断和后置 validation 防止发布，不是所有 run 缺失都在 live manifest 写入前硬阻断。 |
| `package_layout_transform` | pass | source、input、qmd、`graphrag/output`、`graphrag/runs` 与 state 均被迁入或映射到 package-relative 布局；legacy output/runs 路径会重写到 hotplug 目标。 |
| `checksum_manifest_regeneration` | pass | `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、manifest sidecar、文件闭包 sha256、artifact metadata closure 均按目标布局重新生成并由 validator 校验。 |
| `residue_quarantine_policy` | pass | 34 个残留目录记录在 residue report 中，`mountAllowed: false`、`exportAllowed: false`、`deletePerformed: false`；没有残留进入 catalog。 |
| `idempotent_migration` | partial | 已迁移目录可被识别并跳过，重跑不会重新处理有效 manifest；但实现未显式区分 `partial_migration`、`failed_interrupted` 等状态，也没有完整 staging resume 语义。 |
| `conflict_and_duplicate_handling` | partial | 当前 source-hash prefix conflict 与 duplicate source hash 有稳定记录；但 sameBookIdDifferentSourceHash、目标目录已存在、staging target 已存在等冲突的实现路径和人工决策入口仍不完整。 |
| `rollback_and_audit_trail` | partial | 已写入 plan、classification、copy-map、checkpoint、validation、commit-record 与 sidecar，并保留 legacy evidence；但 copy-map 不是逐文件 before/after hash，缺少完整 started/completed 字段矩阵，且 backfill 仍直接写 live root，未实现真正 staging rollback。 |
| `catalog_projection_cleanup` | pass | catalog 可从 `BOOK_MANIFEST.json` mount scan 重建；真实 vault 当前 38 books、38 identities、30 capabilities 无 stale book，测试覆盖 stale catalog cleanup。 |
| `executable_migration_tests` | partial | 已有残留隔离、缺失 source fail-closed、stale catalog cleanup、质量门测试；但 38/34 批量 fixture、中断重试、checksum 重建、重复运行、冲突矩阵、provider payload no-read 的自动化覆盖仍不完整。 |

## overall_result

`partial`

当前实现已经能支撑真实 vault 的 38 本完成书生成可复制的 hotplug package，
并将 34 个历史残留目录排除在 mount/catalog authority 之外。书籍创建过程也
已接入质量门，当前 38 本书的 package validator 与质量门均通过。

未给出 `pass` 的原因是固定基准要求的迁移治理面更宽：部分迁移/中断恢复状态、
更完整的人工冲突决策、逐文件级 rollback/evidence，以及所有 source-of-truth
条件在 live manifest 写入前硬阻断，仍未完全达到合同强度。

## Residual Risks

- 若 producer run evidence 缺失但前置分类仍允许进入生成路径，当前实现会依赖
  后置 validation 阻止可分发质量门通过；更稳妥的行为是在写入 live
  `BOOK_MANIFEST.json` 前完成同等强度的预验证或使用 staging root。
- backfill 缺少显式 `partial_migration`、`failed_interrupted`、`resume_from_copy_map`
  状态，异常中断后的可观察恢复能力仍弱于基准。
- 冲突处理已覆盖当前 34 个 source-hash prefix residue 冲突，但尚未覆盖固定
  基准列出的全部冲突族。
- 迁移证据足够复核本轮 38/34 结果，但尚未达到最终合同中逐字段、逐文件
  before/after hash 与完整 rollback record 的强度。
- 自动化测试已经覆盖关键 happy path 和几个 fail-closed path，但尚未覆盖完整
  migration cleanup 矩阵。

## Recommended Next Actions

1. 将 package 生成改为 staging-first，或在 live manifest 写入前运行与
   `validateBookHotplugPackage` 等价的 dry-run validation。
2. 在 migration state 中新增显式 `partial_migration`、`failed_interrupted`、
   `rolled_back` 与 `resume_required` 分类，并补充中断重试测试。
3. 扩展 `book-conflicts.yaml` 冲突矩阵，覆盖 sameBookIdDifferentSourceHash、
   sameSourceHashDifferentBookId、target live root exists、staging target exists。
4. 将 copy-map 扩展为逐文件 before/after locator、sha256、operation 与 commit
   status，满足 rollback/audit trail 基准。
5. 增加 38/34 fixture 或采样 fixture 的自动化迁移测试，固定当前真实场景的
   回归保护。
