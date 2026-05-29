# GraphRAG Responses Output None Recovery Design Audit

## 结论

不通过（FAIL）。

真实失败不应归类为 data issue。失败发生在 OpenAI Responses wrapper
消费 `response.completed` payload 的边界：服务端或网关返回了完成事件，但完成
对象的 `output` 为 `None`。本地 OpenAI SDK 的 `Response.output_text`
便利属性会无条件遍历 `self.output`，因此在 `output=None` 时抛出
`TypeError: 'NoneType' object is not iterable`。当前 wrapper 直接访问该
property，把 provider payload 异常转换成裸 Python `TypeError`，随后绕过
已有 transient recovery，最终被 GraphRAG/batch 层记录为 unknown 和
`stop_until_fixed`。

根因分类（root-cause classification）如下：

- 主分类：wrapper bug。wrapper 在恢复敏感路径依赖 SDK convenience property，
  未在自身边界验证 Responses 完成对象的 shape、status、error、
  incomplete/refusal 信号。
- 触发因素：SDK compatibility / provider malformed payload。OpenAI SDK
  2.24.0 和本地 `.venv-graphrag` 的 2.37.0 都假设 `Response.output` 可迭代；
  当前网关/服务端实际返回了 `output=None`。
- 操作恢复分类：仅当完成响应 `output=None`、没有已收集文本、没有 explicit
  failure/refusal/content-filter/incomplete reason 时，才应按 provider
  transient / malformed completed response 重试。
- 非分类：不是 GraphRAG extract_graph 的数据兼容性问题，也没有证据表明
  `Code that fits in your head...` EPUB 内容本身导致永久失败。

## Evidence

- `python/qmd_graphrag/graphrag_responses_completion.py` 中
  `_completed_response_output_text()` 当前实现为
  `getattr(response, "output_text", "")`。这会触发 SDK property，而不是读取
  原始字段。
- `_collect_response_stream()` 和 `_collect_response_stream_async()` 在
  `response.completed` 后优先调用 `_completed_response_output_text()`。因此即使
  streaming collector 已有 text parts，也会先触发 unsafe SDK property。
- 本地 OpenAI SDK 的 `Response.output_text` property 实现为遍历
  `for output in self.output`。当 `self.output is None` 时会抛出本次真实错误。
- `_run_with_responses_recovery()` 只重试 `_is_transient_responses_error()`
  识别的错误。裸 `TypeError("'NoneType' object is not iterable")` 没有 provider
  status、kind 或 transient token，因此不重试。
- `audits/.../reports/status.yaml` 记录真实失败为
  `GraphRAG index workflow failed: extract_graph error "'NoneType' object is
  not iterable"`，`failureKind=unknown`，`retryable=false`，
  `recoveryDecision=stop_until_fixed`。

## Blocking Findings

1. Unsafe SDK property access blocks recovery.

   wrapper 必须把 Responses API payload 转换成 GraphRAG completion object。
   这个边界不能依赖 `response.output_text`，因为该 property 隐含 SDK 对
   `output` 字段的非空假设。当前设计没有在 wrapper 层隔离 SDK shape
   incompatibility，导致 provider anomaly 变成不可分类的本地 TypeError。

2. `output=None` 和真实空输出（real empty output）没有被区分。

   `output=None` 是 malformed completed payload；`output=[]`、message content
   为空、或 `response.output_text.done` 明确给出空文本，是完成响应中的真实空
   输出。前者可以作为 provider transient 恢复；后者不能静默变成成功的空
   assistant message，也不能无条件重试到掩盖模型真实行为。

3. Refusal 和 content filter 没有显式 fail-closed 路径。

   Responses stream 可能出现 `response.refusal.delta` /
   `response.refusal.done`，完成对象的 message content 也可能包含
   `type="refusal"`。Responses incomplete details 还可能包含
   `reason="content_filter"` 或 `reason="max_output_tokens"`。当前 collector 只
   处理 text delta/done、completed 和三个 failure event type；没有把 refusal
   或 content filter 转成明确的非 transient 失败。

4. `_create_completion_response()` 仍有潜在 unsafe fallback。

   当调用方没有传入 `output_text` 时，该函数也会读取
   `getattr(response, "output_text", "")`。虽然当前 stream collector 多数路径会
   传入 `output_text`，这个 fallback 仍会重新引入同类 SDK property 风险。

