# GraphRAG Batch Provider Auth Reopen 审计基准

1. Provider auth failure 判定必须只覆盖明确认证失败
   （authentication failure），包括 HTTP 401、403、`INVALID_API_KEY`、
   `unauthorized`、`forbidden` 或等价认证失败文本；该类失败必须保持
   `failed + retryable=false + stop_until_fixed`，不得被 transient provider wait
   吞掉。

2. Provider auth reopen 只允许处理明确候选 checkpoint
   （eligible checkpoint）：`status=failed`、`retryable=false`、
   `recoveryDecision=stop_until_fixed`，且失败证据为 provider auth failure。
   重开结果只能写回 `pending + continue_pending`，不得直接或间接写成
   `completed`。

3. Provider auth context 必须 fail-closed。必需密钥和端点
   （required keys and endpoints）均须 present；`OPENAI_BASE_URL` 是 OpenAI
   Responses 路径的必需 endpoint；provider 配置不可读或非法时必须阻断 reopen，
   并投影 `provider_auth_config_unreadable`。

4. Dotenv 优先级必须清晰且可审计：默认加载项目根 `.env` 后加载
   `graph_vault/.env`；当 shell process env 未预先占用同名变量时，
   `graph_vault/.env` 是批处理权威值（authoritative value）。`--skip-dotenv`
   必须不加载 dotenv，状态只能显示 `dotenv_not_loaded` 等语义。

5. Process env shadow 必须阻断 provider auth reopen。若初始 shell env 与
   权威 dotenv 的 observed provider 变量不同，包括 endpoint 变量，必须投影
   `process_env_shadows_dotenv`，不得继续高成本阶段。

6. Provider auth fingerprint 决策必须有界且顺序稳定
   （bounded and ordered）：配置未 ready 优先于所有 reopen 判断；随后检查当前
   fingerprint present、attempt-limit、failure fingerprint unchanged、current
   fingerprint already_reopened，最后才允许 reopen。attempt count 不得因历史数组
   缺失而降级。

7. Provider auth 状态投影必须基于当前上下文重新计算候选决策，不得用旧
   metadata 显示过期的 ready、eligible 或 reopen 结论。非候选 item 不得投影会被
   操作者误读为当前可重开或当前被阻断的 provider auth 状态。

8. 状态投影必须保留可诊断的 GraphRAG lineage 事实。artifact 存在但 producer
   run、provider fingerprint、stage fingerprint 或 corpus hash 不匹配时，必须报告
   mismatch/stale lineage（例如 `stage_artifact_producer_run_mismatch`），不得退化为
   `artifact_missing`。

9. Provider auth reopen 和 item start 必须带锁与 CAS（compare-and-swap）。写入前
   必须在文件锁内重读 checkpoint，比较 status、attempts、failed/completed 时间、
   recovery decision、runner lease 等关键字段；重复 runner、fresh remote lease、
   stale in-memory decision 和重复 current fingerprint 都必须 fail-closed。

10. 每本书的 `completed` 必须由完整闭环证明（closed loop evidence）产生或维持：
    EPUB normalize、GraphRAG build、GraphRAG query、固定 qmd command checks 全部
    成功，且 GraphRAG artifacts 为当前书 book-scoped、内容哈希、producer lineage、
    provider fingerprint 与 stage fingerprint 一致。`status-json` 与 `migrate-only`
    不得把 skipped/imported、缺 qmd、缺 GraphRAG 或缺 query 的书投影或计数为真实
    completed；迁移模式只能迁移结构和脱敏历史，不能掩盖闭环缺口。
