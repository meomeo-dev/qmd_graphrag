# Agent C Development Audit Criteria

审计对象：Batch provider auth fail-fast 实施。

固定基准如下：

1. 实施必须解决真实跑中 401 后继续启动下一本书的问题。
2. 实施必须把外部凭据错误建模为 `stop_until_fixed`，而不是 transient retry。
3. 实施必须保持 429/5xx 的可恢复路径不变。
4. 实施必须保持 local artifact gate repair 的 providerStatusCode 防线。
5. 实施必须避免修改 qmd / GraphRAG 构建状态展示和恢复状态 schema。
6. 测试必须断言后续 pending item 的 checkpoint 保持 pending 且 attempts 为 0。
7. 测试必须断言事件中不会为 provider auth 发 data compatibility stop event。
8. 测试必须断言 `batch_stopped_after_non_transient_failure` 可见。
9. 验证结果必须记录到审计报告或最终报告。
10. 若开发审计发现问题，必须修复后复审，直到所有固定基准通过。