5. 错误分类消息必须稳定，不能重新落回 batch unknown。

   Python wrapper 即使改为抛出 typed transient，也必须保证重试耗尽后的
   stderr/errorSummary 被 `scripts/graphrag/batch-failure-classifier.mjs` 识别为
   transient。若新增 kind，例如 `malformed_completed_response`，必须同步更新
   classifier 与 docs；否则仍会从 Python 层可恢复错误退化为 batch unknown。

## 建议设计

### 1. Wrapper 不再读取 `response.output_text`

新增安全提取器（safe extractor），只读取原始字段：

- `response.output`
- `response.status`
- `response.error`
- `response.incomplete_details`
- message content block 的 `type`、`text`、`refusal`

实现原则：

- 不调用 `response.output_text` property。
- 对 Pydantic SDK object、`SimpleNamespace` test double、dict-like payload 都按
  同一字段语义处理。
- `_create_completion_response()` 必须要求调用方传入已提取的 `output_text`，或
  使用同一个安全提取器；不得保留 unsafe property fallback。

### 2. 以 stream text 为主，completed payload 为校验和 usage 来源

collector 已从 `response.output_text.delta` 和 `response.output_text.done`
收集文本。完成事件到达后应按以下顺序处理：

1. 若 stream text 非空，使用 stream text 生成 GraphRAG completion；完成对象只
   用于 response id、created_at 和 usage。即使完成对象 `output=None`，也不应
   触发 retry，因为响应正文已经通过 SSE text events 完整到达。
2. 若 stream text 为空且 completed payload 中有可安全提取的 output text，使用
   completed payload text。
3. 若 stream text 为空且 `output is None`，且没有 error、incomplete/refusal/
   content-filter 信号，抛出 `OpenAIResponsesTransientError`。建议使用现有
   classifier 已识别的 kind，例如 `kind="server_error"`，message 包含
   `completed response output was null`，避免 batch 层 unknown。
4. 若 stream text 为空且 `output` 是空 list 或 message content 无 output_text，
   抛出非 transient empty-output contract error。对 GraphRAG structured output
   来说，这应 fail closed，不应成功返回空 content。

### 3. 明确 fail-closed 信号

wrapper 应把以下情况转换为非 transient、可诊断错误：

- Refusal：stream 中出现 `response.refusal.done`，或 completed output content
  包含 `type="refusal"`。错误应标记为 refusal，不进入 provider retry。
- Content filter：`response.incomplete` 或 completed response 的
  `incomplete_details.reason == "content_filter"`。错误应标记为 content filter，
  不进入 provider retry。
- Max output tokens：`incomplete_details.reason == "max_output_tokens"`。这通常
  是 request/token budget 问题，应作为非 transient 输出不完整错误处理，除非
  同一 payload 同时包含 provider 5xx/connection transient 证据。
- Explicit response error：若 `response.error` 存在，先按 status/code/message
  分类；5xx、429、timeout、rate/concurrency/network token 仍 transient，其余
  fail closed。

### 4. 错误类型和消息保持恢复可观测

建议保留 `OpenAIResponsesTransientError` 作为 Python retry 入口，并补充一组
内部 helper，而不是把所有异常都转换成 generic `RuntimeError`：

- malformed completed payload：`OpenAIResponsesTransientError(kind="server_error",
  message="completed response output was null")`
- refusal：非 transient `RuntimeError` 或专用 `OpenAIResponsesRefusalError`
- content filter：非 transient `RuntimeError` 或专用
  `OpenAIResponsesContentFilterError`
- empty output：非 transient `RuntimeError` 或专用
  `OpenAIResponsesEmptyOutputError`

如果新增 transient kind，不使用 `server_error`，则必须同步扩展 JS batch
classifier，使重试耗尽后的
`Responses API transient failure after ...` 仍分类为
`failureKind=transient`、`retryable=true`。

### 5. 不把 GraphRAG structured output 解析错误降级为 transient

本次修复只覆盖 Responses wrapper payload shape 和 stream recovery。后续
`structure_completion_response()` 的 Pydantic/JSON/schema 解析失败仍应暴露为真实
GraphRAG structured output failure，除非错误文本同时包含明确 provider
transient 证据。不能用 `output=None` 的 retry 逻辑吞掉 schema violation、
数据兼容性错误或 GraphRAG integrity failure。

## Required Tests

### Python wrapper unit tests

在 `test/python/test_graphrag_responses_completion.py` 增加 focused regression：

- completed response 的 `output=None` 且无 text deltas 时，collector 抛出
  `OpenAIResponsesTransientError`，错误文本包含稳定 provider transient token。
