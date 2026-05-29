# GraphRAG Catalog Directory Fsync Target Mapping Implementation Audit R1

## Verdict

总体 verdict: FAIL

10 条固定实施基准中，6 条 PASS，4 条 FAIL。catalog checksum meta
backfill 的直接 parent directory fsync 缺失映射问题已修复，但派生 sidecar
evidence、共享 durable store parity、status-json 自失败投影与非 catalog scope
回归覆盖仍不完整。

## Scope

- 固定基准：
  `audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/agent-a/implementation-criteria-r1.md`
- Type DD:
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- 实现：
  `scripts/graphrag/batch-epub-workflow.mjs`
  `src/job-state/durable-state-store.ts`
  `src/contracts/batch-run.ts`
- 测试：
  `test/graphrag-runner-status-json-readonly.test.ts`
  `test/graphrag-runner-durable-preflight.test.ts`
  `test/cli.test.ts`
  `test/integrations/contracts.test.ts`
- 状态：
  `audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/reports/status.json`

## Criteria Results

| # | Result | Finding |
|---|---|---|
| 1 | FAIL | Type DD 的主要目录 scope 与 catalog acceptance 已落地，但 status-json 自失败投影（self failure projection）和 fsyncErrno sentinel 保留不完整。 |
| 2 | FAIL | checksum sidecar 派生 parent fsync 未稳定继承 sidecarTargetLocator 与 sidecarKind。 |
| 3 | PASS | runner 裸目录 fsync 使用显式 directory scope，未映射生产目录 fail closed。 |
| 4 | PASS | books.yaml checksum meta backfill parent fsync 映射到 graph_vault/catalog，不再触发 missing target mapping。 |
| 5 | FAIL | 部分目录 fsync failure evidence 缺 sidecar 字段、lane/owner 或 sentinel 字段。 |
| 6 | PASS | --status-json 对 catalog books checksum meta 缺失保持只读，并投影目录证据。 |
| 7 | PASS | runner 内部 schema 与 src/contracts/batch-run.ts 接收目录 fsync closure 字段，覆盖主要 batch contracts。 |
| 8 | FAIL | shared durable store 的目录 fsync evidence 与 runner 不完全兼容。 |
| 9 | PASS | 目录 fsync 注入 hook 只匹配候选 locator 并注入失败，不改变映射语义。 |
| 10 | FAIL | 聚焦验证覆盖 catalog 路径，但缺非 catalog scope 与 shared durable parity 回归。 |

## Findings

### 1. Status-json self failure 与 fsyncErrno sentinel 未完全对应 Type DD

Result: FAIL

Type DD 要求 status-json 自身读取 durable target 时尽量输出可解析 JSON，并在
fail-closed durable failure 中保留 directory fsync boundary 字段。当前
`inspectDurableSerializedTargetReadOnly` 直接调用 `durableTargetMapping`：

- `scripts/graphrag/batch-epub-workflow.mjs:4774`
- `scripts/graphrag/batch-epub-workflow.mjs:4780`

若 read-only 路径遇到 `durable_target_mapping_missing`，异常会落入顶层 catch，
只写 stderr 并设置 exitCode：

- `scripts/graphrag/batch-epub-workflow.mjs:12147`
- `scripts/graphrag/batch-epub-workflow.mjs:12152`

这不满足 Type DD 中 self failure projection 的 parseable JSON 要求。

此外，目录 fsync 失败在 errno 缺失时写入 `"unknown"`，但没有把
`fsyncErrno` 加入 `unavailableFieldSentinels`：

- `scripts/graphrag/batch-epub-workflow.mjs:3398`
- `scripts/graphrag/batch-epub-workflow.mjs:3404`
- `src/job-state/durable-state-store.ts:1608`
- `src/job-state/durable-state-store.ts:1615`
- `src/job-state/durable-state-store.ts:1637`
- `src/job-state/durable-state-store.ts:1644`

修复建议：

- 在 `scripts/graphrag/batch-epub-workflow.mjs:4774` 附近捕获
  `durableTargetMapping` 的 `DurableStateError`，通过
  `recordStatusJsonDurableDiagnostic` 记录 `statusJsonDecision:
  "fail_closed_projection"`、`recoveryDecision: "stop_until_fixed"` 与
  `repairAllowed: false`。
