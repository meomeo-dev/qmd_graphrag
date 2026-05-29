# GraphRAG Provider Auth Reopen 审计基准

1. dotenv 解析（dotenv parsing）必须只接受显式 `KEY=value` 或
   `export KEY=value` 形式，忽略空行、注释和非法变量名，并避免把解析失败的
   内容当作凭据。
2. dotenv 加载顺序必须稳定：先加载项目根 `.env`，再加载
   `graph_vault/.env`；未被初始 shell 环境占用时，
   `graph_vault/.env` 对同名变量具有当前批处理权威优先级
   （authoritative precedence）。
3. 初始 shell 环境（initial shell environment）中的 provider 变量不得被
   dotenv 覆盖；若其值与权威 dotenv 不同，必须被标记为 shadow，并阻断
   provider auth reopen。
4. provider auth 状态持久化只能包含 present/missing、source、
   redacted fingerprint、readiness status、blocked reason 和 attempt count；
   不得持久化 provider secret 原文、dotenv 原文值或 bearer token。
5. 日志、事件、checkpoint、recovery summary 和异常输出必须统一通过脱敏
   （redaction）路径处理，包括精确环境值、URL userinfo、敏感 query 参数、
   bearer token、API key 形态和绝对路径。
6. provider auth reopen 必须 fail-closed：缺少必需 key、缺少 OpenAI base URL、
   provider 配置不可读、Responses API 配置不符合运行时约束、shell shadow、
   fingerprint 缺失异常或 attempt limit 达到时，不得重开 checkpoint。
7. OpenAI Responses base URL readiness 必须明确建模：`OPENAI_BASE_URL`
   或配置指定的等价 env 名必须作为必需 endpoint present 后，才允许 reopen。
8. OpenAI Responses API 边界必须验证 endpoint、stream transport 和 strict
   structured output；配置偏离运行时约束时，provider auth 恢复必须阻断而非
   继续执行真实批处理。
9. test hook 只能由初始进程环境显式激活；dotenv 中新增的
   `QMD_GRAPHRAG_*` hook 变量不得激活 fake qmd 或 fake resume runner。
10. provider auth reopen 必须有界且闭环：只处理明确的
    `failed + retryable=false + stop_until_fixed` provider auth failure，重开后
    只能回到 `pending/continue_pending`，清空旧命令检查，并要求重新完成真实
    GraphRAG 与 qmd command check 闭环。