- sync recovery：第一次 `output=None`，第二次正常 text，断言 attempts 为 2 且
  最终 content 正确。
- async recovery：同上，覆盖 `_collect_response_stream_async()` 和
  `_run_with_responses_recovery_async()`。
- completed response 的 `output=None` 但 stream 已收到 text deltas 时，collector
  返回该 stream text，不访问 unsafe `output_text` property。
- completed response 的 `output=[]` 或 message content 无 output_text 时，抛出
  非 transient empty-output error，并断言 recovery 不重试。
- stream `response.refusal.done` 或 completed output content `type="refusal"`
  时，抛出非 transient refusal error，不返回 assistant content。
- `incomplete_details.reason="content_filter"` 或 `response.incomplete` 携带
  content filter reason 时，抛出非 transient content-filter error。
- `incomplete_details.reason="max_output_tokens"` 时，抛出非 transient incomplete
  output error。
- `_create_completion_response()` 测试：不给它机会调用 unsafe SDK property，或
  使用带有会抛 TypeError 的 `output_text` property 的 fake response 证明不会触发。

### Batch/classifier tests

- 如果 Python transient error message 使用新 kind，给 `classifyFailure()` 增加
  精确样例：
  `Responses API transient error kind=<kind> status_code=unknown:
  completed response output was null`，断言 transient/retryable。
- 给 GraphRAG index workflow 包装文本增加样例：
  `GraphRAG index workflow failed: extract_graph error "Responses API transient
  failure after ... completed response output was null"`，断言
  `failureKind=transient`、`retryable=true`。
- 保留负例：`content_filter`、`refusal`、`empty output` 不应分类为 transient。

### End-to-end recovery acceptance tests

- 使用 fake Responses stream 注入 first-attempt `response.completed` with
  `output=None`，second-attempt 正常 structured JSON，证明 extract_graph 不产生
  unknown TypeError。
- 重试耗尽时，batch checkpoint 必须进入 provider recovery wait，而不是
  `stop_until_fixed`：
  `failureKind=transient`、`retryable=true`、`retryExhausted=false`、
  `recoveryDecision=retry_same_run_id`、`nextRetryAt`、`retryDelaySeconds`、
  `metadata.waitingForProviderRecovery=true`。

## Docs Impact

需要补 docs。

最小文档改动：

- `docs/records/graphrag/2026-05-21-responses-api-streaming-transport.yaml`：
  在 event handling / implications 中记录 wrapper 不依赖 SDK
  `response.output_text` property；`output=None` completed payload 是 malformed
  provider response，按 transient recovery；refusal/content filter/explicit empty
  output fail closed。
- `docs/architecture/graphrag-provider-retry-classification.md`：
  增加 Responses malformed completed payload 的分类规则，明确该规则不覆盖
  real empty output、refusal、content filter、schema parse failure。
- `docs/operations/graphrag-epub-batch-runbook.md`：
  在 Provider 限流与重试章节补充 operator 可见语义：若状态摘要显示
  `completed response output was null`，同一 runId 等待/重试；若显示
  refusal/content filter/empty output，则按非 transient 阻塞处理。

若 data bus catalog 被用作 provider contract 索引，也应给
`openai_responses_response` 增加 note：collector 消费 stream events，completed
payload 的 `output` 可能因 provider/SDK compatibility anomaly 为 null；wrapper
必须在边界安全分类。

## 验收标准

- 真实失败样式不再出现裸
  `TypeError: 'NoneType' object is not iterable`。
- `response.completed` payload `output=None`、无其他 failure 信号、无 stream text
  时，在 Python wrapper 内被分类为 provider transient，并受现有 retry/backoff
  管理。
- 若第二次尝试成功，GraphRAG extract_graph 正常继续，生成的
  `LLMCompletionResponse.content` 来自实际 text events 或安全提取的 output text。
- 若 retry budget 耗尽，batch 层仍投影为
  `failureKind=transient`、`retryable=true`、
  `recoveryDecision=retry_same_run_id`，并显示 provider recovery wait timing。
- Completed payload `output=[]`、无 output_text blocks、refusal、content filter、
  max_output_tokens、schema parse failure 均不被本修复伪装成成功，也不被无条件
  归类为 transient。
- Python sync/async collector、recovery helper、batch classifier、status-json
  recovery projection 均有 focused regression。
- 文档明确 Responses `output=None` recovery taxonomy，并说明该 taxonomy 与真实
  空输出、拒绝、内容过滤、结构化输出解析失败的边界。
