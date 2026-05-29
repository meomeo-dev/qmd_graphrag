# GraphRAG 多书并行 Runner 实施审计发现

## 决策

fail

当前实现已具备单进程 worker pool 的基本并行能力，但生产设计中的
run 级协调器锁、fencing、durable provider slot、durable subprocess
registry 和 fsync 写入协议尚未落地。资源竞争与子进程边界不能判定为
生产就绪（production ready）。

## Blocking Findings

### C-01: 缺少同 runId coordinator lock

严重性：blocking

证据路径/函数：

- [docs/architecture/graphrag-parallel-runner.type-dd.yaml](../../../../docs/architecture/graphrag-parallel-runner.type-dd.yaml)
  `runLock` 要求 `graph_vault/catalog/batch-runs/{runId}/coordinator-lock.json`
  使用 generation compare-and-swap、heartbeat 和 takeover guard。
- [scripts/graphrag/batch-epub-workflow.mjs](../../../../scripts/graphrag/batch-epub-workflow.mjs)
  `main` 在 6375-6431 直接加载 manifest/checkpoints 并启动 runner
  配置事件，没有 acquire/heartbeat/release run lock。
- 同文件 2153-2199 的 `withJsonFileLock` 仅保护单个 JSON 文件，不是 run
  级 coordinator 互斥。
- 全仓库检索只在设计文档中出现 `coordinator-lock`，实现和测试未出现该
  文件名或等价 run lock。

影响：

两个 OS 级 `batch-epub-workflow` 进程使用同一 `--run-id` 时都可进入
coordinator 路径。它们会竞争 item checkpoint、events、manifest、qmd index
和 book artifacts，违反 `single_coordinator_per_run`。

测试缺口：

- [test/cli.test.ts](../../../../test/cli.test.ts) 2110-2304 的并行测试只启动
  一个 batch 进程，用 fake resume 证明 `book-concurrency=2` 有重叠执行。
- 未测试两个 OS runner 使用同一 runId 时第二个进程必须拒绝、等待或受控
  takeover。

修复建议：

实现 `coordinator-lock.json`。获取锁时写同目录临时文件、fsync、atomic
rename，再做 generation CAS；heartbeat 必须带 current generation 与
`runnerSessionId`；接管前检查旧 pid 和 durable subprocess registry。正常
退出释放或标记 expired，status-json/migrate-only 不应成为 writer。

### C-02: item/book lease 没有 fencing token，stale worker 可写持久状态

严重性：blocking

证据路径/函数：

- [src/contracts/batch-run.ts](../../../../src/contracts/batch-run.ts) 82-128 的
  checkpoint schema 只有 `runnerSessionId`、`runnerHost`、`runnerPid`、
  `runnerHeartbeatAt`，没有 `fencingToken`、`generation`、`expiresAt` 或
  `workerId`。
- [scripts/graphrag/batch-epub-workflow.mjs](../../../../scripts/graphrag/batch-epub-workflow.mjs)
  `markItemRunning` 5663-5721 只用当前 checkpoint 字段做一次比较后写
  running。
- 同文件 `runItem` 5602-5624 调用 `saveCheckpoint` 后直接追加
  `item_completed`，没有重新验证 item/book fencing。
- 同文件 `activeRunningBookCheckpoint` 1738-1750 只扫描当前进程内的
  checkpoints map，未创建 durable book lease。

影响：

若旧 worker 在 lease 过期后继续运行，或另一个 coordinator 接管同一 item/book，
旧 worker 仍可能写 checkpoint、event、manifest 或 book-scoped artifact。
同 bookId 的不同 item 也缺少持久 book lease 屏障。

测试缺口：

未见 stale worker 写入被 fencing 拒绝、同 bookId 双 item 竞争、旧
`runnerSessionId` 完成写被拒绝的行为测试。

修复建议：

为 item lease 和 book lease 增加 durable CAS：`runnerSessionId`、`workerId`、
`fencingToken`、`generation`、`heartbeatAt`、`expiresAt`。所有持久写入函数
接收并校验 fencing token；完成、失败、恢复、artifact 投影和 qmd/corpus
写入前都必须校验当前 generation。

