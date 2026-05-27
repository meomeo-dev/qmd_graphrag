# Agent B 设计审计报告

审计对象：`audit/batch-provider-auth-failfast-run_1/design.md`

固定基准：
`audit/batch-provider-auth-failfast-run_1/agent-b/audit-criteria.md`

## 发现项

未发现设计级阻断项。设计已覆盖真实失败证据中的 provider 401
认证失败场景，并将变更边界限定在 batch runner 对不可恢复 provider auth/config
failure 的停批判定。

证据：

- 设计记录真实批处理在 query 阶段收到 `401 INVALID_API_KEY`，checkpoint 已包含
  `failureKind: permanent`、`retryable: false`、`providerStatusCode: 401` 和
  `recoveryDecision: stop_until_fixed`，但现有 runner 仍继续下一本书；见
  `design.md:5` 至 `design.md:22`。
- 设计要求 401、403、invalid api key、unauthorized、forbidden、
  authentication 等认证/授权错误停止当前 batch runner；见 `design.md:26` 至
  `design.md:28`。
- 设计将 `shouldStopBatchAfterFailure()` 的边界限定为
  data compatibility failure 与 unrecoverable provider auth/config failure 停批，
  其他 permanent item failure 策略不变；见 `design.md:51` 至 `design.md:54`。

## 风险

1. 设计提出对错误文本中的 `auth` token 判定为 auth/config global stop；实现时需
   避免过宽 substring 造成非认证错误误停批。建议实现中优先使用 provider
   status code、结构化错误码和更精确的认证/授权 token。
2. status JSON、events 和 recovery summary 需继续使用既有字段表达
   `stop_until_fixed` 与 `providerStatusCode`，避免为本修复引入新的输出格式或
   schema 破坏。
3. 新 runner 启动前停批依赖既有循环在处理 item 前读取 checkpoint 并调用停批
   判定。实现时应确保 auth failed checkpoint 也走同一 pre-processing guard。

## 逐条基准结论

1. PASS：设计必须保护批处理状态管理，避免无效凭据下继续写入多书失败。

   证据：设计的问题陈述指出 401 后 runner 继续启动下一本书会消耗请求并制造更多
   失败状态；见 `design.md:19` 至 `design.md:22`。不变量要求 provider
   auth/config permanent 4xx failure 不可通过重试或处理下一本书恢复；见
   `design.md:26`。测试计划要求 401 后写入停批事件且不能启动后续 item；见
   `design.md:64` 至 `design.md:65`。

   必要修正建议：无。

2. PASS：设计必须保留 transient retry budget 和 provider recovery wait 机制。

   证据：设计明确 429 和 5xx 仍是 transient provider failure，并继续使用既有
   retry budget 与 provider recovery wait；见 `design.md:29` 至
   `design.md:30`。测试计划要求 429/5xx transient provider failure 的既有 retry
   tests 仍通过；见 `design.md:68`。

   必要修正建议：无。

3. PASS：设计必须说明 `shouldStopBatchAfterFailure()` 的变更边界。

   证据：设计明确 `shouldStopBatchAfterFailure()` 变更为 data compatibility
   failure 停批、unrecoverable provider auth/config failure 停批，其他 permanent
   item failure 不改变当前策略；见 `design.md:51` 至 `design.md:54`。

   必要修正建议：无。

4. PASS：设计必须说明既有 `classifyFailure()` 语义是否改变。

   证据：设计明确保持 `classifyFailure()` 的既有 retryable 类型不变，继续将
   4xx 分类为 permanent、429 分类为 transient、5xx 分类为 transient；本设计只
   改变 batch runner 是否继续处理后续图书；见 `design.md:56` 至
   `design.md:58`。

   必要修正建议：无。

5. PASS：设计必须避免把用户凭据问题伪装为本地可修复问题。

   证据：设计要求已失败的 auth item 不得触发 local artifact gate repair；见
   `design.md:36`。测试计划要求 mixed provider failure and local projection text
   测试继续证明 401 不进入 local artifact repair；见 `design.md:70` 至
   `design.md:71`。Non-goals 也明确不修复用户或代理服务的 API key；见
   `design.md:82`。

   必要修正建议：无。

6. PASS：设计必须确保新 runner 看到既有 auth failed checkpoint 时启动前停批。

   证据：设计不变量明确要求新 runner 在同一 run id 上看到已有 auth stop
   checkpoint 时，必须在处理下一本书前停止；见 `design.md:37` 至
   `design.md:38`。设计同时将 auth/config failure 纳入
   `shouldStopBatchAfterFailure()` 停批边界；见 `design.md:51` 至
   `design.md:54`。现有代码存在 `shouldStopBatchBeforeProcessing(checkpoint)`
   委托 `shouldStopBatchAfterFailure(checkpoint)` 的启动前停批入口；见
   `scripts/graphrag/batch-epub-workflow.mjs:4310` 至
   `scripts/graphrag/batch-epub-workflow.mjs:4311`。

   必要修正建议：无。

7. PASS：设计必须不修改 qmd / GraphRAG 构建状态展示语义。

   证据：设计明确本变更不修改 GraphRAG bridge projection、artifact gate、
   `query_ready` lineage、qmd/GraphRAG build 状态或输出渲染；见 `design.md:32`
   至 `design.md:33`。Non-goals 也明确不改变 GraphRAG 构建或查询的 artifact
   validation；见 `design.md:84`。

   必要修正建议：无。

8. PASS：设计必须不修改输出格式、research 子命令或 CLI 查询逻辑。

   证据：设计的 Proposed Change 将实现范围限定在
   `scripts/graphrag/batch-epub-workflow.mjs` 中引入 provider auth failure 停批
   判定；见 `design.md:44` 至 `design.md:54`。设计明确不修改输出渲染；见
   `design.md:32` 至 `design.md:33`。Non-goals 明确不改变 GraphRAG 构建或查询
   artifact validation；见 `design.md:84`。设计未提出修改 research 子命令或 CLI
   查询逻辑。

   必要修正建议：无。

9. PASS：设计必须记录真实跑恢复前需先修复外部凭据。

   证据：设计不变量明确真实跑恢复前必须先由用户修复外部 API key/proxy 凭据；
   见 `design.md:40`。Non-goals 也明确不修复用户或代理服务的 API key；见
   `design.md:82`。

   必要修正建议：无。

10. PASS：设计必须不提交 runtime artifacts。

    证据：设计不变量明确修复不得提交 `graph_vault`、`.qmd`、`inbox` 或 `/tmp`
    运行产物；见 `design.md:39`。Non-goals 明确不恢复或改写已生成的 batch
    运行产物；见 `design.md:86`。当前工作区仅显示本 case 的
    `status.yaml` 为未跟踪文件，未见 runtime artifact。

    必要修正建议：无。

## 总体结论

设计满足固定审计基准。后续实现应保持 classifier 语义不变，仅扩展 batch
runner 的停批判定，并用既有 recovery/status 字段表达 auth/config
`stop_until_fixed`，不得引入输出格式、research 子命令或 CLI 查询逻辑变更。

verdict: design_audit_passed
