# GraphRAG Parallel Runner Production Design Reaudit 1 Findings

审计对象：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml`

修正摘要：
`audits/graphrag-parallel-runner-production-design-run_20260527_r1__open/reports/design_fix_summary.yaml`

固定基准：
`audits/graphrag-parallel-runner-production-design-run_20260527_r1__open/design-agent-a/criteria.md`

## 首轮 must-fix 复核

C04 已解决（resolved）。设计现在为 `manifestWriterLane` 给出唯一
ownership，明确 writer lane acquisition order，并定义 JSONL、YAML/JSON
replace、SQLite 的 durable write contract。

证据：

- `manifestWriterLane` 只保护 batch run `manifest.json` 与 `status.json`
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:211-215`）。
- `writerLaneProtocol.acquisitionOrder` 明确 qmd index、catalog、checkpoint、
  event、manifest 的总顺序
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:216-230`）。
- Durable write contract 覆盖 JSONL append、YAML/JSON atomic replace 和
  SQLite write
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:231-243`）。
- Terminal commit protocol 固定 completed 与 failed 的 durable commit order
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:245-266`）。

C08 已解决（resolved）。设计现在定义 qmd/GraphRAG subprocess ownership、
process group cleanup、orphan recovery、stale artifact quarantine、retry budget
exhaustion terminal state、partial write recovery 和 reconciliation matrix。

证据：

- Worker 启动子进程时必须记录 durable subprocess registry，并在 lease loss、
  cancellation 或 coordinator quiesce 时终止 process group
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:302-308`）。
- Retry budget exhaustion 转为 `failed_retry_exhausted`，追加
  `retry_budget_exhausted` event，并从 runnable queue 排除
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:360-363`）。
- Worker crash 与 coordinator crash 都要求 stale write fencing、subprocess
  cleanup 或 orphan 诊断
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:384-402`）。
- Recovery matrix 覆盖 partial event tail、checkpoint temp、manifest mismatch、
  SQLite integrity、orphan artifact 和 live expired process
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:403-458`）。
- Fault-injection validation 覆盖 active subprocess crash、terminal commit crash、
  provider slot leak、retry exhaustion 和 stale fencing commit
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:617-627`）。

## C01. Single Coordinator Authority

Status: PASS

设计保证同一 `runId` 只有一个有效 coordinator，并定义 durable run lock、
heartbeat、expiry、atomic acquisition 与 safe takeover。

证据：

- `runLock` 记录 lock path，并规定 temp file、fsync、atomic rename 与
  generation compare-and-swap acquire primitive
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:49-54`）。
- Heartbeat 必须携带 current generation 与 `runnerSessionId`，generation
  mismatch 会使旧 coordinator 停止 claim 和 durable write
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:55-57`）。
- Takeover 前必须扫描 durable subprocess registry；无法终止旧进程时进入
  `stop_until_fixed`
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:58-61`）。
- Hard invariant 要求 lock identity、heartbeat、expiry 和 recovery-only
  rebuild
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:63-70`）。

结论：

首轮 should-fix 已解决；本基准通过。

## C02. Item Lease and Fencing Correctness

Status: PASS

设计保证同一 `itemId` 最多由一个 live worker 持有，并把 fencing 扩展到所有
durable item-state transition 与 shared write。

证据：

- Item lease 必须包含 `runnerSessionId`、`workerId`、`fencingToken`、
  `heartbeatAt` 与 `expiresAt`
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:71-78`）。
- Claim 操作必须是 atomic compare-and-swap
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:76`）。
- 每次 checkpoint、event、catalog、manifest、qmd index 与 book-scoped
  artifact commit 前都必须验证当前 fencing token
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:77-78`）。
- Terminal commit protocol 要求在 completed 或 failed commit 前验证当前
  item lease 与 book lease
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:245-266`）。

结论：

首轮 should-fix 已解决；本基准通过。

## C03. Book-Scoped Writer Exclusivity

Status: PASS

设计保证同一 `bookId` 最多存在一个 live writer，并把 book lease 与 item lease
分离。

证据：

