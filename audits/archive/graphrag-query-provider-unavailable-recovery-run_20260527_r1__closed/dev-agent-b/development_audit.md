# GraphRAG Query Provider Unavailable Recovery Development Audit

## 结论

FAIL。

目标事故路径（incident path）已经基本恢复：真实 runId
`epub-batch-20260527-real-resume-1` 的
`Building Microservices (Sam Newman).epub` 可通过只读
`--status-json --skip-dotenv` 投影为：

- `status=pending`
- `failureKind=transient`
- `retryable=true`
- `retryExhausted=false`
- `recoveryDecision=retry_same_run_id`
- `failedStage=qmd-query-graphrag-json`
- `waitingForProviderRecovery=true`
- `nextRetryAt`、`retryDelaySeconds`、`providerRecoveryReason` 存在
- `graphBuildStatus.status=succeeded`

same-writer `stop_until_fixed` 泛化停止、status-json provider recovery
可观测性、真实 runId 恢复投影和本案精确 fixture 测试均已落地。

但当前结构化 provider error 分类仍存在阻塞缺陷：batch classifier 会把任意
`provider=graphrag`、`capability=graph_query`、
`code=provider_unavailable` payload 判为 transient，而不区分
`stage=graphrag_query` 的 before-response provider outage 与
`stage=provider` 的 provider 未配置（provider not configured）。这会把永久配置缺失
错误误投影为 provider wait，违反结构化 provider 语义边界。

未读取或输出 `.env` secret 值。

## 审计依据

读取范围：

- `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/README.md`
- `implementation_summary.md`
- `agent-a/design_audit.md`
- `agent-b/design_audit.md`
- `agent-c/design_audit.md`
- `scripts/graphrag/batch-failure-classifier.mjs`
- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/resume-book-workspace.mjs`
- `src/query/unified-router.ts`
- `src/integrations/graphrag.ts`
- `src/cli/qmd.ts`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `test/unified-query.test.ts`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/operations/graphrag-epub-resume-boost.md`
- `docs/operations/graphrag-epub-resume-commands.md`
- `graph_vault/catalog/batch-runs/epub-batch-20260527-real-resume-1`
  下 manifest、item checkpoint、events、recovery summary 非秘密内容

只读实测命令：

```bash
node scripts/graphrag/batch-epub-workflow.mjs \
  --source-dir inbox/软件工程与系统设计经典著作指南 \
  --state-root graph_vault \
  --log-root outputs/qmd-epub-batch-20260527-real-resume-1 \
  --config .qmd/index.yml \
  --qmd-index-path .qmd/index.sqlite \
  --run-id epub-batch-20260527-real-resume-1 \
  --skip-dotenv \
  --status-json
```

该命令输出中，目标 item 为 `pending/transient/retry_same_run_id` provider wait；
相邻历史 running item 被投影为 `pending/transient/retry_same_run_id`、
`failedStage=runner_orphaned`，未污染目标 item identity。

## 阻塞问题

### B-1. `provider_unavailable` 结构化分类过宽

严重性：Blocking。

证据：

- `scripts/graphrag/batch-failure-classifier.mjs:68-77`：
  `classifyTypedQueryFailure` 只检查
  `provider=graphrag`、`capability=graph_query`、`code=provider_unavailable`，
  直接返回 `{ failureKind: "transient", retryable: true }`。
- `src/query/unified-router.ts:553-563`：当 `services.queryGraphRag` 不存在时，
  typed error 也是 `provider=graphrag`、`capability=graph_query`、
  `code=provider_unavailable`，但 `stage=provider`、
  `retryable=false`，message 为 GraphRAG query provider is not configured。
- 当前分类探针结果：

  ```text
  stage=provider, code=provider_unavailable,
  redactedMessage=GraphRAG query provider is not configured.
  => failureKind=transient, retryable=true
  ```

影响：

- provider 未配置（configuration missing）会被误恢复为
  `pending/retry_same_run_id/waitingForProviderRecovery`，而不是
  `failed/stop_until_fixed`。
- 这与 `implementation_summary.md` 中 provider-not-configured remains
  non-retryable 的声明不一致。
