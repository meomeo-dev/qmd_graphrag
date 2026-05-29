# Implementation Audit R5

结论：FAIL

审计基准仅使用
`audits/graphrag-book-yaml-rename-enoent-run_20260528_r1__open/agent-b/criteria.md`
固定 10 条。未修改 criteria，未修改源码，未运行真实 EPUB runner，未读取
`.env`。本轮仅新增本报告。

## 验证记录

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：通过。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：通过。
- `npm run test:types`：通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 120000 test/graphrag-runner-status-json-readonly.test.ts
  test/graphrag-runner-durable-preflight.test.ts`：通过，2 个测试文件、
  6 个测试用例通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 120000 test/book-job-state.test.ts -t
  "durable checksum|shared quarantine rename ENOENT"`：通过，1 个测试文件、
  3 个匹配用例通过，63 个用例跳过。

## 阻断项

### B1. focused schema-closure regression 仍未覆盖完整 durable payload

违反 criteria：10。影响 criteria：1、2、3、6 的可回归验证性。

文件与行号：

- `test/integrations/contracts.test.ts:194`
- `test/integrations/contracts.test.ts:222`
- `test/integrations/contracts.test.ts:274`
- `test/integrations/contracts.test.ts:301`
- `test/integrations/contracts.test.ts:1724`
- `test/cli.test.ts:1941`

问题：

`test/integrations/contracts.test.ts` 的 batch manifest、checkpoint、event 与
recovery summary fixtures 仍是 provider transient 示例。它们没有携带完整
durable evidence 字段，尤其没有覆盖：

- `primaryTargetLocator`
- `sidecarTargetLocator`
- `sidecarKind`
- `checksumExpected: null`
- `checksumActual`
- `checksumRecoveryDecision`
- `repairAllowed`
- `cleanupReason`
- `statusJsonDecision`
- `diagnosticClass`
- `evidenceIncomplete`
- `evidenceIncompleteReason`
- `unavailableFieldSentinels`

`test/integrations/contracts.test.ts:1724` 的 schema 测试确实解析了公开
contract schema，但断言范围停留在 `runningItems`、`retryable`、
`failedStage`、`retryAfterSeconds` 和 settings projection 字段。它不能证明
公开 contract schema 对完整 durable payload 的字段闭合（schema closure）。

`test/cli.test.ts:1941` 的批处理 schema 测试主要是源码字符串包含检查。它不能
证明完整 durable payload 同时通过公开 contract schema 与 runner 内部 zod
schema 后仍保留 null 与 sidecar/checksum/repair/incomplete 字段。

影响：

- 若公开 contract schema 删除某个 durable 字段，而 runner runtime 测试仍直接
  从 runner 输出断言字段，当前聚焦回归不一定失败。
- 若 runner 内部重复 schema 删除某个字段，而公开 contract 仍保留字段，当前
  contract fixture 也不能直接证明 parity。
- R4 已修复的 sidecar repair evidence 现在有 runtime 覆盖，但 criteria 10
  要求的 schema-closure focused regression 仍未闭合。

修复要求：

- 增加 focused schema-closure 测试，构造包含完整 durable evidence 的
  command check、item checkpoint、event、manifest `durableFailureSummary`、
  recovery summary item，以及 `durableStateFailures`、
  `durableTempDiagnostics`、`durableLockDiagnostics` 条目。
- 该 fixture 必须同时覆盖 `checksumExpected: null` 与非 null checksum，
  并断言 parse 后所有 sidecar、checksum、repair、cleanup、read-only
  diagnostic 与 incomplete evidence 字段仍保留。
- 用公开 `src/contracts/batch-run.ts` schema 解析上述 payload。
- 对 runner 内部 schema 增加等价 parity 验证。可选实现包括抽出共享 schema、
  增加只执行 schema parse 的 runner test hook，或通过 synthetic
  `--status-json` fixture 输出完整 durable diagnostics 后再用公开 schema
  解析并逐字段断言。

## 通过项

- Criteria 1：公开 contract schema 已声明 durable/status 所需主要字段，包括
  sidecar、checksum、cleanup、repair、incomplete evidence 与 status-json
  diagnostics。证据：`src/contracts/batch-run.ts:45`、
  `src/contracts/batch-run.ts:183`、`src/contracts/batch-run.ts:247`、
  `src/contracts/batch-run.ts:413`、`src/contracts/batch-run.ts:450`、
  `src/contracts/batch-run.ts:512`。
