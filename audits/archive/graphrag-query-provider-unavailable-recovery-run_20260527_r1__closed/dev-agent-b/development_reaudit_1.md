# GraphRAG Query Provider Unavailable Recovery Development Reaudit 1

## 结论

PASS。

阻塞项：无。

本轮复审确认上次阻塞项 B-1 已修复：当前
`scripts/graphrag/batch-failure-classifier.mjs` 只把 structured GraphRAG
query failure 中 `stage=graphrag_query`、`provider=graphrag`、
`capability=graph_query`、`code=provider_unavailable` 的 payload 判为
transient；`stage=provider` 且 message 为
`GraphRAG query provider is not configured.` 的 provider-not-configured
payload 不进入 provider recovery wait。

新增 qmd build manifest 运行期回归、`providerRecoveryReason` 观测补丁、
same-writer `stop_until_fixed` 泛化停止、status-json provider recovery
投影和真实 runId 恢复投影均满足 README.md 固定 10 条基准。

未读取或输出 `.env` secret 值。真实 runId 验证使用 `--skip-dotenv`。

## 审计范围

固定基准：

- `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/README.md`

审计记录：

- `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/implementation_summary.md`
- `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/agent-a/design_audit.md`
- `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/agent-b/design_audit.md`
- `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/agent-c/design_audit.md`
- `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/dev-agent-b/development_audit.md`

实现、测试、文档：

- `scripts/graphrag/batch-failure-classifier.mjs`
- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/query/unified-router.ts`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/operations/graphrag-epub-resume-boost.md`

真实 runId 只读观测：

- `epub-batch-20260527-real-resume-1`
- 目标 item：`item-2d1d667301e9-095a11e7`

## 只读验证结果

分类边界探针：

```bash
node --input-type=module <<'NODE'
import { classifyFailure } from './scripts/graphrag/batch-failure-classifier.mjs';
const query = {
  schemaVersion: '1.0.0',
  route: 'graphrag',
  stage: 'graphrag_query',
  provider: 'graphrag',
  capability: 'graph_query',
  code: 'provider_unavailable',
  retryable: false,
  redactedMessage: 'GraphRAG query provider failed before returning a response.',
};
const provider = {
  schemaVersion: '1.0.0',
  route: 'graphrag',
  stage: 'provider',
  provider: 'graphrag',
  capability: 'graph_query',
  code: 'provider_unavailable',
  retryable: false,
  redactedMessage: 'GraphRAG query provider is not configured.',
};
console.log(JSON.stringify({
  query: classifyFailure(JSON.stringify(query, null, 2)),
  provider: classifyFailure(JSON.stringify(provider, null, 2)),
}, null, 2));
NODE
```

结果：

```json
{
  "query": {
    "failureKind": "transient",
    "retryable": true
  },
  "provider": {
    "failureKind": "unknown",
    "retryable": false
  }
}
```

语法检查：

```bash
node --check scripts/graphrag/batch-failure-classifier.mjs
node --check scripts/graphrag/batch-checkpoint-hydration.mjs
node --check scripts/graphrag/batch-epub-workflow.mjs
```

结果：通过。

聚焦回归：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run test/cli.test.ts \
  --reporter=verbose \
  --testTimeout 60000 \
  --testNamePattern \
  "keeps transient and permanent provider recovery decisions typed|\
status-json recovers GraphRAG query provider_unavailable as provider transient|\
normal run keeps qmd build succeeded when GraphRAG query check fails|\
generic stop-until-fixed failure stops before next book|\
fail-fast transient failure persists recoverable pending checkpoint|\
status-json projects transient failures as provider recovery wait"
```

结果：`5 passed | 207 skipped`。

真实 runId 只读 status-json 投影：

```bash
node scripts/graphrag/batch-epub-workflow.mjs \
  --source-dir 'inbox/软件工程与系统设计经典著作指南' \
  --state-root graph_vault \
  --log-root outputs/qmd-epub-batch-20260527-real-resume-1 \
  --config .qmd/index.yml \
  --qmd-index-path .qmd/index.sqlite \
  --run-id epub-batch-20260527-real-resume-1 \
  --skip-dotenv \
  --status-json
