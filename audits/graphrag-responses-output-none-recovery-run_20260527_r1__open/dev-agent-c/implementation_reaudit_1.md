# Responses Output None 恢复实施复审 1

## 结论

PASS。

本次复审仅检查修复后的当前工作树。此前阻塞点已修复：
`_completed_response_output_text()` 已将 completed payload 缺失 `output` 字段与
`output=None` 分开处理；只有 `output is None` 抛出 typed
`OpenAIResponsesTransientError(kind="responses_output_none")`，缺失 `output` 字段保持
non-transient `RuntimeError`。

## Blocking Findings

无。

## 复审结果

1. Missing output 与 output=None 分流：PASS。

   Evidence:

   - `python/qmd_graphrag/graphrag_responses_completion.py:558`
   - `python/qmd_graphrag/graphrag_responses_completion.py:583`
   - `python/qmd_graphrag/graphrag_responses_completion.py:584`
   - `python/qmd_graphrag/graphrag_responses_completion.py:586`

   `output is _MISSING` 现在抛出
   `Responses API completed response output field was missing`，不进入
   `OpenAIResponsesTransientError`。`output is None` 才进入
   `responses_output_none` typed transient。

2. Python missing output 负例测试：PASS。

   Evidence:

   - `test/python/test_graphrag_responses_completion.py:183`
   - `test/python/test_graphrag_responses_completion.py:194`
   - `test/python/test_graphrag_responses_completion.py:198`

   新增 `test_collect_response_stream_missing_output_is_non_transient()`，断言缺失
   `output` 字段抛出非 `OpenAIResponsesTransientError`，并包含
   `output field was missing`。

3. 裸 NoneType 未通过 classifier 泛化：PASS。

   Evidence:

   - `scripts/graphrag/batch-failure-classifier.mjs:117`
   - `scripts/graphrag/batch-failure-classifier.mjs:132`
   - `test/cli.test.ts:2347`
   - `test/cli.test.ts:2355`

   classifier 仍只新增 typed `kind=responses_output_none` matcher，没有加入
   `NoneType`、`TypeError`、`not iterable` 或 `extract_graph` 的宽泛 transient
   matcher。已有 Vitest 负例继续要求裸 `NoneType` 和本地 `TypeError` 为
   `unknown + retryable=false`。

4. Legacy 裸 NoneType 通过 batch 层双证据恢复：PASS。

   Evidence:

   - `scripts/graphrag/batch-epub-workflow.mjs:753`
   - `scripts/graphrag/batch-epub-workflow.mjs:760`
   - `scripts/graphrag/batch-epub-workflow.mjs:792`
   - `scripts/graphrag/batch-epub-workflow.mjs:803`
   - `scripts/graphrag/batch-epub-workflow.mjs:812`
   - `test/cli.test.ts:4321`

   batch 层恢复要求 checkpoint failure summary 同时满足：
   `GraphRAG index workflow failed`、`workflow=extract_graph` 和裸
   `'NoneType' object is not iterable`。随后还必须读取同书 `graph_extract`
   `indexing-engine.log`，并在 log 中命中旧 adapter 栈锚点：
   `_completed_response_output_text`、`response.output_text` 或
   `getattr(response, "output_text"`、`graphrag_responses_completion.py`。只有两类证据
   同时成立时才追加 typed `responses_output_none` evidence。

5. 真实只读 status-json 投影：PASS。

   Evidence:

   - 命令：
     `node scripts/graphrag/batch-epub-workflow.mjs --state-root graph_vault --log-root /tmp/qmd-epub-batch-20260527-real-resume-1 --run-id epub-batch-20260527-real-resume-1 --skip-dotenv --status-json`
   - 目标 item：`item-5d08f60ba01e-ca4bcb21`
   - 观测结果：`status=pending`、`failureKind=transient`、
     `retryable=true`、`retryExhausted=false`、
     `recoveryDecision=retry_same_run_id`、`failedStage=resume-book-1`、
     `waitingForProviderRecovery=true`。

   该命令是只读 `--status-json` 观测路径，未启动真实 batch，且使用
   `--skip-dotenv`。

6. 未手改 checkpoint：PASS。

   Evidence:

   - `graph_vault/catalog/batch-runs/epub-batch-20260527-real-resume-1/items/item-5d08f60ba01e-ca4bcb21.json`
   - 只读检查仍显示原 checkpoint 为 `status=failed`、
     `failureKind=unknown`、`retryable=false`、
     `retryExhausted=true`、`recoveryDecision=stop_until_fixed`。
   - `git status --short` 对该 checkpoint、manifest 和 recovery-summary 无修改输出。

## 残余风险

- `providerRecoveryEvidenceLocator` 未出现在当前 status summary 投影中；checkpoint
  hydration metadata 内有 evidence locator 字段，但 summary schema 未投影该字段。本次用户
  要求只确认 status-json 状态投影和不手改 checkpoint，因此不作为阻塞项。
- 本复审未运行完整测试套件。`reports/status.yaml` 记录已有
  `pythonResponsesHarness`、focused Vitest、typeCheck、diffCheck 和 nodeCheck 通过；本轮
  只做静态复核与一次真实只读 `--status-json` probe。

## 建议

1. 保持当前 classifier 窄域策略，不添加裸 `NoneType` 或 `TypeError` transient matcher。
2. 可选把 `providerRecoveryEvidenceLocator` 投影到 recovery summary，便于操作者从
   status JSON 直接定位 legacy log 证据。
3. 合入前保留 missing-output 负例，防止未来再次把 schema 缺失误归类为
   `responses_output_none` transient。
