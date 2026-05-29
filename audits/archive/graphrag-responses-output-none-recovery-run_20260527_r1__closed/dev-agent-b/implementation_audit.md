# Responses Output None Recovery 实施审计

## 结论

PASS。

当前未提交实现把 OpenAI Responses completed payload `output=None` 收敛为窄域
provider response integrity transient failure。恢复入口依赖 typed
`responses_output_none` evidence，并通过共享 batch classifier 投影为
`retry_same_run_id`。未发现阻塞问题。

本次审计为静态审计（static review），未启动真实 batch，未修改 `graph_vault`，
未读取 `.env`，未输出 API key、Bearer token 或原始 provider 请求/响应体。

## Blocking Findings

无。

## 逐条基准结果

1. Typed evidence only：通过。
   Python transient kind 集合只新增 `responses_output_none`
   （`python/qmd_graphrag/graphrag_responses_completion.py:72`），
   completed response 的 `output` 为 `None` 时抛
   `OpenAIResponsesTransientError(kind="responses_output_none")`
   （`python/qmd_graphrag/graphrag_responses_completion.py:583`）。
   JS classifier 仅通过 `kind=responses_output_none` token 识别该类 transient
   （`scripts/graphrag/batch-failure-classifier.mjs:117`）。

2. Adapter boundary：通过。
   `_create_completion_response()` 改为必须接收 `output_text`，不再 fallback 到
   `response.output_text`
   （`python/qmd_graphrag/graphrag_responses_completion.py:225`）。
   completed payload 解析改读原始 `output` 字段
   （`python/qmd_graphrag/graphrag_responses_completion.py:558`）。
   测试 fixture 明确让 `output_text` property 抛出裸 `TypeError`
   （`test/python/test_graphrag_responses_completion.py:81`），并验证仍能从
   completed `output` 提取文本
   （`test/python/test_graphrag_responses_completion.py:161`）。

3. Stream text precedence：通过。
   sync/async collector 均使用 `output_text or _completed_response_output_text(...)`
   （`python/qmd_graphrag/graphrag_responses_completion.py:657`,
   `python/qmd_graphrag/graphrag_responses_completion.py:710`）。
   chunk iterator 在已发出 delta 时不再从 completed payload 重提取文本
   （`python/qmd_graphrag/graphrag_responses_completion.py:777`）。
   测试覆盖 stream text 已存在且 completed `output=None` 的场景
   （`test/python/test_graphrag_responses_completion.py:185`）。

4. Empty/no-text fail-closed：通过。
   `output` 非 sequence、`output=[]`、无可接受文本分别抛普通
   `RuntimeError`，不进入 `OpenAIResponsesTransientError`
   （`python/qmd_graphrag/graphrag_responses_completion.py:589`）。
   测试覆盖 empty output 和 no output text 两个 negative case
   （`test/python/test_graphrag_responses_completion.py:197`,
   `test/python/test_graphrag_responses_completion.py:210`）。

5. Safety refusal/incomplete fail-closed：通过。
   incomplete reason 在读取 `output` 前失败关闭
   （`python/qmd_graphrag/graphrag_responses_completion.py:559`），refusal 在 stream
   和 completed payload 中均抛普通 `RuntimeError`
   （`python/qmd_graphrag/graphrag_responses_completion.py:613`,
   `python/qmd_graphrag/graphrag_responses_completion.py:657`）。
   测试覆盖 refusal、`content_filter`、`max_output_tokens`
   （`test/python/test_graphrag_responses_completion.py:226`,
   `test/python/test_graphrag_responses_completion.py:240`,
   `test/python/test_graphrag_responses_completion.py:255`）。

6. Auth/config fail-closed：通过。
   batch classifier 在 typed/query/transient token 之前先处理 provider HTTP 4xx，
   除 429 外均返回 permanent
   （`scripts/graphrag/batch-failure-classifier.mjs:8`）。
   provider auth reopen 逻辑显式识别 401/403、invalid API key、unauthorized、
   forbidden 和 authentication
   （`scripts/graphrag/batch-epub-workflow.mjs:815`）。
   测试覆盖 provider-not-configured 保持 non-retryable unknown
   （`test/cli.test.ts:2419`），以及 401 checkpoint 的 permanent 形态
   （`test/cli.test.ts:1429`, `test/cli.test.ts:6854`）。

