# Implementation Audit R1

结论：FAIL

审计对象：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/resume-book-workspace.mjs`
- `src/contracts/batch-run.ts`
- `src/job-state/durable-state-store.ts`
- `src/graphrag/settings-projection.ts`
- `src/index.ts`
- `test/cli.test.ts`
- `test/graphrag-runner-durable-preflight.test.ts`
- `test/graphrag-runner-status-json-readonly.test.ts`

本轮未修改源码，未重新执行测试；结论基于静态审计与既有验证背景。

## Findings

### 1. Status-json durable failure entry schema 未闭合

违反基准：1、2、4、6

证据：

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1360` 到 `1374`
  要求 status-json durable failure entry 保留 `itemId`、`bookId`、
  `activeCommand`、`retryable`、`completedPublishRule` 与 `repairAllowed`。
- `src/contracts/batch-run.ts:45` 到 `79` 的
  `DurableStateDiagnosticSchema` 没有 `itemId`、`bookId`、`activeCommand`
  或 `retryable`，也没有 `cleanupReason`。
- runner 内重复 schema `scripts/graphrag/batch-epub-workflow.mjs:614`
  到 `648` 同样缺少这些字段。
- `scripts/graphrag/batch-epub-workflow.mjs:4363` 到 `4381` 使用该
  diagnostic schema 解析 status-json durable diagnostics，因此这些字段即使
  上游存在也无法进入 `durableStateFailures`。

影响：

status-json 的 durable diagnostics 无法满足本地状态失败条目的身份闭合
（schema closure）。涉及 item/book/command 的 durable failure 会被迫依赖
`items[]` 或 metadata，而不是 `durableStateFailures` 条目的 typed fields。

建议修复：

将 `itemId`、`bookId`、`activeCommand`、`retryable`、`cleanupReason` 纳入
`DurableStateDiagnosticSchema`，并同步 runner 内部 schema。随后补充
status-json durable diagnostics 的 schema 测试。

### 2. `cleanupReason` 未进入通用 durable projection 与 recovery summary

违反基准：1、2、3、6

证据：

- 设计把 `cleanupReason` 列为 event/recovery 观测字段：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1233`。
- 公开 event schema 有 `cleanupReason`：
  `src/contracts/batch-run.ts:480`。
- 但公开 `DurableStateDiagnosticSchema`、`BatchCommandCheckSchema`、
  checkpoint schema、manifest durableFailureSummary 与
  `BatchRecoverySummaryItemSchema` 没有统一包含 `cleanupReason`
  （例如 `src/contracts/batch-run.ts:45` 到 `79`、
  `src/contracts/batch-run.ts:175` 到 `236`、
  `src/contracts/batch-run.ts:501` 到 `542`）。
- runner 的 `localDurableEvidence` 未投影 `cleanupReason`：
  `scripts/graphrag/batch-epub-workflow.mjs:2736` 到 `2784`。
- runner 的 `durableProjection` 也未读取 source 或 metadata 中的
  `cleanupReason`：`scripts/graphrag/batch-epub-workflow.mjs:2821`
  到 `2882`。
- preflight blocked event 仅把 cleanup reason 放入 metadata：
  `scripts/graphrag/batch-epub-workflow.mjs:5243` 到 `5249`。

影响：

durable temp recovery 或 unresolved temp preflight 的 cleanup cause 无法在
checkpoint、status-json durable diagnostics、manifest durableFailureSummary
与 recovery summary item 中稳定保留。后续自动恢复和人工诊断只能解析
event metadata，违反 typed observability closure。

建议修复：

把 `cleanupReason` 加入公开 contract、runner schema、`localDurableEvidence`、
`durableProjection`、checkpoint/command/recovery item 投影，并把 event
metadata 中的 cleanup reason 同步到 top-level typed field。

### 3. Shared durable store 与 resume-book envelope 会丢失 sidecar evidence

违反基准：1、3、5、6、9

证据：

- 设计要求 sidecar failure evidence 同时包含 `primaryTargetLocator`、
  `sidecarTargetLocator` 与 `sidecarKind`：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:247` 到 `252`。
- runner 自身的 checksum meta sidecar 写入会补充这些字段：
  `scripts/graphrag/batch-epub-workflow.mjs:4314` 到 `4325`。
- shared durable store 的 `writeJsonAtomicSidecar` 只用 sidecar path 创建
  operation evidence，没有 primary/sidecar 字段：
  `src/job-state/durable-state-store.ts:1173` 到 `1195`。
- shared store 的 `newOperationEvidence` 也只记录 `targetLocator`，没有
  `primaryTargetLocator`、`sidecarTargetLocator` 或 `sidecarKind`：
  `src/job-state/durable-state-store.ts:1767` 到 `1803`。
- `resume-book-workspace.mjs` 的 durable failure envelope 只转发部分字段，
  未转发 `primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind`、
  `checksumExpected`、`checksumActual`、`repairAllowed`、
  `evidenceIncomplete`、`evidenceIncompleteReason`、`unavailableFieldSentinels`、
  `fsyncTarget`、`fsyncErrno` 或 `fsyncPlatform`：
  `scripts/graphrag/resume-book-workspace.mjs:118` 到 `152`。

