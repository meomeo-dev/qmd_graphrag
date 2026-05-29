# GraphRAG 多书并行 Runner 实施审计基准

1. 同 runId 协调器互斥（coordinator exclusivity）必须由持久
   `coordinator-lock.json` 执行。锁必须包含 `runnerSessionId`、pid、
   heartbeat、expiry、generation，并通过原子 compare-and-swap
   获取、续租、接管和释放。
2. item 与 book 的工作权（lease）必须持久化并带 fencing token。
   每次 checkpoint、event、manifest、catalog、qmd index、book artifact
   写入前都必须验证当前 fencing token 仍有效。
3. provider 并发限制（provider semaphore）必须覆盖所有可能调用
   OpenAI/Jina 的 qmd 与 GraphRAG 子进程。子进程启动前必须获得 slot
   lease，并记录 provider、slot、generation、fencing token、释放事件和
   可恢复状态。
4. qmd index writer lane 与文件锁必须覆盖 `.qmd/index.sqlite` 的所有写入
   路径，包括父进程 qmd 命令、GraphRAG/resume 子进程、SQLite 事务和恢复。
   锁必须有 owner、timeout、stale pid 检查和 bounded retry。
5. 子进程边界（child process boundary）必须可恢复。每个 qmd/GraphRAG
   命令必须登记 durable subprocess registry，使用独立 process group，
   timeout 后先 terminate 再 kill 整个 process group，并在 `close` 后清理。
6. events、checkpoint、manifest、status、catalog 写入必须满足 durable
   write contract。JSON/YAML 替换必须 temp file、fsync file、atomic rename、
   fsync parent；events 必须有 `eventId`、`sequence`、单行 append、flush/fsync
   和尾部损坏恢复。
7. 终态提交（terminal commit）必须有固定顺序：验证 item/book lease 和
   provider slot，验证 qmd/GraphRAG/query_ready 证据，写 book checkpoint，
   写 item checkpoint，追加 event，派生 manifest/status，最后释放 lease。
8. run manifest 与 status-json 必须从 durable checkpoint 和 durable events
   派生，而不是以内存计数为权威。status-json 必须展示 provider slots、
   wait time、slot generation、worker、running command 和恢复决策。
9. worker pool 必须证明单进程 coordinator 内的 bounded parallelism。
   多 worker 不得让同一 item 或同一 book 并发执行；fail-fast、provider
   wait、retry window 与 stop_until_fixed 必须不造成重复 claim 或饥饿。
10. 测试证据必须是行为级（behavioral evidence）。测试应覆盖同 runId 双
    OS runner 竞争、provider slot 竞争、qmd index 文件锁竞争、子进程
    timeout/process-group kill、event/manifest crash recovery、stale fencing
    写入拒绝，以及单进程 worker pool 的真实重叠执行。
