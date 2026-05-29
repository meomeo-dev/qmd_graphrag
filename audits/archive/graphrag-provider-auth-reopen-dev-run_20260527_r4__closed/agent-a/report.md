# GraphRAG Batch Provider Auth Reopen r4 开发审计报告

结论：FAIL

审计范围：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- r3 审计报告：`audit/graphrag-provider-auth-reopen-dev-run_20260527__closed_r3__closed`

未读取、打印、摘要或暴露任何真实 `.env` 密钥值。审计只使用
present/missing、source、fingerprint、redacted、readiness 与 blocked reason
语义。

## 基准结果

1. PASS - Provider auth failure 判定范围正确。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:781` 到 `794` 将 provider auth
     failure 限定为 401、403、`invalid api key`、`invalid_api_key`、
     `unauthorized`、`forbidden`、`authentication`。
   - `test/cli.test.ts:6029` 到 `6226` 覆盖 unrecoverable provider auth failure
     stop-before-next-book；`test/cli.test.ts:7539` 到 `7640` 覆盖运行期 401 后
     不继续处理下一本。

   测试证据：

   - 聚焦测试通过：`unrecoverable provider auth failure stops before next book`。
   - 聚焦测试通过：`runtime provider auth failure stops before next book`。

   风险：认证失败文本仍包含较宽的 `authentication` token，但只作用于 provider
   auth recovery 路径，当前测试覆盖关键误继续风险。

   must-fix：无。

2. PASS - Provider auth reopen 候选条件和重开目标正确。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:1005` 到 `1010` 只允许
     `failed + retryable=false + stop_until_fixed + auth failure` 成为 candidate。
   - `scripts/graphrag/batch-epub-workflow.mjs:1162` 到 `1249` 将重开 checkpoint
     写为 `pending`、`recoveryDecision=continue_pending`、清空 failed 字段和
     `commandChecks`，并设置 `normalCommandChecksRequired=true`。
   - `scripts/graphrag/batch-epub-workflow.mjs:4719` 到 `4788` 真实 completed 只在
     normalize、GraphRAG resume、qmd checks、GraphRAG build、GraphRAG query 全部
     成功后写入。

   测试证据：

   - 聚焦测试通过：`provider auth repair reopens legacy checkpoint once and reruns
     closed loop`。

   风险：无新增阻断风险。

   must-fix：无。

3. PASS - Provider auth context fail-closed。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:802` 到 `838` 读取 provider
     config，纳入 OpenAI/Jina key env 和 endpoint env；`OPENAI_BASE_URL` 在
     `requiredEndpointNames` 中。
   - `scripts/graphrag/batch-epub-workflow.mjs:912` 到 `918` 对 config invalid、
     missing required names、process env shadow 依次 fail-closed。
   - `scripts/graphrag/batch-epub-workflow.mjs:927` 到 `944` 只投影 redacted error、
     required names、presence、source、fingerprint 和 present flags。

   测试证据：

   - 聚焦测试通过：`provider auth status-json blocks missing OpenAI base URL`。
   - 聚焦测试通过：`provider auth status-json blocks missing OpenAI API key`。
   - 聚焦测试通过：`provider auth status-json blocks unreadable provider config`。

   风险：无新增阻断风险。

   must-fix：无。

4. PASS - `graph_vault/.env` 优先级和 `--skip-dotenv` 行为正确。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:1781` 到 `1794` 默认按项目 `.env`
     后 `graph_vault/.env` 顺序加载；后者在不是初始 shell env 时可覆盖前者。
   - `scripts/graphrag/batch-epub-workflow.mjs:842` 到 `873` 投影
     `graph_vault_dotenv_shadows_project_dotenv`、`dotenv_not_loaded` 等 source
     语义。

   测试证据：

   - 聚焦测试通过：`provider auth status-json lets graph_vault dotenv override root
     dotenv`。
   - 聚焦测试通过：`skip-dotenv blocks provider auth reopen when only dotenv has
     required values`。

   风险：无。

   must-fix：无。

5. PASS - Shell env shadow fail-closed。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:848` 到 `867` 识别初始 process env；
     若 observed provider env 与 dotenv 不一致，返回
     `process_env_shadows_dotenv`。
   - `scripts/graphrag/batch-epub-workflow.mjs:897` 到 `917` 将 shadowed env names
     纳入 readiness，且 readiness 变为 `process_env_shadows_dotenv`。

   测试证据：

   - 聚焦测试通过：`status-json blocks provider auth reopen when shell env shadows
     dotenv`。
   - 聚焦测试通过：`status-json blocks provider auth reopen when observed endpoint
     env shadows dotenv`。
   - 聚焦测试通过：`status-json current provider auth readiness overrides stale
     reopen metadata`。

   风险：无。

   must-fix：无。

6. PASS - Provider auth fingerprint 决策有界且顺序稳定。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:984` 到 `988` 以历史 fingerprint
     数组长度和显式 attempt count 的最大值作为 attempt count，避免降级。
   - `scripts/graphrag/batch-epub-workflow.mjs:1028` 到 `1067` 的判断顺序为
     context not ready、current fingerprint missing、attempt limit、unchanged
     fingerprint、already reopened fingerprint。
   - `scripts/graphrag/batch-epub-workflow.mjs:122` 固定
     `maxProviderAuthReopenAttempts=3`。

   测试证据：

   - 聚焦测试通过：`provider auth reopen respects attempt limit without count
     downgrade`。
   - 聚焦测试通过：`provider auth status-json blocks already reopened current
     fingerprint`。
   - 聚焦测试通过：`provider auth status-json blocks unchanged current fingerprint`。
   - 聚焦测试通过：`provider auth refailure clears stale reopen eligibility`。

   风险：无。

   must-fix：无。

