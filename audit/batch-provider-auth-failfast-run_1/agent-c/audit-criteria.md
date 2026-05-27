# Agent C Design Audit Criteria

审计对象：Batch provider auth fail-fast 设计。

固定基准如下：

1. 设计必须用 fail-fast 减少无效 LLM/API 请求。
2. 设计必须对 401/403 和认证文本提供明确判定规则。
3. 设计必须不影响 429/5xx 的恢复行为。
4. 设计必须不影响 data compatibility 停批行为。
5. 设计必须不影响 graph capability projection 修复成果。
6. 设计必须要求测试覆盖同一 runner 内不启动下一本。
7. 设计必须要求测试覆盖 status-json 对已有 401 checkpoint 的观测。
8. 设计必须不新增外部依赖。
9. 设计必须包含提交前 `git diff --check`。
10. 设计必须明确任务未完成时因外部凭据阻断暂停真实跑。