- Book lease 独立于 item lease，并包含 `runId`、`bookId`、`itemId`、
  `runnerSessionId`、`workerId`、`fencingToken`、`producerScope`、
  `heartbeatAt`、`expiresAt` 与 `generation`
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:79-88`）。
- Book lease claim、heartbeat 与 expiry takeover 必须使用 atomic
  compare-and-swap
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:85-86`）。
- 相同 `bookId` 的后到 item 必须等待、跳过或重新排队，不能并发写入
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:89-90`）。
- Scheduler duplicate book policy 要求 candidate queued until book lease
  release
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:286-288`）。

结论：

本基准通过。

## C04. Serialized Durable Writes

Status: PASS

设计已序列化 catalog、`.qmd/index.sqlite`、events、checkpoints、manifest 与
status 的 shared durable writes，并定义 path ownership、atomic durability 与
lane ordering。

证据：

- Global invariant 声明 `catalogWriterLane`、`qmdIndexWriterLane`、
  `eventWriterLane`、`manifestWriterLane` 的职责，并规定嵌套持有时的总顺序
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:98-107`）。
- `resourceControls.writerLanes` 分别定义 catalog、qmd index、event、
  checkpoint、manifest lane 的 protected paths
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:187-215`）。
- `writerLaneProtocol` 定义 acquisition order、timeout、release-on-error 与
  manifest derivation rule
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:216-230`）。
- Durable write contract 明确 event append flush/fsync、YAML/JSON temp file
  replace、parent fsync、generation/checksum 与 SQLite busy handling
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:231-243`）。
- Completed terminal commit 明确 checkpoint-before-event-before-manifest/status
  order
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:245-258`）。

结论：

首轮 must-fix 已解决；本基准通过。

## C05. Provider and Local Resource Backpressure

Status: PASS

设计通过 coordinator-granted provider slot lease 约束所有 worker 与子进程的
OpenAI、Jina 和 local CPU resource usage，并区分 retryable 与
stop-until-fixed failures。

证据：

- GraphRAG 与 qmd 子进程启动前必须向 coordinator 申请 provider slot lease，
  未获得 slot lease 不得启动
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:123-147`）。
- OpenAI 全局 semaphore 覆盖 GraphRAG LLM 与 qmd OpenAI-compatible provider
  requests，并统一分类 429、5xx、timeout、Responses output none 与 network
  interruption
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:148-162`）。
- Jina 全局 semaphore 覆盖 GraphRAG embedding 与 qmd embedding/rerank，且
  单本书不得独占全部 Jina capacity
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:163-177`）。
- Local CPU concurrency 单独保护 EPUB extraction、parquet validation、LanceDB
  和 file scans
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:178-186`）。
- Transient 与 permanent provider failures 分别进入 retry/recovery 和
  `failed_stop_until_fixed` path
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:346-376`）。

结论：

本基准通过。

## C06. GraphRAG Artifact Isolation and Lineage

Status: PASS

设计隔离每本书的 GraphRAG work、output、reports、logs 与 producer records，并
要求 `query_ready` 只引用同一 `bookId` 的 completed producer runs。

证据：

- Scope 明确包含 book-scoped GraphRAG artifact isolation，并排除多书共享
  `graph_vault/output`
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:17-25`）。
- `graph_artifact_isolation` 要求独立 work/output/report directories、唯一
  stage run id 与 same-book producer runs
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:91-97`）。
- Stage evidence 要求 producer run record、parquet/vector validation、
  same-book lineage、capability projection 与 qmd GraphRAG query success
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:319-344`）。
- Worker crash 后的 stale qmd/GraphRAG outputs 必须 quarantine，除非经过
  producer、fingerprint、book lease generation 和完整 artifact set
  reconciliation
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:390-394`）。
- Reconciliation matrix 拒绝 incomplete producer、orphan artifact 与 invalid
  query-ready projection
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:420-458`）。

结论：

本基准通过。

## C07. Derived Manifest and Status Truth

Status: PASS

设计把 checkpoints 与 events 作为 run state 的 source of truth，并把 manifest
与 status 定义为可重建 derived cache。

证据：

- `derived_run_manifest` 禁止以 worker in-memory counters 作为 completed、
  pending、running、failed、skipped 的权威
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:108-113`）。
- Manifest writer lane 只写 derived manifest/status
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:103-107`）。
- Terminal commit 在 checkpoint 与 event durable 后派生并替换
  manifest/status
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:245-266`）。
- Coordinator crash recovery 必须扫描 checkpoints 与 events 重建 manifest
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:395-402`）。
- Recovery authority order 把 manifest/status 明确列为 derived cache only
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:420-428`）。