- 在 `scripts/graphrag/batch-epub-workflow.mjs:12147` 的顶层 catch 中，若
  `statusJson` 且错误为 durable failure，输出最小可解析 recovery summary
  JSON，并包含 `durableStateFailures`。
- 在 runner 与 shared store 的目录 fsync catch 中，当 errno 缺失并使用
  `"unknown"`、`"unsupported"`、`"unavailable"` 或类似 sentinel 时，补充
  `unavailableFieldSentinels: ["fsyncErrno"]`。

### 2. checksum sidecar 派生目录 fsync 缺 sidecar evidence

Result: FAIL

checksum meta sidecar backfill 已包含 `sidecarTargetLocator` 与
`sidecarKind: "checksum_meta"`。但 checksum sidecar (`*.sha256`) 的部分
parent fsync 仍使用 primary 或 checksum operation，未携带 sidecar closure。

runner 中相关位置：

- `scripts/graphrag/batch-epub-workflow.mjs:5127`
- `scripts/graphrag/batch-epub-workflow.mjs:5143`
- `scripts/graphrag/batch-epub-workflow.mjs:5666`
- `scripts/graphrag/batch-epub-workflow.mjs:5686`

shared durable store 中相关位置：

- `src/job-state/durable-state-store.ts:1119`
- `src/job-state/durable-state-store.ts:1137`
- `src/job-state/durable-state-store.ts:1145`
- `src/job-state/durable-state-store.ts:1163`

这些路径触发目录 fsync failure 时，`directoryFsyncEvidence` 只能从
`targetLocator` 推导 primary locator，不能证明 fsync 跟随 checksum sidecar
write，也不能投影 `sidecarKind: "checksum"`。

修复建议：

- 为 `.sha256` sidecar 增加与 `.sha256.meta.json` 等价的 helper，例如
  `checksumSidecarWriteEvidence(primaryPath, checksumPath, ...)`。
- 在 `scripts/graphrag/batch-epub-workflow.mjs:5134` 和 `:5668` 附近传入
  `primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind: "checksum"`
  与 `primaryDurableKind`。
- 在 `src/job-state/durable-state-store.ts:1124` 和 `:1150` 附近同步修复
  async/sync checksum backfill operation。

### 3. shared durable store 目录 fsync parity 不完整

Result: FAIL

`src/job-state/durable-state-store.ts` 的 `directoryFsyncEvidence` 只复制传入
operation 并设置 directory fields：

- `src/job-state/durable-state-store.ts:1651`
- `src/job-state/durable-state-store.ts:1673`

它没有 runner 侧的 directory scope mapping / fail-closed closure。部分 shared
store cleanup/recovery fsync 传入的是临时 operation，缺少 lane、
targetMappingOwner、primaryDurableKind 或 sidecar fields：

- stale lock recovery: `src/job-state/durable-state-store.ts:937`
- stale lock recovery sync: `src/job-state/durable-state-store.ts:976`
- stale temp cleanup: `src/job-state/durable-state-store.ts:1026`
- stale temp cleanup sync: `src/job-state/durable-state-store.ts:1090`

这些 failure evidence 不能与 runner 的 directory fsync evidence 兼容。
checksum meta sidecar 的 `primaryDurableKind` 未见 `"primary"` 或
`"json-sidecar"` 泄漏，但 parity 仍因目录映射和 cleanup evidence 缺口失败。

修复建议：

- 在 `src/job-state/durable-state-store.ts` 增加与 runner 等价的
  `DurableDirectoryFsyncScopeTable`，或抽出共享映射 helper，供
  `directoryFsyncEvidence` 在 operation 不完整时 fail closed 推导。
- 对 `:937`、`:976`、`:1026`、`:1090` 传入完整 mapped operation，至少包含
  `lane`、`targetMappingOwner`、`directoryDurableKind`、`primaryDurableKind`
  和可用的 primary/sidecar locator。
- 为 shared store 增加 focused tests，覆盖 directory fsync failure evidence
  与 checksum sidecar primaryDurableKind 不泄漏。

### 4. 回归验证缺非 catalog directory scope 覆盖

Result: FAIL

已有测试覆盖：

