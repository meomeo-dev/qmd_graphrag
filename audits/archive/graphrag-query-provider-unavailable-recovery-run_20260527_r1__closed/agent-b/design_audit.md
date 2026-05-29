# GraphRAG Query Provider Unavailable Recovery Design Audit

## 结论

FAIL。

当前设计未能把 `qmd-query-graphrag-json` 返回的结构化
`provider_unavailable`（GraphRAG query provider failed before returning a
response）稳定归入可恢复的 provider outage。该失败在真实批次中被写成
`failureKind=unknown`、`retryable=false`、`retryExhausted=true`、
`recoveryDecision=stop_until_fixed`，且没有 `nextRetryAt`、
`waitingForProviderRecovery` 或 provider recovery reason。

更严重的是，同一 writer 在写入 `stop_until_fixed` 后继续调度下一本书。
真实事件序列显示 `item-2d1d667301e9-095a11e7` 于
`2026-05-27T07:46:09.077Z` 写入 `item_failed`，随后
`item-bc1d37ebbc88-0951f1dc` 于 `2026-05-27T07:46:11.946Z`
进入 `item_start`。这违反 stop-until-fixed 停止语义
（stop-until-fixed scheduling semantics）。

## 审计范围与证据

读取范围：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/resume-book-workspace.mjs`
- `scripts/graphrag/batch-failure-classifier.mjs`
- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `src/cli/qmd.ts`
- `src/llm.ts`
- `src/query/unified-router.ts`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/operations/graphrag-epub-resume-commands.md`
- `docs/operations/graphrag-epub-resume-boost.md`
- `graph_vault/catalog/batch-runs/epub-batch-20260527-real-resume-1`
  下的 manifest、item checkpoint、events 和 recovery summary 非秘密内容

未读取、未输出 `.env` 内容。

关键证据：

- `src/query/unified-router.ts:293-307` 将 GraphRAG provider runtime
  failure 包装为 `provider_unavailable` 且固定 `retryable=false`。
- `src/query/unified-router.ts:497-529` 中 provider 未配置与 provider
  pre-response runtime failure 都使用 `provider_unavailable`，缺少可恢复性区分。
- `scripts/graphrag/batch-failure-classifier.mjs:1-59` 主要按文本 token
  分类；未解析 typed query error JSON，未识别 `route=graphrag`、
  `stage=graphrag_query`、`provider=graphrag`、`capability=graph_query`、
  `code=provider_unavailable`。
- `scripts/graphrag/batch-epub-workflow.mjs:4329-4507` 从 stderr/stdout
  构造 command check；结构化 JSON 被当作普通文本进入 classifier。
- `scripts/graphrag/batch-epub-workflow.mjs:5700-5889` 在
  `failureKind=unknown`、`retryable=false` 时写入 failed/stop_until_fixed。
- `scripts/graphrag/batch-epub-workflow.mjs:5292-5300` 的停止条件只覆盖
  data compatibility 与 provider auth，不覆盖所有 `stop_until_fixed`。
- 真实 checkpoint
  `graph_vault/catalog/batch-runs/epub-batch-20260527-real-resume-1/items/`
  `item-2d1d667301e9-095a11e7.json` 显示失败 item 为
  `failureKind=unknown`、`retryable=false`、`recoveryDecision=stop_until_fixed`、
  `failedStage=qmd-query-graphrag-json`。
- 只读 `--status-json --skip-dotenv` 观察仍显示该 item 未进入 provider
  recovery wait；`waitingForProviderRecovery=false`，无 `nextRetryAt`、
  `providerRecoveryWaitCount`、`providerRecoveryReason`。
- `events.jsonl` 记录失败后继续启动下一本，形成 adjacent book running/orphan
  状态。

## 固定原则评估

1. Retryability preserves structured provider error semantics.

   FAIL。结构化 typed query error 的字段没有被 batch classifier 解析并作为
   一等语义使用；`provider_unavailable` 仅以普通文本参与 token 匹配，最终落入
   `unknown/retryable=false`。同时上游 GraphRAG runtime failure 与 provider 未配置
   共用 `provider_unavailable` 且固定 `retryable=false`，使结构化错误语义本身
   不能表达 pre-response provider outage 的可恢复性。

2. Transient upstream/provider failures do not become permanent without proof.

   FAIL。本案错误文本为 provider 在返回响应前失败，没有 HTTP 4xx、401/403、
   auth failure、data compatibility 或 local artifact gate 证据。设计却将其
   写成 `unknown`、`retryable=false`、`retryExhausted=true`、
   `stop_until_fixed`。这是没有证明的永久化（permanent without proof）。

3. Batch stage gates require book-scoped QMD build, command, GraphRAG build,
   and GraphRAG query evidence before completion.

   PASS。`runItem` 在写入 `completed` 前检查 qmd build evidence、
   GraphRAG build evidence、GraphRAG query evidence 和 27 个 command checks；
   `graphBuildEvidence` 验证 book-scoped output、producer run lineage、
   stage fingerprint、provider fingerprint 和 content hash；`graphQueryEvidence`
   要求 `qmd-query-auto-json` 与 `qmd-query-graphrag-json` 均通过。

   但存在观测缺口：本案已完成大量 qmd command 与 GraphRAG build，失败后
   checkpoint 的 `qmdBuildStatus` 仍为 `pending/qmd_build_manifest_missing`，
   因为 qmd build manifest 在所有 CLI checks 之后才写入。该缺口不导致误
   completed，但会削弱失败定位的可读性。

