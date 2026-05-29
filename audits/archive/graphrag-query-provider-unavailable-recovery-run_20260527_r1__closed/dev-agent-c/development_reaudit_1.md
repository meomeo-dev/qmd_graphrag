# GraphRAG Query Provider Unavailable Recovery Development Reaudit 1

## 结论

PASS.

本次开发复审（development reaudit）确认上次 C 审计指出的两个问题已修复：
`stage=provider` 的 provider-not-configured 结构化错误不再被误归类为
transient provider wait；fresh transient provider recovery checkpoint 已写入
`providerRecoveryReason=transient_failure_recovered`。

同时确认 fresh run 中 `qmd_build_manifest.json` 在 qmd-native checks 之后、
GraphRAG query checks 之前落盘，状态投影（status projection）能够同时显示
`qmdBuildStatus.status=succeeded` 与
`graphQueryStatus.status=failed`。

阻塞问题：无。

## 范围

- 审计目录：
  `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open`
- 复审报告：
  `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/dev-agent-c/development_reaudit_1.md`
- 固定基准：`README.md` 的 10 条审计原则。
- 真实 runId：`epub-batch-20260527-real-resume-1`
- 真实失败书目：`Building Microservices (Sam Newman).epub`
- 限制：只读审计当前实现；未读取或输出 `.env` secret 值；未修改源代码。

## 关键复核结论

1. 上次阻塞项 `stage=provider` 误分类已修复。

   `scripts/graphrag/batch-failure-classifier.mjs:68` 到
   `scripts/graphrag/batch-failure-classifier.mjs:83` 现在要求
   `payload.stage === "graphrag_query"`、`provider=graphrag`、
   `capability=graph_query`、`code=provider_unavailable` 才进入
   transient override。`src/query/unified-router.ts:553` 到
   `src/query/unified-router.ts:563` 仍把 provider-not-configured 发为
   `stage=provider`、`retryable=false`，分类器边界与 runtime 语义一致。

2. fresh transient `providerRecoveryReason` 观测风险已补上。

   `scripts/graphrag/batch-epub-workflow.mjs:5229` 到
   `scripts/graphrag/batch-epub-workflow.mjs:5260` 的
   `buildRecoverableTransientCheckpoint` 写入
   `waitingForProviderRecovery=true` 和
   `providerRecoveryReason="transient_failure_recovered"`。
   `scripts/graphrag/batch-epub-workflow.mjs:4033` 到
   `scripts/graphrag/batch-epub-workflow.mjs:4085` 将该 metadata 投影到
   status JSON。

3. qmd build manifest 落盘顺序已满足本案要求。

   `scripts/graphrag/batch-epub-workflow.mjs:215` 到
   `scripts/graphrag/batch-epub-workflow.mjs:223` 将
   `qmd-query-auto-json` 与 `qmd-query-graphrag-json` 排除出
   qmd-native command check set。`scripts/graphrag/batch-epub-workflow.mjs:3337`
   到 `scripts/graphrag/batch-epub-workflow.mjs:3472` 使用该 qmd-native set
   写 `qmd_build_manifest.json`。`scripts/graphrag/batch-epub-workflow.mjs:5078`
   到 `scripts/graphrag/batch-epub-workflow.mjs:5103` 的执行顺序为：先跑
   qmd-native checks，随后 `writeQmdBuildManifest`，再执行
   `qmd-query-auto-json` 和 `qmd-query-graphrag-json`。

4. fresh-run 状态投影能表达 qmd succeeded / graph query failed。

   `test/cli.test.ts:10790` 到 `test/cli.test.ts:10992` 覆盖正常执行中
   GraphRAG query check 失败时的 manifest 与 status-json 行为，断言
   qmd manifest 不包含 graph query checks，checkpoint 与 status summary 均显示
   `qmdBuildStatus.status=succeeded`、`graphBuildStatus.status=succeeded`、
   `graphQueryStatus.status=failed`。