### C-03: provider semaphore 只在当前 Node 进程内有效，未跨子进程形成 slot lease

严重性：blocking

证据路径/函数：

- [scripts/graphrag/batch-epub-workflow.mjs](../../../../scripts/graphrag/batch-epub-workflow.mjs)
  `AsyncSemaphore` 1859-1938 是内存队列，未持久化 slot lease。
- 同文件 `qmd` 4942-4968 仅在父进程启动 qmd 命令前包一层 semaphore。
- 同文件 `runGraphResume` 5111-5155 仅按 next stage hint 包住整个
  `resume-book` 子进程，没有向子进程传入 slot id、generation、fencing
  token 或 release contract。
- 同文件 `runCommand` 4785-4792 传入的 env 只有通用 qmd/graphrag 配置，
  没有 provider slot lease 诊断字段。
- [src/contracts/batch-run.ts](../../../../src/contracts/batch-run.ts) 221-252 的
  status summary item schema 没有 `activeProviderSlots`、`providerWaitMs` 或
  `providerSlotGeneration`。

影响：

同一 runId 的多个 OS runner 会分别拥有自己的内存 semaphore，实际 provider
请求并发可能超过配置。GraphRAG/qmd 子进程内的真实 API 请求也无法逐请求回到
coordinator；当前实现最多是 best-effort process-level wrapper，且没有可恢复
slot lease。

测试缺口：

没有测试 OpenAI/Jina provider concurrency 在多 worker 下的最大活跃 slot；
没有测试子进程超时、失败、kill 后 provider slot 被 durable 回收；没有
status-json 断言 active slot 与 wait time。

修复建议：

实现 durable provider slot registry 或 request-level IPC/proxy。启动任何
provider 子进程前必须 claim slot lease，lease 包含 provider、workerId、
itemId、bookId、commandId、generation、fencingToken、expiresAt。子进程退出、
timeout、kill、lease loss 和恢复扫描都必须释放或回收 slot，并在 status-json
暴露 active slots 和 wait metrics。

### C-04: qmd index writer lane 与文件锁没有统一覆盖所有写入路径

严重性：blocking

证据路径/函数：

- [scripts/graphrag/batch-epub-workflow.mjs](../../../../scripts/graphrag/batch-epub-workflow.mjs)
  `qmdIndexWriterLane` 1938 是父进程内 semaphore。
- 同文件 `qmd` 4959-4967 只对 `qmd-pull`、`qmd-update`、`qmd-embed`、
  `qmd-cleanup` 包父进程 lane。
- 同文件 `runGraphResume` 5122-5155 启动 GraphRAG/resume 子进程时未持有
  `qmdIndexWriterLane`，但向子进程传入 `--qmd-index-path`。
- [src/job-state/graphrag-book.ts](../../../../src/job-state/graphrag-book.ts)
  `registerQmdCorpusDocument` 1007-1041 使用独立 `.lock` 文件写 qmd index。
- 同文件 `withQmdIndexFileLock` 1048-1084 使用 `openSync(lockPath, "wx")`
  和 mtime stale 删除，没有 owner、pid liveness、timeout、fsync 或 SQLite
  busy_timeout 证据。

影响：

父进程 qmd writer lane、GraphRAG 子进程 `.lock`、可能的 qmd CLI 内部 SQLite
写入不是一个统一协议。多 worker、多 OS runner 或 GraphRAG child 与 qmd
writer 交错时，`.qmd/index.sqlite` 仍可能出现 writer 冲突、stale lock 误删、
长期等待或 SQLite busy 失败。

测试缺口：

没有让 fake qmd writer 与 resume child 同时持有/竞争 qmd index lock 的测试；
没有 SQLite locked/busy bounded retry 测试；没有 stale `.lock` owner 仍存活时
拒绝删除的测试。

修复建议：

