# Agent C Design Audit Report

审计对象：`audit/batch-provider-auth-failfast-run_1__closed/design.md`

固定基准：
`audit/batch-provider-auth-failfast-run_1__closed/agent-c/audit-criteria.md`

## 发现项

未发现阻断性设计缺陷。设计针对真实 401 provider authentication failure
给出了 batch fail-fast 策略，并限定不改变 GraphRAG bridge projection、artifact
gate、query_ready lineage、qmd/GraphRAG build 状态或输出渲染。

## 风险

1. 设计把 `auth` 纳入认证文本判定词。实现时必须避免裸 substring 造成误判，
   例如匹配到非认证语义文本；建议实现使用大小写归一化后的明确 token、错误码或
   provider status code 优先判定。
2. 真实恢复仍依赖外部 API key/proxy 凭据修复。设计已要求凭据未修复前暂停真实跑，
   但该约束需要在执行记录和操作流程中继续保持。

## 逐条基准结论

1. PASS。设计明确指出当前 runner 在 401 后继续启动下一本会继续消耗无效请求，
   并要求 provider auth/config permanent 4xx failure 停止当前 batch runner，
   满足 fail-fast 降低无效 LLM/API 请求的要求。
   必要修正建议：无。

2. PASS。设计对 401、403 以及 `invalid api key`、`invalid_api_key`、
   `unauthorized`、`forbidden`、`authentication`、`auth` 等认证/授权文本给出
   global stop 判定规则。
   必要修正建议：实现阶段应把 `auth` 作为受边界约束的认证语义匹配，避免过宽
   文本误判。

3. PASS。设计明确保持 `classifyFailure()` 现有 retryable 类型不变，并声明 429
   和 5xx 继续使用既有 retry budget 与 provider recovery wait 机制。
   必要修正建议：无。

4. PASS。设计把 data compatibility failure 停批保留为
   `shouldStopBatchAfterFailure()` 的第一类停批条件，未削弱现有
   data compatibility 停批行为。
   必要修正建议：无。

5. PASS。设计的不变式和 Non-Goals 均明确不修改 GraphRAG bridge projection、
   artifact gate、query_ready lineage、qmd/GraphRAG build 状态或输出渲染。
   必要修正建议：无。

6. PASS。测试计划要求 provider 401 命令失败时写入 `item_failed` 后写入
   `batch_stopped_after_non_transient_failure`，且不能启动后续 item，覆盖同一
   runner 内不启动下一本。
   必要修正建议：无。

7. PASS。测试计划要求 status-json 对既有 401 failed checkpoint 显示
   `recoveryDecision: stop_until_fixed`、`providerStatusCode: 401`，且不得显示
   provider recovery wait。
   必要修正建议：无。

8. PASS。设计变更范围限定在 `scripts/graphrag/batch-epub-workflow.mjs` 的判定逻辑，
   未提出新增外部依赖。
   必要修正建议：无。

9. PASS。设计的验证命令列表包含 `git diff --check`。
   必要修正建议：无。

10. PASS。设计不变式要求真实跑恢复前必须先由用户修复外部 API key/proxy 凭据，
    Non-Goals 明确不修复用户或代理服务的 API key，满足任务未完成时因外部凭据
    阻断暂停真实跑的要求。
    必要修正建议：无。

## 总结

设计满足固定 10 条审计基准，可以进入实现阶段。实现审计应重点验证 provider
auth/config 停批判定不会扩大到普通 400/409，不会影响 429/5xx recovery，不会触发
local artifact gate repair，并且测试命令真实执行且非空匹配。

verdict: design_audit_passed
