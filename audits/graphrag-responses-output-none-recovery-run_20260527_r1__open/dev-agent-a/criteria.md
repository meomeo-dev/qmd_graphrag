# 固定实施审计基准原则

1. `responses_output_none` 只能由 Responses adapter 的 typed evidence 进入
   transient recovery；裸 `NoneType`、`TypeError`、`not iterable` 或
   `extract_graph` 文本不得被泛化为 transient。
2. Python adapter 不得读取 OpenAI SDK `response.output_text` convenience
   property 作为 completed payload 的 fallback；必须从原始 `output` 结构解析。
3. completed payload `output=None` 只有在没有已收集 stream text、explicit error、
   refusal、content filter 或 incomplete reason 时，才可被视为 provider response
   integrity transient。
4. `output=[]`、completed payload 无可用 output text、refusal、content filter 和
   `max_output_tokens` 必须 fail-closed，不能进入 provider retry。
5. HTTP 401/403、INVALID_API_KEY、provider-not-configured 必须保持 permanent 或
  配置失败分类，不能被 `responses_output_none` 恢复逻辑覆盖。
6. schema/JSON parse failure、GraphRAG data compatibility failure 和 local artifact
   gate failure 必须保持各自分类，不能因本次变更被误判为 transient。
7. JS batch classifier 只能识别 typed `responses_output_none` evidence，不新增宽泛
   Python runtime error matcher。
8. status-json hydration 必须能把 legacy `unknown + stop_until_fixed` 的 typed
   `responses_output_none` 失败投影为 `transient + retry_same_run_id`，且不启动真实
   batch 工作。
9. provider recovery 必须可观测，至少在 summary 中呈现 `failureKind=transient`、
   `retryable=true`、`recoveryDecision=retry_same_run_id` 和 provider recovery wait
   元数据。
10. 实现必须窄域、低副作用：不发布 succeeded high-cost checkpoint、producer
    manifest、`query_ready` 或 graph capability；不泄露 `.env`、API key、Bearer
    token、原始 provider 请求体或响应体。
