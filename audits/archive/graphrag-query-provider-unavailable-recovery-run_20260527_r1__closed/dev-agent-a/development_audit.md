# GraphRAG Query Provider Unavailable Recovery Development Audit

## 结论

PASS，有剩余非阻塞风险（residual non-blocking risks）。

当前实现已经恢复本案真实闭环：`Building Microservices (Sam Newman).epub`
在 `qmd-query-graphrag-json` 收到结构化
`provider_unavailable` 后，不再被永久化为 `stop_until_fixed`。只读
`--status-json` 投影显示该 item 为
`pending/transient/retry_same_run_id` provider recovery wait，并保留
`failedStage=qmd-query-graphrag-json`、重试时间、等待原因和 GraphRAG build
成功证据。

未发现会阻止真实跑书闭环（real batch closed loop）的阻塞问题。剩余风险集中在
历史 checkpoint 的 qmd build manifest 缺失观测、typed provider error code 语义复用、
以及全量测试未在本次审计中跑完。

## 审计范围

- 审计目录：
  `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open`
- 固定基准来源：
  `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/README.md:41-57`
- 真实 runId：`epub-batch-20260527-real-resume-1`
- 真实目标项：`Building Microservices (Sam Newman).epub`
- 审计对象：GraphRAG query provider_unavailable/网络瞬断恢复、qmd build
  状态观测、阶段门控、GraphRAG 产物隔离、batch status-json 投影。

## 真实状态投影

只读命令：

```bash
node scripts/graphrag/batch-epub-workflow.mjs \
  --run-id epub-batch-20260527-real-resume-1 \
  --status-json \
  --skip-dotenv \
  --log-root /tmp/qmd-audit-status-json-dev-agent-a-20260527
```

关键结果：

- batch：`status=running`、`totalItems=38`、`pendingItems=37`、
  `runningItems=0`、`completedItems=1`、`failedItems=0`
- batch recovery：`recoveryDecision=retry_same_run_id`、
  `retryableItemCount=3`
- target item：`status=pending`、`failureKind=transient`、
  `retryable=true`、`retryExhausted=false`
- target recovery：`recoveryDecision=retry_same_run_id`、
  `waitingForProviderRecovery=true`
- target retry：`nextRetryAt=2026-05-27T10:20:46.391Z`、
  `retryDelaySeconds=300`
- target reason：`providerRecoveryReason=legacy_retry_exhausted_transient`
- target stage：`failedStage=qmd-query-graphrag-json`
- target build/query：`graphBuildStatus.status=succeeded`、
  `graphQueryStatus.status=failed`
- target qmd build observation：`qmdBuildStatus.status=pending`、
  `reason=qmd_build_manifest_missing`

该 qmd build 观测缺口来自历史 checkpoint；当前实现已在未来正常运行中把
qmd build manifest 写在 GraphRAG query checks 之前。

## 阻塞问题

未发现阻塞问题。

当前代码能够把本案历史
`failed/unknown/retryable=false/stop_until_fixed` checkpoint 投影并恢复为
`pending/transient/retry_same_run_id`。同进程调度也已对任意
`failed + retryable=false + recoveryDecision=stop_until_fixed` 项执行停止门控，
不会继续调度后续图书。

## 剩余风险

1. 历史真实目标项仍显示 `qmdBuildStatus=pending`。

   证据：真实 status-json 目标项显示
   `reason=qmd_build_manifest_missing`。实现层面
   `qmdBuildEvidence` 在缺少 manifest 时返回 pending
   (`scripts/graphrag/batch-epub-workflow.mjs:3474-3486`)；当前正常运行会在
   qmd-native checks 后立即写 manifest
   (`scripts/graphrag/batch-epub-workflow.mjs:5025-5103`)。

   影响：不允许 false completed，不重建已成功 GraphRAG 高成本产物；但 operator
   在历史状态中会看到 qmd build 证据缺失，下一次写入续跑需要补写该 manifest。

2. CLI typed provider error code 仍复用 `provider_unavailable`。

   证据：provider 未配置路径在
   `src/query/unified-router.ts:553-563` 使用
   `code=provider_unavailable`、`stage=provider`、`retryable=false`；runtime
   before-response outage 在 `src/query/unified-router.ts:566-588` 也使用
   `code=provider_unavailable`，但 stage 为 `graphrag_query`。
   batch classifier 当前通过 stage 精确区分
   (`scripts/graphrag/batch-failure-classifier.mjs:68-82`)。

   影响：当前不阻塞，因为 provider-not-configured 负例已固定为
   `unknown/retryable=false`；长期建议使用更窄 code 或 metadata 降低误读风险。

