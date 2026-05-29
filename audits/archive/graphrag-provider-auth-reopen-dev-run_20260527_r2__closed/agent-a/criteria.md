# GraphRAG Provider Auth Reopen 审计基准

1. Provider auth stop 识别必须只接受明确证据，包括 HTTP 401/403、
   `INVALID_API_KEY`、`unauthorized`、`forbidden` 或认证失败文本；该类失败必须保持
   `failureKind=permanent`、`retryable=false`、
   `recoveryDecision=stop_until_fixed`，不得进入 transient retry。

2. Reopen candidate 必须同时满足 `status=failed`、`retryable=false`、
   `recoveryDecision=stop_until_fixed` 和 provider auth 证据；其他失败类型、
   pending/running/completed 状态、transient provider recovery 不得被 auth reopen
   修改。

3. Provider auth readiness 必须 fail closed。配置不可读、必需变量 missing、必需变量
   被启动时 shell env 遮蔽 dotenv 时，reopen 必须阻断，并输出可审计的
   readiness/block reason。

4. `OPENAI_BASE_URL` 必须作为 OpenAI endpoint readiness 的必需项参与 presence、
   source、fingerprint 和 missing-key 判定；只检查 API key 不足以允许 reopen。

5. Dotenv precedence 必须稳定：project dotenv 先加载，`graph_vault/.env` 后加载；
   `graph_vault/.env` 只可覆盖非启动时 shell env 注入的值，启动时 shell env 不得被
   dotenv 覆盖。

6. Shell env shadow 必须可观测且可阻断。若启动时 shell env 与 project 或
   `graph_vault` dotenv 中同名必需变量不同，必须标记
   `process_env_shadows_dotenv` 并阻断 provider auth reopen。

7. Reopen 必须幂等且有界。同一 current provider auth fingerprint 已 reopen 过、
   current fingerprint 与失败 fingerprint 未变化、或 attempt limit 已达到时，不得再次
   reopen；attempt count 不得被 reopened fingerprint 数量降级。

8. Legacy checkpoint 兼容只能有界放行。缺失失败时 fingerprint 的旧 provider auth
   checkpoint 可在 provider context ready 时 reopen，但必须记录
   `legacyProviderAuthFingerprintMissing=true`、current fingerprint 和 attempt。

9. Reopen 只可把 item 恢复到 `pending/continue_pending`，不得写 completed 或伪造
   qmd/GraphRAG 成功；后续必须重新走 GraphRAG resume、query readiness 和 27 个
   qmd command checks 的 closed loop。

10. Secret redaction 必须覆盖 process env、project dotenv、`graph_vault/.env`、URL
    credentials、Bearer token、API key/base URL 文本和绝对路径；状态、事件、summary
    和审计输出只允许 present/missing/source/fingerprint 等语义，不得包含原始密钥值。
