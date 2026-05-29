# Agent A 设计审计报告

审计 case：`batch-provider-auth-failfast-run_1`

审计对象：`audit/batch-provider-auth-failfast-run_1__closed/design.md`

固定基准：
`audit/batch-provider-auth-failfast-run_1__closed/agent-a/audit-criteria.md`

## 结论摘要

阻断项：无。

设计说明了真实批处理在 GraphRAG bridge projection 修复后进入
`query_ready` 查询阶段，并因 provider 认证失败收到
`401 INVALID_API_KEY`。设计把 401/403 与认证授权文本识别为当前 batch runner
必须停止的不可恢复 provider auth/config failure，同时保留 429/5xx transient
恢复机制，不把一般 400/409 扩大为全局停批。

设计明确不改变 GraphRAG bridge projection、artifact gate、query_ready lineage、
GraphRAG build 状态或输出渲染，并要求 status JSON、events、recovery summary
可观测。测试要求覆盖 401 后后续 item 不启动、status-json 保留
`stop_until_fixed` 与 `providerStatusCode: 401`、429/5xx retry 仍通过，以及
provider 401 不进入 local artifact repair。

## 发现项与风险

未发现必须修改的设计项。

剩余风险：设计在文本匹配列表中包含裸词 `auth`。实现时应避免过宽 substring
误匹配非认证语义文本，例如采用大小写归一化后的错误码、状态码、词边界或明确短语
匹配。该风险不构成本次 FAIL，因为设计同时限定为 provider auth/config 语义，且
明确禁止把所有 4xx 扩大为全局停批。

## 逐条基准结论

1. PASS：设计必须说明真实 401 `INVALID_API_KEY` 触发场景。

   证据：`design.md:5` 到 `design.md:10` 说明真实批处理
   `epub-batch-20260527-after-bridge-projection-fix` 在已 `query_ready` 的图书查询
   阶段收到 `Error code: 401 - {'code': 'INVALID_API_KEY', 'message': 'Invalid API key'}`。
   `status.yaml:13` 到 `status.yaml:23` 也记录对应 run、item、book 和失败消息。

   必要修正建议：无。

2. PASS：设计必须区分 auth/config 4xx 与 transient 429/5xx。

   证据：`design.md:26` 将 provider auth/config permanent 4xx 定义为不可通过重试
   或处理下一本书恢复；`design.md:29` 到 `design.md:31` 明确 429 和 5xx 仍使用既有
   retry budget 与 provider recovery wait，一般 400、409 等 4xx 仍按单书永久失败
   处理；`design.md:56` 到 `design.md:58` 要求保持 `classifyFailure()` 中 4xx、
   429、5xx 的既有 retryable 分类。

   必要修正建议：无。

3. PASS：设计必须要求 401 和 403 停止当前 batch runner。

   证据：`design.md:27` 到 `design.md:28` 要求 401、403 停止当前 batch runner；
   `design.md:47` 到 `design.md:48` 要求从 checkpoint 和 failed command checks
   中读取 provider status code，并对 401、403 判定为 global stop。

   必要修正建议：无。

4. PASS：设计必须要求 invalid api key / unauthorized / forbidden 文本停批。

   证据：`design.md:49` 到 `design.md:50` 要求错误文本包含
   `invalid api key`、`invalid_api_key`、`unauthorized`、`forbidden`、
   `authentication`、`auth` 等认证/授权语义时判定为 global stop。

   必要修正建议：无。实现时建议避免裸 `auth` 造成误匹配。

5. PASS：设计不得把所有 4xx 都扩大为全局停批。

   证据：`design.md:31` 明确一般 400、409 等 4xx 仍可按单书永久失败处理，不在本
   设计中扩大为全局停批；`design.md:53` 到 `design.md:54` 明确
   `shouldStopBatchAfterFailure()` 只新增 unrecoverable provider auth/config failure
   停批，其他 permanent item failure 不改变当前策略。

   必要修正建议：无。

6. PASS：设计不得改变 GraphRAG bridge projection 或 artifact gate。

   证据：`design.md:32` 到 `design.md:33` 明确本变更不修改 GraphRAG bridge
   projection、artifact gate、query_ready lineage、qmd/GraphRAG build 状态或输出
   渲染；`design.md:84` 再次把不改变 GraphRAG 构建或查询 artifact validation
   列为 Non-Goal。

   必要修正建议：无。

7. PASS：设计必须保留 local artifact repair 不处理 provider 401。

   证据：`design.md:36` 明确已失败的 auth item 不得触发 local artifact gate
   repair；`design.md:70` 到 `design.md:71` 要求 mixed provider failure and local
   projection text 测试继续证明 401 不进入 local artifact repair。

   必要修正建议：无。

8. PASS：设计必须要求 status/events/recovery summary 可观测。

   证据：`design.md:34` 到 `design.md:35` 要求 status JSON、events 和 recovery
   summary 显示 `stop_until_fixed` 并保留 provider status code；`design.md:64` 到
   `design.md:67` 要求测试验证 `item_failed`、
   `batch_stopped_after_non_transient_failure`、`recoveryDecision:
   stop_until_fixed` 和 `providerStatusCode: 401`，且不得显示 provider recovery wait。

   必要修正建议：无。

9. PASS：设计必须要求测试证明后续 item 不会在 401 后启动。

   证据：`design.md:64` 到 `design.md:65` 要求真实运行中命令失败为 provider 401
   时，runner 写入 `item_failed` 后必须写入
   `batch_stopped_after_non_transient_failure`，且不能启动后续 item；
   `design.md:37` 到 `design.md:38` 还要求新 runner 在同一 run id 上看到已有
   auth stop checkpoint 时，必须在处理下一本书前停止。

   必要修正建议：无。

10. PASS：设计必须要求验证命令真实可执行。

    证据：`design.md:73` 到 `design.md:78` 给出可执行验证命令：
    `npm run test:node -- test/cli.test.ts -t "provider"`、
    `npm run test:node -- test/cli.test.ts -t "non-transient"`、
    `npm run typecheck` 和 `git diff --check`。`package.json` 中存在
    `test:node` 与 `typecheck` scripts，`test/cli.test.ts` 文件存在，且测试文件中已
    有 `provider`、`non-transient`、`status-json`、`recoveryDecision` 等相关测试
    名称和断言文本，因此这些命令是仓库内真实入口而非不存在命令。

    必要修正建议：无。

verdict: design_audit_passed
