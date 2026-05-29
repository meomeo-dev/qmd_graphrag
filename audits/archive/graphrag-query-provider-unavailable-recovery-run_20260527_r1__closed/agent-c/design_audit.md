# GraphRAG Query Provider Unavailable Recovery Design Audit

## 结论

FAIL。

真实批次 `epub-batch-20260527-real-resume-1` 已证明该设计曾把
`Building Microservices (Sam Newman).epub` 的 GraphRAG query provider outage
错误写成永久停止态，并且同一 writer 在 `stop_until_fixed` 后继续调度下一本书。
当前工作树已经补上部分关键实现：`batch-failure-classifier` 能把本案结构化 JSON
分类为 transient；`shouldStopBatchAfterFailure` 已改为通用
`failed + retryable=false + stop_until_fixed` 停止门。但设计仍未全部满足固定审计
原则（fixed audit principles）。

主要剩余缺口是：

- CLI typed error taxonomy 仍让 GraphRAG runtime provider outage 输出
  `provider_unavailable`，且可输出 `retryable=false`。batch 层有补救分类，但 typed
  provider error 本身仍不能稳定表达 outage 与配置缺失的区别。
- `status-json` 的 legacy provider recovery 设计依赖当前 source directory 可被
  discovery 重新找到；本次真实 run 的原始 source 目录当前缺失时，不能只读投影旧
  checkpoint 的 provider recovery 状态。
- runbook 只描述一般 provider transient/recovery wait，未明确覆盖本案结构化
  `qmd-query-graphrag-json` `provider_unavailable` JSON 与 operator action。
- 测试覆盖有近似项，但未固定本案完整 payload 的 status hydration、same-writer
  stop 行为与“不重建无关成功产物”的端到端断言。

## 审计范围

读取了唯一 open 审计目录：

- `audit/graphrag-query-provider-unavailable-recovery-run_20260527_r1__open/README.md`
- `agent-a/design_audit.md`
- `agent-b/design_audit.md`

读取了相关实现、契约、测试、运行手册和非秘密批次状态：

- `scripts/graphrag/batch-failure-classifier.mjs`
- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/resume-book-workspace.mjs`
- `src/query/unified-router.ts`
- `src/cli/qmd.ts`
- `src/integrations/graphrag.ts`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `test/unified-query.test.ts`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/operations/graphrag-epub-resume-boost.md`
- `docs/operations/graphrag-epub-resume-commands.md`
- `graph_vault/catalog/batch-runs/epub-batch-20260527-real-resume-1/`
  下的 manifest、item checkpoint、events 和 recovery summary。

未读取或输出 `.env` 内容。

## 关键证据

真实批次证据：

- 目标 item：
  `graph_vault/catalog/batch-runs/epub-batch-20260527-real-resume-1/items/item-2d1d667301e9-095a11e7.json`
  是 `Building Microservices (Sam Newman).epub`。
- 该 item 的 `qmd-query-graphrag-json` command check 失败，stderr 为结构化 JSON：
  `route=graphrag`、`stage=graphrag_query`、`provider=graphrag`、
  `capability=graph_query`、`code=provider_unavailable`、`retryable=false`。
- 同一 checkpoint 写入 `status=failed`、`failureKind=unknown`、
  `retryable=false`、`retryExhausted=true`、
  `recoveryDecision=stop_until_fixed`、`failedStage=qmd-query-graphrag-json`、
  `metadata.waitingForProviderRecovery=false`。
- 该 checkpoint 同时显示 `graphBuildStatus.status=succeeded` 与
  `graphQueryStatus.status=failed`，失败精确落在 GraphRAG query check。
- `events.jsonl` 显示 `item_failed` 于 `2026-05-27T07:46:09.077Z` 写入后，
  同一 writer 于 `2026-05-27T07:46:11.946Z` 对下一本
  `Building Microservices Designing Fine-Grained Systems (Sam Newman).epub`
  写入 `item_start`。
- 当时 `recovery-summary.json` 对目标 item 显示 `waitingForProviderRecovery=false`，
  无 `nextRetryAt`、`retryDelaySeconds`、`providerRecoveryWaitCount` 或
  `providerRecoveryReason`。

当前工作树证据：

- `scripts/graphrag/batch-failure-classifier.mjs:68-77` 已解析 typed query JSON，
  并把 `provider=graphrag`、`capability=graph_query`、
  `code=provider_unavailable` 分类为 `transient/retryable=true`。直接探针确认本案
  JSON 返回 `{failureKind:"transient", retryable:true}`。
