# Responses Output None 恢复实施审计基准

1. 恢复范围必须限定为 OpenAI Responses completed payload 的
   `output=None`，且仅在 adapter 产生 typed `responses_output_none` 证据时进入
   transient recovery。
2. Python adapter 不得访问 OpenAI SDK `response.output_text` convenience property
   作为 completed payload 事实源，避免裸 `TypeError` 泄漏到 batch 层。
3. 已收集 stream text 时，completed payload 只能补充 id、usage、created_at 等元数据；
   不得因 completed `output=None` 覆盖已获得的文本。
4. `output=[]`、缺少 output text、refusal、content filter 和
   `max_output_tokens` 必须 fail-closed，不得归类为 transient。
5. 裸 `NoneType`、`TypeError`、`not iterable`、`extract_graph` 文本不得作为 transient
   matcher；JS classifier 只能识别 typed provider evidence。
6. HTTP 401/403、provider-not-configured、INVALID_API_KEY 等认证或配置错误必须保持
   permanent/non-retryable，不得被 `responses_output_none` 规则覆盖。
7. schema/JSON parse failure、GraphRAG data compatibility failure 和 local artifact gate
   必须保留各自分类，不得被 provider transient 泛化吸收。
8. status-json hydration 必须通过同一 classifier 将历史
   `unknown + stop_until_fixed` 的 typed `responses_output_none` 恢复为
   `pending + retry_same_run_id`。
9. 恢复路径必须可观测：command check、item checkpoint 和 recovery summary 能显示
   `failureKind=transient`、`retryable=true`、`recoveryDecision=retry_same_run_id`。
10. 文档、设计决策、代码和测试必须一致说明窄域边界、fail-closed 例外和操作者恢复动作。
