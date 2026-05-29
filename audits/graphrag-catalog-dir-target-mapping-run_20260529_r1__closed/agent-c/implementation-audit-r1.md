# GraphRAG Catalog Directory Target Mapping Implementation Audit R1

总体 verdict: FAIL

## 审计范围

- 固定基准：
  `audits/graphrag-catalog-dir-target-mapping-run_20260529_r1__open/agent-c/implementation-criteria-r1.md`
- Type DD：
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

## 主要结论

实现未完全满足固定 10 条实施基准。catalog checksum meta backfill 的主
路径已有覆盖，且现有聚焦测试通过；但目录 fsync evidence（directory
fsync evidence）仍存在 schema drift 与映射漂移风险，尤其是 read-only
诊断未投影完整 fsync sentinel 字段，checksum sidecar 派生 fsync 未完整
继承 sidecar evidence，shared durable store 与 runner 语义不完全一致。

## 发现

### F1. Status-json read-only 诊断未投影完整目录 fsync evidence

影响基准：1, 5, 6

证据：

- Type DD 要求 directory fsync evidence 保留 `fsyncTarget`、
  `fsyncPlatform`、`fsyncErrno`，且不可用时写入显式 sentinel：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:265`
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:279`
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:285`
- read-only 诊断的 baseDiagnostic 手工设置 `directoryTargetLocator`、
  `directoryDurableKind`、`primaryDurableKind`、locator 与 owner，但未设置
  `fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 或
  `unavailableFieldSentinels`：
  `scripts/graphrag/batch-epub-workflow.mjs:4774`
  `scripts/graphrag/batch-epub-workflow.mjs:4784`
  `scripts/graphrag/batch-epub-workflow.mjs:4798`
- missing checksum meta 诊断继承该 baseDiagnostic，因此同样缺少上述字段：
  `scripts/graphrag/batch-epub-workflow.mjs:4823`
  `scripts/graphrag/batch-epub-workflow.mjs:4832`

风险：

- `--status-json` 可以报告 checksum meta 缺失，但不能提供与真实目录 fsync
  failure 等价的 evidence closure。
- 下游 status-json、recovery summary 或审计消费方无法区分“未执行 fsync”
  与“字段丢失”。

修复建议：

- 在 `scripts/graphrag/batch-epub-workflow.mjs:4774` 附近将 read-only
  诊断改为复用目录 fsync evidence 生成逻辑，或新增只读 helper，例如
  `directoryFsyncProjectionEvidence(dirname(path), operation)`。
- 对 read-only 投影设置：
  `fsyncTarget: directoryTargetLocator`、
  `fsyncPlatform: process.platform` 或 `not_attempted_read_only`、
  `fsyncErrno: not_attempted_read_only`，
  并将 `fsyncErrno` 加入 `unavailableFieldSentinels`。
- 扩展 `test/graphrag-runner-status-json-readonly.test.ts:251` 附近断言，
  要求 missing checksum meta 诊断包含上述字段。

### F2. Read-only 目录 evidence 未使用同一 directory fsync scope mapping

影响基准：1, 6

证据：

- `inspectDurableSerializedTargetReadOnly` 使用 primary target mapping：
  `scripts/graphrag/batch-epub-workflow.mjs:4780`
- 随后直接把 primary mapping spread 到诊断：
  `scripts/graphrag/batch-epub-workflow.mjs:4784`
  `scripts/graphrag/batch-epub-workflow.mjs:4785`
- 目录 scope mapping 的独立表在：
  `scripts/graphrag/batch-epub-workflow.mjs:453`
  `scripts/graphrag/batch-epub-workflow.mjs:529`
- 裸目录 fsync 才会调用该目录表：
  `scripts/graphrag/batch-epub-workflow.mjs:2795`
  `scripts/graphrag/batch-epub-workflow.mjs:2825`

风险：

- 对 catalog/books.yaml 当前恰好一致；但对非 catalog scope 可能漂移。
  例如 `graph_vault/books/{bookId}/output/.../qmd_row_count.json` 的 primary
  mapping owner 是 `artifactValidation`，而 Type DD 的 recursive directory
  scope 是 book output family。
- read-only 与 repair writer 不再由同一目录 fsync mapping 推导，违反同一
  mapping（same mapping）要求。

修复建议：

- 在 `scripts/graphrag/batch-epub-workflow.mjs:4774` 附近调用目录 scope
  mapping，并显式合并 primary/sidecar locator，而不是只使用 primary
  mapping。