4. Failed required evidence must prevent completion and expose the exact failed
   stage.

   PASS。失败的 `qmd-query-graphrag-json` 阻止了 `completed` 写入，并在
   checkpoint、command check、GraphRAG query status 与 events 中暴露
   `failedStage=qmd-query-graphrag-json` 和
   `reason=graph_query_command_check_failed`。

5. A stop-until-fixed decision must stop scheduling further books in the same
   writer process.

   FAIL。当前停止门只对 data compatibility 与 provider auth 的
   `stop_until_fixed` 生效；未知或其他永久失败会记录
   `item_failed_not_retryable` 后继续调度。真实批次中同一 writer 在
   `Building Microservices (Sam Newman).epub` 失败后继续启动下一本书，直接
   违反该原则。

6. Orphaned runner recovery must preserve checkpoint identity and not corrupt
   adjacent book state.

   PASS。设计中 `recoverOrphanedRunningCheckpoint` 保留 item/book 身份字段，
   仅将 stale/freshness 判定后的 orphaned running item 投影为
   `pending/transient/retry_same_run_id`，并记录 runner host、pid、heartbeat
   与 detected time。只读 status-json 对后续被人工停止的 running item 投影为
   `failedStage=runner_orphaned`，未篡改相邻书籍 identity。

   该机制能够恢复已经形成的 orphan，但不能抵消原则 5 的调度缺陷；根因仍是
   writer 不应在 `stop_until_fixed` 后启动相邻书。

7. Provider recovery must be observable in status JSON with retry timing and
   reason.

   FAIL。代码有 provider recovery projection 字段
   `waitingForProviderRecovery`、`nextRetryAt`、`retryDelaySeconds`、
   `providerRecoveryWaitCount`、`maxProviderRecoveryWaits`、
   `providerRecoveryReason`，但本案未进入该路径。只读 status-json 对目标 item
   仍显示 `waitingForProviderRecovery=false`，且没有 retry timing 或 reason。

8. Retrying a failed query must not rebuild unrelated successful artifacts
   unless lineage is stale.

   PASS。GraphRAG retry 设计以 `BookResumePlan.nextStage` 和 stage evidence
   为准；当 `nextStage=null` 且 graph lineage 仍新鲜时，resume 只进入 query
   与 CLI checks，不应重建 `graph_extract`、`community_report` 或 `embed`。
   `graphBuildEvidence` 也会用 producer run id、fingerprint、content hash 和
   book-scoped artifacts 判断 lineage 是否 stale。

   本案的实际阻塞是分类错误导致无法自动 retry，而不是 retry 路径会重建
   unrelated GraphRAG artifacts。

9. Docs and runbooks must describe the operator action for provider query
   outages.

   FAIL。runbook 说明了 rate limit、timeout、HTTP 429/5xx、partial output、
   provider auth 和 provider recovery wait，但没有明确覆盖结构化
   `qmd query --graphrag` `provider_unavailable` JSON，尤其没有说明当
   `redactedMessage` 为 provider before-response failure 时应按 provider outage
   使用同一 runId、等待 `nextRetryAt` 恢复，而不是设计审计/手改 checkpoint/
   新建 runId。

10. Tests must pin retry classification and batch stop behavior for this case.

   FAIL。现有测试覆盖了 typed GraphRAG provider error 生成、GraphRAG query
   failed completed checkpoint reopen、provider recovery projection、provider
   auth stop、data compatibility stop 和 orphaned runner recovery。但缺少本案
   精确 fixture：

   - `qmd-query-graphrag-json` stderr 为结构化 JSON：
     `route=graphrag`、`stage=graphrag_query`、`provider=graphrag`、
     `capability=graph_query`、`code=provider_unavailable`。
   - persisted legacy payload 中 `retryable=false` 时仍按 provider outage
     或明确的分类规则重投影。
   - live writer 在任何真实 `stop_until_fixed` 后不得启动下一本。
   - provider outage 必须写入 retry timing、provider recovery reason 和 same-run
     recovery decision。

## 必须修复项

1. 修正 GraphRAG provider error taxonomy。

   将 provider 未配置（configuration unavailable）与 provider runtime outage
   （provider failed before response）拆开。前者可保持 non-retryable；后者应
   表达为 transient/retryable，或提供明确的 structured recovery hint。不要让
   `provider_unavailable` 同时代表永久配置缺失和临时上游不可用。