3. 本次未执行完整 `npm test`。

   已执行聚焦恢复、停止门控、query/integration 与 typecheck。全量测试范围较大，
   本次审计未将其作为通过条件。

## 基准逐条结果

1. Retryability preserves structured provider error semantics.

   结果：PASS。

   `classifyTypedQueryFailure` 解析 typed query JSON，并且只对
   `provider=graphrag`、`stage=graphrag_query`、`capability=graph_query`、
   `code=provider_unavailable` 覆盖为 `transient/retryable=true`
   (`scripts/graphrag/batch-failure-classifier.mjs:68-82`)。同一测试文件还固定
   `stage=provider` 的 provider-not-configured payload 不被判为 transient
   (`test/cli.test.ts:2386-2399`)。

2. Transient upstream/provider failures do not become permanent without proof.

   结果：PASS。

   HTTP `429` 与 `5xx` 被判为 transient，除 `429` 外的 HTTP `4xx` 被判为
   permanent (`scripts/graphrag/batch-failure-classifier.mjs:8-32`)。
   网络瞬断词包括 Jina、httpx、aiohttp、urllib3、SSL、DNS、connection reset、
   timeout 等 (`scripts/graphrag/batch-failure-classifier.mjs:117-178`)。
   GraphRAG query bridge 在抛出前会对相同 transient token 做内部重试
   (`src/integrations/graphrag.ts:49-127`)。

3. Batch stage gates require book-scoped QMD build, command, GraphRAG build,
   and GraphRAG query evidence before completion.

   结果：PASS，有历史观测 caveat。

   completion 前重新计算 `qmdBuildStatus`、`graphBuildStatus` 和
   `graphQueryStatus`，任何一项非 succeeded 都抛错，不写 completed
   (`scripts/graphrag/batch-epub-workflow.mjs:5150-5201`)。真正写 completed
   时保存三类状态和完整 command checks
   (`scripts/graphrag/batch-epub-workflow.mjs:5202-5227`)。完整命令集合含
   `qmd-query-auto-json` 与 `qmd-query-graphrag-json`
   (`scripts/graphrag/batch-epub-workflow.mjs:186-220`)。

4. Failed required evidence must prevent completion and expose the exact failed
   stage.

   结果：PASS。

   `graphQueryEvidence` 对失败的 graph query command check 返回
   `status=failed`、`stage=<failed command name>`、`reason=graph_query_command_check_failed`
   (`scripts/graphrag/batch-epub-workflow.mjs:3574-3617`)。`runItem` 在该状态非
   succeeded 时抛出，并把对应 command check 作为失败证据
   (`scripts/graphrag/batch-epub-workflow.mjs:5192-5200`)。真实 status-json
   的目标项精确暴露 `failedStage=qmd-query-graphrag-json`。

5. A stop-until-fixed decision must stop scheduling further books in the same
   writer process.

   结果：PASS。

   `shouldStopBatchAfterFailure` 已泛化为
   `status=failed && retryable=false && recoveryDecision=stop_until_fixed`
   (`scripts/graphrag/batch-epub-workflow.mjs:5407-5415`)。主循环在处理前扫描
   stop checkpoint (`scripts/graphrag/batch-epub-workflow.mjs:5552-5562`)，并在
   新失败写入后立即停止本 writer
   (`scripts/graphrag/batch-epub-workflow.mjs:6102-6108`)。
   回归测试固定第二本书不会收到 `command_start`
   (`test/cli.test.ts:6468-6629`)。

6. Orphaned runner recovery must preserve checkpoint identity and not corrupt
   adjacent book state.

   结果：PASS。

   checkpoint hydration 会补齐并保留 item identity
   (`scripts/graphrag/batch-checkpoint-hydration.mjs:183-238`)。
   orphaned running checkpoint 被恢复为
   `pending/transient/retry_same_run_id`，同时保留 runner host、pid、
   heartbeat 证据 (`scripts/graphrag/batch-epub-workflow.mjs:3790-3831`)。
   `status-json` 路径不写 event log
   (`scripts/graphrag/batch-epub-workflow.mjs:1828-1842`)。
   相关测试覆盖 read-only orphan recovery
   (`test/cli.test.ts:6142-6175`)。