7. PASS - 非候选 completed item 不再投影旧 provider auth reopen 当前状态。

   证据：

   - r3 agent-a 的 FAIL 指向旧逻辑在非候选分支复制旧
     `providerAuthReopenDecision`、`providerAuthReopenEligible`、readiness 和当前
     fingerprint。
   - 当前 `scripts/graphrag/batch-epub-workflow.mjs:1080` 到 `1100` 在
     `decision.candidate=false` 时只保留历史 `providerAuthFailureFingerprint`、
     `lastProviderAuthReopenFingerprint`、`providerAuthReopenAttemptCount` 和
     `legacyProviderAuthFingerprintMissing`，不输出 reopen decision、eligible、
     reason、blocked reason、current fingerprint、readiness 或 credential sources。
   - `scripts/graphrag/batch-epub-workflow.mjs:3690` 到 `3765` recovery summary
     通过 `providerAuthSummaryProjection(item)` 投影该逻辑。

   测试证据：

   - 聚焦测试通过：`status-json does not project stale provider auth reopen state on
     completed item`。该测试断言 status-json 不写 checkpoint，并且 summary 中
     completed item 不包含旧 reopen decision/eligible/reason/readiness/current
     fingerprint。

   风险：checkpoint metadata 仍保存历史 reopen 字段；summary 已避免将其表达为当前
   决策。若后续新增 UI 直接读取 checkpoint metadata，需要复用 summary 语义。

   must-fix：无。

8. PASS - Stale GraphRAG producer lineage 不再误报 artifact missing。

   证据：

   - r3 agent-c 的 FAIL 是 `stageCandidateArtifacts()` 先按 expected producer run id
     过滤，导致 artifact 存在但 lineage stale 时退化为 `stage_artifact_missing`。
   - 当前 `scripts/graphrag/batch-epub-workflow.mjs:2829` 到 `2859` 的 candidate
     收集只按 book、stage/kind 或 checkpoint artifact id 收集，不再按
     `producerRunId` 提前丢弃。
   - `scripts/graphrag/batch-epub-workflow.mjs:2885` 到 `2898` 在详细校验中返回
     `stage_artifact_producer_run_mismatch:<stage>`。
   - `scripts/graphrag/batch-epub-workflow.mjs:3033` 到 `3061` 将候选交给
     `selectValidStageArtifacts()`，保留 mismatch reason。

   测试证据：

   - 聚焦测试通过：`status-json reopens completed items with stale GraphRAG producer
     lineage`，断言 reason 匹配
     `stage_artifact_producer_run_mismatch:community_report`。

   风险：当前测试覆盖 `community_report`；同类 producer stage 中
   `graph_extract`、`embed` 的机制相同但未在本次过滤中分别命名覆盖。

   must-fix：无。