- 增加非 catalog read-only 投影测试，覆盖
  `graph_vault/books/{bookId}/output/lancedb/*.lance/qmd_row_count.json`、
  `graph_vault/output/lancedb/*.lance/qmd_row_count.json`、provider requests
  与 book leases。

### F3. Checksum sidecar 派生目录 fsync 未完整继承 sidecar evidence

影响基准：2, 5, 8

证据：

- runner checksum sidecar backfill 使用 checksum sidecar path 建 operation：
  `scripts/graphrag/batch-epub-workflow.mjs:5666`
  `scripts/graphrag/batch-epub-workflow.mjs:5671`
- 该 operation 未设置 `primaryTargetLocator`、`sidecarTargetLocator`、
  `sidecarKind`；后续 parent directory fsync 直接继承它：
  `scripts/graphrag/batch-epub-workflow.mjs:5683`
  `scripts/graphrag/batch-epub-workflow.mjs:5686`
- `directoryFsyncEvidence` 在 operation 缺少 primary locator 时会把
  `operation.targetLocator` 当作 primary locator：
  `scripts/graphrag/batch-epub-workflow.mjs:3367`
  `scripts/graphrag/batch-epub-workflow.mjs:3377`
- shared durable store 的 checksum backfill 也以 primary path 创建
  `"checksum"` operation，未把 checksum sidecar locator/kind 注入 fsync
  evidence：
  `src/job-state/durable-state-store.ts:1119`
  `src/job-state/durable-state-store.ts:1137`

风险：

- checksum sidecar 写入后的目录 fsync failure 可能没有 `sidecarTargetLocator`
  与 `sidecarKind: checksum`。
- `primaryTargetLocator` 可能错误指向 `.sha256` sidecar 或缺失，破坏
  primary/sidecar lineage。

修复建议：

- 在 `scripts/graphrag/batch-epub-workflow.mjs:5666` 附近创建 checksum
  sidecar operation 时加入：
  `primaryTargetLocator: relative(root, path)`、
  `primaryDurableKind: primaryDurableKindForPath(path)`、
  `sidecarTargetLocator: relative(root, checksumPath)`、
  `sidecarKind: "checksum"`。
- 在 `src/job-state/durable-state-store.ts:1119` 和同步路径
  `src/job-state/durable-state-store.ts:1145` 附近应用同等 evidence。
- 增加 checksum sidecar parent directory fsync failure 注入测试，不只覆盖
  checksum meta sidecar。

### F4. Shared durable store 与 runner 的目录 fsync evidence parity 不完整

影响基准：8

证据：

- shared store 只有 primary target mapping 表，没有与 runner 等价的目录
  fsync scope table：
  `src/job-state/durable-state-store.ts:58`
  `src/job-state/durable-state-store.ts:217`
- shared store `directoryFsyncEvidence` 直接使用传入绝对 path 作为
  `directoryTargetLocator` 与 `fsyncTarget`：
  `src/job-state/durable-state-store.ts:1651`
  `src/job-state/durable-state-store.ts:1668`
- runner 使用 project-relative locator：
  `scripts/graphrag/batch-epub-workflow.mjs:3359`
  `scripts/graphrag/batch-epub-workflow.mjs:3364`

风险：

- shared durable store 产生的 evidence 与 runner evidence 在 locator 语义上
  不兼容，难以被同一 batch contract、status-json 或 recovery consumer
  稳定消费。
- sidecar evidence 未见 `"primary"` 或 `"json-sidecar"` 泄漏到
  `primaryDurableKind`，但整体 parity 仍不满足。

修复建议：

- 在 `src/job-state/durable-state-store.ts` 增加 directory fsync scope mapping
  或 adapter，使其与 runner 的目录 scope、lane、owner 和 locator 规则一致。
- 对 `directoryTargetLocator`、`fsyncTarget`、`primaryTargetLocator`、
  `sidecarTargetLocator` 建立统一 locator 规范；若 shared store 保留绝对
  path，必须在 batch boundary 前转换为 project-relative locator。
- 增加 shared store 单元测试，断言 catalog、book output、shared output 与
  `.qmd` parent directory fsync evidence 与 runner 兼容。

### F5. 回归覆盖缺少非 catalog directory fsync scope 与完整 contract closure

影响基准：10

证据：

- catalog read-only、catalog checksum meta backfill、repair writer parent
  directory fsync failure 已覆盖：
  `test/graphrag-runner-status-json-readonly.test.ts:251`
  `test/graphrag-runner-status-json-readonly.test.ts:315`
  `test/graphrag-runner-status-json-readonly.test.ts:372`