- `scripts/graphrag/batch-checkpoint-hydration.mjs:135-238` 会用当前 classifier
  重新分类 failed command checks 和 checkpoint failure text。
- `scripts/graphrag/batch-epub-workflow.mjs:3816-3889` 能把 transient failed/pending
  checkpoint 转为 provider recovery wait，并写入 `nextRetryAt`、
  `retryDelaySeconds`、`waitingForProviderRecovery=true` 与
  `providerRecoveryReason`。
- `scripts/graphrag/batch-epub-workflow.mjs:5310-5314` 已把
  `shouldStopBatchAfterFailure` 改为通用 stop-until-fixed 条件。
- `scripts/graphrag/batch-epub-workflow.mjs:5448-5457` 在处理任何 item 前扫描
  stop checkpoint；`5982-5988` 在新失败后也停止当前 writer。
- `src/query/unified-router.ts:553-587` 仍把 provider 未配置和 provider before-response
  runtime failure 都映射为 `code=provider_unavailable`；runtime failure 的
  `retryable` 取决于 `isTransientGraphProviderError` 文本匹配。
- `scripts/graphrag/batch-epub-workflow.mjs:5390-5394` 在 `--status-json` 下仍要求
  `sourceDir` 存在并重新 discover EPUB。真实 run 的 manifest 记录
  `sourceRootName=软件工程与系统设计经典著作指南`，当前仓库中该 source 目录不存在，
  因此无法对真实 run 做纯 checkpoint 的只读 recovery projection。
- `docs/operations/graphrag-epub-batch-runbook.md:199-256` 覆盖一般 provider
  transient/recovery wait，但没有点名本案结构化
  `provider_unavailable` GraphRAG query JSON。
- `test/cli.test.ts:2241-2375` 覆盖 HTTP、Jina/APIConnectionError 和 provider
  transient 文本；`10110-10402` 覆盖 completed item 的 failed GraphRAG query reopen；
  但未覆盖本案 persisted failed checkpoint JSON payload。

## 固定原则评估

1. Retryability preserves structured provider error semantics.

   PARTIAL FAIL。batch classifier 现在会解析本案 typed JSON，并把 GraphRAG
   `provider_unavailable` query failure 归类为 transient，这修复了 batch 层最直接
   的语义丢失。但 CLI typed error 本身仍可能对 before-response provider outage 输出
   `retryable=false`，并且与 provider 未配置共用 `provider_unavailable`。这要求
   batch 层覆盖 CLI 字段，说明结构化 provider error taxonomy 仍不自洽。

2. Transient upstream/provider failures do not become permanent without proof.

   PASS WITH RESIDUAL RISK。当前 classifier 已把 Jina/APIConnectionError、SSL、
   EOF、HTTP 429/5xx、timeout 以及本案 structured GraphRAG
   `provider_unavailable` 归入 transient。旧的真实 checkpoint 曾永久化，但当前
   hydration 路径会基于 failure text 重新分类。剩余风险是 typed provider error 若丢失
   底层 transient token 且 `retryable=false`，仍依赖本案专门规则兜底。

3. Batch stage gates require book-scoped QMD build, command, GraphRAG build,
   and GraphRAG query evidence before completion.

   PASS。当前 completion gate 需要独立 qmd build manifest、完整 command check
   set、GraphRAG build evidence 和 GraphRAG query evidence 全部成功后才写
   `completed`。`graphQueryEvidence` 会把 failed `qmd-query-graphrag-json`
   投影为 `graph_query_command_check_failed`，真实目标 item 未被误标 completed。

   设计缺口：`writeQmdBuildManifest` 在所有 CLI checks 通过后才写入，因此本案失败
   后 `qmdBuildStatus` 仍显示 `pending/qmd_build_manifest_missing`。这不破坏
   completion gate，但会让已完成的 qmd/native command 进度不可观测，并提高后续恢复
   的重复检查风险。

4. Failed required evidence must prevent completion and expose the exact failed
   stage.

   PASS。真实 checkpoint、command check、GraphRAG query status 和 events 均暴露
   `failedStage=qmd-query-graphrag-json`；item 保持 failed，没有 completed。
   当前 `graphQueryEvidence` 与 `commandCheckSetEvidence` 仍保留精确失败 stage。

5. A stop-until-fixed decision must stop scheduling further books in the same
   writer process.

   PASS FOR CURRENT DESIGN, FAIL FOR REAL RUN HISTORY。真实运行违反该原则：
   `item_failed` 后两秒启动下一本书。当前代码已把停止条件改为
   `failed + retryable=false + recoveryDecision=stop_until_fixed`，并在处理前和新失败后
   都停止 writer。仍需补充本案精确回归测试，因为现有测试主要覆盖 data compatibility
   或 provider auth stop，而非 generic stop-until-fixed 或本案 query failure。

