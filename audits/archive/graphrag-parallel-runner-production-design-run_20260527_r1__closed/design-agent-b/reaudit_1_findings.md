# GraphRAG 多书并行 Runner 生产设计复审发现

审计对象：`docs/architecture/graphrag-parallel-runner.type-dd.yaml`

修正摘要：
`audits/graphrag-parallel-runner-production-design-run_20260527_r1__open/reports/design_fix_summary.yaml`

复审结论：PASS

首轮 must-fix 复核结果：C02、C07、C10 均已解决。当前设计已补齐 book
lease（图书租约）互斥契约、retry budget exhausted（重试预算耗尽）终态，
以及 checkpoint、events、producer run record、artifact、projection 与 lease
相关的恢复调和规则。

## C01 Run Lock 与 Coordinator 单写者

状态：PASS

设计定义了 run lock 的持久路径
`graph_vault/catalog/batch-runs/{runId}/coordinator-lock.json`，并要求通过
同目录临时文件、fsync、atomic rename 与 generation compare-and-swap 获取锁。
acquire 只能在锁缺失、锁过期且旧 pid 不存活，或显式 resume takeover
验证通过后成功。heartbeat 必须携带 current generation 与
`runnerSessionId`，generation 不匹配时旧 coordinator 停止 claim 与持久写入。

设计还要求 takeover 前扫描 durable subprocess registry；若旧 coordinator 或
其子进程组仍存活且无法终止，恢复流程停在 `stop_until_fixed`。coordinator
crash 后，run lock 过期前不得接管，接管后旧 generation 的持久提交由
fencing（栅栏令牌）拒绝。

证据：目标文档第 49-61 行、第 63-70 行、第 395-402 行。

## C02 Item Lease 与 Book Lease 互斥

状态：PASS

首轮 must-fix 已解决。

item lease（条目租约）要求包含 `runnerSessionId`、`workerId`、
`fencingToken`、`heartbeatAt` 与 `expiresAt`，claim 操作必须是原子
compare-and-swap。每次 checkpoint、event、catalog、manifest、qmd index 与
book-scoped artifact 提交前必须验证 fencing token 仍有效。

book lease（图书租约）已补齐为与 item lease 等强度的独立契约。设计要求 book
lease 包含 `runId`、`bookId`、`itemId`、`runnerSessionId`、`workerId`、
`fencingToken`、`producerScope`、`heartbeatAt`、`expiresAt` 与 `generation`。
book lease claim、heartbeat 与 expiry takeover 都必须使用原子
compare-and-swap。所有 book-scoped artifact、producer run record、graph
capability 与 book checkpoint 写入前必须验证 book fencing token。

重复 `bookId` 的策略也已明确：不同 `itemId` 解析到同一 `bookId` 时，后到
worker 必须等待、跳过或重新排队，不能并发写入。

证据：目标文档第 71-90 行、第 245-266 行、第 286-298 行、第 452-455 行。

## C03 Stale Running Reclaim 正确性

状态：PASS

设计明确 stale `running` 的领取边界。scheduler 只允许领取 `pending`、
`failed_retryable_due` 与 `stale_running_expired`，并排除
`running_with_live_lease`。worker heartbeat 必须在 lease TTL 过半前更新，
missed heartbeat 只有在 lease expiry 后才使 item 可恢复。

worker crash 流程要求 item 保持 `running` 直到 lease 过期，过期后变为
`stale_running_expired` 并可重新 claim；旧 worker 的迟到写入由
`fencingToken` 检查拒绝。若 expired lease 对应 process group 仍存活，恢复
流程必须先终止 process group；无法终止时进入 `stop_until_fixed`。

证据：目标文档第 276-295 行、第 384-394 行、第 452-455 行。

## C04 Checkpoint 持久性与阶段幂等

状态：PASS

设计把 checkpoint 纳入恢复权威，并给出 durable write（持久写入）契约。
checkpoint、manifest、lock 与 catalog 文件必须写入同目录 temp file、fsync
文件、atomic rename、再 fsync 父目录；文件内容必须包含 generation 或
checksum，以便恢复时拒绝半写入状态。JSONL event append 也要求单行 JSON、
eventId、sequence、flush/fsync，并在恢复时截断尾部不完整 JSON 行。

终态提交协议要求 completed 先验证 item lease、book lease、provider slot、
qmd、GraphRAG stage、producer lineage 与 `query_ready` 证据，再写 book
checkpoint 与 item checkpoint，随后追加 `item_completed` event 并派生
manifest/status。failed 提交必须记录 `failureKind`、`retryable`、
`recoveryDecision`、`failedStage`、`activeCommand`、attempts、
`retryBudgetRemaining` 与 `nextRetryAt`。

阶段证据覆盖 qmd、graph extract、community report、embed 与 query ready；
恢复调和规则覆盖 checkpoint temp、generation/checksum 无效、event 与
checkpoint 不一致、producer record 与 artifact 不一致等幂等重放边界。

证据：目标文档第 231-243 行、第 245-266 行、第 319-344 行、第 403-458 行。

## C05 Manifest 派生模型

状态：PASS

设计明确 run 级统计必须从 item checkpoint 与事件流派生，`completed`、
`pending`、`running`、`failed` 与 `skipped` 不以 worker 内存变量为权威。
coordinator 定期扫描 checkpoint 重建 manifest，进程恢复后 manifest 必须可由
磁盘状态完整重算。`manifestWriterLane` 只写派生后的 manifest/status，不维护
未同步内存计数。

