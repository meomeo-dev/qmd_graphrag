# GraphRAG 并行 Runner 实施审计基准

1. **同 runId 单协调器（single coordinator）**
   同一 `runId` 任意时刻只能有一个 live coordinator 写共享 batch 状态。
   实现必须有持久 coordinator lock、心跳、过期接管检查，以及子进程注册表
   重建（subprocess registry reconciliation）。

2. **Item claim 与 fencing**
   每个 item claim 必须是原子且持久的。live claim 必须包含 runner session、
   worker identity、lease generation、expiresAt 与 fencing token；写入
   checkpoint、event、manifest、catalog、artifact 或 qmd 产物前必须校验。

3. **Book 级互斥（book-scoped mutual exclusion）**
   每个 `bookId` 必须有独立持久 book lease。解析到同一本书的重复 item
   不得并发执行 qmd、GraphRAG、checkpoint、artifact 或 query-ready producer。

4. **顺序兼容（sequential compatibility）**
   `--book-concurrency 1` 必须保持旧顺序执行的 item 顺序、retry 语义、事件、
   manifest 与 completed-item 行为。

5. **Manifest 与 event 一致性**
   Manifest 与 status 必须由 durable checkpoint 和有效 event 派生。Event
   必须可安全追加，具备稳定 identity 与 sequence；恢复必须处理 partial
   JSONL tail、duplicate event、temp file 与 manifest drift。

6. **Provider slot 治理**
   qmd 与 GraphRAG 子进程中的 OpenAI-compatible 和 Jina 请求必须受
   coordinator-granted provider slot 控制。Slot 必须是持久 lease，具备
   generation、wait metric、release event、leak recovery 与 status-json 可见性。

7. **qmd index 写入安全**
   所有 `.qmd/index.sqlite` 与 qmd corpus 写入必须由 qmd index writer lane
   和 file lock 串行化；SQLite `busy` 或 `locked` 必须按 bounded local retry
   分类，并通过可观测 retry metric 暴露。

8. **失败与等待语义（failure/wait semantics）**
   Fail-fast、transient retry、provider recovery wait、provider auth 与
   non-transient stop 语义必须保持区分。可恢复 provider wait 不得阻塞无关
   runnable book；不可恢复失败必须在新 claim 前 quiesce scheduler。

9. **GraphRAG 闭环 gate**
   completed item 必须具备真实 qmd build evidence、GraphRAG stage producer
   lineage、有效 book-scoped artifact、qmd corpus registration、query-ready
   checkpoint validation 与 GraphRAG query check。repair-only 或 projection
   state 不得弱化该 gate。

10. **生产级测试覆盖**
    测试必须覆盖 parallel/sequential worker、duplicate book 排他、
    coordinator recovery、stale claim fencing、provider slot contention 与 leak
    recovery、qmd SQLite lock contention、event/manifest reconciliation，以及
    fail-fast/transient/provider wait 的持久证据。
