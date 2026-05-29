# Provider Auth Failure Reopen 开发审计基准

1. 401/403 provider auth failure 必须保持 permanent stop 语义
   （permanent stop semantics），不得被 transient retry、local artifact
   repair、data compatibility 分支误处理。

2. provider auth reopen 只允许作用于 `status=failed`、`retryable=false`、
   `recoveryDecision=stop_until_fixed` 且可判定为 401/403 或认证失败文本
   的 checkpoint。

3. 重开必须依赖当前已脱敏 provider auth fingerprint（redacted current
   fingerprint）和 ready 状态；缺少必要 key、当前 fingerprint 缺失、
   或 shell env shadow 项影响 required key 时必须阻断重开。

4. 当前 fingerprint 与失败时 fingerprint 相同，或当前 fingerprint 已在
   `providerAuthReopenedFingerprints` 中出现时，不得重复重开。

5. provider auth fingerprint 必须是不可逆摘要或配置摘要，不得记录原始
   key、base URL 密钥材料、Bearer token、`.env` 值，且事件、checkpoint、
   summary 必须保持脱敏。

6. `--status-json` 必须只读（read-only）；不得创建、修改 checkpoint、
   manifest、event log、summary、GraphRAG output manifest 或 raw logs，
   也不得运行 normalize/resume/qmd checks。

7. `--migrate-only` 不得运行 provider auth reopen、normalize、resume、
   qmd checks 或真实构建；只允许执行既有迁移与审计性输出。

8. 重开行为必须可审计（auditable）：event、checkpoint metadata、
   recovery summary 必须能说明重开、阻断、fingerprint 变化、ready 状态、
   原失败状态与后续失败。

9. 重开后的执行路径必须经过 `markItemRunning -> runItem ->
   runGraphResume -> 27 qmd checks`，不得跳过 normal command checks，也不得
   只做 GraphRAG resume 后标记完成。

10. 实现不得引入语法错误、死锁、无限循环、无限重复重开、shell env shadow
    误判、或因 schema 不一致导致运行时崩溃；测试应覆盖关键正向、阻断和
    回归路径。
