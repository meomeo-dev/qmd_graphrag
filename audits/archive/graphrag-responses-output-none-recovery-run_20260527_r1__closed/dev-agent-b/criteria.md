# Responses Output None Recovery 固定实施审计基准

1. Typed evidence only（仅类型化证据）：只有 Python Responses adapter 明确输出
   `kind=responses_output_none` 时，completed payload `output=None` 才可进入
   provider transient recovery。
2. Adapter boundary（适配器边界）：恢复实现不得依赖 OpenAI SDK
   `response.output_text` convenience property 作为兜底读取路径。
3. Stream text precedence（流文本优先）：已收到 stream text 时，completed payload
   `output=None` 不得覆盖或否定已收集文本。
4. Empty/no-text fail-closed（空输出失败关闭）：`output=[]`、非文本 content 或没有
   可接受 output text 的 completed payload 不得被归类为 transient。
5. Safety refusal/incomplete fail-closed（安全拒绝与不完整失败关闭）：refusal、
   `content_filter`、`max_output_tokens` 和其他 incomplete signal 不得进入
   `responses_output_none` transient 路径。
6. Auth/config fail-closed（认证与配置失败关闭）：HTTP 401/403、INVALID_API_KEY、
   provider-not-configured 不得因 OpenAI/Jina/Responses 文本而被误判为 transient。
7. No generic Python error matching（不泛化 Python 错误文本）：裸 `NoneType`、
   `TypeError`、`not iterable`、`extract_graph` 文本不得成为 transient matcher。
8. Schema/artifact boundaries（schema 与本地产物边界）：schema/JSON parse failure、
   GraphRAG data compatibility failure 和 local artifact gate 必须保留各自
   fail-closed 或修复路径，不得被 output-none 恢复污染。
9. Observable same-run recovery（可观测同 run 恢复）：状态恢复必须投影为
   `failureKind=transient`、`retryable=true`、`recoveryDecision=retry_same_run_id`
   和 provider wait metadata；不得删除产物或伪造 succeeded checkpoint。
10. Regression and docs alignment（回归与文档一致）：实现、测试和文档必须同时覆盖
    positive case、GraphRAG wrapper case、negative boundaries 和 legacy
    status-json hydration。
