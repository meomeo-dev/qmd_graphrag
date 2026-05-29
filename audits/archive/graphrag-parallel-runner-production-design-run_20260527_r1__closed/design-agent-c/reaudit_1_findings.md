# GraphRAG 多书并行 Runner 生产设计复审发现

审计对象：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml`

修正摘要：
`audits/graphrag-parallel-runner-production-design-run_20260527_r1__open/reports/design_fix_summary.yaml`

复审基准：
沿用本目录 `criteria.md` 的 10 条固定基准。未修改 `criteria.md`。

总体判定：PASS

## 首轮 must-fix 复核

### provider_semaphore_subprocess_boundary

判定：PASS

复核结论：
- 设计新增 `coordinator_granted_provider_slots` 模型，要求 GraphRAG 与 qmd
  provider 子进程启动前取得 provider slot lease。
- 设计区分 `process_level_slot` 与 `request_level_proxy` 两种实施边界
  （enforcement boundary），并要求未取得 slot lease 的 provider 子进程不得
  启动。
- slot lease 包含 provider、worker、item、book、command、expiry、fencing token
  与 release event，并要求子进程退出、kill、超时或 worker lease 丢失时释放。
- status-json 与事件必须暴露 active provider slots、provider wait 与 generation
  证据。

复审说明：
- must-fix 已解决。当前设计接受 subprocess-level slot 作为黑盒子进程的保守
  限流模型，同时为可插拔 provider adapter 保留 request-level proxy 路径。
- 非阻断建议：实现前宜明确 GraphRAG/qmd 子进程内部 provider 并发是否由命令
  配置压到 1，或在 `process_level_slot` 模式下把指标名称表述为 subprocess slot
  concurrency，避免把它误读为逐 HTTP request 的精确计数。

### event_checkpoint_atomicity

判定：PASS

复核结论：
- 设计新增 JSONL append 规则：单行 JSON、`eventId`、`sequence`、单次 append、
  newline、flush/fsync，以及 partial tail recovery。
- checkpoint、manifest、lock 与 catalog 文件新增 temp-file、fsync、atomic rename、
  parent directory fsync、generation/checksum 规则。
- 恢复流程定义 partial `events.jsonl` 截断、duplicate event 处理、checkpoint
  temp file 清理、generation/checksum 回退与 manifest rebuild。

复审说明：
- must-fix 已解决。writer lane 不再是唯一持久化保证，文档已补足 crash window
  中的 durable write contract。

### writer_lane_ordering

判定：PASS

复核结论：
- 设计新增独立 `manifestWriterLane`，并明确其保护 manifest 与 status。
- `writerLaneProtocol.acquisitionOrder` 固定为 `qmdIndexWriterLane`、
  `catalogWriterLane`、`checkpointWriterLane`、`eventWriterLane`、
  `manifestWriterLane`。
- 设计规定单个 critical section 默认只持有一个 lane；确需多 lane 时按固定
  顺序获取，并设置 timeout、`writer_lane_timeout` 事件与 release-on-error。

复审说明：
- must-fix 已解决。首轮 `catalogWriterLane` 与 `manifestWriterLane` 责任混用的
  歧义已消除。

## 1. Coordinator 与 lease fencing

判定：PASS

依据：
- run lock 包含 generation、runner session、pid、heartbeat、expiry，并定义
  acquire、heartbeat 与 takeover guard。
- item lease 与 book lease 都要求 fencing token、heartbeat、expiry 与 CAS claim。
- checkpoint、event、catalog、manifest、qmd index 与 book-scoped artifact 提交前
  必须验证 fencing token。
- coordinator crash 与 stale worker 写入均由 run lock generation 与 fencing token
  拒绝。

复审结论：
- 满足单 coordinator、单 item worker、单 book writer 与 stale write fencing 的
  设计基准。

## 2. qmd SQLite 与 qmd 全局写入安全

判定：PASS

依据：
- `qmdIndexWriterLane` 明确保护 `.qmd/index.sqlite`、qmd corpus、book
  registration、embedding writes 与 cleanup writes。
- SQLite 写入必须在 `qmdIndexWriterLane` 内执行，并配置 `busy_timeout`。
- locked/busy 错误进入 bounded local retry；超过上限后根据证据转为
  `failed_retryable` 或 `failed_stop_until_fixed`。
- partial recovery 规定 database locked/busy retry 与 `integrity_check` failure
  的 stop-until-fixed 行为。

复审结论：
- 首轮 qmd SQLite lock contract should-fix 已解决到设计可实施水平。
- 非阻断建议：实现前在 command envelope 中列出哪些 qmd 子命令必须持有
  `qmdIndexWriterLane`，以及哪些 provider wait 阶段不得持有 SQLite writer lane。

## 3. GraphRAG 产物隔离与 lineage gate

判定：PASS

依据：
- 每本书必须拥有独立 GraphRAG work/output/report 目录。
- `query_ready` 只能引用同一 `bookId` 下已完成的 `graph_extract`、
  `community_report` 与 `embed` producer run。
- recovery reconciliation 明确 producer record、artifact、projection、manifest 的
  权威顺序。
- orphan artifact 与 incomplete producer 不得进入 `query_ready`。

复审结论：
- 满足 book-scoped GraphRAG artifact isolation 与 producer lineage gate。

## 4. Provider semaphore 与子进程边界

判定：PASS

依据：
- provider semaphore 由 coordinator 授予 slot lease，并跨 GraphRAG/qmd 子进程
  生效。
- `process_level_slot` 覆盖无法逐请求回调 coordinator 的黑盒子进程。
- `request_level_proxy` 覆盖 provider adapter 或 IPC gate 可逐 request 限流的
  场景。
- 未获得 slot lease 的 provider 子进程不得启动；slot 泄漏、子进程退出和恢复
  回收均有事件与 status 证据。
- OpenAI 等待与 Jina/本地阶段推进互不阻塞的集成测试仍被保留。

复审结论：
- 首轮 provider semaphore subprocess boundary must-fix 已解决。
- 非阻断建议：把 `process_level_slot` 的度量语义明确为保守 subprocess slot；
  若要声明逐实际 HTTP request 并发，应要求对应子进程使用 request-level proxy
  或显式限制其内部 provider concurrency。

## 5. 事件、checkpoint 与 manifest 持久化原子性

判定：PASS

依据：
- JSONL event append 明确单行 JSON、`eventId`、`sequence`、single append、
  newline、flush/fsync 与 partial tail recovery。
- checkpoint、manifest、lock、catalog 使用 temp file、fsync、atomic rename、
  parent dir fsync、generation/checksum。
- duplicate `eventId` 或 sequence 保留首次 durable event，后续进入
  `duplicate_event_ignored` 诊断。
- run manifest/status 被定义为 checkpoint 与 events 的派生缓存。

复审结论：
- 首轮 event/checkpoint atomicity must-fix 已解决。

## 6. Writer lanes、临界区与死锁控制

判定：PASS

依据：
- catalog、qmd index、event、checkpoint、manifest lane 均有 capacity 与 protects
  清单。
- 获取顺序固定，默认禁止 nested lane；多 lane 终态提交必须按顺序获取。
- timeout、release-on-error、worker cancellation、lease loss 与 subprocess failure
  释放规则明确。
- event append 不等待 manifest refresh，manifest 从 durable checkpoint 与 events
  派生，降低长期占用风险。

复审结论：
- 首轮 writer lane ordering must-fix 已解决。

## 7. 失败分类、恢复与重入

判定：PASS

依据：
- transient provider failure、permanent provider failure、artifact gate failure、
  worker crash 与 coordinator crash 均有明确行为。
- retry budget exhausted 进入 `failed_retry_exhausted`，不再无限 pending 或无限
  retry。
- subprocess registry、process group cleanup、orphan quarantine 与 recovery
  reconciliation matrix 已纳入设计。
- manifest/status 不作为完成权威；恢复可从 checkpoint、producer record、
  artifact 与 events 重建。

复审结论：
- 满足失败分类、确定性恢复（deterministic resume）与重入设计基准。

## 8. CLI、环境变量与 secret 契约

判定：PASS

依据：
- CLI required 参数覆盖 run、source、state、qmd index、config、dotenv 与 log root。
- 并发参数覆盖 book、OpenAI、Jina 与 local CPU。
- resolution table 明确 CLI > environment > config > default，以及并发值范围。
- provider secret precedence 明确 shell environment > project dotenv >
  graph_vault dotenv。
- events、status-json、logs 与子进程环境要求 secret redaction 和 env allowlist。

复审结论：
- 首轮 CLI/env resolution 与 secret redaction should-fix 已解决到设计层面。
- 非阻断建议：实现前列出具体子进程 env allowlist 名称与冲突诊断 error code。

## 9. 测试与验收可实施性

判定：PASS

依据：
- unit tests 覆盖 duplicate claim、duplicate bookId、lease expiry、manifest 派生
  与 writer lane 串行化。
- integration tests 覆盖顺序兼容、并行推进、provider wait 互不阻塞、
  transient retry、invalid API key、provider slot lease 与 SQLite locked retry。
- fault injection 覆盖 worker crash、coordinator crash、process group kill、
  partial JSONL、checkpoint temp file、SQLite locked、provider slot leak、retry
  exhausted、stale fencing token 与 orphan artifact。
- acceptance criteria 要求绑定到事件、status-json、checkpoint、producer record、
  artifact 或 qmd 命令输出证据。

复审结论：
- 首轮 fault-injection 与量化验收 should-fix 已解决。

## 10. 生产观测与运维可诊断性

判定：PASS

依据：
- required events 覆盖 batch、coordinator、worker、item、book、command、
  provider slot、retry、lease、subprocess、partial recovery、manifest 与终态。
- event schema 包含 `itemId`、`bookId`、`workerId`、`stage`、`commandId`、
  `producerRunId`、`providerSlotId`、`fencingTokenHash`、wait time、duration、
  retry budget 与 SQLite retry count。
- status-json 字段覆盖 provider slots、writer lane queues、queue depth、leases、
  stages、retry budget、failed stage、active command、producer lineage 与 dotenv
  source diagnostics。
- redaction 规则禁止输出 API key、Bearer token、provider credential 与完整
  fencing token。

复审结论：
- 首轮 production observability metrics should-fix 已解决。

## 复审结论

本轮复审未发现 remaining must-fix。三项首轮 must-fix 均已在 Type DD 中形成
可实施的设计契约：

- provider semaphore 与 GraphRAG/qmd 子进程边界已由 provider slot lease、
  subprocess registry、process-level/request-level 两级模型和 status/event 证据
  覆盖。
- event、checkpoint、manifest 与 SQLite durable write 已补充 atomic write、
  fsync、generation/checksum、partial recovery 与 reconciliation 规则。
- writer lane ownership、capacity、acquisition order、timeout 与 release-on-error
  已明确。

剩余事项均为实现前澄清项，不阻断本设计通过生产设计复审。