- 这违反原则 1：retryability 必须保留结构化 provider error 语义。

建议修复：

- 只把 `stage=graphrag_query` 且 message/metadata 表示 before-response runtime
  provider outage 的 `provider_unavailable` 判为 transient。
- 对 `stage=provider` 且 redacted message 为 provider not configured 的 payload
  保持 `permanent/retryable=false/stop_until_fixed`。
- 增加负例测试：provider not configured 的 typed JSON 不得进入 provider recovery
  wait。

## 固定原则评估

1. Retryability preserves structured provider error semantics.

   Result: FAIL。

   本案 `stage=graphrag_query` structured payload 已被 batch 层正确恢复为
   transient provider wait。但分类器没有检查 `stage` 或配置缺失语义，导致
   `stage=provider` 的 provider-not-configured typed error 也被判为 transient。
   结构化 provider semantics 尚未闭合。

2. Transient upstream/provider failures do not become permanent without proof.

   Result: PASS。

   当前 `classifyFailure` 已解析本案 JSON，并把
   `provider=graphrag`、`capability=graph_query`、
   `code=provider_unavailable` 分类为 transient。真实 status-json 投影也显示目标
   item 从旧 `failed/unknown/retryable=false/stop_until_fixed` 恢复为
   `pending/transient/retry_same_run_id`。阻塞问题 B-1 是永久配置错误被误判为
   transient，而不是本案 transient 被永久化。

3. Batch stage gates require book-scoped QMD build, command, GraphRAG build,
   and GraphRAG query evidence before completion.

   Result: PASS。

   completion gate 仍要求 qmd build evidence、完整 command check、
   GraphRAG build evidence 和 GraphRAG query evidence 全部 succeeded。
   `graphQueryEvidence` 会把 failed `qmd-query-graphrag-json` 暴露为
   `graph_query_command_check_failed`。当前实现还将 qmd-native command checks
   与 graph query checks 分离：`writeQmdBuildManifest` 写入 qmd-native
   command names，`qmdBuildEvidence` 接受 qmd-native 或 legacy full set。

4. Failed required evidence must prevent completion and expose the exact failed
   stage.

   Result: PASS。

   真实 checkpoint、status-json、events 和 tests 均保留
   `failedStage=qmd-query-graphrag-json`。目标 item 没有被误标 completed；
   status-json 同时显示 `commandCheckStatus.stage=qmd-query-graphrag-json` 和
   `graphQueryStatus.stage=qmd-query-graphrag-json`。

5. A stop-until-fixed decision must stop scheduling further books in the same
   writer process.

   Result: PASS。

   `scripts/graphrag/batch-epub-workflow.mjs:5334-5337` 已把停止条件泛化为
   `failed + retryable=false + recoveryDecision=stop_until_fixed`。
   同文件 `5479-5488` 在处理前扫描 stop checkpoint，`6029-6035` 在新失败后停止。
   `test/cli.test.ts:6454-6615` 覆盖 generic stop-until-fixed 不得启动第二本书。

6. Orphaned runner recovery must preserve checkpoint identity and not corrupt
   adjacent book state.

   Result: PASS。

   `batch-checkpoint-hydration.mjs:39-47` 保留 checkpoint identity fields。
   `batch-epub-workflow.mjs:3758-3798` 将 orphaned running item 投影为
   `pending/transient/retry_same_run_id`，保留 runner host、pid、heartbeat 证据。
   真实 status-json 中相邻 item 被恢复为 `runner_orphaned`，目标 item 的 bookId、
   sourceHash 和 failedStage 未被相邻状态污染。

7. Provider recovery must be observable in status JSON with retry timing and
   reason.

   Result: PASS。

   `buildRecoverySummary` 投影 `waitingForProviderRecovery`、`nextRetryAt`、
   `retryDelaySeconds`、`retryBudgetSeconds`、`providerRecoveryWaitCount`、
   `maxProviderRecoveryWaits` 和 `providerRecoveryReason`。真实 runId 只读
   status-json 已显示目标 item 的上述字段。

