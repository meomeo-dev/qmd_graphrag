# Agent B Design Audit Criteria

审计对象：Batch provider auth fail-fast 设计。

固定基准如下：

1. 设计必须保护批处理状态管理，避免无效凭据下继续写入多书失败。
2. 设计必须保留 transient retry budget 和 provider recovery wait 机制。
3. 设计必须说明 `shouldStopBatchAfterFailure()` 的变更边界。
4. 设计必须说明既有 `classifyFailure()` 语义是否改变。
5. 设计必须避免把用户凭据问题伪装为本地可修复问题。
6. 设计必须确保新 runner 看到既有 auth failed checkpoint 时启动前停批。
7. 设计必须不修改 qmd / GraphRAG 构建状态展示语义。
8. 设计必须不修改输出格式、research 子命令或 CLI 查询逻辑。
9. 设计必须记录真实跑恢复前需先修复外部凭据。
10. 设计必须不提交 runtime artifacts。
