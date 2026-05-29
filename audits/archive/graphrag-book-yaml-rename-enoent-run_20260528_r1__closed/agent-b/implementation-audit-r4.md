# Implementation Audit R4

结论：FAIL

审计基准仅使用
`audits/graphrag-book-yaml-rename-enoent-run_20260528_r1__open/agent-b/criteria.md`
固定 10 条。未修改 criteria，未修改源码，未运行真实 EPUB runner，未读取
`.env`。

## 已执行验证

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：通过。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：通过。
- `npm run test:types`：通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-runner-status-json-readonly.test.ts
  test/graphrag-runner-durable-preflight.test.ts`：通过，2 个测试文件、
  5 个测试用例通过。

## 阻断项

### B1. checksum meta sidecar 写入/rename ENOENT 证据字段不完整

违反 criteria：3、6、9、10。

文件与行号：

- `scripts/graphrag/batch-epub-workflow.mjs:4385`
- `scripts/graphrag/batch-epub-workflow.mjs:4638`
- `scripts/graphrag/batch-epub-workflow.mjs:4674`
- `scripts/graphrag/batch-epub-workflow.mjs:4734`
- `src/job-state/durable-state-store.ts:1171`
- `src/job-state/durable-state-store.ts:1195`
- `src/job-state/durable-state-store.ts:1336`

问题：

runner 的 `writeJsonAtomicSidecar` 只把
`primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind` 放入
`.sha256.meta.json` sidecar operation evidence。后续
`renameWithDurableEvidence` 失败时，`DurableStateError.evidence` 只继承该
operation，缺少 `checksumExpected`、`checksumActual`、
`checksumRecoveryDecision`、`repairAllowed`。

runner 的 `checksumMetaSidecarEvidence` 包含 checksum 与 sidecar locator，
但没有设置 `repairAllowed: true`。因此
`durable_checksum_meta_sidecar_quarantined`、`durable_checksum_meta_backfilled`
以及 sidecar rename ENOENT 的恢复证据都不能完整表达 writer repair 决策。

共享 store 也存在同类缺口。`writeChecksumMeta` 生成的 value 有
`checksumRecoveryDecision`，但 `writeJsonAtomicSidecar` 的 rename operation
只接收 `sidecarEvidence(path)`。如果 checksum meta backfill 或 repair 写入
期间发生 rename ENOENT，错误证据同样缺少 checksum 与 repair 字段。

影响：

- sidecar-only repair 与 primary-bundle failure 的边界无法在 recovery evidence
  中完整判定。
- command check、event、manifest durableFailureSummary、status-json 与
  recovery summary 即使调用 `durableProjection`，也只能投影已有字段，无法补回
  缺失的 `checksumActual/checksumRecoveryDecision/repairAllowed`。
- 现有 rename ENOENT 聚焦测试只断言 primary/sidecar locator 与 sidecarKind，
  未阻止该证据退化。

修复要求：

- 为 checksum meta missing、invalid、conflict、backfill、repair 和
  `.sha256.meta.json` rename ENOENT 统一生成完整 sidecar repair evidence：
  `primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind`、
  `checksumExpected`、`checksumActual`、`checksumRecoveryDecision`、
  `repairAllowed`。
- status-json 只读诊断保持 `repairAllowed: false`；writer backfill/repair
  路径必须显式记录 `repairAllowed: true`。
- 确保上述 evidence 进入 `DurableStateError.evidence`，再由
  `localDurableEvidence`、`durableProjection`、command check、event、
  manifest durableFailureSummary、status-json 与 recovery summary 无损保留。

### B2. focused regression coverage 未覆盖 schema closure 与 conflict 字段闭合

违反 criteria：10，并影响 criteria 1、2、3、6、9 的可验证性。

文件与行号：

- `test/graphrag-runner-status-json-readonly.test.ts:218`
- `test/graphrag-runner-status-json-readonly.test.ts:329`
- `test/graphrag-runner-status-json-readonly.test.ts:395`
- `test/cli.test.ts:1941`
- `test/integrations/contracts.test.ts:1724`

问题：

现有聚焦测试覆盖了 status-json read-only、checksum meta missing、invalid、
metadata backfill、rename ENOENT、incomplete envelope、recovery summary
projection 与 book-scoped YAML preflight 的部分路径，但仍有关键缺口：

- 未发现 `durable_checksum_meta_conflict` 的测试覆盖。
- runner rename ENOENT 测试未断言 `checksumExpected`、`checksumActual`、
  `checksumRecoveryDecision`、`repairAllowed`。
- invalid sidecar-only repair 测试未断言 `repairAllowed`。
- schema closure 主要依赖字符串包含测试，未用公开 contract schema 与 runner
  内部 schema 对含完整 durable 字段的 payload 做解析闭合验证。

修复要求：

- 增加 checksum meta conflict fixture，断言只 quarantine/repair meta sidecar，
  primary YAML/JSON 不被 quarantine，并断言完整 evidence 字段。
- 增加 sidecar rename ENOENT fixture，断言错误事件、checkpoint、manifest
  durableFailureSummary、status-json durableStateFailures 与 recovery summary
  都保留完整 checksum/sidecar/repair 字段。
- 增加 schema closure 测试，用完整 durable diagnostic、command check、event、
  checkpoint、manifest durableFailureSummary 与 recovery summary payload 同时
  验证公开 contract schema 与 runner 内部 schema。

## 通过项

- Contract 与 runner 内部 zod schema 均已声明主要 durable 字段，包括 sidecar、
  checksum、cleanup、repair、incomplete evidence 与 status-json diagnostic
  字段。
- `localDurableEvidence` 与 `durableProjection` 已列出 sidecar、checksum、fsync、
  repair、cleanup 与 incomplete evidence 字段；当前缺口来自上游 evidence
  生成不完整。
- status-json 路径在当前聚焦测试中保持只读，不创建 lock/temp/checksum meta，
  且 read-only diagnostic 保留 `repairAllowed: false`。
- before-claim、before-resume-book、runner-start preflight 均调用 targetMapping
  派生扫描范围；聚焦测试覆盖了 book-scoped YAML preflight。

## 最终判定

FAIL。R3 后实现尚未满足 checksum meta sidecar repair/rename ENOENT 的完整
evidence 合同，也缺少能锁定这些字段的 focused regression coverage。