统一所有 qmd index 写入到同一个 durable writer lane/file lock。锁文件记录
owner pid、runnerSessionId、workerId、itemId、bookId、generation 和 expiresAt；
获取锁必须有 timeout 与活 pid 检查。qmd CLI、GraphRAG child 和 direct store
写入都必须复用该协议，并配置 SQLite `busy_timeout` 与 bounded retry。

### C-05: 子进程 timeout/kill 没有 process group 与 durable registry

严重性：blocking

证据路径/函数：

- [docs/architecture/graphrag-parallel-runner.type-dd.yaml](../../../../docs/architecture/graphrag-parallel-runner.type-dd.yaml)
  子进程协议要求 process group、durable subprocess registry、terminate/kill
  整组进程和 takeover 扫描。
- [scripts/graphrag/batch-epub-workflow.mjs](../../../../scripts/graphrag/batch-epub-workflow.mjs)
  `spawnCommand` 4685-4761 用普通 `spawn` 启动命令，未设置 command child
  `detached: true` 或记录 registry。
- 同函数 4703-4716 timeout 时只对 child pid 发送 `SIGTERM` 后 `SIGKILL`。
  若命令启动 Python/GraphRAG/grandchild，子进程组可能残留。
- 同文件 2713-2755 只有 heartbeat monitor 使用 `detached: true`，不是 qmd 或
  GraphRAG 工作命令。

影响：

GraphRAG 或 qmd 命令 timeout 后可能留下仍在调用 provider、写 output 或写
SQLite 的孤儿进程。新 runner 无 durable registry 可扫描，也无法在 takeover
前确认旧 child process group 已终止。

测试缺口：

没有测试命令启动 grandchild 后 timeout，grandchild 必须被 kill；没有
subprocess registry 恢复测试；没有 takeover 前旧 process group 无法终止时
进入 `stop_until_fixed` 的测试。

修复建议：

为每个命令创建 `commandId` 和 registry record，记录 pid/pgid、itemId、bookId、
provider slot、startedAt、timeoutAt。Unix 下用 detached process group 并对
`-pid` kill，Windows 使用 job object 或等价策略。timeout 后先 graceful
terminate，再 kill，等待 `close`，最后更新 registry 和释放 provider slot。

### C-06: events/manifest/checkpoint 写入不满足 durable write contract

严重性：blocking

证据路径/函数：

- [scripts/graphrag/batch-epub-workflow.mjs](../../../../scripts/graphrag/batch-epub-workflow.mjs)
  `event` 2099-2124 使用 `writeFileSync(..., { flag: "a" })` 追加，没有
  `eventId`、`sequence`、flush/fsync 或 tail recovery。
- [src/contracts/batch-run.ts](../../../../src/contracts/batch-run.ts) 202-219 的
  `BatchEventLogSchema` 没有 `eventId` 或 `sequence` 字段。
- [scripts/graphrag/batch-epub-workflow.mjs](../../../../scripts/graphrag/batch-epub-workflow.mjs)
  `writeJsonAtomic` 2130-2135 只 write temp + rename，没有 fsync 文件或父目录，
  文件内容也没有 generation/checksum。
- 同文件 `migrateEventLog` 4569-4573 整体重写 `events.jsonl`，不是同目录
  temp + fsync + atomic rename。

影响：

进程崩溃、机器掉电或并发 writer 下，events 可能丢失、半行损坏、重复或乱序；
manifest/checkpoint/catalog 替换可能在 rename 前后出现不可恢复的持久状态。
恢复逻辑无法基于 event sequence 做幂等重放。

测试缺口：

没有 partial event tail 截断测试；没有 duplicate sequence/idempotent recovery
测试；没有 crash-between-checkpoint-and-event 或 crash-during-manifest-rename
测试。

修复建议：

新增 durable writer API。events 使用单次 append、`eventId`、monotonic
`sequence`、flush/fsync；恢复时截断尾部非完整 JSON 并记录恢复事件。JSON/YAML
替换使用 temp file、fsync file、atomic rename、fsync parent，并加入 generation
或 checksum。