7. Provider recovery must be observable in status JSON with retry timing and
   reason.

   结果：PASS。

   provider transient recovery 写入 `waitingForProviderRecovery`、
   `providerRecoveryReason`、`providerRecoveryWaitCount`、`nextRetryAt`、
   `retryDelaySeconds` (`scripts/graphrag/batch-epub-workflow.mjs:3848-3931`)。
   recovery summary 投影这些字段
   (`scripts/graphrag/batch-epub-workflow.mjs:4033-4155`)，schema 也声明了
   `nextRetryAt`、`retryDelaySeconds`、`providerRecoveryReason` 和
   `waitingForProviderRecovery` (`src/contracts/batch-run.ts:221-338`)。
   真实目标项已投影出 retry timing 与 reason。

8. Retrying a failed query must not rebuild unrelated successful artifacts
   unless lineage is stale.

   结果：PASS。

   GraphRAG build evidence 校验 book-scoped artifact path、stage fingerprint、
   provider fingerprint、producer run id 和 `stageProducerRunIds`
   (`scripts/graphrag/batch-epub-workflow.mjs:2927-3293`)。query-ready 状态成功时
   只保留本书的 artifactIds。resume 脚本在 `nextStage == null` 时仅刷新 producer
   manifest 并执行 graph query，不进入高成本 index workflows
   (`scripts/graphrag/resume-book-workspace.mjs:1127-1162`)。只有 lineage 需要重建
   的 `nextStage` 才会进入 workflows
   (`scripts/graphrag/resume-book-workspace.mjs:1274-1445`)。

9. Docs and runbooks must describe the operator action for provider query
   outages.

   结果：PASS。

   batch runbook 说明了 structured GraphRAG query provider failure、legacy
   reclassification、provider recovery wait 和同 runId 恢复策略
   (`docs/operations/graphrag-epub-batch-runbook.md:200-266`)。同一文档列出
   status-json 期望字段和通用 stop-until-fixed 停止门
   (`docs/operations/graphrag-epub-batch-runbook.md:360-376`)。resume boost 文档
   给出签名和 operator action
   (`docs/operations/graphrag-epub-resume-boost.md:277-315`)。resume commands
   文档给出只读状态投影与写入续跑命令
   (`docs/operations/graphrag-epub-resume-commands.md:41-107`)。

10. Tests must pin retry classification and batch stop behavior for this case.

    结果：PASS。

    classifier 测试固定 HTTP、网络瞬断、本案 structured JSON、SSL-wrapped
    variant，以及 provider-not-configured 负例
    (`test/cli.test.ts:2241-2399`)。status-json fixture 固定历史 failed
    checkpoint 恢复为 provider transient wait
    (`test/cli.test.ts:4151-4317`)。generic stop-until-fixed 测试固定同 writer
    停止行为 (`test/cli.test.ts:6468-6629`)。qmd build manifest 在 graph query
    失败前持久化的正常运行测试位于 `test/cli.test.ts:10790-10991`。

## 建议修复

1. 为历史 checkpoint 增加 qmd build evidence backfill。

   对已拥有完整 qmd-native passed command checks、normalized markdown、qmd index
   与 config 的历史 item，可在写入续跑或 migrate-only 中补写
   `qmd_build_manifest.json`，或在 status-json 中给出更明确的
   `legacy_qmd_build_manifest_missing` reason。

2. 收敛 provider unavailable taxonomy。

   保留当前 stage-based 分类，同时考虑把 provider 未配置改为更窄的
   `provider_not_configured` code，或在 typed payload metadata 中加入
   `outageClass=before_response_runtime`，减少未来 classifier 漂移风险。

3. 抽取共享 transient token 表。

   `batch-failure-classifier.mjs`、`src/query/unified-router.ts` 与
   `src/integrations/graphrag.ts` 维护相近 token 列表。建议抽取可测试的共享配置或
   生成式 fixture，降低网络瞬断分类漂移。

4. 在合并前运行全量测试。

   本次审计已通过聚焦测试与 typecheck；若该修复进入主线，应再执行完整
   `npm test`，确认未影响非 GraphRAG CLI 行为。

## 验证记录

通过：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 test/cli.test.ts \
  -t "status-json recovers GraphRAG query provider_unavailable as provider transient|generic stop-until-fixed failure stops before next book|status-json recovers orphaned running item to retryable pending|status-json accepts portable book-scoped GraphRAG producer evidence|status-json reopens completed items when GraphRAG query check failed"
```

结果：`1 passed` test file，`5 passed` tests，`207 skipped`。

通过：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 \
  test/unified-query.test.ts test/integrations/graphrag-cost.test.ts
```

结果：`2 passed` test files，`40 passed` tests。

通过：

```bash
npm run test:types
```

结果：TypeScript build typecheck passed。

未执行完整 `npm test`；该项列为合并前建议验证，不作为本次审计阻塞项。
