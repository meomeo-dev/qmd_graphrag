# GraphRAG 多书并行 Runner 生产设计审计发现

审计对象：`docs/architecture/graphrag-parallel-runner.type-dd.yaml`

## C01 Run Lock 与 Coordinator 单写者

状态：WARN

设计声明同一 `runId` 只能有一个 coordinator，并要求 run lock 记录
`runnerSessionId`、`pid`、`startedAt`、`heartbeatAt` 与 `expiresAt`。新
coordinator 必须拒绝未过期锁，或接管已过期且无活进程的锁。对应条款见
第 50-57 行、第 267-271 行。

缺口是 run lock 的存储位置、原子创建/替换机制、心跳续租的 compare-and-swap
条件、pid 复用防护和 lock fencing 未被写成可实现契约。多机写入已排除，
因此该缺口不直接否定设计，但生产实现仍需要更明确的 lock record schema
和原子写入规则。

## C02 Item Lease 与 Book Lease 互斥

状态：FAIL

item lease 设计较完整，包含 `runnerSessionId`、`workerId`、`fencingToken`、
heartbeat 与 expiry，并要求 claim 是原子 compare-and-swap，每次 checkpoint
写入前校验 fencing token。对应条款见第 58-64 行。

book lease 只说明独立于 item lease，并要求重复 `bookId` 等待、跳过或重排。
对应条款见第 65-70 行、第 177-179 行。设计没有规定 book lease 的字段、
TTL、heartbeat、原子 claim、fencing token、过期回收和 book-scoped 产物写入
前校验。若 worker 崩溃后 item lease 过期但 book lease 残留，或旧 worker
继续写入 GraphRAG producer/catalog，当前设计无法证明同一 `bookId` 的单写者
不变量可恢复。

必须补充 book lease 与 item lease 等强度的可恢复契约。

## C03 Stale Running Reclaim 正确性

状态：PASS

设计把 `stale_running_expired` 列为可领取状态，排除
`running_with_live_lease`，并要求 missed heartbeat 只有 lease 过期后才可恢复。
worker crash 流程明确：live coordinator 发现心跳缺失，item 保持 running
直到 lease 过期，过期后可 claim，旧 worker 写入由 fencing token 拒绝。
对应条款见第 167-186 行、第 261-266 行。

该基准在 item 层面通过。book lease 的 stale 回收缺口已计入 C02。

## C04 Checkpoint 持久性与阶段幂等

状态：WARN

设计定义 checkpoint writer lane，要求失败时记录 `failureKind`、`retryable`、
`recoveryDecision`、`failedStage`、`activeCommand`、attempt counters 与
`nextRetryAt`，并要求 completed 必须具备 qmd、GraphRAG、`query_ready` 和
验证证据。对应条款见第 153-157 行、第 187-192 行、第 194-227 行。

缺口是 checkpoint schema 没有明确 stage-level producer run id、input
fingerprint、command idempotency key、checkpoint 文件原子写入方式和 fsync
边界。设计足以表达目标状态，但还不足以让实现者判断崩溃发生在子命令成功、
事件写入、checkpoint 写入、manifest 刷新之间时应如何幂等恢复。

## C05 Manifest 派生模型

状态：PASS

设计明确 run 级统计必须从 item checkpoint 与事件派生，`completed`、
`pending`、`running`、`failed` 与 `skipped` 不以 worker 内存变量为权威。
coordinator 定期扫描 checkpoint 重建 manifest，恢复后 manifest 必须可由
磁盘状态完整重算。manifest writer lane 只写派生结果。对应条款见第 78-90
行、第 267-271 行。

该基准通过。

## C06 GraphRAG 产物隔离与 Query-Ready 门控

状态：PASS

设计要求每本书有独立 GraphRAG 工作目录、输出目录与报告目录，GraphRAG
stage run id 包含 stage、timestamp 与唯一后缀，并禁止把
`graph_vault/output` 作为跨书共享生产输出目录。`query_ready` 只能引用同一
`bookId` 下完成的 `graph_extract`、`community_report` 与 `embed` producer，
并要求 qmd GraphRAG query 成功。对应条款见第 71-77 行、第 208-227 行。

该基准通过。

## C07 Transient Retry 与预算耗尽

状态：FAIL

设计正确列出 HTTP 429、5xx、timeout、connection reset、Responses output
none 与 provider rate-limit 类错误，并要求分类为 retryable，记录
`nextRetryAt` 和 retry budget，在 durable `failed_retryable` 后释放 lease，
允许其他 worker 处理其他书。对应条款见第 229-242 行、第 347-355 行。

阻塞缺口是 retry budget 耗尽后的状态迁移没有定义。`failed_retryable` 等待
`nextRetryAt` 后重新领取，但没有说明 attempts 达到预算后转为
`failed_stop_until_fixed`、`failed_exhausted`、`skipped` 或 batch incomplete。
该缺口会导致生产实现可能无限 retry、无限 pending，或不同实现对同一磁盘状态
做出不同恢复决策。

必须补充 retry budget 耗尽后的确定状态、事件和 coordinator 行为。

## C08 Non-Transient Stop-Until-Fixed

状态：WARN

设计把 `INVALID_API_KEY`、authentication failed、permission denied、
unsupported model 与 schema/configuration error 归为永久失败，要求进入
`failed_stop_until_fixed`，在 durable failure event 后停止 coordinator，并保留
已完成图书与 retryable 状态以便恢复。对应条款见第 243-253 行、第 194-201 行。

缺口是 stop 过程的 quiesce 顺序没有明确：发现非 transient 后是否立即阻止新
claim、是否等待已运行 worker 到阶段边界、是否取消 provider 调用、以及 running
item 如何持久化为可恢复状态。该缺口可能影响停止时的一致观测，但核心状态意图
已经正确。

## C09 状态观测与 Secret 隔离

状态：WARN

设计列出 batch、coordinator、worker、item、command、provider retry、lease
missed、stale reclaim、manifest refresh 和 batch completion 事件，并列出
`status-json` 字段。secret handling 明确要求 events、status-json 与 logs 不得
输出 API key，子进程环境只传必要 provider 变量。对应条款见第 273-309 行、
第 331-338 行。

缺口是 `requiredStatusJsonFields` 仍偏聚合层，缺少 per-item/per-stage 状态、
`failedStage`、`activeCommand`、lease expiry、fencing/session 标识、stage
producer lineage 和 retry budget remaining。验收条件要求 status-json 准确展示
qmd、GraphRAG、worker、provider slot 与 retry 状态；当前字段不足以直接满足该
验收目标。

## C10 重启恢复与崩溃后调和

状态：FAIL

设计要求 coordinator crash 后新 coordinator 在 run lock 过期前不得接管，
恢复时扫描 checkpoint 与事件重建 manifest，expired running item 带 stale
lease evidence 变为可恢复。artifact gate 也要求缺失 lineage 不得静默接受，
repair 只能在 fingerprint、run record 与 parquet 文件匹配时复用。对应条款见
第 254-271 行。

阻塞缺口是重启恢复的调和算法没有覆盖部分完成产物和事件/checkpoint 不一致的
决策矩阵。例如 GraphRAG 子命令已产生 parquet 但 producer record 未持久化、
事件已追加但 checkpoint 未刷新、checkpoint completed 但 query_ready projection
缺失、book lease 残留但 item lease 过期等情况。设计说明了原则，但没有给出
恢复优先级、可复用条件、重建条件和拒绝条件，难以证明崩溃后恢复正确性。

必须补充崩溃后磁盘状态调和规则，尤其是 checkpoint、events、producer run
record、parquet artifact、capability projection 与 leases 之间的优先级。
