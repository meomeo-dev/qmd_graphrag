# Agent B Development Audit Criteria

审计对象：Batch provider auth fail-fast 实施。

固定基准如下：

1. 实施必须只改批处理停机策略，不改 GraphRAG bridge projection、
   artifact lineage 或 query_ready gate。
2. 实施必须保留 data compatibility 停批旧行为和旧兼容事件。
3. provider auth 停批不得发出 data compatibility 专属事件。
4. 通用 non-transient 停批事件必须携带可机器读取的停批原因。
5. 新 runner 读取既有 401/403 failed checkpoint 时必须在处理下一本前停批。
6. status-json 不应执行工作，也不应因本变更产生事件副作用。
7. 现有 mixed provider/local projection 用例必须继续证明 provider 401 不修复。
8. 新测试不得依赖真实 LLM、真实 API key 或网络。
9. 实施不得新增依赖、配置模板变更或运行产物提交。
10. 提交前必须审查 diff，确认无关 CLI 输出格式、research 子命令或 token
    配置变更。
