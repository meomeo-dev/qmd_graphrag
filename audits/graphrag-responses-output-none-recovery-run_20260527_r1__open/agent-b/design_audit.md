# GraphRAG Responses Output None Recovery 设计审计

## 结论

`graphrag-responses-output-none-recovery` 应按受控的 provider/adapter
transient failure（提供方/适配器瞬态失败）处理，而不是保持
`failureKind=unknown`。本次真实失败的直接证据显示，GraphRAG
`extract_graph` 工作流报出的 `"'NoneType' object is not iterable"` 不是本地
artifact gate、输入数据兼容性（data compatibility）或业务代码不变量失败；
它发生在 `python/qmd_graphrag/graphrag_responses_completion.py` 的
`_completed_response_output_text()` 读取 OpenAI SDK `response.output_text` 属性时。
SDK 的该属性访问因为底层 `response.output` 为 `None` 抛出 TypeError，随后被
GraphRAG 折叠为 `extract_graph` workflow failure。

批处理层应把这类已定位到 OpenAI Responses completed response
`output=None` 的错误映射为：

```json
{
  "failureKind": "transient",
  "retryable": true,
  "recoveryDecision": "retry_same_run_id",
  "waitingForProviderRecovery": true
}
```

该分类必须受 structured evidence（结构化证据）或窄文本证据约束。不能把所有
Python `TypeError`、所有 `NoneType`、或所有 GraphRAG `extract_graph` 失败都
作为 transient 重试，否则会掩盖真实 GraphRAG 代码缺陷并造成高成本无限循环。

## Blocking Findings

1. 当前 failure classifier 对 Responses `output=None` 缺少可恢复分类。

   `scripts/graphrag/batch-failure-classifier.mjs` 只将 provider status code
   429/5xx、DNS/TLS/connect/reset/timeout/rate-limit、GraphRAG partial-output
   等文本归入 transient。真实失败的 operator-facing 文本是
   `GraphRAG index workflow failed: [{"workflow":"extract_graph","errorMessage":"'NoneType' object is not iterable"}]`，
   没有 provider status code、`Responses API transient error`、`timeout` 或
   网络关键字，因此落入 `unknown/retryable=false`。

2. Responses 适配器丢失了 provider 边界语义。

   日志显示错误栈位于
   `_completed_response_output_text(completed_response)` 读取
   `response.output_text`。OpenAI SDK 的 `output_text` 属性内部迭代
   `response.output`，当 `output` 为 `None` 时抛出
   `TypeError: 'NoneType' object is not iterable`。适配器没有把该情况转换为
   typed provider error（类型化提供方错误），导致批处理层只能看到普通
   Python TypeError。

3. 当前 checkpoint/status-json/recovery-summary 投影错误阻塞整批。

   真实 checkpoint 中，目标 item 为：
   `status=failed`、`failureKind=unknown`、`retryable=false`、
   `retryExhausted=true`、`recoveryDecision=stop_until_fixed`、
   `failedStage=resume-book-1`。`recovery-summary.json` 同步投影为
   manifest `status=failed`、batch `recoveryDecision=stop_until_fixed`，
   使 32 个 pending items 无法继续调度。该投影与 provider transient
   recovery 设计不一致。

4. GraphRAG 层会吞掉部分 extract errors，造成最终错误语义漂移。

   GraphRAG `GraphExtractor.__call__()` 会捕获单个 text unit 的异常并返回空
   entities/relationships；后续汇总或描述 summarization 仍可能再次触发同类
   provider/adapter 错误。最终 workflow error 只保留
   `extract_graph` 和 TypeError 文本，缺少 response id、Responses event type、
   output 是否缺失、adapter function、retry attempts 等关键恢复证据。

5. 现有 retry 防线不足以区分 transient provider anomaly 与真实代码 bug。

   `runCommand()` 只根据 `classifyFailure(failureText)` 决定命令级重试；
   `recoverProviderTransientCheckpoint()`、hydration 和 status-json 也依赖同一
   分类结果。若简单把 `NoneType` 文本加入 transient token，会把任何本地代码
   的 `NoneType` 误判为 provider outage，突破当前 `stop_until_fixed` 保护。

## 建议设计

### 1. 分类模型

新增窄分类：`responses_output_none`，语义为 OpenAI Responses API completed
response 缺少可迭代 `output` 或缺少可用 text output，导致 SDK/adapter 在
Responses compatibility projection（兼容投影）阶段失败。

建议保持外部 contract 的 `failureKind` 不新增枚举，仍投影为：

- `failureKind=transient`
- `retryable=true`
- `recoveryDecision=retry_same_run_id`
- `providerStatusCode` 仅在真实 upstream status code 可得时填写
- `retryAfterSeconds` 仅在真实 Retry-After 可得时填写

细分类不要塞进 `failureKind`，应进入 metadata 或 structured error payload：

- `provider=openai_responses`
- `stage=responses_completion`
- `capability=graph_extract_completion`
- `code=responses_output_none`
- `retryable=true`
- `redactedMessage=OpenAI Responses completed response did not contain output text.`
- `adapterFunction=_completed_response_output_text`
- `graphWorkflow=extract_graph`
- `sdkProjection=response.output_text`

