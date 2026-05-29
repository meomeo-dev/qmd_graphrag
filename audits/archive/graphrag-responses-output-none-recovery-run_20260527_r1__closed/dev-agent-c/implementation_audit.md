# Responses Output None 恢复实施审计

## 结论

FAIL。

实现总体方向正确：Python adapter 避免读取 `response.output_text`，为 completed
`output=None` 产生 typed `responses_output_none`；JS classifier 只新增
`kind=responses_output_none` matcher；测试覆盖 typed 正例、裸 `NoneType`/`TypeError`
负例、status-json legacy 恢复和主要 fail-closed 边界。

但当前实现把 completed payload 缺失 `output` 字段与 `output=None` 合并为同一 transient。
该行为超过本次设计决策的窄域边界，因此本次实施审计不通过。

## Blocking Findings

### C-BLOCKER-001：缺失 `output` 字段被误归类为 `responses_output_none`

- Severity: high
- Blocking: yes
- References:
  - `python/qmd_graphrag/graphrag_responses_completion.py:558`
  - `python/qmd_graphrag/graphrag_responses_completion.py:583`
  - `python/qmd_graphrag/graphrag_responses_completion.py:584`
  - `audits/graphrag-responses-output-none-recovery-run_20260527_r1__open/reports/design_decision.md:5`
  - `audits/graphrag-responses-output-none-recovery-run_20260527_r1__open/reports/design_decision.md:38`

`_completed_response_output_text()` 使用 `_field(response, "output", _MISSING)` 读取
output，但随后用同一分支处理 `output is _MISSING or output is None`，并抛出
`OpenAIResponsesTransientError(kind="responses_output_none")`。

本次设计决策只把 OpenAI Responses completed payload 的 `output=None` 定义为 provider
response integrity transient。缺失 `output` 字段更接近 provider schema/adapter
compatibility anomaly，应 fail-closed 或至少单独分类；否则会把 schema 形状漂移误判为
可重试 provider transient，扩大恢复范围。

建议修复：

- 将 `_MISSING` 与 `None` 分开处理。
- 仅 `output is None` 抛出 typed `responses_output_none`。
- `output is _MISSING` 使用非 transient `RuntimeError`，例如
  `Responses API completed response output field was missing`。
- 增加 Python 负例测试：completed response 无 `output` 属性时不是
  `OpenAIResponsesTransientError`。

## 逐条基准结果

1. 限定为 `output=None` typed evidence：FAIL。`output` 字段缺失也会进入同一 transient。
2. 不访问 `response.output_text`：PASS。`_create_completion_response()` 只接收
   `output_text` 参数；新增测试用会抛 `TypeError` 的 property 验证此点。
3. stream text 优先：PASS。sync/async collector 在已有 `output_text` 时不读取 completed
   `output`，并有 `output=None` 但已有 stream text 的测试覆盖。
4. `output=[]`、no output text、refusal、content filter、`max_output_tokens` fail-closed：
   PASS。Python 测试覆盖这些负例，代码均抛非 `OpenAIResponsesTransientError`。
5. 裸 `NoneType`/`TypeError`/`not iterable`/`extract_graph` 不泛化：PASS。JS classifier
   只新增 `kind=responses_output_none`，Vitest 覆盖裸 `NoneType` 和本地 `TypeError`
   为 unknown/non-retryable。
6. 401/403/provider-not-configured 保持 fail-closed：PASS。classifier 先处理 4xx 为
   permanent；runbook 明确 provider-not-configured 和 401/403 不进入 recovery。
7. schema parse、data compatibility、local artifact gate 不被吸收：PASS。classifier 顺序
   保留 data compatibility 与 local artifact gate，文档明确排除 schema/JSON parse 和
   local artifact gate。
8. status-json hydration 通过同一 classifier 恢复 legacy typed failure：PASS。
   `test/cli.test.ts` 覆盖 legacy `unknown + stop_until_fixed` 转为
   `pending + retry_same_run_id`。
9. 可观测性：PASS。status-json 测试断言 `failureKind=transient`、`retryable=true`、
   `retryExhausted=false`、`recoveryDecision=retry_same_run_id`、
   `waitingForProviderRecovery=true` 和 provider recovery 计数字段。
10. 文档/设计/代码/测试一致性：FAIL。文档和 design decision 描述 `output=None` 窄域，
    但代码把 missing output 字段纳入同一 transient。

## 残余风险

- `_is_transient_responses_error()` 仍包含 broad message fragments，例如 `server error` 和
  `timeout`。这是既有 provider transient 策略，不是本次阻塞，但后续应继续避免把本地错误
  写成 provider-like 文本。
- JS classifier 通过 substring `kind=responses_output_none` 识别 typed evidence。当前负例
  已覆盖裸 `NoneType` 和本地 `TypeError`，但仍依赖错误文本不被本地代码伪造。
- 未在本次审计运行测试；本结论基于 diff、代码路径和测试断言的静态审计。

## 建议

1. 修复 missing `output` 字段误分类，并增加对应 Python 负例。
2. 可选增加 Vitest 负例，确认 `Responses API completed response output field was missing`
   不会被 classifier 识别为 transient。
3. 保持当前 typed evidence 策略，不要加入 `NoneType`、`TypeError`、`not iterable` 或
   `extract_graph` 泛化 matcher。
4. 修复后运行至少以下测试：
   `python test/python/test_graphrag_responses_completion.py` 和包含
   `responses_output_none`/legacy status-json 用例的 `test/cli.test.ts` 相关套件。
