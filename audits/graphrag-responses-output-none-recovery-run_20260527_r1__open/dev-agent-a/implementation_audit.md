# Responses Output None Recovery 实施审计

## 结论

PASS。

当前未提交实现满足本次 open 审计的核心要求：OpenAI Responses completed payload
`output=None` 通过 Python adapter typed evidence 进入 provider transient recovery；
裸 `NoneType`、`TypeError`、`extract_graph` 文本未被泛化；`output=[]`、无
output text、refusal、content filter、`max_output_tokens`、401/403、schema parse
和 local artifact gate 边界保持 fail-closed。实现范围集中在 Responses adapter、
batch failure classifier、回归测试和恢复文档，未观察到对源码外状态或
`graph_vault` 的运行副作用。

本次只做本地静态审计，未运行测试命令，未读取 `.env`、API key、Bearer token 或
原始 provider 请求体/响应体。

## Blocking Findings

无。

## 逐条基准结果

1. typed evidence 限定：通过。
   `OpenAIResponsesTransientError` 生成
   `Responses API transient error kind=... status_code=...` typed message，见
   [graphrag_responses_completion.py:83](/Users/jin/projects/qmd_graphrag/python/qmd_graphrag/graphrag_responses_completion.py:83)。
   `output=None` 时显式设置 `kind="responses_output_none"`，见
   [graphrag_responses_completion.py:583](/Users/jin/projects/qmd_graphrag/python/qmd_graphrag/graphrag_responses_completion.py:583)。
   CLI negative 测试固定裸 `NoneType` 和 local `TypeError` 仍为 unknown，见
   [test/cli.test.ts:2347](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:2347)。

2. 不读取 `response.output_text` fallback：通过。
   `_create_completion_response()` 改为强制接收已解析 `output_text`，不再自行访问
   SDK property，见
   [graphrag_responses_completion.py:224](/Users/jin/projects/qmd_graphrag/python/qmd_graphrag/graphrag_responses_completion.py:224)。
   Python 测试构造 `output_text` property 抛 `TypeError` 的响应对象，并验证仍从
   `output` 解析文本，见
   [test_graphrag_responses_completion.py:72](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_responses_completion.py:72)
   和
   [test_graphrag_responses_completion.py:161](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_responses_completion.py:161)。

3. `output=None` 条件窄域：通过。
   adapter 先处理 incomplete reason、response error、failed/cancelled status，再处理
   `output=None`，见
   [graphrag_responses_completion.py:558](/Users/jin/projects/qmd_graphrag/python/qmd_graphrag/graphrag_responses_completion.py:558)。
   已收集 stream text 时优先使用 stream text，不因 completed `output=None` 失败，
   见
   [graphrag_responses_completion.py:657](/Users/jin/projects/qmd_graphrag/python/qmd_graphrag/graphrag_responses_completion.py:657)
   和测试
   [test_graphrag_responses_completion.py:185](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_responses_completion.py:185)。

4. empty/no-text/refusal/content-filter/max-token fail-closed：通过。
   `output=[]`、无 output text、refusal 分别抛普通 `RuntimeError`，见
   [graphrag_responses_completion.py:591](/Users/jin/projects/qmd_graphrag/python/qmd_graphrag/graphrag_responses_completion.py:591)
   到
   [graphrag_responses_completion.py:621](/Users/jin/projects/qmd_graphrag/python/qmd_graphrag/graphrag_responses_completion.py:621)。
   content filter 和 `max_output_tokens` 通过 incomplete reason 先行 fail-closed，见
   [graphrag_responses_completion.py:560](/Users/jin/projects/qmd_graphrag/python/qmd_graphrag/graphrag_responses_completion.py:560)。
   对应测试见
   [test_graphrag_responses_completion.py:197](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_responses_completion.py:197)、
   [test_graphrag_responses_completion.py:210](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_responses_completion.py:210)、
   [test_graphrag_responses_completion.py:226](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_responses_completion.py:226)、
   [test_graphrag_responses_completion.py:240](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_responses_completion.py:240)
   和
   [test_graphrag_responses_completion.py:255](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_responses_completion.py:255)。