6. Orphaned runner recovery must preserve checkpoint identity and not corrupt
   adjacent book state.

   PASS。`hydrateBatchCheckpoint` 保留 `sourceIdentityPath`、`sourceHash`、
   `normalizedPath` 和 `bookId`；`recoverOrphanedRunningCheckpoint` 只把 stale running
   item 投影为 `pending/transient/retry_same_run_id`，写入 runner host/pid/heartbeat
   证据，不改相邻书 identity。真实批次中相邻书因人工停止形成 running/orphan 风险，
   但未见目标 item 污染相邻书状态。

7. Provider recovery must be observable in status JSON with retry timing and
   reason.

   PARTIAL FAIL。当前 summary schema 与 projection 包含
   `waitingForProviderRecovery`、`nextRetryAt`、`retryDelaySeconds`、
   `providerRecoveryWaitCount`、`maxProviderRecoveryWaits` 和
   `providerRecoveryReason`，且 `recoverProviderTransientCheckpoint` 会写这些字段。
   但真实 persisted summary 没有这些字段；更重要的是，`--status-json` 仍要求 source
   directory 存在，当前无法对这个真实 run 做只读 legacy projection 验证。status JSON
   设计仍未完全满足“恢复必须可观测”的操作要求。

8. Retrying a failed query must not rebuild unrelated successful artifacts unless
   lineage is stale.

   PASS WITH OBSERVABILITY GAP。单书 resume 以 `BookResumePlan.nextStage` 为准；
   当 GraphRAG high-cost stages 已成功且 `nextStage=null` 时，batch 只进入 query 与
   CLI checks，不应重建 `graph_extract`、`community_report` 或 `embed`。当前
   GraphRAG build evidence 还校验 producer run、stage fingerprint、provider
   fingerprint、content hash 和 book-scoped output。缺口仍是 qmd build manifest
   晚写：query failure 后 qmd build evidence 可能看似 missing，建议拆分 qmd build
   evidence 与完整 command check evidence，避免恢复策略误读。

9. Docs and runbooks must describe the operator action for provider query
   outages.

   FAIL。runbook 描述了 provider transient、recovery wait、`nextRetryAt` 和同一
   runId 恢复，但没有明确说明本案结构化
   `qmd-query-graphrag-json` JSON：
   `provider=graphrag`、`capability=graph_query`、
   `code=provider_unavailable`、`redactedMessage=GraphRAG query provider failed before
   returning a response`。也没有说明即便 payload 内 `retryable=false`，batch 层应按
   provider outage 观察 `waitingForProviderRecovery`、等待 `nextRetryAt`、使用同一
   runId 恢复，且不得删除 book output 或新建 runId 掩盖失败。

10. Tests must pin retry classification and batch stop behavior for this case.

   FAIL。现有测试覆盖了大量相邻行为，但没有本案完整 fixture：
   persisted `failed/unknown/retryable=false/stop_until_fixed` checkpoint，failed
   command 为 `qmd-query-graphrag-json`，errorSummary 是本案结构化 JSON，GraphRAG build
   evidence succeeded，GraphRAG query evidence failed。也未见 same-writer 在本案
   query failure 后不得启动下一本书的专门测试，未见 provider recovery observability
   字段与不重建 high-cost artifacts 的组合断言。

## 必须修复项

1. 修正 typed GraphRAG provider error taxonomy。

   将 provider 未配置（configuration unavailable）与 provider runtime outage
   （failed before returning a response）分流。至少应保证 runtime outage 的 typed
   payload 带有可恢复 hint，例如 `retryable=true` 或单独 code；provider not configured
   才保持 non-retryable。batch classifier 不应成为唯一能辨别二者的层。

2. 让真实 run 的 status projection 不依赖仍存在的 source directory。

   `--status-json` 对已有 `manifest.json` 和 `items/*.json` 的只读观测，应能在 source
   root 不可用时降级为 checkpoint-only projection，至少输出 failed/recovery 状态、
   retry timing、reason 和 runner ownership。否则 provider recovery 对真实事故不可观测。

3. 补充本案结构化 provider outage 的 runbook。

   文档必须明确识别 `qmd-query-graphrag-json` 的 structured JSON，说明
   `provider_unavailable` GraphRAG query before-response failure 的 operator action：
   读取 `--status-json`、确认 `waitingForProviderRecovery` 与 `nextRetryAt`、等待 provider
   恢复后用同一 `runId` 续跑，不删除成功 GraphRAG output，不新建 runId 掩盖故障。

