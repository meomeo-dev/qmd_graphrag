# GraphRAG Provider Auth 恢复审计基准

1. dotenv 解析（dotenv parsing）必须只接受显式 `KEY=value` 或
   `export KEY=value` 形式，忽略空行、注释和非法变量名，不得把解析失败内容当作
   凭据。
2. dotenv 权威顺序（authoritative precedence）必须稳定：先加载项目根 `.env`，
   再加载 `graph_vault/.env`；未被初始 shell 环境占用时，
   `graph_vault/.env` 对同名 provider 变量具有当前批处理权威优先级。
3. 初始 shell 环境（initial shell environment）中的 provider 变量不得被 dotenv
   覆盖；若其值与权威 dotenv 不同，必须标记为 shadow 并阻断 provider auth
   reopen。
4. observed provider env，包括 endpoint env（如 `JINA_API_BASE`），只要被初始
   shell 环境遮蔽权威 dotenv，就必须可观测且 fail-closed。
5. `OPENAI_BASE_URL` 或配置指定的等价 OpenAI base URL env 必须作为 required
   endpoint 建模；缺失时不得重开 provider auth checkpoint。
6. provider 配置读取或运行时约束验证失败时必须 fail-closed，包括 OpenAI
   Responses endpoint、stream transport、strict structured output 和 Jina profile
   约束。
7. provider auth 状态持久化只能包含 present/missing、source、redacted
   fingerprint、readiness status、blocked reason 和 attempt count；不得持久化
   provider secret、dotenv 原值、process env 原值或 bearer token。
8. 日志、事件、checkpoint、recovery summary、raw log migration 和异常输出必须统一
   经过脱敏（redaction），覆盖精确环境值、dotenv 精确值、URL credential、敏感
   query 参数、bearer token、API key 形态和绝对路径。
9. provider auth reopen 必须有界且闭环：只处理明确的
   `failed + retryable=false + stop_until_fixed` provider auth failure；重开后只能回到
   `pending/continue_pending`，清空旧命令检查，并要求重新完成真实 GraphRAG 与
   qmd command check 闭环。
10. 恢复前只读状态命令（read-only status projection）必须足以逐本确认 qmd build、
    GraphRAG build、GraphRAG query、runner、retry/provider wait 和 stale producer
    lineage 状态；不得把已知 stale lineage 退化成误导性的缺失状态。