### 2. Evidence Gate

只有满足以下任一证据组合，才允许归入 transient provider recovery：

1. Structured evidence（推荐）：
   错误文本中存在 schemaVersion `1.0.0` 的 typed provider payload，且
   `provider=openai_responses`、`code=responses_output_none`、
   `retryable=true`。

2. 窄文本证据：
   同一失败文本同时包含全部关键锚点：
   `GraphRAG index workflow failed`、`workflow":"extract_graph"`、
   `"'NoneType' object is not iterable"`，并且包含
   `graphrag_responses_completion.py` 或 `_completed_response_output_text` 或
   `response.output_text`。

3. 日志补充证据：
   command stderr 只保留 GraphRAG workflow summary 时，可以通过同一 stage 的
   sanitized log evidence locator 读取或摘要出：
   `_completed_response_output_text`、`response.output_text`、
   `TypeError: 'NoneType' object is not iterable`。该摘要应进入 checkpoint
   metadata，而不是把原始日志全文写入 recovery-summary。

仅有 `"'NoneType' object is not iterable"`、仅有 `extract_graph`、或仅有
`TypeError` 不得归入 transient。

### 3. Adapter Boundary

根修复应优先在 Python Responses adapter 中完成，而不是只在 batch classifier
加文本匹配。

建议 `_completed_response_output_text()` 不直接访问可能抛出 TypeError 的
`response.output_text` 属性。应先读取原始 `response.output`：

- 如果 `response.output` 是 list/tuple 且可提取 text，正常返回。
- 如果 `response.output is None`，抛出 typed transient error：
  `OpenAIResponsesTransientError(kind="responses_output_none", status_code=None, ...)`。
- 如果 response event 是 `response.failed` 或 `response.incomplete`，继续使用
  现有 `_raise_stream_failure()` 语义。
- 如果是 schema/adapter programming error（例如参数配置错误、非 Responses
  transport、非 strict structured output），保持 non-transient。

该 typed error 经 `_run_with_responses_recovery()` 重试耗尽后，应保留
`Responses API transient failure after N attempts` 和
`kind=responses_output_none`，让 JS classifier 无需依赖 Python traceback。

### 4. 防止真实代码 bug 无限重试

必须设置四层边界：

1. 文本匹配边界：
   transient 匹配必须锚定 provider adapter 或 typed provider payload。
   禁止宽泛匹配 `NoneType`、`not iterable`、`TypeError`、`extract_graph error`。

2. 重试预算边界：
   保留现有 `maxTransientCommandAttempts`、`retryBudgetSeconds`、
   `maxProviderRecoveryWaits`。预算耗尽后仍保持
   `recoveryDecision=retry_same_run_id` 和 provider wait 投影，但 runner 应退出
   当前调度循环，避免热循环。

3. 稳定失败升级边界：
   对同一 `itemId + failedStage + code + adapterFunction` 连续达到 provider wait
   上限后，不应转成 permanent，也不应继续本进程重试；应进入 observable
   provider wait limit（可观察的提供方等待上限）状态，等待 operator 或下一次
   runner。

4. 非 provider TypeError 边界：
   下列情况应保持 `unknown` 或 `permanent/data_compatibility`：
   本地 artifact identity mismatch、parquet/lancedb gate、settings projection、
   GraphRAG data compatibility、provider auth 401/403、schema validation、
   import/module errors、以及没有 Responses adapter 锚点的 Python TypeError。

### 5. Batch/Status/Recovery Summary 投影

对于已分类的 `responses_output_none` transient，checkpoint 应投影为：

```json
{
  "status": "pending",
  "failureKind": "transient",
  "retryable": true,
  "retryExhausted": false,
  "recoveryDecision": "retry_same_run_id",
  "failedStage": "resume-book-1",
  "nextRetryAt": "<iso timestamp>",
  "retryDelaySeconds": "<policy or Retry-After delay>",
  "retryBudgetSeconds": "<configured budget>",
  "metadata": {
    "waitingForProviderRecovery": true,
    "providerRecoveryReason": "responses_output_none",
    "provider": "openai_responses",
    "providerFailureCode": "responses_output_none",
    "graphWorkflow": "extract_graph",
    "adapterFunction": "_completed_response_output_text"
  }
}
```

`status-json` 和 `recovery-summary.json` 应同步暴露：

- item `status=pending`
- item `failureKind=transient`
- item `retryable=true`
- item `recoveryDecision=retry_same_run_id`
- item `waitingForProviderRecovery=true`
- item `providerRecoveryReason=responses_output_none`
- item `providerRecoveryWaitCount` 和 `maxProviderRecoveryWaits`
- item `nextRetryAt`、`retryDelaySeconds`、`retryBudgetSeconds`
- batch `recoveryDecision=retry_same_run_id`
- manifest 不应因该 item 进入 `failed`，除非存在其他 non-transient failed item

若旧 checkpoint 已持久化为
`unknown/retryable=false/stop_until_fixed`，hydration 或 status-json recovery pass
应在满足 evidence gate 时重分类为 transient，并记录：