4. 补齐精确回归测试。

   测试必须直接使用本案 JSON payload，而不是只用近似文本
   `GraphRAG query provider failed` 或 Jina APIConnectionError 文本。测试应覆盖
   classifier、legacy hydration/status projection、same-writer stop gate 和 GraphRAG
   successful artifacts 不重建。

5. 解耦 qmd build evidence 与完整 CLI command check evidence。

   在 qmd build/native qmd checks 已成功但 GraphRAG query check 失败时，应保留可观测
   qmd build evidence，而不是让 `qmdBuildStatus` 显示 missing。该修复可减少恢复时重复
   无关检查的风险。

## 建议修复范围

- `src/query/unified-router.ts`

  拆分 `provider_unavailable` 的配置缺失与 runtime outage，或在 metadata 中加入
  `providerFailureKind=configuration|runtime_before_response`。runtime outage 应输出
  batch 可直接信任的 retryability 或 recovery hint。

- `scripts/graphrag/batch-failure-classifier.mjs`

  保留当前 typed JSON 解析规则，并把结构化字段投影到分类 metadata，便于 summary 和
  events 解释 provider/capability/code。增加 provider not configured 的负例，避免所有
  `provider_unavailable` 都被无条件 transient 化。

- `scripts/graphrag/batch-checkpoint-hydration.mjs`

  对本案 legacy failed checkpoint 增加 fixture，确认 old
  `retryable=false/stop_until_fixed` 会经当前 taxonomy 投影为
  `pending/transient/retry_same_run_id`，并保留 `failedStage=qmd-query-graphrag-json`。

- `scripts/graphrag/batch-epub-workflow.mjs`

  增加 checkpoint-only status path；补强 generic `stop_until_fixed` 测试；在 qmd build
  证据可证明时提前持久化 qmd build manifest，或把 qmd native check evidence 与 graph
  query check evidence 分离。

- `docs/operations/graphrag-epub-batch-runbook.md`
  和 `docs/operations/graphrag-epub-resume-boost.md`

  增加“GraphRAG query provider outage”小节，列出本案 JSON、预期 status 字段、同一
  runId 恢复命令、等待策略、provider wait limit 后动作，以及不得删除/重建成功产物的
  边界。

## 测试建议

1. Classifier unit test。

   输入完整 JSON：

   ```json
   {
     "schemaVersion": "1.0.0",
     "route": "graphrag",
     "stage": "graphrag_query",
     "provider": "graphrag",
     "capability": "graph_query",
     "code": "provider_unavailable",
     "retryable": false,
     "redactedMessage": "GraphRAG query provider failed before returning a response."
   }
   ```

   断言 `failureKind=transient`、`retryable=true`，并增加 provider not configured
   负例。

2. Legacy hydration/status-json test。

   构造 persisted checkpoint：
   `status=failed`、`failureKind=unknown`、`retryable=false`、
   `retryExhausted=true`、`recoveryDecision=stop_until_fixed`、
   `failedStage=qmd-query-graphrag-json`，failed command errorSummary 为本案 JSON。
   断言 status projection 为 `pending/transient/retry_same_run_id`，
   `waitingForProviderRecovery=true`，并包含 `nextRetryAt`、`retryDelaySeconds`、
   `retryBudgetSeconds`、`providerRecoveryReason`。

3. Same-writer stop test。

   用两本书 fixture 让第一本在 `qmd-query-graphrag-json` 产生本案结构化 JSON。若分类
   被故意改坏而形成 `stop_until_fixed`，writer 必须写
   `batch_stopped_after_non_transient_failure`，且不得对第二本写 `item_start` 或
   `command_start`。该测试固定 principle 5 的通用 stop gate。

4. Provider recovery live-run test。

   用 test qmd runner 在 `qmd-query-graphrag-json` 第一次返回本案 JSON，断言 checkpoint
   进入 provider recovery wait，而不是 failed permanent；到达 retry window 后只重跑
   query/CLI 检查，不重跑 GraphRAG high-cost stages。

5. No unrelated rebuild test。

   构造 graph build lineage succeeded、producer run ids 固定、`nextStage=null` 的失败
   query checkpoint。续跑后断言 `graph_extract`、`community_report`、`embed` 的
   producer run ids、artifact ids、stage fingerprints 不变；只有 GraphRAG query command
   check 被重试。

6. Source-missing status-json test。

   对已有 manifest/checkpoint 但 source directory 缺失的 run，`--status-json` 应仍能
   输出 checkpoint-only recovery summary，而不是因 missing source directory 退出。
