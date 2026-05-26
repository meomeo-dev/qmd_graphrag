# OpenAI Retry-Guidance Failure Classification Re-Audit

Conclusion: PASS

## Scope

本次复审（re-audit）使用固定基准
`audit/graphrag-openai-retry-classification-run_1/dev-agent-b/baseline.md`
中的 10 条标准。审计对象包括：

- `scripts/graphrag/batch-failure-classifier.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `test/cli.test.ts`
- `package.json`

## Criteria Results

1. PASS. The observed provider wording must not leave items in `unknown`
   failure state.

   证据：`batch-failure-classifier.mjs` 将
   `an error occurred while processing your request. you can retry your request`
   纳入 provider transient 文本匹配；直接探针确认包含该 OpenAI retry
   guidance 的 GraphRAG workflow 包装文本返回
   `failureKind=transient`、`retryable=true`。

2. PASS. The resulting recovery decision must be derivable as
   `retry_same_run_id` by existing batch logic.

   证据：`batch-checkpoint-hydration.mjs` 对 known retryable failure 使用
   `retry_same_run_id`；`batch-epub-workflow.mjs` 的
   `recoveryDecisionForBatch` 对未完成且 `retryable=true` 或已有
   `retry_same_run_id` 的 checkpoint 返回 `retry_same_run_id`。运行时失败路径
   也继续以 `retryable && failureKind === "transient"` 进入同 runId 恢复。

3. PASS. The patch must not introduce a separate recovery ledger or state
   source.

   证据：差异仅在 shared classifier 新增一个文本 token、在测试中新增直接
   分类用例，并在 `package.json` 增加 `typecheck` 脚本入口。未新增 ledger、
   checkpoint 外状态源或独立 recovery 状态文件。

4. PASS. The change must remain deterministic and side-effect free.

   证据：`classifyFailure` 仍为纯字符串分类函数（pure string classifier），
   只执行 lower-case、regex/status-code 提取和 substring matching；无 I/O、
   时间、随机数或外部 provider 调用。

5. PASS. The classifier must continue to prioritize numeric provider status
   codes.

   证据：`classifyFailure` 先调用 `extractProviderStatusCode`，并先处理
   429/5xx transient 与 400-499 permanent，再进入文本匹配。直接探针确认
   `HTTP 400` 加 retry wording 仍为 `failureKind=permanent`、
   `retryable=false`、`providerStatusCode=400`。

6. PASS. The test must exercise classification directly and not depend on live
   provider calls.

   证据：`test/cli.test.ts` 直接 import `classifyFailure`，新增 regression
   case 使用合成 GraphRAG workflow error string，无网络、无 OpenAI/Jina live
   provider 调用。

7. PASS. The change must not broaden retry handling to arbitrary help-center or
   request-ID messages.

   证据：新增匹配 token 要求同时出现 processing error 与 explicit retry
   guidance 文案；直接探针确认仅含 help/support/request ID 的文本仍返回
   `failureKind=unknown`、`retryable=false`。

8. PASS. The change must preserve existing partial-output and network transient
   classification.

   证据：provider transient token list 仍保留 `partial-output`、
   `partial output`、`stream_read_error`、`timeout`、`httpx.`、`aiohttp.`、
   `urllib3.`、`connection reset`、`getaddrinfo` 等既有 token。测试继续直接
   断言 partial-output、Jina connection、httpx/aiohttp/urllib3 网络错误为
   transient。

9. PASS. The change must preserve permanent local artifact gate classification.

   证据：local artifact gate token list 未被移除，仍包含
   `missingArtifactKinds`、`missingArtifactIds`、`invalidArtifacts`、
   `did not produce valid book-scoped artifacts`、query_ready identity/capability
   projection failures 等。直接探针确认纯 local artifact gate 文本仍为
   `failureKind=permanent`、`retryable=false`。

10. PASS. The code must remain small enough that a future provider phrase can be
    added without touching unrelated GraphRAG runtime paths.

    证据：实现改动局限于 `isProviderTransientFailureText` 的一个 token；batch
    runner、hydration、artifact gates、query projection 与 output rendering
    无需为该 provider phrase 增加新路径。未来相同类别 provider phrase 可继续
    在 shared classifier token list 中维护。

## Verification

- PASS:
  `npm run test:node -- test/cli.test.ts -t "keeps transient and permanent provider recovery decisions typed"`
- PASS: `npm run typecheck`
- PASS: direct classifier probe for observed retry wording, HTTP 400 precedence,
  help/request-ID negative cases, partial-output transient, and artifact gate
  permanent classification.

## Required Fixes

无（none）。