结论：

本基准通过。

## C08. Crash, Retry, and Resume Semantics

Status: PASS

设计覆盖 worker crash、coordinator crash、stale lease、transient provider
failure、permanent provider failure、retry budget exhaustion、partial write
recovery 与 safe re-entry，不依赖 hidden in-memory assumptions。

证据：

- Worker lifecycle 记录 subprocess ownership，并定义 process group graceful
  terminate、timeout kill 与 cancellation/killed events
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:302-308`）。
- State model 定义 `failed_retryable`、`failed_retry_exhausted` 与
  `failed_stop_until_fixed`
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:310-318`）。
- Transient provider failures 记录 `nextRetryAt`、retry budget，并在 budget
  exhausted 时进入确定终态
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:346-363`）。
- Permanent provider failures 进入 `failed_stop_until_fixed`，quiesce scheduler，
  取消未终态 provider 子进程，并保留可恢复状态
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:364-376`）。
- Worker crash 与 coordinator crash recovery 明确 stale write rejection、
  orphan subprocess handling 与 takeover generation fencing
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:384-402`）。
- Partial write recovery 与 reconciliation matrix 覆盖 event tail、temp file、
  checksum/generation、manifest mismatch、SQLite integrity 和 orphan artifacts
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:403-458`）。

结论：

首轮 must-fix 已解决；本基准通过。

## C09. Real Build Closure

Status: PASS

设计把真实 qmd 与 GraphRAG execution 作为默认 completion path，并禁止 dry-run、
repair-only 或 status-only mode 合成 completed 状态。

证据：

- Scope 排除绕过 qmd 或 GraphRAG 真实构建的模拟完成状态
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:21-25`）。
- `real_build_by_default` 要求 qmd validation、GraphRAG stage gates、
  producer lineage、`query_ready` projection 和禁止缺失产物完成
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:114-120`）。
- `completed` state 要求 qmd、GraphRAG、query_ready 与 validation subcommands
  全部通过
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:310-344`）。
- Production validation 要求真实 EPUB、真实 qmd 命令与真实 GraphRAG build；
  dry run 不得作为 completed evidence
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:628-631`）。

结论：

本基准通过。

## C10. Observability, Configuration, and Validation Coverage

Status: PASS

设计已指定足够的 events、status fields、logs、configuration precedence、
secret handling 和 validation coverage，用于证明 production behavior。

证据：

- Required events 覆盖 coordinator、worker、command、provider slot、retry、
  lease、subprocess、partial recovery、manifest 与 batch lifecycle
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:460-487`）。
- Event schema 包含 event identity、sequence、lease generation、provider slot、
  fencing token hash、writer lane wait、retry budget 与 SQLite retry fields，并
  禁止输出 secrets
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:487-515`）。
- Status JSON fields 覆盖 coordinator、concurrency、item counts、active
  workers/provider slots、queue、lanes、leases、retries、failed stage、
  active command、producer lineage 与 dotenv diagnostics
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:516-545`）。
- Configuration contract 定义 CLI required options、parallel options、dotenv
  precedence 与 secret allowlist/redaction rules
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:547-597`）。
- Validation requirements 覆盖 sequential compatibility、true parallel
  progress、provider backpressure、failure recovery、writer serialization、
  subprocess crash、terminal commit crash、partial writes、stale fencing 与 real
  build evidence
  （`docs/architecture/graphrag-parallel-runner.type-dd.yaml:599-649`）。

结论：

首轮 should-fix 已解决；本基准通过。