### C-07: terminal commit 没有按设计执行 fenced finalization

严重性：blocking

证据路径/函数：

- [scripts/graphrag/batch-epub-workflow.mjs](../../../../scripts/graphrag/batch-epub-workflow.mjs)
  `runItem` 5550-5601 验证 qmd/GraphRAG/query 状态后构造 completed。
- 同函数 5623-5624 调用 `saveCheckpoint` 后立即追加 `item_completed` event。
  没有 book checkpoint、item checkpoint、event、manifest 的 fenced
  critical section。
- `saveCheckpoint` 2557-2563 直接调用 `writeTypedJson`；`writeTypedJson`
  2192-2199 只持有单文件锁，没有验证当前 lease generation。

影响：

终态写入期间若 lease 被接管、子进程 slot 已失效、checkpoint 未 durable fsync
或另一个 coordinator 修改同 item/book，旧 worker 仍可提交 completed event。
这会把未满足生产闭环的状态标记为完成。

测试缺口：

没有模拟 terminal commit 前 lease 丢失、provider slot 丢失、checkpoint 写入后
event 前崩溃、event 写入后 manifest 前崩溃的测试。

修复建议：

实现 terminal commit transaction。提交前验证 item/book fencing token 与
provider slot generation；按固定顺序写 book checkpoint、item checkpoint、
event、derived manifest/status；每步 durable fsync；失败时保留可恢复证据并
禁止释放 lease 后再写 completed。

## Nonblocking Findings

### C-08: status-json 观测面不足以审计 provider 与 worker 资源状态

严重性：nonblocking

证据路径/函数：

- [scripts/graphrag/batch-epub-workflow.mjs](../../../../scripts/graphrag/batch-epub-workflow.mjs)
  `printStatusAndExit` 4445-4448 输出 `buildRecoverySummary`。
- [src/contracts/batch-run.ts](../../../../src/contracts/batch-run.ts) 221-252 的
  summary item schema 覆盖 runner heartbeat 和 provider recovery wait，但没有
  `activeProviderSlots`、`providerWaitMs`、`providerSlotGeneration` 或 per-worker
  slot ownership。
- `AsyncSemaphore` 1877-1893 只在 acquire event 中临时记录 `waitMs`，未进入
  status-json 派生模型。

影响：

即使 provider semaphore 后续实现正确，当前 status-json 也无法稳定证明生产
运行中哪个 worker 占用哪个 provider slot、等待了多久、slot 属于哪一代。

测试缺口：

没有 status-json active provider slot、wait metrics、generation projection 的
契约测试。

修复建议：

把 provider slot registry 纳入 recovery summary。status-json 至少输出
`activeProviderSlots`、`providerWaitMs`、`providerSlotGeneration`、provider、
workerId、itemId、bookId、commandId 和 lease expiry。

### C-09: 并行测试主要证明 worker overlap，未证明生产并发不变量

严重性：nonblocking

证据路径/函数：

- [test/cli.test.ts](../../../../test/cli.test.ts) 1827-1905 的
  `keeps batch state typed...` 是字符串存在性断言。
- 同文件 2110-2304 的 worker pool fixture 能证明 `book-concurrency=2`
  比 `book-concurrency=1` 更早启动第二本书的 fake resume。
- 这些测试未覆盖双 coordinator、fencing、durable provider slot、qmd index
  lock、process group kill 或 durable event recovery。

影响：

测试能证明“单 OS 进程内有多个 async worker”，但不能证明“多书并行不是多个
OS runner 竞争”，也不能证明资源竞争控制符合生产设计。

测试缺口：

缺少基准 10 中列出的行为测试矩阵，尤其是同 runId 双进程竞争和 timeout 后
孤儿子进程清理。

修复建议：

将字符串存在性测试降级为 smoke test，新增行为测试：两个 batch 进程同 runId；
fake provider server 记录最大并发；fake qmd/resume 同时写 index；grandchild
timeout；事件半行恢复；stale fencing write rejection；status-json active slot。