## 十条原则复审

1. **PASS - Retryability preserves structured provider error semantics.**

   结构化 GraphRAG query provider outage 仅在
   `stage=graphrag_query` 时被归为 transient；`stage=provider` 的
   provider-not-configured 保持 non-retryable。
   证据：`scripts/graphrag/batch-failure-classifier.mjs:68` 到
   `scripts/graphrag/batch-failure-classifier.mjs:83`；
   `src/query/unified-router.ts:553` 到 `src/query/unified-router.ts:563`；
   `test/cli.test.ts:2364` 到 `test/cli.test.ts:2399`。

2. **PASS - Transient upstream/provider failures do not become permanent without proof.**

   GraphRAG query provider runtime outage 与网络/provider token 会被归为
   `failureKind=transient`、`retryable=true`，并恢复为
   `recoveryDecision=retry_same_run_id`。
   证据：`scripts/graphrag/batch-failure-classifier.mjs:117` 到
   `scripts/graphrag/batch-failure-classifier.mjs:179`；
   `scripts/graphrag/batch-epub-workflow.mjs:3848` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3930`；
   `test/cli.test.ts:4155` 到 `test/cli.test.ts:4320`。

3. **PASS - Batch stage gates require book-scoped QMD build, command,
   GraphRAG build, and GraphRAG query evidence before completion.**

   completion gate 同时检查 qmd build、GraphRAG build、GraphRAG query evidence；
   任一 required evidence 不成功不会写 completed。
   证据：`scripts/graphrag/batch-epub-workflow.mjs:5149` 到
   `scripts/graphrag/batch-epub-workflow.mjs:5201`；
   `scripts/graphrag/batch-epub-workflow.mjs:5202` 到
   `scripts/graphrag/batch-epub-workflow.mjs:5227`。

4. **PASS - Failed required evidence must prevent completion and expose the exact failed stage.**

   `graphQueryEvidence` 对失败 GraphRAG query command 返回
   `status=failed`、`stage=<failed command name>`，`runItem` 将该 command check
   作为失败来源抛出。
   证据：`scripts/graphrag/batch-epub-workflow.mjs:3574` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3617`；
   `scripts/graphrag/batch-epub-workflow.mjs:5192` 到
   `scripts/graphrag/batch-epub-workflow.mjs:5200`。

5. **PASS - A stop-until-fixed decision must stop scheduling further books in the same writer process.**

   `shouldStopBatchAfterFailure` 对所有
   `failed + retryable=false + recoveryDecision=stop_until_fixed` 通用生效；
   调度循环在继续处理前检查该条件。
   证据：`scripts/graphrag/batch-epub-workflow.mjs:5408` 到
   `scripts/graphrag/batch-epub-workflow.mjs:5415`；
   `scripts/graphrag/batch-epub-workflow.mjs:5553` 到
   `scripts/graphrag/batch-epub-workflow.mjs:5563`；
   `test/cli.test.ts:6472` 到 `test/cli.test.ts:6633`。

6. **PASS - Orphaned runner recovery must preserve checkpoint identity and not corrupt adjacent book state.**

   checkpoint hydration 保留 source/book identity；orphaned running checkpoint
   只把本 checkpoint 恢复为 pending transient，不改写相邻书目。
   证据：`scripts/graphrag/batch-checkpoint-hydration.mjs:39` 到
   `scripts/graphrag/batch-checkpoint-hydration.mjs:47`；
   `scripts/graphrag/batch-epub-workflow.mjs:3790` 到
   `scripts/graphrag/batch-epub-workflow.mjs:3810`。

