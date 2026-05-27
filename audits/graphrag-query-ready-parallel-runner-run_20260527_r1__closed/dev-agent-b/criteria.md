# 实施审计基准原则

1. 批量状态恢复必须以持久化证据为准，不得通过删除
   `graph_vault/books/<bookId>/output`、清空目录或手改 checkpoint 得到
   假成功状态。
2. `completed` item 必须重新验证 qmd build、GraphRAG build、GraphRAG query
   与固定命令检查集合，不得信任历史 `qmdBuildStatus` 或旧摘要字段。
3. `query_ready` repair 只能修复本地 projection、producer manifest 或 capability
   projection，不得重跑 `graph_extract`、`community_report`、`embed` 高成本阶段。
4. repair-only 路径在 blocked 时必须立即返回 blocked，不得进入普通 24 pass
   resume 循环或造成无限同状态循环。
5. provider auth、provider transient 与 query-ready producer gate failure 必须分类
   隔离，producer lineage/gate 文本不得污染 auth/transient 恢复决策。
6. 同一 `runId` 恢复必须保持幂等；已存在的 producer run id、stage
   fingerprint、provider fingerprint 不得被无证据覆盖。
7. `running` checkpoint 的 runner ownership 与 heartbeat 必须阻止重复 writer；
   stale runner 恢复必须有可审计字段和事件。
8. 本地 artifact gate repair 必须 fail-closed：混书输出、source/content mismatch、
   normalizedPath mismatch、缺失 producer lineage、空 text unit 或不完整 artifact
   不得被修复为 ready。
9. 事件日志、recovery summary 与 `--status-json` 投影必须表达同一事实，且不得
   包含密钥、Bearer token、原始 provider 请求体或响应体。
10. 测试覆盖必须包含状态机负例、repair-only blocked、provider auth/transient
    分类隔离、query_ready lineage 修复和真实 batch 恢复安全性。