- contract closure 测试存在，但 fixture 未包含 `directoryTargetLocator`、
  `directoryDurableKind`、`primaryDurableKind`、`fsyncTarget`、`fsyncPlatform`
  或 `fsyncErrno`：
  `test/integrations/contracts.test.ts:372`
  `test/integrations/contracts.test.ts:415`
  `test/integrations/contracts.test.ts:1812`
- 当前审计输入测试中未发现 provider requests、settings、book leases、
  book output lancedb、shared output lancedb 的 directory fsync evidence
  断言。

风险：

- 非 catalog scope 的映射回归可能无法被测试捕获。
- contract schema 可接受字段不等于字段在 command check、checkpoint、
  event、manifest、status-json 与 recovery summary 中被完整验证。

修复建议：

- 在 `test/cli.test.ts` 或新增聚焦测试中覆盖以下 parent directory fsync
  evidence：
  `graph_vault/settings.yaml` -> `graph_vault`、
  `graph_vault/catalog/provider-requests/*.json`、
  `graph_vault/catalog/batch-runs/{runId}/book-leases/*.json`、
  `graph_vault/books/{bookId}/output/lancedb/*.lance/qmd_row_count.json`、
  `graph_vault/output/lancedb/*.lance/qmd_row_count.json`。
- 在 `test/integrations/contracts.test.ts:372` 的 durable fixture 加入完整
  directory fsync closure 字段，并断言 command check、checkpoint、event、
  manifest、status-json diagnostic 与 recovery summary item 均保留这些字段。

## 固定基准逐项结果

1. Type DD 可追溯性：FAIL。实现覆盖 catalog 主路径，但 read-only、
   sidecar 与 shared store parity 未完整对应 Type DD。
2. 派生目录 fsync：FAIL。checksum sidecar 写入后的 parent directory fsync
   未完整继承 sidecar locator 与 sidecar kind。
3. 裸目录 fsync：PASS。runner 的裸 `fsyncDirectory` 通过显式目录 scope
   映射，未映射生产目录 fail closed 为
   `durable_target_mapping_missing`。
4. Catalog checksum meta backfill：PASS。catalog/books.yaml checksum meta
   repair 写入后使用 derived directory fsync，现有测试覆盖未再触发 missing
   target mapping。
5. Evidence 完整性：FAIL。status-json read-only diagnostic 缺少
   `fsyncTarget`、`fsyncPlatform`、`fsyncErrno` 与 unavailable sentinel。
6. Status-json read-only：FAIL。未写入 state 的行为通过；但目录证据未复用
   同一 directory fsync mapping，且缺少完整 fsync projection。
7. Contract schema closure：PASS。`src/contracts/batch-run.ts` 与 runner
   内部 schema 已接收目录 fsync closure 字段，并覆盖主要 batch contract
   形态；测试强度不足归入基准 10。
8. Shared durable store parity：FAIL。shared store 与 runner 的目录 scope
   mapping、locator 语义和 checksum sidecar fsync evidence 不完全一致。
9. Test hook 边界：PASS。目录 fsync 注入 hook 由
   `QMD_GRAPHRAG_ENABLE_TEST_HOOKS` 显式开启，可匹配 directory、primary、
   sidecar 与 fsync locator，未发现其改写生产 target mapping。
10. 回归验证：FAIL。缺少非 catalog directory fsync scope 与完整 contract
    closure 字段保留测试。

## 已运行验证命令

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
  - 结果：PASS
- `npm run test:types -- --pretty false`
  - 结果：PASS
- `npx vitest run test/graphrag-runner-status-json-readonly.test.ts test/graphrag-runner-durable-preflight.test.ts test/integrations/contracts.test.ts -t "durable schema closure|status-json durable read-only|durable preflight"`
  - 结果：PASS，8 passed，71 skipped
- `npx vitest run test/cli.test.ts -t "durable state classifier preserves local failure classes|directory fsync failure blocks completed publication with evidence|durable reconcile skips auxiliary sidecar targets"`
  - 结果：PASS，2 passed，253 skipped
- `git diff --check -- scripts/graphrag/batch-epub-workflow.mjs src/job-state/durable-state-store.ts src/contracts/batch-run.ts test/graphrag-runner-status-json-readonly.test.ts test/graphrag-runner-durable-preflight.test.ts test/cli.test.ts test/integrations/contracts.test.ts`
  - 结果：PASS

未运行真实 EPUB batch runner。
