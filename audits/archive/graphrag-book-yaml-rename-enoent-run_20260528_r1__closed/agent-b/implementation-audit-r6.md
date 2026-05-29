# Implementation Audit R6

结论：PASS。

审计基准仅使用
`audits/graphrag-book-yaml-rename-enoent-run_20260528_r1__open/agent-b/criteria.md`
固定 10 条。未修改 criteria，未修改源码，未读取 `.env`，未运行真实 EPUB
runner。运行的 runner 类测试均为聚焦测试或使用测试 hook/fake resume runner。

## R5 阻断项复核

R5 阻断项为缺少完整 durable payload schema-closure regression。R6 已补入
`test/integrations/contracts.test.ts` 的
`accepts durable schema closure payloads across batch contracts`，该用例使用公开
batch contract schemas 与 `DataBusEnvelopeSchema` 解析完整 durable payload，并断言
关键字段未被 schema strip：

- `checksumExpected: null` 在 `BatchCommandCheckSchema` 与嵌套 command check 中保留。
- `primaryTargetLocator`、`sidecarTargetLocator`、`sidecarKind`、checksum、
  repair、cleanup 与 incomplete evidence 字段跨 command check、checkpoint、
  event、manifest durable summary、recovery diagnostics/items 保留。
- `durableStateFailures` 保留 `statusJsonDecision:
  metadata_missing_read_only`。
- `durableTempDiagnostics` 覆盖非 null checksum expected。
- 四类 batch bus envelope 均通过 `DataBusEnvelopeSchema`。

证据：`test/integrations/contracts.test.ts:1812` 到
`test/integrations/contracts.test.ts:1895`。

## 逐项判定

1. Contract schema closure：PASS。
   `src/contracts/batch-run.ts` 的 `DurableStateDiagnosticSchema`、
   `BatchCommandCheckSchema`、`BatchItemCheckpointSchema`、event、manifest
   `durableFailureSummary`、recovery summary diagnostics/items 均包含 durable
   state/status 所需字段，包括 sidecar、checksum、repair、cleanup、status-json
   decision 与 incomplete evidence。证据：
   `src/contracts/batch-run.ts:45`、`:183`、`:285`、`:413`、`:450`、
   `:520`、`:676`。

2. Runner schema parity：PASS。
   `scripts/graphrag/batch-epub-workflow.mjs` 内部 zod schema 与公开 batch
   schema 在 durable 字段上保持同等闭合，包含 nullable
   `checksumExpected`、sidecar fields、`repairAllowed`、`cleanupReason` 与
   incomplete evidence。证据：`scripts/graphrag/batch-epub-workflow.mjs:615`、
   `:740`、`:965`、`:1091`、`:1145`、`:1215`、`:1357`。

3. Durable evidence projection：PASS。
   `localDurableEvidence` 与 `durableProjection` 保留 sidecar、checksum、
   fsync、repair、cleanup、status-json decision 与 incomplete evidence 字段；
   `checksumExpected: null` 通过 `withoutUndefined` 保留。证据：
   `scripts/graphrag/batch-epub-workflow.mjs:2749` 到 `:2801`、
   `:2838` 到 `:2905`。

4. Status-json durable diagnostics：PASS。
   status-json diagnostics 使用 `DurableStateDiagnosticSchema` 解析，并保留
   item/book/command scope、classification、recovery/read-only decision、
   sidecar locator 与 redacted evidence。证据：
   `scripts/graphrag/batch-epub-workflow.mjs:4496` 到 `:4581`、
   `:4584` 到 `:4665`、`:9038` 到 `:9084`。

5. Child process durable envelope：PASS。
   `resume-book-workspace.mjs` 发出 typed durable failure envelope，包含 shared
   durable store evidence；父 runner 优先解析 envelope，缺失或 malformed
   envelope fail closed 为 incomplete evidence，而不是退回文本分类。证据：
   `scripts/graphrag/resume-book-workspace.mjs:120` 到 `:181`、`:1527` 到
   `:1534`，以及 `scripts/graphrag/batch-epub-workflow.mjs:2940` 到
   `:3133`、`:9610` 到 `:9631`。

6. Recovery/event field preservation：PASS。
   command check、event、checkpoint、manifest durable summary、status-json 与
   recovery summary 均通过 durable projection 写入/汇总 durable failure 字段。
   证据：`scripts/graphrag/batch-epub-workflow.mjs:9653` 到 `:9708`、
   `:8815` 到 `:8828`、`:8963` 到 `:8968`、`:9038` 到 `:9084`。

7. Status-json read-only behavior：PASS。
   `--status-json` 路径只读检查 durable serialized targets，不执行修复写入；
   聚焦测试断言缺失 checksum meta 不被创建且 state snapshot 不变。证据：
   `scripts/graphrag/batch-epub-workflow.mjs:4584` 到 `:4665`，
   `test/graphrag-runner-status-json-readonly.test.ts:251`。

8. Durable preflight coverage：PASS。
   target mapping 声明 book-scoped YAML、catalog、batch run、output、temp/lock
   扫描范围；preflight 扫描 lock、temp、JSON/YAML primary，并在 runner-start、
   before-claim、before-resume-book 执行。证据：
   `scripts/graphrag/batch-epub-workflow.mjs:240` 到 `:451`、
   `:5302` 到 `:5377`、`:9976`、`:10584`、`:11401` 到 `:11403`。

9. Sidecar repair boundary：PASS。
   checksum meta missing、invalid、conflict 与 rename ENOENT 区分
   sidecar-only 与 primary-bundle 处理，evidence 指明 primary 与 sidecar。
   证据：`scripts/graphrag/batch-epub-workflow.mjs:4436` 到 `:4451`、
   `:4700` 到 `:4778`、`:4804` 到 `:4827`；
   `test/graphrag-runner-status-json-readonly.test.ts:310`、`:367`、`:444`、
   `:523`。

10. Focused regression coverage：PASS。
    覆盖 schema closure、status-json read-only、sidecar failure fields、
    incomplete envelope、recovery summary projection 与 book-scoped YAML
    preflight。证据：`test/integrations/contracts.test.ts:1812`、
    `test/graphrag-runner-status-json-readonly.test.ts:250`、
    `test/graphrag-runner-durable-preflight.test.ts:113`、
    `test/cli.test.ts:4055` 到 `:4198`。

## 验证命令

- `npx vitest run test/integrations/contracts.test.ts -t
  "batch execution bus envelopes|durable schema closure" --reporter=verbose`
  ：通过，1 个测试文件，2 个用例通过，70 个跳过。
- `npm run test:types -- --pretty false`
  ：通过。
- `npx vitest run test/graphrag-runner-status-json-readonly.test.ts
  test/graphrag-runner-durable-preflight.test.ts --reporter=verbose`
  ：通过，2 个测试文件，6 个用例通过。
- `npx vitest run test/cli.test.ts -t
  "partial durable subprocess envelope fails closed|malformed durable subprocess
  envelope fails closed|missing durable subprocess envelope fails closed"
  --reporter=verbose`
  ：通过，1 个测试文件，3 个用例通过，252 个跳过。

## 剩余风险

无阻断项。需要注意的是，Zod object 默认会 strip unknown fields，因此
schema-closure 回归必须继续保持逐字段断言；仅断言 parse 成功不足以证明字段
保留。本轮 R6 新增测试已对 R5 缺口中的关键字段进行显式断言。

## 最终判定

PASS。