7. **PASS - Provider recovery must be observable in status JSON with retry timing and reason.**

   summary schema 暴露 `nextRetryAt`、`retryDelaySeconds`、
   `providerRecoveryWaitCount`、`maxProviderRecoveryWaits`、
   `providerRecoveryReason` 和 `waitingForProviderRecovery`。fresh transient
   checkpoint 与 legacy recovered checkpoint 均有 reason。
   证据：`src/contracts/batch-run.ts:221` 到
   `src/contracts/batch-run.ts:253`；
   `scripts/graphrag/batch-epub-workflow.mjs:4033` 到
   `scripts/graphrag/batch-epub-workflow.mjs:4085`；
   `scripts/graphrag/batch-epub-workflow.mjs:5229` 到
   `scripts/graphrag/batch-epub-workflow.mjs:5260`；
   `test/cli.test.ts:2481` 到 `test/cli.test.ts:2611`。

8. **PASS - Retrying a failed query must not rebuild unrelated successful artifacts unless lineage is stale.**

   qmd build manifest 在 GraphRAG query checks 前落盘；fresh failure projection
   保持 qmd 与 graph build succeeded，仅 graph query failed。该行为避免将 query
   provider outage 误解释为 qmd/graph build 失败。
   证据：`scripts/graphrag/batch-epub-workflow.mjs:5078` 到
   `scripts/graphrag/batch-epub-workflow.mjs:5103`；
   `test/cli.test.ts:10934` 到 `test/cli.test.ts:10991`。

9. **PASS - Docs and runbooks must describe the operator action for provider query outages.**

   runbook 记录结构化 GraphRAG query provider outage 的 transient 条件、
   `stage=provider` provider-not-configured 负例、same-runId 恢复和 status-json
   观测字段。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:199` 到
   `docs/operations/graphrag-epub-batch-runbook.md:253`；
   `docs/operations/graphrag-epub-batch-runbook.md:350` 到
   `docs/operations/graphrag-epub-batch-runbook.md:378`。

10. **PASS - Tests must pin retry classification and batch stop behavior for this case.**

    聚焦测试覆盖 structured provider retry classification、`stage=provider`
    负例、legacy status-json recovery、fresh transient reason、generic stop
    和 qmd manifest/query failure 投影。
    证据：`test/cli.test.ts:2241` 到 `test/cli.test.ts:2410`；
    `test/cli.test.ts:2481` 到 `test/cli.test.ts:2717`；
    `test/cli.test.ts:4155` 到 `test/cli.test.ts:4320`；
    `test/cli.test.ts:6472` 到 `test/cli.test.ts:6633`；
    `test/cli.test.ts:10790` 到 `test/cli.test.ts:10992`。

## 阻塞问题

无。

## 非阻塞风险

1. 真实历史 checkpoint 的 qmd build manifest 仍可能缺失。

   只读 status projection 对真实 run
   `epub-batch-20260527-real-resume-1` 显示
   `Building Microservices (Sam Newman).epub` 已恢复为
   `status=pending`、`failureKind=transient`、
   `recoveryDecision=retry_same_run_id`，但 `qmdBuildStatus.status=pending`、
   `reason=qmd_build_manifest_missing`。这是旧 run 在修复前未落盘
   `qmd_build_manifest.json` 的历史状态，不是当前 fresh-run 路径失败。
   当前实现和回归测试已证明后续 fresh write path 会在 GraphRAG query checks 前
   保留 qmd succeeded evidence。

2. status-json projection 中的 `nextRetryAt` 会随当前时间重新计算。

   legacy retry-exhausted transient 的只读恢复会重新投影 `nextRetryAt` 与
   `retryDelaySeconds`。这满足 operator observability，但审计对比时应断言字段存在
   和恢复决策，而不是固定时间戳。

## 已执行验证

分类器正负样例：

```bash
node --input-type=module - <<'NODE'
import { classifyFailure } from './scripts/graphrag/batch-failure-classifier.mjs';
const notConfigured = JSON.stringify({
  schemaVersion: '1.0.0',
  route: 'graphrag',
  stage: 'provider',
  provider: 'graphrag',
  capability: 'graph_query',
  code: 'provider_unavailable',
  retryable: false,
  redactedMessage: 'GraphRAG query provider is not configured.'
});
const runtimeOutage = JSON.stringify({
  schemaVersion: '1.0.0',
  route: 'graphrag',
  stage: 'graphrag_query',
  provider: 'graphrag',
  capability: 'graph_query',
  code: 'provider_unavailable',
  retryable: false,
  redactedMessage: 'GraphRAG query provider failed before returning a response.'
});
console.log(JSON.stringify({
  notConfigured: classifyFailure(notConfigured),
  runtimeOutage: classifyFailure(runtimeOutage),
}, null, 2));
NODE
```

结果：

```json
{
  "notConfigured": {
    "failureKind": "unknown",
    "retryable": false
  },
  "runtimeOutage": {
    "failureKind": "transient",
    "retryable": true
  }
}
```

语法检查：

```bash
node --check scripts/graphrag/batch-epub-workflow.mjs
node --check scripts/graphrag/batch-failure-classifier.mjs
node --check scripts/graphrag/batch-checkpoint-hydration.mjs
```

结果：全部通过。

聚焦 vitest：

```bash
npm exec vitest -- run test/cli.test.ts -t \
  "keeps transient and permanent provider recovery decisions typed|status-json starts transient retry budget at first failure|fail-fast transient failure persists recoverable pending checkpoint|status-json recovers GraphRAG query provider_unavailable as provider transient|normal run keeps qmd build succeeded when GraphRAG query check fails|generic stop-until-fixed failure stops before next book"
