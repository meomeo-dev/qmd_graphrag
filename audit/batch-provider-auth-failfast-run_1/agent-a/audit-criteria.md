# Agent A Design Audit Criteria

审计对象：Batch provider auth fail-fast 设计。

固定基准如下：

1. 设计必须说明真实 401 `INVALID_API_KEY` 触发场景。
2. 设计必须区分 auth/config 4xx 与 transient 429/5xx。
3. 设计必须要求 401 和 403 停止当前 batch runner。
4. 设计必须要求 invalid api key / unauthorized / forbidden 文本停批。
5. 设计不得把所有 4xx 都扩大为全局停批。
6. 设计不得改变 GraphRAG bridge projection 或 artifact gate。
7. 设计必须保留 local artifact repair 不处理 provider 401。
8. 设计必须要求 status/events/recovery summary 可观测。
9. 设计必须要求测试证明后续 item 不会在 401 后启动。
10. 设计必须要求验证命令真实可执行。