7. No generic Python error matching：通过。
   classifier token 列表只加入 `kind=responses_output_none`，未加入裸
   `NoneType`、`TypeError`、`not iterable` 或 `extract_graph`
   （`scripts/graphrag/batch-failure-classifier.mjs:117`）。
   Vitest 覆盖 GraphRAG wrapper 中 typed message 为 transient，同时裸
   `NoneType` 和本地 `TypeError` 保持 unknown/non-retryable
   （`test/cli.test.ts:2330`, `test/cli.test.ts:2347`,
   `test/cli.test.ts:2355`）。

8. Schema/artifact boundaries：通过。
   classifier 在 provider transient 后仍保留 data compatibility 和 local
   artifact gate 专用分类
   （`scripts/graphrag/batch-failure-classifier.mjs:47`,
   `scripts/graphrag/batch-failure-classifier.mjs:201`）。
   Python retry helper 不重试 schema validation failure
   （`test/python/test_graphrag_responses_completion.py:547`）。
   query_ready projection/local artifact gate negative tests 保持 permanent
   （`test/cli.test.ts:2447`）。job-state 文档明确排除 schema/JSON parse、
   data compatibility 和 local artifact gate
   （`docs/design/job-state/book-job-state.md:246`）。

9. Observable same-run recovery：通过。
   checkpoint 恢复通过 `classifyFailure(checkpointFailureText(...))` 共享分类器
   （`scripts/graphrag/batch-epub-workflow.mjs:743`,
   `scripts/graphrag/batch-epub-workflow.mjs:775`）。
   provider transient recovery 写回 `pending`、`failureKind=transient`、
   `retryable=true`、`retryExhausted=false`、`retry_same_run_id` 和 provider
   wait metadata
   （`scripts/graphrag/batch-epub-workflow.mjs:3851`）。
   status summary 暴露 waiting/provider wait 字段
   （`scripts/graphrag/batch-epub-workflow.mjs:4036`）。
   legacy output-none status-json 测试验证旧 unknown/stop 状态被恢复为 pending
   transient，而非 completed/succeeded
   （`test/cli.test.ts:4197`, `test/cli.test.ts:4295`）。
   文档要求该失败不发布 succeeded checkpoint、producer manifest 或 graph
   capability（`docs/design/job-state/book-job-state.md:225`,
   `docs/operations/graphrag-epub-batch-runbook.md:256`）。

10. Regression and docs alignment：通过。
    设计决策记录了 typed evidence、fail-closed boundaries 和 status-json
    hydration 要求
    （`audits/graphrag-responses-output-none-recovery-run_20260527_r1__open/reports/design_decision.md:31`,
    `audits/graphrag-responses-output-none-recovery-run_20260527_r1__open/reports/design_decision.md:34`,
    `audits/graphrag-responses-output-none-recovery-run_20260527_r1__open/reports/design_decision.md:46`）。
    architecture 与 runbook 文档同步说明裸 Python error 不构成 transient 证据，
    真实空输出、安全拒绝、content filter、max tokens、provider-not-configured
    和 401/403 仍 fail-closed
    （`docs/architecture/graphrag-provider-retry-classification.md:34`,
    `docs/architecture/graphrag-provider-retry-classification.md:51`,
    `docs/operations/graphrag-epub-batch-runbook.md:213`）。

## 残余风险

- 本次未执行 Python 或 Vitest 测试；结论基于 diff、源码、测试用例和文档静态审计。
- `_completed_response_output_text()` 将缺失 `output` 字段与 `output=None`
  归入同一 transient path。若未来 SDK 需要区分 absent output 和 explicit null，
  应补充专门 fixture 并重新确认分类边界。
- Python adapter 对 401/403 的 fail-closed 主要依赖 status/message 组合与 batch
  classifier 的 4xx 优先级。建议增加 Responses stream error 的 401/403 negative
  单测，覆盖包含 transient-looking 文本的 auth failure。

## 建议

- 保持 JS classifier 只识别 `kind=responses_output_none`，不要加入
  `NoneType`、`TypeError`、`not iterable` 或 `extract_graph` 泛化 matcher。
- 为 missing `output` 字段补充一条显式测试，固定它与 `output=None` 是否同类。
- 为 status-json output-none recovery 增加断言：恢复结果不得出现 completed
  status、succeeded graph stage 或 producer capability 发布事实。
- 在运行回归前优先执行窄域用例：
  `test/python/test_graphrag_responses_completion.py` 与
  `test/cli.test.ts` 中的 classifier/status-json 相关测试。