terminal commit 也禁止直接递增内存 completed counter 作为 manifest 权威。
恢复时若 manifest generation 与 checkpoint 派生结果不一致，manifest 作为
derived cache（派生缓存）丢弃并重建。

证据：目标文档第 108-113 行、第 211-230 行、第 245-258 行、第 413-458 行。

## C06 GraphRAG 产物隔离与 Query-Ready 门控

状态：PASS

设计要求每本书必须有独立 GraphRAG 工作目录、输出目录与报告目录。GraphRAG
stage runId 必须包含 stage、timestamp 与唯一后缀，且禁止把
`graph_vault/output` 作为跨书共享生产输出目录。

`query_ready` 只能引用同一 `bookId` 下已完成的 `graph_extract`、
`community_report` 与 `embed` producer run，并要求 graph capability
projection 存在、qmd GraphRAG query 成功。completed 终态也必须验证 qmd、
GraphRAG stage、producer lineage 与 `query_ready` 证据齐全。

证据：目标文档第 91-97 行、第 245-254 行、第 319-344 行、第 377-383 行。

## C07 Transient Retry 与预算耗尽

状态：PASS

首轮 must-fix 已解决。

设计把 HTTP 429、HTTP 5xx、network timeout、connection reset、Responses API
output none with completed status，以及 provider concurrency/rate-limit
message 归类为 transient provider failure。除非 auth 或 quota policy 证明
不是 transient，否则进入 retryable，记录 `nextRetryAt` 与 retry budget，并在
durable `failed_retryable` state 后释放 lease，让其他书继续推进。

retry budget exhausted（重试预算耗尽）已有确定终态。attempt 达到预算后，item
转为 `failed_retry_exhausted`，追加 `retry_budget_exhausted` event，并从
runnable queue 排除。该状态不停止 coordinator，其他可运行书继续推进；人工
修复后只能通过显式 `resume/reset-retry-budget` 命令恢复为 `pending`。

验收条件也明确 retry budget exhausted 不会导致无限 pending 或无限 retry。

证据：目标文档第 310-318 行、第 346-363 行、第 460-486 行、第 617-627 行、
第 633-649 行。

## C08 Non-Transient Stop-Until-Fixed

状态：PASS

设计把 `INVALID_API_KEY`、authentication failed、permission denied、
unsupported model 与 schema/configuration error 归为永久 provider failure。
这些错误必须分类为 `failed_stop_until_fixed`，在 durable failure event 后
停止 coordinator，并保留 completed books 与 retryable state 供后续 resume。

stop 顺序已补齐：必须先 quiesce scheduler、禁止新 claim，再取消未进入终态的
provider 子进程，并把 live running item 写成 recoverable stopped state。该
流程满足非 transient 错误停止新领取、保留可恢复状态、避免无限 pending 的基准。

证据：目标文档第 310-318 行、第 364-376 行、第 599-616 行。

## C09 状态观测与 Secret 隔离

状态：PASS

设计列出 run、coordinator、worker、item、book、command、provider slot、
retry、lease、subprocess、manifest 与 batch completion 相关事件。event schema
包含 `eventId`、`sequence`、`runId`、`status`，并在条件字段中覆盖 item、book、
worker、stage、command、producer run、provider slot、fencing token hash、
lease generation、idempotency key、retry budget 与 SQLite retry count。

`requiredStatusJsonFields` 已扩展到 `items`、`stages`、`leases`、
`providerSlots`、`retryBudgetRemaining`、`failedStage`、`activeCommand` 与
`producerLineage`。secret handling 要求 events、status-json 与 logs 不得输出
API key，子进程环境只传递必要 provider 变量，诊断只能输出 source、presence、
redacted hash 和 validation error code。

本次复审未读取 `.env` secret，未启动批处理 runner。

证据：目标文档第 460-545 行、第 585-597 行。

## C10 重启恢复与崩溃后调和

状态：PASS

首轮 must-fix 已解决。

设计已补充恢复调和矩阵（recovery reconciliation matrix）。authority order
明确以 valid item checkpoint、valid book checkpoint with current book lease
generation、producer run record、complete parquet/vector artifact set、graph
capability projection、events.jsonl、manifest/status 的顺序判断恢复权威。其中
events.jsonl 是 audit trail，不是单独的 completion authority；
manifest/status 只是 derived cache。

矩阵覆盖首轮指出的关键不一致状态：checkpoint completed 但 event 缺失、event
completed 但 checkpoint 缺失、producer record 存在但 artifact 缺失、artifact
存在但 producer record 缺失、`query_ready` projection 存在但 producer
incomplete、expired live lease 仍有 process alive，以及 manifest 与 checkpoint
不一致。对应动作包括补写 reconciliation event、重建 checkpoint、降级为
pending 或 `failed_stop_until_fixed`、orphan quarantine、删除或重写 projection、
终止 process group、重建 manifest 等。

worker crash 与 coordinator crash 条款还覆盖 orphan subprocess、旧 generation
fencing、stale running 回收、失联 worker 产物 quarantine，以及 partial JSONL、
checkpoint temp file、manifest mismatch 与 SQLite integrity failure 的恢复边界。

证据：目标文档第 384-418 行、第 420-458 行、第 617-627 行、第 641-649 行。