- catalog books.yaml status-json read-only checksum meta 缺失。
- catalog checksum meta backfill 成功事件。
- catalog checksum meta parent directory fsync failure。
- durable preflight。
- CLI durable directory fsync failure。
- schema closure。

但未发现针对 Type DD 非 catalog directory scope closure 的聚焦断言，例如：

- `graph_vault/settings.yaml` -> `graph_vault`
- `graph_vault/catalog/provider-requests/*.json`
- `graph_vault/catalog/batch-runs/{runId}/book-leases/*.json`
- `graph_vault/books/{bookId}/output/lancedb/*.lance/qmd_row_count.json`
- `graph_vault/output/lancedb/*.lance/qmd_row_count.json`

`rg` 只找到 catalog directory fsync failure 测试与 preflight target mapping
测试；未找到非 catalog directory fsync owner/lane 断言。

修复建议：

- 在 `test/cli.test.ts:2821` 附近新增参数化 directory fsync failure tests，
  使用 `QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN` 分别命中上述非
  catalog scope，并断言 `lane`、`targetMappingOwner`、
  `directoryDurableKind`、`primaryDurableKind`、`directoryTargetLocator`
  与 `completedPublishRule`。
- 在 `test/integrations/contracts.test.ts:1812` 的 schema closure fixture 中
  增加真实 directory fsync fields：`directoryTargetLocator`、
  `primaryTargetLocator` 或 `sidecarTargetLocator`、`sidecarKind`、
  `directoryDurableKind`、`primaryDurableKind`、`fsyncTarget`、
  `fsyncPlatform`、`fsyncErrno`。

## Passing Evidence

- runner directory scope table 覆盖 Type DD 主要目录 scope：
  `scripts/graphrag/batch-epub-workflow.mjs:453`
  到 `scripts/graphrag/batch-epub-workflow.mjs:529`。
- 裸目录 fsync 通过 `durableOperationEvidence(path, "directory-fsync")`
  进入显式 directory mapping：
  `scripts/graphrag/batch-epub-workflow.mjs:3359`
  到 `scripts/graphrag/batch-epub-workflow.mjs:3365`。
- 未映射生产目录 fail closed 为 `durable_target_mapping_missing`：
  `scripts/graphrag/batch-epub-workflow.mjs:2795`
  到 `scripts/graphrag/batch-epub-workflow.mjs:2813`。
- catalog checksum meta backfill 通过 `writeJsonAtomicSidecar` 写入 sidecar
  并 fsync parent directory：
  `scripts/graphrag/batch-epub-workflow.mjs:4925`
  到 `scripts/graphrag/batch-epub-workflow.mjs:4935`，
  `scripts/graphrag/batch-epub-workflow.mjs:4644`
  到 `scripts/graphrag/batch-epub-workflow.mjs:4660`。
- status-json catalog checksum meta 缺失测试断言无 mutation 且包含目录证据：
  `test/graphrag-runner-status-json-readonly.test.ts:251`
  到 `test/graphrag-runner-status-json-readonly.test.ts:308`。
- test hook 匹配 directory、primary、sidecar 与 fsync locator：
  `scripts/graphrag/batch-epub-workflow.mjs:3418`
  到 `scripts/graphrag/batch-epub-workflow.mjs:3441`。

## Verification Commands

未运行真实 EPUB batch runner。以下命令均为只读验证或聚焦测试。

| Command | Result |
|---|---|
| `node --check scripts/graphrag/batch-epub-workflow.mjs` | PASS |
| `npx vitest run test/graphrag-runner-status-json-readonly.test.ts` | PASS, 6 tests |
| `npx vitest run test/graphrag-runner-durable-preflight.test.ts` | PASS, 1 test |
| `npx vitest run test/integrations/contracts.test.ts -t "durable schema closure"` | PASS, 1 test selected |
| `npx vitest run test/cli.test.ts -t "directory fsync"` | PASS, 1 test selected |
| `npx vitest run test/cli.test.ts -t "durable target mapping"` | No matching selected tests; file skipped |
| `rg -n "providerRequestFingerprint\|settingsProjection\|artifactValidation\|graphOutputProducer\|QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN" test/...` | Found no non-catalog directory fsync failure assertions |

