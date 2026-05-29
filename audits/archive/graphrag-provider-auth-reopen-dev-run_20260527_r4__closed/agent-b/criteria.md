# 批量 EPUB 到 GraphRAG 闭环审计基准

1. **真实阶段成功门**：每本书只有在 qmd build succeeded、GraphRAG build
   succeeded、GraphRAG query succeeded 均由当前证据重新计算为成功时，才可进入
   `completed`。

2. **命令检查完整门**：每个 `completed` item 必须恰好包含固定的 27 个 qmd
   command checks，名称无缺失、无重复、无额外项，且全部为 `passed`。

3. **生产者与运行隔离**：GraphRAG 高成本阶段产物必须绑定当前 book、stage、
   producer run id、stage fingerprint、provider fingerprint，不得混用旧 run、
   其他 stage 或其他 book 的产物。

4. **内容哈希隔离**：source hash、normalized content hash、artifact content
   hash、corpus content hash 必须分别校验；GraphRAG checkpoint、producer
   manifest 和 artifact manifest 必须在内容身份上 fail closed。

5. **书级路径隔离**：GraphRAG 输入、输出、LanceDB 和报告产物必须位于当前
   `books/<bookId>/...` 范围内；host absolute path、共享 `graph_vault/output`
   或越界 realpath 不得满足 readiness。

6. **query_ready 可追溯性**：`query_ready` 只能引用已完成且已验证的
   `graph_extract`、`community_report`、`embed` producer run 产物，并且不得把
   projection repair 当作高成本阶段成功替代品。

7. **远程运行与孤儿恢复**：fresh remote running lease 必须只观测不抢占；
   missing ownership、过期 heartbeat 或 dead same-host PID 必须投影或恢复为
   retryable pending，并保留同一 run id 的恢复语义。

8. **错误分类与重试预算**：provider transient、provider auth、data
   compatibility、local artifact gate、unknown/permanent failures 必须有稳定分类；
   transient 必须受 retry budget 和 provider recovery wait budget 约束，401/403
   provider auth 必须 fail-fast 到 stop-until-fixed，修复后只能按受控 reopen
   重跑。

9. **状态投影不可误导**：`--status-json` 与 recovery summary 必须只读、重算
   readiness，不写 checkpoint；不得把 stale persisted status、seeded manifest、
   skipped item、partial check set 或 stale provider-auth metadata 展示为完成。

10. **秘密最小披露**：日志、checkpoint、summary、事件和审计材料不得暴露
    `.env` 或环境变量 secret 值；只允许使用 present/missing/source/fingerprint/
    redacted 语义。