```

结果：

```text
test/cli.test.ts: 6 passed, 206 skipped
```

真实 runId 只读 status projection：

```bash
env -u OPENAI_API_KEY -u JINA_API_KEY -u OPENAI_BASE_URL -u JINA_API_BASE \
  node scripts/graphrag/batch-epub-workflow.mjs \
    --run-id epub-batch-20260527-real-resume-1 \
    --skip-dotenv \
    --status-json \
    --log-root /tmp/qmd-graphrag-status-reaudit-c
```

摘录结果：

```json
{
  "runId": "epub-batch-20260527-real-resume-1",
  "recoveryDecision": "retry_same_run_id",
  "retryableItemCount": 3,
  "item": {
    "status": "pending",
    "failureKind": "transient",
    "retryable": true,
    "retryExhausted": false,
    "recoveryDecision": "retry_same_run_id",
    "failedStage": "qmd-query-graphrag-json",
    "waitingForProviderRecovery": true,
    "providerRecoveryReason": "legacy_retry_exhausted_transient",
    "qmdBuildStatus": {
      "status": "pending",
      "reason": "qmd_build_manifest_missing"
    },
    "commandCheckStatus": {
      "status": "failed",
      "stage": "qmd-query-graphrag-json"
    },
    "graphBuildStatus": {
      "status": "succeeded",
      "stage": "query_ready"
    },
    "graphQueryStatus": {
      "status": "failed",
      "stage": "qmd-query-graphrag-json"
    }
  }
}
```

## 建议验证命令

```bash
node --check scripts/graphrag/batch-epub-workflow.mjs
node --check scripts/graphrag/batch-failure-classifier.mjs
node --check scripts/graphrag/batch-checkpoint-hydration.mjs
```

```bash
npm exec vitest -- run test/cli.test.ts -t \
  "keeps transient and permanent provider recovery decisions typed|status-json starts transient retry budget at first failure|fail-fast transient failure persists recoverable pending checkpoint|status-json recovers GraphRAG query provider_unavailable as provider transient|normal run keeps qmd build succeeded when GraphRAG query check fails|generic stop-until-fixed failure stops before next book"
```

```bash
env -u OPENAI_API_KEY -u JINA_API_KEY -u OPENAI_BASE_URL -u JINA_API_BASE \
  node scripts/graphrag/batch-epub-workflow.mjs \
    --run-id epub-batch-20260527-real-resume-1 \
    --skip-dotenv \
    --status-json \
    --log-root /tmp/qmd-graphrag-status-reaudit-c
```