9. PASS - Provider auth reopen 与 item start 有锁、CAS、防重复和 lease 保护。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:1850` 到 `1877` 使用 lock 文件保护
     JSON read/write；`scripts/graphrag/batch-epub-workflow.mjs:1879` 到 `1886`
     在锁内读取当前 JSON、schema parse、写入。
   - `scripts/graphrag/batch-epub-workflow.mjs:1285` 到 `1314` provider auth reopen
     在锁内重读 checkpoint，比对 status、attempts、failedAt、recoveryDecision、
     runnerSessionId、runnerHeartbeatAt，并重新计算 decision。
   - `scripts/graphrag/batch-epub-workflow.mjs:4824` 到 `4882` item start 在锁内
     重读并比较 status、attempts、completedAt、failedAt、runnerSessionId、
     runnerHeartbeatAt 后才写入本 runner lease。

   测试证据：

   - 聚焦测试通过：`status-json does not steal fresh remote running items`。
   - 聚焦测试通过：`status-json projects stale remote running items as retryable
     pending`。
   - 聚焦测试通过：`normal run does not steal fresh remote running items`。
   - 聚焦测试通过：`normal run recovers stale remote running items before processing`。

   风险：没有专门的双进程压力测试证明两个真实进程同时竞争同一 pending item 时只有
   一个进入 fake runner；代码级 CAS 已覆盖关键字段。

   must-fix：无。

10. FAIL - `migrate-only` 仍会把缺闭环证据的既有 completed 计入 completed。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:2158` 到 `2168` 的 `migrateOnly`
     分支只 hydrate、写入 build status snapshot 和 persistence invariant，跳过
     `downgradeCompletedIfClosedLoopInvalid()`。
   - `scripts/graphrag/batch-epub-workflow.mjs:2170` 到 `2175` 只有非 migrate-only
     路径会调用 `downgradeCompletedIfClosedLoopInvalid()`。
   - `scripts/graphrag/batch-epub-workflow.mjs:3398` 到 `3468` 的 completed
     降级逻辑要求 command check set、qmd build、GraphRAG build、GraphRAG query
     全部 succeeded，但 migrate-only 不执行该降级。
   - `scripts/graphrag/batch-epub-workflow.mjs:3605` 到 `3620` 的 manifest count
     直接按 checkpoint `status === "completed"` 计数，不要求闭环证据。
   - `test/cli.test.ts:8596` 到 `8724` 明确断言
     `migrate-only preserves completed items without real GraphRAG evidence`：测试夹具中
     checkpoint 为 `status=completed` 且没有真实 GraphRAG evidence，运行
     `--migrate-only` 后 manifest 仍为 `status=completed`、`completedItems=1`，
     summary item 仍为 `status=completed`，同时 `graphBuildStatus.status=pending`、
     reason=`real_graphrag_stage_missing`。

   测试证据：

   - 聚焦测试通过：`migrate-only preserves completed items without real GraphRAG
     evidence`。该测试通过本身证明当前实现保留并计数缺 GraphRAG evidence 的
     completed。
   - 聚焦测试通过：`status-json reopens completed items when GraphRAG query check
     failed`。
   - 聚焦测试通过：`status-json reopens completed items with incomplete command check
     set`。
   - 聚焦测试通过：`status-json reopens completed non-transient failed checks with
     valid schema`。
   - 聚焦测试通过：`non-migrate runs reopen skipped items for real build`。

   风险：

   - `status-json` 对缺 query、缺 qmd checks、stale producer lineage 的 completed
     会投影为 pending，不写回磁盘，这是正确的只读行为。
   - `migrate-only` 作为写入型迁移模式会产出一个语义矛盾状态：manifest 与 item
     仍显示 completed，但 embedded build status 明确显示 GraphRAG 缺证据。若运营者把
     migrate-only 后的 manifest 作为真实批处理闭环完成依据，会误判完成率。
   - 这不等同于 r3 的两个 FAIL；r3 两个 FAIL 已修复。本项是 r4
     “真实批处理闭环状态要求”的 FAIL。

   must-fix：

   - `--migrate-only` 不得把缺 qmd、缺 GraphRAG build、缺 GraphRAG query、
     skipped/imported seed 的 item 计入真实 `completedItems` 或 batch
     `status=completed`。
   - 保持迁移不启动真实工作，但应把缺闭环证据的 item 投影或迁移为非 completed
     状态，或引入明确的 legacy/migrated historical completed 字段，避免与真实
     completed 计数混用。
   - 更新 `migrate-only preserves completed items without real GraphRAG evidence`
     测试，改为断言 migrate-only 后 manifest 不再把该 item 计入真实 completed；同时
     保留一条只读历史字段断言，证明迁移没有删除历史信息。

## 测试记录

已运行聚焦测试：

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 120000 test/cli.test.ts \
  -t "provider auth|test qmd runner hook is not activated from dotenv|status-json reopens completed items with stale GraphRAG producer lineage|status-json reopens completed items when GraphRAG query check failed|status-json reopens completed items with incomplete command check set|status-json reopens completed non-transient failed checks|migrate-only preserves completed|non-migrate runs reopen skipped|reconciles existing manifest|duplicate EPUB|redacts exact environment values|redacts URL credentials"
```

结果：1 个测试文件通过；26 个相关测试通过；178 个测试跳过。

已运行 running/lease 聚焦测试：

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 120000 test/cli.test.ts \
  -t "remote running|checkpoint changed|duplicate runner|status-json does not steal fresh remote running|normal run does not steal fresh remote running|normal run recovers stale remote running"
```

结果：1 个测试文件通过；4 个相关测试通过；200 个测试跳过。

## Must Fix

1. 修正 `--migrate-only` 的 completed 语义：缺 qmd、缺 GraphRAG build、缺 GraphRAG
   query、skipped/imported seed 或其他缺闭环证据的 item 不得继续计入真实
   `completedItems`，batch 不得因此保持 `status=completed`。

2. 更新对应测试，把
   `migrate-only preserves completed items without real GraphRAG evidence` 从“保留并计数
   completed”改为“保留历史信息但不计入真实 completed”。

3. 明确区分历史迁移状态与真实闭环完成状态。若必须保留 legacy completed，应使用
   `legacyCompletedItems`、`historicalCompletedAt` 或同等字段，不得复用当前
   `completedItems` 与 item `status=completed` 表达真实完成。