```

解析目标 item 后结果：

```json
{
  "recoveryDecision": "retry_same_run_id",
  "retryableItemCount": 3,
  "target": {
    "status": "pending",
    "failureKind": "transient",
    "retryable": true,
    "retryExhausted": false,
    "recoveryDecision": "retry_same_run_id",
    "failedStage": "qmd-query-graphrag-json",
    "waitingForProviderRecovery": true,
    "providerRecoveryReason": "legacy_retry_exhausted_transient",
    "hasNextRetryAt": true,
    "retryDelaySeconds": 300,
    "qmdBuildStatus": "pending",
    "graphBuildStatus": "succeeded",
    "graphQueryStatus": "failed"
  }
}
```

`qmdBuildStatus=pending` 是该历史 checkpoint 在修复前没有写入
`qmd_build_manifest.json` 的遗留状态。当前运行期回归已证明未来的
GraphRAG query failure 会在 graph query checks 之前持久化 qmd-native build
manifest，因此该遗留观测不是阻塞项。

## B-1 复核

Result: PASS。

证据：

- `scripts/graphrag/batch-failure-classifier.mjs:68-82`：
  `classifyTypedQueryFailure` 解析 typed query JSON 后，只有同时满足
  `provider=graphrag`、`stage=graphrag_query`、
  `capability=graph_query`、`code=provider_unavailable` 时才返回
  `{ failureKind: "transient", retryable: true }`。
- `src/query/unified-router.ts:553-563`：provider 未配置仍输出
  `stage=provider`、`code=provider_unavailable`、`retryable=false`、
  `redactedMessage="GraphRAG query provider is not configured."`。
- 直接分类探针确认 `stage=provider` provider-not-configured payload 返回
  `failureKind=unknown`、`retryable=false`，不会满足 provider recovery wait
  所需的 `pending/transient/retry_same_run_id` 条件。
- `test/cli.test.ts:2364-2399` 同时固定本案 `stage=graphrag_query`
  正例和 `stage=provider` provider-not-configured 负例。
- `docs/operations/graphrag-epub-batch-runbook.md:246-252` 和
  `docs/operations/graphrag-epub-resume-boost.md:295-297` 已把该边界写入
  operator 文档。

## 固定原则评估

1. Retryability preserves structured provider error semantics.

   Result: PASS。

   batch classifier 已把 structured provider semantics 作为优先分类输入。
   本案 `stage=graphrag_query` GraphRAG query provider outage 被恢复为
   transient；`stage=provider` provider-not-configured 保持 non-retryable。
   该边界由实现、测试和文档共同固定。

2. Transient upstream/provider failures do not become permanent without proof.

   Result: PASS。

   `classifyFailure` 现在能从 typed JSON 中识别本案 provider outage。
   `batch-checkpoint-hydration.mjs:135-238` 会用当前 classifier 重分类 legacy
   failed command checks 和 checkpoint failure text；旧
   `failed/unknown/retryable=false/stop_until_fixed` checkpoint 可投影为
   `pending/transient/retry_same_run_id`。真实 runId 只读 status-json 已验证目标
   item 恢复为 pending transient provider wait。

3. Batch stage gates require book-scoped QMD build, command, GraphRAG build,
   and GraphRAG query evidence before completion.

   Result: PASS。

   completion gate 仍要求 qmd build evidence、完整 command check set、
   GraphRAG build evidence 和 GraphRAG query evidence 全部成功后才允许
   `completed`。新增 qmd build manifest 逻辑把 qmd-native checks 与 graph query
   checks 分离：`scripts/graphrag/batch-epub-workflow.mjs:215-223` 定义
   graph query check 子集与 qmd-native 子集，
   `scripts/graphrag/batch-epub-workflow.mjs:304-324` 允许 qmd build manifest
   记录 qmd-native set 或 legacy full set，
   `scripts/graphrag/batch-epub-workflow.mjs:3392-3471` 写入 qmd build
   manifest，`scripts/graphrag/batch-epub-workflow.mjs:5025-5103` 在
   graph query checks 前持久化该 manifest。
   `test/cli.test.ts:10790-10992` 固定运行期回归。

4. Failed required evidence must prevent completion and expose the exact failed
   stage.

   Result: PASS。

   本案失败 stage 仍精确暴露为 `qmd-query-graphrag-json`。status-json
   恢复回归断言 `failedStage`、`commandCheckStatus.stage` 和
   `graphQueryStatus.stage` 均为该 stage（`test/cli.test.ts:4155-4321`）。
   qmd build manifest 回归也断言 query failure 后 item 不会 completed，
   且 graph query status 保持 failed（`test/cli.test.ts:10947-10991`）。

5. A stop-until-fixed decision must stop scheduling further books in the same
   writer process.

   Result: PASS。

   `scripts/graphrag/batch-epub-workflow.mjs:5408-5415` 将停止条件泛化为
   `failed + retryable=false + recoveryDecision=stop_until_fixed`。
   主循环在处理前扫描 stop checkpoint
   （`scripts/graphrag/batch-epub-workflow.mjs:5553-5562`），并在新失败后停止
   当前 writer（`scripts/graphrag/batch-epub-workflow.mjs:6103-6109`）。
   `test/cli.test.ts:6472-6633` 断言 generic stop-until-fixed failure 不会启动
   第二本书。

6. Orphaned runner recovery must preserve checkpoint identity and not corrupt
   adjacent book state.

   Result: PASS。

   `scripts/graphrag/batch-checkpoint-hydration.mjs:39-47` 保留
   `sourceIdentityPath`、`sourceHash`、`normalizedPath` 和 `bookId`。
   `scripts/graphrag/batch-epub-workflow.mjs:3790-3830` 只把 orphaned running
   checkpoint 投影为 `pending/transient/retry_same_run_id`，并记录 runner host、
   pid、heartbeat 和 detected time。真实 runId 只读 status-json 投影未发现目标
   item 与相邻 running/orphan item 身份混淆。

7. Provider recovery must be observable in status JSON with retry timing and
   reason.

   Result: PASS。

   `scripts/graphrag/batch-epub-workflow.mjs:3848-3910` 的 legacy/current
   provider transient recovery 会写入 `waitingForProviderRecovery`、
   `nextRetryAt`、`retryDelaySeconds`、`providerRecoveryWaitCount`、
   `maxProviderRecoveryWaits` 和 `providerRecoveryReason`。
   `scripts/graphrag/batch-epub-workflow.mjs:4033-4076` 在 status-json summary
   中投影这些字段。fresh transient path 也写入
   `providerRecoveryReason=transient_failure_recovered`
   （`scripts/graphrag/batch-epub-workflow.mjs:5229-5260`）。retry budget/provider
   wait path 写入 `transient_retry_budget_window_elapsed` 或
   `provider_recovery_wait_limit_reached`
   （`scripts/graphrag/batch-epub-workflow.mjs:5967-5999`）。
   相关断言见 `test/cli.test.ts:2560-2610`、
   `test/cli.test.ts:2670-2707`、`test/cli.test.ts:3978-4012` 和
   `test/cli.test.ts:4155-4321`。

8. Retrying a failed query must not rebuild unrelated successful artifacts
   unless lineage is stale.

   Result: PASS。

   本案真实 status-json 目标 item 保持 `graphBuildStatus=succeeded`、
   `graphQueryStatus=failed`，恢复决策为 same-run retry。当前 qmd build manifest
   运行期回归证明 query failure 后 qmd-native build evidence 会保留为 succeeded，
   graph query failure 只影响 graph query status，不会把已成功的 qmd/native checks
   或 GraphRAG build evidence 误标为 completed 或 stale。
   历史真实 item 的 `qmdBuildStatus=pending` 是修复前未写 manifest 的遗留状态，
   已列入非阻塞风险。

9. Docs and runbooks must describe the operator action for provider query
   outages.

   Result: PASS。

   `docs/operations/graphrag-epub-batch-runbook.md:246-252` 明确
   `stage=graphrag_query` `provider_unavailable` 进入 provider recovery wait，
   `stage=provider` provider-not-configured 不进入 wait。
   `docs/operations/graphrag-epub-batch-runbook.md:362-378` 描述 status-json
   期望观测面和通用 `stop_until_fixed` writer 停止门。
   `docs/operations/graphrag-epub-resume-boost.md:279-297` 记录本案结构化签名、
   transient 重分类语义和 provider-not-configured 分流规则。

10. Tests must pin retry classification and batch stop behavior for this case.

    Result: PASS。

    `test/cli.test.ts:2364-2399` 固定 B-1 正负分类边界。
    `test/cli.test.ts:4155-4321` 固定 legacy failed checkpoint 的
    status-json provider recovery 投影。
    `test/cli.test.ts:10790-10992` 固定 qmd build manifest 在 graph query
    failure 前持久化的运行期回归。
    `test/cli.test.ts:6472-6633` 固定 generic stop-until-fixed 不启动后续图书。
    `test/cli.test.ts:2560-2610` 和 `test/cli.test.ts:2670-2707` 固定
    `providerRecoveryReason=transient_failure_recovered`。

## 阻塞问题

无。

## 非阻塞风险

1. 真实历史目标 item 的 `qmdBuildStatus` 仍为 `pending`，因为失败发生在本次
   qmd build manifest 提前持久化补丁之前。当前回归已覆盖未来运行，但第一次真实
   续跑仍可能重复部分 qmd-native 检查来补齐 manifest。该风险不允许 false
   completed，也不要求重建已成功的 GraphRAG high-cost artifacts，除非 lineage stale。

2. provider-not-configured 目前已有 direct classifier 负例和文档约束，但还没有
   一个完整 status-json fixture 直接断言 `stage=provider` provider-not-configured
   不会投影为 provider recovery wait。建议补充该负例，以防未来 hydration 或 summary
   路径绕过 classifier 边界。

3. `classifyTypedQueryFailure` 对 `payload.retryable === true` 的 typed payload
   仍统一判 transient。该规则依赖上游 typed error 只在真实可恢复错误上设置
   `retryable=true`。建议后续增加 auth/config/schema 类 typed payload 的负例表格测试。

## 建议验证命令

分类边界：

```bash
node --input-type=module <<'NODE'
import { classifyFailure } from './scripts/graphrag/batch-failure-classifier.mjs';
const query = {
  schemaVersion: '1.0.0',
  route: 'graphrag',
  stage: 'graphrag_query',
  provider: 'graphrag',
  capability: 'graph_query',
  code: 'provider_unavailable',
  retryable: false,
  redactedMessage: 'GraphRAG query provider failed before returning a response.',
};
const provider = {
  schemaVersion: '1.0.0',
  route: 'graphrag',
  stage: 'provider',
  provider: 'graphrag',
  capability: 'graph_query',
  code: 'provider_unavailable',
  retryable: false,
  redactedMessage: 'GraphRAG query provider is not configured.',
};
console.log(JSON.stringify({
  query: classifyFailure(JSON.stringify(query, null, 2)),
  provider: classifyFailure(JSON.stringify(provider, null, 2)),
}, null, 2));
NODE
```

语法和类型：

```bash
node --check scripts/graphrag/batch-failure-classifier.mjs
node --check scripts/graphrag/batch-checkpoint-hydration.mjs
node --check scripts/graphrag/batch-epub-workflow.mjs
npm run test:types
git diff --check
```

聚焦回归：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run test/cli.test.ts \
  --reporter=verbose \
  --testTimeout 60000 \
  --testNamePattern \
  "keeps transient and permanent provider recovery decisions typed|\
status-json recovers GraphRAG query provider_unavailable as provider transient|\
normal run keeps qmd build succeeded when GraphRAG query check fails|\
generic stop-until-fixed failure stops before next book|\
fail-fast transient failure persists recoverable pending checkpoint|\
status-json projects transient failures as provider recovery wait"
```

真实 runId 只读状态投影：

```bash
node scripts/graphrag/batch-epub-workflow.mjs \
  --source-dir 'inbox/软件工程与系统设计经典著作指南' \
  --state-root graph_vault \
  --log-root outputs/qmd-epub-batch-20260527-real-resume-1 \
  --config .qmd/index.yml \
  --qmd-index-path .qmd/index.sqlite \
  --run-id epub-batch-20260527-real-resume-1 \
  --skip-dotenv \
  --status-json
```