- `metadata.reclassifiedByCurrentFailureClassifier=true`
- `metadata.originalFailureKind=unknown`
- `metadata.originalRecoveryDecision=stop_until_fixed`
- `metadata.providerRecoveryReason=responses_output_none`

### 6. Observability

事件日志建议新增或复用以下事件语义：

- `command_failed`：
  `failureKind=transient`、`retryable=true`、
  `recoveryDecision=retry_same_run_id`、`failedStage=resume-book-1`。
- `item_retry_deferred` 或 `item_provider_recovery_wait`：
  metadata 包含 `providerRecoveryReason=responses_output_none`。
- `command_attempt_budget_exhausted`：
  对 transient 仍应投影 `recoveryDecision=retry_same_run_id`，不得写成
  `stop_until_fixed`。
- `batch_provider_recovery_wait_limit`：
  当 wait 上限触发时，batch manifest 应为 `incomplete` 或仍可恢复状态，不应
  伪装成 permanent failure。

raw stdout/stderr 和 traceback 不应进入 recovery-summary；只保留 redacted
summary、typed code 和 evidence locator。

## 回归测试要求

1. Python adapter unit test：
   模拟 `response.completed` 携带 `response.output=None` 且访问
   `response.output_text` 会抛出 TypeError。断言
   `_collect_response_stream()` 和 `_collect_response_stream_async()` 抛出或重试
   typed transient error，错误文本含 `kind=responses_output_none`，不泄露
   URL、API key 或 prompt content。

2. Python retry test：
   第一次返回 `output=None`，第二次返回有效 delta/completed。断言
   `_run_with_responses_recovery()` 会重试并最终返回有效 completion；非
   transient `ValueError("strict schema validation failed")` 仍只尝试一次。

3. JS classifier test：
   对 typed payload
   `provider=openai_responses/code=responses_output_none/retryable=true` 断言
   `classifyFailure()` 返回 transient/retryable。

4. JS narrow traceback classifier test：
   对包含 `GraphRAG index workflow failed`、`extract_graph`、
   `_completed_response_output_text`、`response.output_text` 和
   `TypeError: 'NoneType' object is not iterable` 的文本断言 transient；对仅含
   `"'NoneType' object is not iterable"` 的文本断言仍为 unknown。

5. Legacy checkpoint hydration/status-json test：
   构造旧 checkpoint：
   `failed/unknown/retryable=false/stop_until_fixed`，command check errorSummary 为
   本次失败摘要并带 adapter evidence。断言 `--status-json` 输出 item 为
   `pending` 或 recoverable transient projection，batch
   `recoveryDecision=retry_same_run_id`，`waitingForProviderRecovery=true`。

6. Recovery-summary projection test：
   断言 `recovery-summary.json` 中目标 item 暴露
   `providerRecoveryReason=responses_output_none`、`providerRecoveryWaitCount`、
   `nextRetryAt`、`retryBudgetSeconds`，且 `retryableItemCount` 包含该 item。

7. Batch stop behavior test：
   同批包含一个 `responses_output_none` item 和后续 pending item。断言 runner
   不发出 `batch_stopped_after_non_transient_failure`，不会把该 transient item
   设置为 `failed/stop_until_fixed`，并按 retry window/provider wait 策略退出或
   延迟。

8. Negative tests：
   下列文本不得被误判为 transient：
   `TypeError: 'NoneType' object is not iterable`；
   `GraphRAG index workflow failed: [{"workflow":"extract_graph","errorMessage":"local parser TypeError"}]`；
   parquet/lancedb artifact mismatch；
   settings projection rejection；
   provider auth 401/403；
   GraphRAG data compatibility failure。

## 验收标准

1. 真实失败等价文本在 classifier 中返回
   `failureKind=transient`、`retryable=true`，但必须依赖 typed payload 或
   Responses adapter 锚点，不能依赖宽泛 `NoneType` token。

2. Responses adapter 对 `response.output=None` 产生 typed transient error
   `responses_output_none`，并在 retry exhausted message 中保留该 code。

3. 同一 runId 下的旧 checkpoint 可通过 status-json/hydration 被重分类为
   recoverable transient；输出不再显示目标 item 为
   `failed/unknown/stop_until_fixed`。

4. `recovery-summary.json` 与 `--status-json` 输出一致，batch
   `recoveryDecision=retry_same_run_id`，目标 item
   `waitingForProviderRecovery=true`，并显示 retry timing。

5. 对该 transient item，事件日志不出现
   `batch_stopped_after_non_transient_failure`；若 provider wait 上限触发，只出现
   provider wait limit 事件。

6. 真实本地代码 bug、schema/config 错误、artifact integrity failure、provider
   auth failure 和 data compatibility failure 仍保持 non-transient 或 unknown，
   不进入 provider recovery。

7. 所有新增测试覆盖 sync/async Responses stream、JS classifier、legacy
   checkpoint hydration、status-json、recovery-summary 和 negative guard cases。

8. recovery-summary、events 和 checkpoint 中只写入 redacted summary、typed code
   和 locator；不得写入 `.env`、secret、raw provider request、prompt 全文或未脱敏
   traceback。