5. 401/403 和 provider-not-configured 不被覆盖：通过。
   JS classifier 先处理 HTTP status；除 429 外的 4xx 在 provider transient matcher
   前已返回 permanent，见
   [batch-failure-classifier.mjs:8](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:8)
   和
   [batch-failure-classifier.mjs:21](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:21)。
   runbook 明确 provider-not-configured、401/403 保持 fail-closed，见
   [graphrag-epub-batch-runbook.md:219](/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:219)。

6. schema/data/local artifact gate 不误判 transient：通过。
   classifier 中 local artifact gate 仍有独立永久分类，见
   [batch-failure-classifier.mjs:201](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:201)。
   文档明确 schema parse、GraphRAG data compatibility 和 local artifact gate 不进入
   provider response integrity recovery，见
   [book-job-state.md:246](/Users/jin/projects/qmd_graphrag/docs/design/job-state/book-job-state.md:246)。
   Python retry helper 对非 transient `ValueError` 不重试，见
   [test_graphrag_responses_completion.py:547](/Users/jin/projects/qmd_graphrag/test/python/test_graphrag_responses_completion.py:547)。

7. JS classifier 窄域 token：通过。
   本次只新增 `kind=responses_output_none` provider transient token，未加入
   `NoneType`、`TypeError`、`not iterable` 或 `extract_graph` matcher，见
   [batch-failure-classifier.mjs:117](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:117)。
   设计记录也要求只识别 typed transient evidence，见
   [design_decision.md:31](/Users/jin/projects/qmd_graphrag/audits/graphrag-responses-output-none-recovery-run_20260527_r1__open/reports/design_decision.md:31)。

8. status-json legacy recovery：通过。
   CLI 测试构造 legacy `unknown + stop_until_fixed` typed
   `responses_output_none` checkpoint，并通过 status-json 投影为
   `retry_same_run_id`，见
   [test/cli.test.ts:4197](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4197)
   和断言
   [test/cli.test.ts:4295](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4295)。

9. provider recovery 可观测：通过。
   status-json 回归断言 summary 中有 `failureKind=transient`、`retryable=true`、
   `retryExhausted=false`、`recoveryDecision=retry_same_run_id`、
   `waitingForProviderRecovery=true`、provider wait count 和 reason，见
   [test/cli.test.ts:4298](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4298)。

10. 窄域低副作用与脱敏：通过。
    adapter 脱敏错误信息中的 API key、authorization、bearer、base URL 和 URL，见
    [graphrag_responses_completion.py:353](/Users/jin/projects/qmd_graphrag/python/qmd_graphrag/graphrag_responses_completion.py:353)。
    恢复文档要求 typed `responses_output_none` 的 `graph_extract` attempt 不发布
    succeeded checkpoint、producer manifest 或 graph capability，见
    [graphrag-epub-batch-runbook.md:256](/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:256)。
    本次审计未发现对真实 batch、`graph_vault` 或源码外状态的运行修改。

## 残余风险

- 未运行测试命令；结论基于当前 diff、实现、测试和文档的静态审计。
- JS classifier 当前匹配 token `kind=responses_output_none`，而不是完整短语
  `Responses API transient error kind=responses_output_none status_code=...`。
  这仍要求 typed token，但若未来无关错误文本人工包含该 token，也会被归为
  transient。
- Python adapter 将 missing `output` field 与 `output=None` 一并视为
  `responses_output_none`。这与 provider boundary anomaly 方向一致，但当前测试未把
  missing field 与 explicit `None` 分开固定。

## 建议

1. 运行 focused regression：
   `python test/python/test_graphrag_responses_completion.py`，以及包含
   `classifies GraphRAG provider failures` 和 legacy status-json 用例的 Vitest
   子集。
2. 可将 JS matcher 从单 token 收紧为包含 `Responses API transient error`、
   `kind=responses_output_none` 和 `status_code=` 的组合判断，进一步降低误报面。
3. 补一个 Python 单测明确 missing `output` field 的期望：若设计接受它等同
   `output=None`，测试应固定；若不接受，应改为普通 non-transient runtime error。
4. 补一组 JS negative tests，显式覆盖 provider-not-configured、schema parse 和
   local artifact gate 文本不含 typed evidence 时仍非 transient。
