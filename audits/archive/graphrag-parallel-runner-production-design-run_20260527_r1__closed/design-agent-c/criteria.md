# GraphRAG 多书并行 Runner 生产设计审计基准

后续复审必须沿用以下 10 条基准，并保持编号、含义与判定边界稳定。

1. Coordinator 与 lease fencing
   同一 `runId` 必须只有一个有效 coordinator。同一 `itemId` 与同一
   `bookId` 必须分别只有一个 live writer，过期 worker 的持久化写入必须由
   fencing token 拒绝。

2. qmd SQLite 与 qmd 全局写入安全
   所有会写入 `.qmd/index.sqlite`、qmd corpus、qmd registration、embedding
   或 cleanup 状态的路径必须串行化，并说明子进程不得绕过 writer lane。设计
   还必须定义 SQLite lock contention、busy/retry、失败恢复与锁持有边界。

3. GraphRAG 产物隔离与 lineage gate
   每本书必须拥有独立 GraphRAG work/output/report/log 目录。`query_ready`
   只能引用同一 `bookId`、同一有效 producer lineage 与已验证 stage artifact。

4. Provider semaphore 与子进程边界
   OpenAI、Jina 等 provider 并发必须在所有 worker 和所有实际 provider call
   上全局生效，包括 GraphRAG/qmd 子进程内部调用。设计必须说明 semaphore 如何
   跨进程实施、如何避免单书独占、以及 provider wait 不阻塞其他可运行书。

5. 事件、checkpoint 与 manifest 持久化原子性
   `events.jsonl` append、checkpoint 写入与 manifest refresh 必须有明确的
   atomic write、flush/fsync、partial record recovery、sequence/idempotency
   与 crash recovery 规则。Run 级统计必须可从磁盘状态完整派生。

6. Writer lanes、临界区与死锁控制
   catalog、qmd index、event、checkpoint 等共享写入 lane 必须容量明确、进入
   退出明确、异常时释放明确，并规定跨 lane 获取顺序或禁止嵌套规则，避免
   deadlock 与长期占用。

7. 失败分类、恢复与重入
   transient provider failure、permanent provider failure、artifact gate
   failure、worker crash 与 coordinator crash 必须映射到可恢复、停止或修复
   决策，并保留足够证据支持重启后的 deterministic resume。

8. CLI、环境变量与 secret 契约
   CLI/env 必须覆盖并发、路径、配置、dotenv precedence 与诊断输出。设计必须
   定义参数范围、优先级、冲突处理、secret 最小传递与日志/status redaction。

9. 测试与验收可实施性
   设计必须给出可执行的 unit、integration、fault-injection 与 production
   dry-run/real-run 验收项，覆盖并发 claim、SQLite 写锁、GraphRAG 隔离、
   provider retry、崩溃恢复与顺序兼容。

10. 生产观测与运维可诊断性
    events、status-json、logs 与 metrics 必须支持定位 worker、stage、provider
    slot、writer lane、retry、失败原因、恢复进度与资源闲置问题，并保证不泄露
    provider secret。