影响：

由 shared durable store 触发的 checksum meta sidecar rename ENOENT 或
sidecar repair failure，尤其是 `resume-book-workspace.mjs` 子进程内的
book-scoped YAML/JSON 写入，无法被父 runner 无损投影到 command check、
item checkpoint、event 与 recovery summary。该路径会削弱 sidecar-only
quarantine 边界，且可能让父进程只能看到不完整或非 sidecar-scoped 的错误。

建议修复：

在 shared durable store 中为 `.sha256` 与 `.sha256.meta.json` 构造显式
sidecar evidence，并在 `resume-book-workspace.mjs` envelope 白名单中加入
全部 durable diagnostic 字段。父 runner 的 envelope normalize 测试应覆盖
这些字段。

### 4. 聚焦测试未覆盖全部 schema closure 与 book-scoped status-json read-only

违反基准：8、10

证据：

- status-json read-only 聚焦测试覆盖了 `catalog/books.yaml` 缺失 checksum
  meta：`test/graphrag-runner-status-json-readonly.test.ts:219` 到 `271`。
- repair writer sidecar backfill、invalid meta quarantine 与 meta rename
  ENOENT 测试覆盖 catalog `books.yaml`：
  `test/graphrag-runner-status-json-readonly.test.ts:278` 到 `456`。
- before-claim book-scoped YAML checksum fault 覆盖 `books/{bookId}/runs/*.yaml`：
  `test/graphrag-runner-durable-preflight.test.ts:114` 到 `219`。
- nested book output temp preflight 覆盖 output JSON temp：
  `test/cli.test.ts:3464` 到 `3607`。
- 未见针对 `books/{bookId}/job.yaml`、
  `books/{bookId}/checkpoints.yaml`、`books/{bookId}/artifacts.yaml` 在
  `--status-json` 下 checksum meta missing/invalid/conflict 的只读不变性测试。
- 未见专门断言 `cleanupReason`、status-json durable failure required fields
  与 resume-book envelope sidecar fields 的 schema closure 测试。

影响：

当前测试能覆盖部分关键路径，但无法防止本报告前三项 schema/projection 漏洞
回归。尤其是 book-scoped YAML 的 status-json read-only 和 child envelope
sidecar evidence 仍缺少直接验收。

建议修复：

新增聚焦测试：

- `job.yaml`、`checkpoints.yaml`、`artifacts.yaml` 的 status-json
  checksum meta read-only fixtures。
- durable diagnostic schema accepts/rejects required status-json fields。
- resume-book typed envelope 保留 sidecar、fsync、repair 与 incomplete fields。
- recovery summary item/top-level diagnostics 保留 `cleanupReason`。

## Passing Evidence

- 公开 contract 和 runner schema 已覆盖多数 durable 字段，包括
  `evidenceIncomplete`、`evidenceIncompleteReason`、`unavailableFieldSentinels`、
  `repairAllowed`、`primaryTargetLocator`、`sidecarTargetLocator` 与
  `sidecarKind`：`src/contracts/batch-run.ts:45` 到 `79`、
  `scripts/graphrag/batch-epub-workflow.mjs:614` 到 `648`。
- runner 的 `localDurableEvidence` 与 `durableProjection` 已保留 sidecar、
  checksum、fsync、repair 与 incomplete evidence 的大部分字段：
  `scripts/graphrag/batch-epub-workflow.mjs:2736` 到 `2882`。
- status-json 入口整体遵守只读方向：`ensureDirs` 在 status-json 下不创建目录
  （`scripts/graphrag/batch-epub-workflow.mjs:4014` 到 `4039`），
  `writeTypedJson` 在 status-json 下 no-op
  （`scripts/graphrag/batch-epub-workflow.mjs:6002` 到 `6008`），
  typed reads 使用 read-only inspection
  （`scripts/graphrag/batch-epub-workflow.mjs:6018` 到 `6027`）。
- manifest/status/recovery-summary 在 status-json 下不写入：
  `scripts/graphrag/batch-epub-workflow.mjs:8658` 到 `8662`，
  `scripts/graphrag/batch-epub-workflow.mjs:8875` 到 `8878`。
- preflight 从 targetMapping 派生 scope，并在 before-claim 与
  before-resume-book 执行：
  `scripts/graphrag/batch-epub-workflow.mjs:5142` 到 `5177`、
  `scripts/graphrag/batch-epub-workflow.mjs:9740` 到 `9741`、
  `scripts/graphrag/batch-epub-workflow.mjs:10338` 到 `10339`。
- preflight scanner 覆盖 lock、temp、primary JSON 与 primary YAML：
  `scripts/graphrag/batch-epub-workflow.mjs:5099` 到 `5137`。

## Residual Risk

上述缺口集中在 schema 与投影闭包，而不是核心 durable write 原语本身。修复时
需要同步公开 contract、runner 内部 schema、shared durable store、child envelope
与聚焦测试；只改其中一层会继续造成观测面字段不一致。