2. 增加 structured query error classifier。

   `batch-failure-classifier` 必须解析 stderr/stdout 中的 typed query error JSON。
   对 `route=graphrag`、`stage=graphrag_query`、
   `provider=graphrag`、`capability=graph_query`、
   `code=provider_unavailable` 的 pre-response failure，应进入
   `failureKind=transient`、`retryable=true`、`recoveryDecision=retry_same_run_id`
   路径，除非同一结构化错误或 metadata 给出 auth、4xx、schema/config 或其他
   non-transient proof。

3. 修正 stop-until-fixed 全局停止门。

   `shouldStopBatchAfterFailure` / `shouldStopBatchBeforeProcessing` /
   `recoveryDecisionForBatch` 应把所有未被本地 repair reopen 的
   `failed + retryable=false + recoveryDecision=stop_until_fixed` 视为当前 writer
   的停止条件，而不仅是 data compatibility 和 provider auth。否则
   `stop_until_fixed` 不是一个可依赖的调度决策。

4. 修正 provider recovery observability。

   对 GraphRAG query provider outage，checkpoint 与 status JSON 必须显示：
   `failureKind=transient`、`retryable=true`、`retryExhausted=false`、
   `recoveryDecision=retry_same_run_id`、`failedStage=qmd-query-graphrag-json`、
   `nextRetryAt`、`retryDelaySeconds`、`retryBudgetSeconds`、
   `waitingForProviderRecovery=true`、`providerRecoveryReason`、
   `providerRecoveryWaitCount` 和 `maxProviderRecoveryWaits`。

5. 解耦 QMD build evidence 与完整 command check evidence。

   本案失败发生在 GraphRAG query check，但 status 同时显示 qmd build evidence
   missing。建议将 qmd build manifest 的持久化提前到可证明 qmd build 完成的
   边界，或在 status JSON 中区分 qmd build evidence、qmd native command
   checks 和 graph query checks，避免后续 query failure 让前置阶段看似未开始。

## 建议修复范围

- `src/query/unified-router.ts`

  拆分 provider error code 或 retryability：provider not configured 保持
  non-retryable；GraphRAG runtime throws before response 应输出 retryable provider
  outage。`TypedQueryError` 可以继续作为 stderr JSON 输出，但其字段必须足够区分
  恢复策略。

- `scripts/graphrag/batch-failure-classifier.mjs`

  添加 typed JSON extraction/parsing。优先使用结构化字段分类，再回退文本 token。
  解析失败时保持现有 redacted text classifier。

- `scripts/graphrag/batch-checkpoint-hydration.mjs`

  对 legacy persisted checkpoint 重新分类结构化 provider outage。若历史 payload
  是本案 JSON，即使旧 payload 写了 `retryable=false`，也应通过当前 taxonomy
  进入 transient provider recovery，并记录 reclassified metadata。

- `scripts/graphrag/batch-epub-workflow.mjs`

  修正 stop gate、batch recovery decision 优先级、provider recovery wait 写入和
  summary projection。确保 live run 与 `--status-json` 对同一 checkpoint 的
  recovery semantics 一致。

- `docs/operations/*`

  增补 GraphRAG query provider outage runbook：识别结构化 JSON、预期状态字段、
  同一 runId 恢复步骤、provider wait limit 后的 operator action，以及
  `provider_unavailable` 与 provider auth/config failure 的分流规则。

## 测试建议

1. Classifier unit test：输入本案结构化 JSON，断言分类为
   `transient/retryable=true/retry_same_run_id`，并保留
   `provider=graphrag`、`capability=graph_query`、`stage=graphrag_query`、
   `code=provider_unavailable` 的可观测 metadata。

2. Legacy hydration test：构造 persisted checkpoint：
   `status=failed`、`failedStage=qmd-query-graphrag-json`、
   `failureKind=unknown`、`retryable=false`、`retryExhausted=true`、
   `recoveryDecision=stop_until_fixed`，errorSummary 为本案 JSON。运行
   `--status-json` 后应投影为 `pending/transient/retry_same_run_id`，
   且包含 `nextRetryAt`、`retryDelaySeconds`、`waitingForProviderRecovery=true`、
   `providerRecoveryReason`。

3. Live batch test：fake qmd runner 在 `qmd-query-graphrag-json` 返回本案 JSON
   和 exit code 1。断言 item 不写成 permanent stop；进入 retry budget/provider
   recovery path，GraphRAG build evidence 保持 succeeded，GraphRAG producer
   run ids 不变化。

4. Stop semantics test：构造两本书，第一本为
   `failed + retryable=false + recoveryDecision=stop_until_fixed` 且不可 local
   repair，第二本为 pending。运行 writer 后断言没有第二本 `item_start`，manifest
   与 recovery summary 顶层 `recoveryDecision=stop_until_fixed`。

5. Mixed-status summary test：同时存在一个 `stop_until_fixed` failed item 和一个
   retryable pending item 时，batch-level recovery decision 必须优先显示
   `stop_until_fixed`，避免 operator 被其他 retryable item 误导。

6. Stage gate regression test：当 GraphRAG query check failed 时不得写
   `completed`；status JSON 必须同时显示 exact failed stage，并且前置 qmd build
   与 GraphRAG build evidence 不被误报为缺失或 stale，除非 lineage 实际 stale。