8. Retrying a failed query must not rebuild unrelated successful artifacts
   unless lineage is stale.

   Result: PASS。

   GraphRAG resume 以 `resumePlan.nextStage` 为边界；当 high-cost stages 已
   succeeded 且 `nextStage=null` 时，`resume-book-workspace.mjs:1127-1162` 刷新
   producer manifest 并执行 query，不重跑 `graph_extract`、`community_report`
   或 `embed`。真实目标 status-json 保留
   `graphBuildStatus.status=succeeded` 和 `stage=query_ready`。

9. Docs and runbooks must describe the operator action for provider query
   outages.

   Result: PASS。

   `docs/operations/graphrag-epub-batch-runbook.md:199-266` 已列出本案 structured
   GraphRAG query provider failure、legacy reclassification 和同 runId 恢复策略。
   `docs/operations/graphrag-epub-batch-runbook.md:360-376` 明确 status-json
   观测字段和通用 stop-until-fixed 停止门。
   `docs/operations/graphrag-epub-resume-boost.md:277-315` 补充了签名、状态投影和
   operator action。

10. Tests must pin retry classification and batch stop behavior for this case.

   Result: PASS with required follow-up。

   `test/cli.test.ts:2364-2385` 固定本案 structured JSON classifier 行为；
   `test/cli.test.ts:4137-4303` 固定 persisted legacy failed checkpoint 的
   status-json provider recovery 投影；`test/cli.test.ts:6454-6615` 固定 generic
   stop-until-fixed 不启动第二本书。

   必须补充 B-1 的负例测试，否则 provider-not-configured 会继续被误判为 transient。

## 非阻塞风险

- 历史真实目标 item 仍缺少 `qmd_build_manifest`，只读 status-json 中
  `qmdBuildStatus.status=pending`。当前代码已在未来运行中将 qmd build manifest
  写在 graph query checks 之前，但旧 checkpoint 只保留失败的
  `qmd-query-graphrag-json` command check，下一次真实续跑仍可能重复部分 qmd-native
  CLI 检查。该风险不重建 GraphRAG high-cost artifacts，也不允许 false completed。
- `recoverProviderTransientCheckpoint` 对 legacy retry exhausted 的
  `providerRecoveryReason` 为 `legacy_retry_exhausted_transient`。该 reason 可观测，
  但未直接包含 `provider/capability/code`；后续可把 typed fields 投影到 metadata，
  便于 operator 快速区分本案 provider outage 与其他 transient。
- status-json 仍依赖 source directory discovery。当前真实 source 目录存在，真实
  runId 投影已通过；若将来只保留 manifest/checkpoints 而 source root 不在本机，
  checkpoint-only status projection 仍值得补强。

## 建议验证命令

语法与类型：

```bash
node --check scripts/graphrag/batch-failure-classifier.mjs
node --check scripts/graphrag/batch-checkpoint-hydration.mjs
node --check scripts/graphrag/batch-epub-workflow.mjs
npm run test:types
git diff --check
```

聚焦测试：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run test/cli.test.ts \
  --reporter=verbose \
  --testTimeout 60000 \
  --testNamePattern "provider_unavailable|generic stop-until-fixed|provider recovery"
```

真实 runId 只读投影：

```bash
node scripts/graphrag/batch-epub-workflow.mjs \
  --source-dir inbox/软件工程与系统设计经典著作指南 \
  --state-root graph_vault \
  --log-root outputs/qmd-epub-batch-20260527-real-resume-1 \
  --config .qmd/index.yml \
  --qmd-index-path .qmd/index.sqlite \
  --run-id epub-batch-20260527-real-resume-1 \
  --skip-dotenv \
  --status-json
```

B-1 修复后的负例验证：

```bash
node --input-type=module <<'NODE'
import { classifyFailure } from "./scripts/graphrag/batch-failure-classifier.mjs";

const providerNotConfigured = {
  schemaVersion: "1.0.0",
  route: "graphrag",
  stage: "provider",
  provider: "graphrag",
  capability: "graph_query",
  code: "provider_unavailable",
  retryable: false,
  redactedMessage: "GraphRAG query provider is not configured.",
};

console.log(classifyFailure(JSON.stringify(providerNotConfigured, null, 2)));
NODE
```

期望结果：`failureKind` 不得为 `transient`，`retryable` 必须为 `false`。
