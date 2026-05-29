# Agent A Development Audit Criteria

审计对象：Batch provider auth fail-fast 实施。

固定基准如下：

1. 实施必须从 checkpoint 顶层和 failed command checks 中读取 provider
   status code。
2. 实施必须让 401 和 403 触发当前 batch runner 停批。
3. 实施必须让 invalid api key / invalid_api_key / unauthorized /
   forbidden / authentication 文本触发 provider auth 停批。
4. 实施不得使用过宽的 `auth` 子串，避免误伤 unrelated text。
5. 实施不得把普通 400、409 等非 auth 4xx 扩大为全局停批。
6. 实施不得改变 429/5xx transient retry budget 或 provider recovery wait。
7. 实施不得让 provider 401 进入 local artifact gate repair。
8. 实施必须通过事件或 summary 观察到 `stop_until_fixed` 和 provider_auth
   停批原因。
9. 测试必须证明 401 后同一 runner 不启动后续 item。
10. 验证必须真实执行聚焦测试、`npm run typecheck` 和 `git diff --check`。
