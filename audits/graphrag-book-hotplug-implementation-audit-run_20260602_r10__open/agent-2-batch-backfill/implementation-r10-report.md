# GraphRAG 单本书热插拔实现审计 R10 报告

## 审计范围

- agent: `agent-2-batch-backfill`
- scenario: 38 本完成书与 34 个历史残留目录的 batch backfill
- baseline: `fixed-baseline.yaml`
- baselineSha256:
  `1d15ad741b3425cba731459cae844c9d7d4879f5f9386003d1c8ad2a33acfc41`
- baselinePolicy: 逐字复用 R9 固定 10 维基准，未新增、删除、重排或改名。
- auditMode: local degraded audit after subagent upstream failure

## 总体结论

- overallStatus: `partial`
- baselineCount: `10`
- passed: `8`
- partial: `2`
- failed: `0`

R10 已补齐 `--only-missing` 跳过前验证：已有 `BOOK_MANIFEST.json` 的书不会
重新生成包产物，但必须先通过 `validateBookHotplugPackage`，并刷新
`state/hotplug-quality-gate.json` 与 `state/hotplug-runtime-gate.json`。真实
backfill 结果显示 38 本均验证后跳过，失败为 0。

R10 同时补齐 `resume-plan.yaml` 和 `rollback-record.yaml` 的汇总字段。最新
迁移证据 `hotplug-backfill-20260603012939480` 中：

- `resume.status=ready`
- `resume.skippedBookIds=38`
- `rollback.status=committed`
- `rollback.preservePublishedBookIds=38`
- `rollback.packageRoots=72`

仍保留 partial 的原因：`partial_migration` / `failed_interrupted` 的执行级
恢复，以及 live-root 原子 publish/fsync/rollback restore 尚未形成完整可执行
闭环。

## 逐项判定

| # | baselineId | status | 主要证据 |
|---|---|---|---|
| 1 | `current_vs_residue_classification` | pass | `book-hotplug-migration-state.mjs`; real scan `38 hotplug / 34 residue` |
| 2 | `migration_source_of_truth` | pass | source closure gate; `buildPrePublishQualityGateFailure` |
| 3 | `package_layout_transform` | pass | `book-hotplug-package.mjs`; `book-package-layout.ts` |
| 4 | `checksum_manifest_regeneration` | pass | `BOOK_MANIFEST` sidecars and publish marker validation |
| 5 | `residue_quarantine_policy` | pass | residue report and no projection of 34 no-manifest directories |
| 6 | `idempotent_migration` | partial | already-migrated verify-only passes; partial/failed execution recovery still evidence-level |
| 7 | `conflict_and_duplicate_handling` | pass | backfill conflict tests and stable conflict diagnostics |
| 8 | `rollback_and_audit_trail` | partial | resume/rollback evidence fields exist; actual live-root rollback restore still partial |
| 9 | `catalog_projection_cleanup` | pass | `qmd-projection.yaml` itemCount `38`; stale projection cleanup test passes |
| 10 | `executable_migration_tests` | pass | backfill/catalog/qmd projection tests cover current contract surface |

## 实测证据

- `test/graphrag-book-hotplug-backfill.test.ts`: `4/4` passed
- `test/graphrag-book-hotplug-catalog.test.ts`: `9/9` passed
- `npm exec -- tsc -p tsconfig.build.json --noEmit`: passed
- `npm run build`: passed
- real backfill: `hotplug-backfill-20260603012939480`
  - discovered: `38`
  - scannedDirectories: `72`
  - residueCount: `34`
  - skipped after validation: `38`
  - failed: `0`
  - packageResults valid: `38`
  - catalog: `bookCount=38`, `identityCount=38`, `capabilityCount=30`
- real package scan:
  - hotplug packages: `38`
  - historicalWithoutManifest: `34`
  - validate passed: `38`
  - qualityGatePassed: `38`
  - no `.lock`, provider payload, log/debug, `.env`, recovery payload residue

## 剩余风险

1. `partial_migration` 与 `failed_interrupted` 已能分类和写恢复计划，但缺少
   实际 resume/restart 执行测试。
2. live-root 替换和 catalog projection rollback 仍以 publish marker 与证据
   约束为主，缺少完整目录级事务实现。

## 写入文件

- `implementation-r10-report.md`
- `implementation-r10-summary.json`
