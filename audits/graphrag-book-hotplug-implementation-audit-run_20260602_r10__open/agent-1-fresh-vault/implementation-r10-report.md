# GraphRAG 单本书热插拔实现审计 R10 报告

## 审计范围

- agent: `agent-1-fresh-vault`
- scenario: fresh vault / 首次挂载 / manifest-first direct query
- baseline: `fixed-baseline.yaml`
- baselineSha256:
  `94a81f0a1b22a3837b481d515d3a6f2c5a8365e2c6e007176ac6a7bdbcfe8f3c`
- baselinePolicy: 逐字复用 R9 固定 10 维基准，未新增、删除、重排或改名。
- auditMode: local degraded audit after subagent upstream failure

## 总体结论

- overallStatus: `partial`
- baselineCount: `10`
- passed: `8`
- partial: `2`
- failed: `0`

R10 已关闭 R9 fresh-vault 中的 direct query catalog 依赖问题。当前查询入口
可以从包内 `BOOK_MANIFEST.json`、`qmd_output_manifest.json`、
`qmd_graph_text_unit_identity.json` 和 producer evidence 投影能力，全局
catalog 缺失时仍可推导 GraphRAG capability。

仍保留 partial 的原因是目录级 live-root 原子替换、fsync 和上一代 root 恢复
闭环尚未完整实现。当前实现以 `PUBLISH_READY.json` 作为可见性屏障，能阻止
坏包挂载，但不等同于完整目录级 staged rename 发布。

## 逐项判定

| # | baselineId | status | 主要证据 |
|---|---|---|---|
| 1 | `direct_query_entrypoint` | pass | `src/graphrag/book-hotplug-package-projection.ts`; `src/graphrag/capability-catalog.ts`; `test/graphrag-book-hotplug-runtime-gate.test.ts` |
| 2 | `artifact_minimum_closure` | pass | `scripts/graphrag/book-hotplug-package.mjs`; `test/graphrag-book-hotplug-catalog.test.ts` |
| 3 | `artifact_gate_state_machine` | partial | `scripts/graphrag/batch-epub-workflow.mjs`; `scripts/graphrag/book-hotplug-publish-gate.mjs`; `PUBLISH_READY` 屏障已实现，目录级 rename/fync 未完整证明 |
| 4 | `producer_lineage_completeness` | pass | `src/graphrag/book-hotplug-producer-run-bindings.ts`; `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts` |
| 5 | `lineage_artifact_binding` | pass | `src/graphrag/book-hotplug-producer-run-bindings.ts`; `scripts/graphrag/book-hotplug-artifact-metadata.mjs` |
| 6 | `schema_runtime_compatibility` | pass | `src/graphrag/book-hotplug-runtime-gate.ts`; `scripts/graphrag/book-hotplug-runtime-compatibility.mjs` |
| 7 | `query_scope_isolation` | pass | `src/graphrag/capability-catalog.ts`; `test/unified-query.test.ts`; `test/cli-graphrag-route.test.ts` |
| 8 | `privacy_payload_exclusion` | pass | `scripts/graphrag/book-hotplug-residue-quarantine.mjs`; real package scan shows no provider/log/debug/.env residue |
| 9 | `recovery_diagnostics` | partial | quality/runtime gates and migration rollback evidence exist; previous live-root restore remains policy/evidence, not full executable rollback |
| 10 | `executable_contract_tests` | pass | hotplug runtime, hardening, catalog, backfill, qmd projection, unified query and CLI tests passed |

## 实测证据

- `npm exec -- tsc -p tsconfig.build.json --noEmit`: passed
- `npm run build`: passed
- `test/graphrag-book-hotplug-runtime-gate.test.ts`: `6/6` passed
- `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts`: `3/3` passed
- `test/graphrag-book-hotplug-catalog.test.ts`: `9/9` passed
- `test/graphrag-book-hotplug-backfill.test.ts`: `4/4` passed
- `test/graphrag-book-hotplug-qmd-projection.test.ts`: `1/1` passed
- `test/unified-query.test.ts`: `37/37` passed
- `test/cli-graphrag-route.test.ts`: `9/9` passed
- real backfill: `hotplug-backfill-20260603012939480`
  - discovered: `38`
  - skipped after validation: `38`
  - failed: `0`
  - catalog: `bookCount=38`, `identityCount=38`, `capabilityCount=30`
- real package scan:
  - `hotplugPackages=38`
  - `validateBookHotplugPackage=38/38`
  - `qualityGatePassed=38`
  - `queryReady=30`
  - `visibleNotQueryReady=8`

## 剩余风险

1. live-root 目录级原子替换、fsync 和 last-good root restore 仍需实现或以更强
   可执行测试证明。
2. 当前 `PUBLISH_READY.json` 屏障能避免坏包挂载，但失败恢复仍偏向保留证据和
   阻止可见性，不是完整事务性 root 替换。

## 写入文件

- `implementation-r10-report.md`
- `implementation-r10-summary.json`