- Criteria 2：runner 内部 zod schema 与公开 schema 在本轮 durable 字段上保持
  同等声明，包含 `checksumExpected` nullable、`repairAllowed`、
  `cleanupReason`、sidecar 与 incomplete evidence 字段。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:614`、
  `scripts/graphrag/batch-epub-workflow.mjs:735`、
  `scripts/graphrag/batch-epub-workflow.mjs:955`、
  `scripts/graphrag/batch-epub-workflow.mjs:1090`、
  `scripts/graphrag/batch-epub-workflow.mjs:1126`、
  `scripts/graphrag/batch-epub-workflow.mjs:1193`。
- Criteria 3：`localDurableEvidence` 与 `durableProjection` 已投影 sidecar、
  checksum、fsync、repair、cleanup、status-json read-only 与 incomplete
  evidence 字段，并通过 `withoutUndefined` 保留 `checksumExpected: null`。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:2748`、
  `scripts/graphrag/batch-epub-workflow.mjs:2837`。
- Criteria 4：status-json durable diagnostics 保留 item/book/command scope、
  classification、recovery decision、read-only decision 与 redacted evidence。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:4449`、
  `scripts/graphrag/batch-epub-workflow.mjs:4488`、
  `scripts/graphrag/batch-epub-workflow.mjs:4537`、
  `scripts/graphrag/batch-epub-workflow.mjs:8991`。
- Criteria 5：`resume-book-workspace.mjs` 输出 typed durable failure envelope，
  并转发 shared durable store sidecar、checksum、repair、fsync 与 incomplete
  evidence；父 runner 优先解析 envelope，缺失字段 fail closed。证据：
  `scripts/graphrag/resume-book-workspace.mjs:120`、
  `scripts/graphrag/resume-book-workspace.mjs:1527`、
  `scripts/graphrag/batch-epub-workflow.mjs:2939`、
  `scripts/graphrag/batch-epub-workflow.mjs:2977`、
  `scripts/graphrag/batch-epub-workflow.mjs:3107`。
- Criteria 6：command check、event、checkpoint、manifest durable summary、
  status-json 与 recovery summary 均有 durable projection path。sidecar checksum
  repair fields 在 runtime 事件与 status-json/read-only tests 中保留。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:8768`、
  `scripts/graphrag/batch-epub-workflow.mjs:8960`、
  `scripts/graphrag/batch-epub-workflow.mjs:9606`、
  `scripts/graphrag/batch-epub-workflow.mjs:10791`。
- Criteria 7：`--status-json` read-only 路径不写 state root；聚焦测试断言
  snapshot before/after 相等、缺失 checksum meta 不被创建、无 lock/temp。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:3215`、
  `scripts/graphrag/batch-epub-workflow.mjs:3278`、
  `scripts/graphrag/batch-epub-workflow.mjs:5377`、
  `scripts/graphrag/batch-epub-workflow.mjs:6163`、
  `scripts/graphrag/batch-epub-workflow.mjs:6173`、
  `test/graphrag-runner-status-json-readonly.test.ts:250`。
- Criteria 8：before-claim、before-resume-book 与 runner-start preflight 从
  targetMapping/preflightScopes 派生扫描范围；runner-start 已对 item-derived
  book scopes 扫描。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:5298`、
  `scripts/graphrag/batch-epub-workflow.mjs:5325`、
  `scripts/graphrag/batch-epub-workflow.mjs:5377`、
  `scripts/graphrag/batch-epub-workflow.mjs:9929`、
  `scripts/graphrag/batch-epub-workflow.mjs:10537`、
  `scripts/graphrag/batch-epub-workflow.mjs:11354`、
  `test/graphrag-runner-durable-preflight.test.ts:113`。
- Criteria 9：checksum meta missing、invalid、conflict 与 rename ENOENT 已区分
  sidecar-only repair 与 primary-bundle quarantine，并在 evidence 中指明 primary
  与 sidecar。共享 durable store 与 runner writer 均包含完整 sidecar repair
  evidence。证据：`src/job-state/durable-state-store.ts:597`、
  `src/job-state/durable-state-store.ts:644`,
  `src/job-state/durable-state-store.ts:1522`,
  `src/job-state/durable-state-store.ts:1935`,
  `scripts/graphrag/batch-epub-workflow.mjs:4389`,
  `scripts/graphrag/batch-epub-workflow.mjs:4653`,
  `test/graphrag-runner-status-json-readonly.test.ts:367`,
  `test/graphrag-runner-status-json-readonly.test.ts:444`,
  `test/graphrag-runner-status-json-readonly.test.ts:523`,
  `test/book-job-state.test.ts:564`。

## 最终判定

FAIL。R4 后实现已修复 checksum meta 三态、sidecar-only boundary、rename
ENOENT evidence 字段、status-json read-only/repair-writer 稳定性、preflight
覆盖与 durable projection 的主要实现问题；但 criteria 10 要求的 focused
schema-closure regression 仍未闭合，不能签发 PASS。
