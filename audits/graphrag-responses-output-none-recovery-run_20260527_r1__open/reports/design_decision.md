# GraphRAG Responses Output None Recovery Design Decision

## Decision

本次阻塞归类为 provider response integrity transient failure
（提供方响应完整性瞬态失败）。OpenAI Responses completed payload
返回 `output=None`，且没有 stream text、explicit error、refusal、
content filter 或 incomplete reason 时，Python Responses adapter 必须抛出
typed transient error：

```text
Responses API transient error kind=responses_output_none status_code=unknown
```

批处理外部状态不新增 `failureKind` 枚举，仍投影为：

```json
{
  "failureKind": "transient",
  "retryable": true,
  "recoveryDecision": "retry_same_run_id"
}
```

## Scope

实现必须优先修复 adapter boundary（适配器边界），避免访问 OpenAI SDK
`response.output_text` convenience property。该 property 在 `response.output`
为 `None` 时会抛出裸 `TypeError`，导致 batch 层只能看到 unknown failure。

JS classifier 只识别 typed transient evidence，不加入宽泛的 `NoneType`、
`TypeError`、`not iterable` 或 `extract_graph` transient matcher。

## Fail-Closed Boundaries

以下情况不属于本次 transient recovery：

- `output=[]` 或 completed payload 没有 text/refusal/error/incomplete 信号；
- stream 或 completed payload 明确返回 refusal；
- `incomplete_details.reason=content_filter`；
- `incomplete_details.reason=max_output_tokens`；
- HTTP 401/403、INVALID_API_KEY、provider not configured；
- GraphRAG data compatibility、schema/JSON parse failure、本地 artifact gate；
- 没有 Responses adapter typed evidence 的裸 `NoneType`/`TypeError`。

## Required Implementation

- `_completed_response_output_text()` 只读取原始字段，不访问
  `response.output_text`。
- stream text 已收集时优先使用 stream text，completed payload 只作为 id、
  usage 和 created_at 来源。
- `output=None` 且无 stream text 时抛出
  `OpenAIResponsesTransientError(kind="responses_output_none")`。
- `_create_completion_response()` 不保留 unsafe `response.output_text` fallback。
- `batch-failure-classifier.mjs` 将 typed `responses_output_none` 映射为
  transient/retryable。
- status-json hydration 通过同一 classifier 将 legacy
  `unknown + stop_until_fixed` 投影回 transient pending。

## Acceptance

- 真实失败不再泄漏裸
  `TypeError: 'NoneType' object is not iterable` 作为 batch unknown。
- Python sync/async collector 和 retry helper 均覆盖 `output=None` 回归。
- Vitest 覆盖 typed transient、GraphRAG workflow wrapped typed transient、
  bare `NoneType` negative、local GraphRAG TypeError negative 和 legacy
  status-json recovery。
- 文档记录分类边界和操作者恢复动作。
