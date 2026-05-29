# GraphRAG 多书并行 Runner 生产设计审计发现

审计对象：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml`

## 1. Coordinator 与 lease fencing

判定：PASS

依据：
- 设计声明同一 `runId` 只能存在一个 coordinator，并要求 run lock 记录
  `runnerSessionId`、`pid`、heartbeat 与 expiry。
- `item lease` 包含 `runnerSessionId`、`workerId`、`fencingToken` 与 TTL，
  且 claim 必须是 atomic compare-and-swap。
- 独立 `book lease` 约束同一 `bookId` 只能由一个 worker 写入。
- worker crash 后的 stale write 由 fencing token 拒绝。

残余风险：
- CAS、run lock 与 book lease 的具体存储介质未在本设计中绑定，但 contract
  层面的 invariant 已充分表达。

## 2. qmd SQLite 与 qmd 全局写入安全

判定：WARN

依据：
- `qmdIndexWriterLane` 明确保护 `.qmd/index.sqlite`、qmd book registration、
  qmd embedding writes 与 cleanup writes。
- 全局写入串行化被列为 hard invariant，且 `acceptanceCriteria` 要求
  `.qmd/index.sqlite` 无并发写入损坏。

问题：
- 设计未说明 qmd 子命令如何被强制包裹在 `qmdIndexWriterLane` 内。如果 qmd
  子进程自行打开 SQLite 并写入，in-process lane 只能保护启动顺序，不能证明
  子进程内部没有旁路写入。
- 未定义 SQLite `busy_timeout`、WAL/rollback journal 期望、locked database
  错误分类、重试上限或 crash 后一致性检查。
- 未说明 qmd embedding 这类可能包含 provider wait 的阶段是否会长时间持有
  SQLite writer lane，从而降低并行可用性。

建议：
- 增加 qmd command envelope 契约：所有可能写 `.qmd/index.sqlite` 的 qmd
  命令必须经 coordinator 调度并在 lane 内执行，或由 qmd 暴露只读/只写拆分。
- 补充 SQLite lock 策略、超时、错误分类、恢复检查与验收测试。

## 3. GraphRAG 产物隔离与 lineage gate

判定：PASS

依据：
- scope 排除多本书共享同一个 `graph_vault/output` 作为生产输出目录。
- `graph_artifact_isolation` 要求每本书独立 GraphRAG 工作目录、输出目录与
  报告目录。
- stage runId 必须包含 stage、timestamp 与唯一后缀。
- `query_ready` 只能引用同一 `bookId` 下已完成的 `graph_extract`、
  `community_report` 与 `embed` producer run。
- stage evidence 要求 parquet artifact 验证、producer lineage 与 capability
  projection。

残余风险：
- 目录命名模板、fingerprint 字段与 producer record schema 未在本文件展开，
  但隔离原则和 gate 条件完整。

## 4. Provider semaphore 与子进程边界

判定：FAIL

依据：
- 设计要求所有 worker 的 OpenAI/Jina 请求共享 semaphore，并区分 OpenAI、
  Jina 与 local CPU 并发。
- worker startup 声明 worker 从 coordinator 接收 provider semaphore handles。
- validation 要求 OpenAI 等待时其他书的 Jina 或本地阶段继续推进，反向亦然。

问题：
- GraphRAG 与 qmd provider 调用通常发生在子命令或子进程内部。本设计没有说明
  in-process semaphore handle 如何跨越子进程边界，也没有说明 GraphRAG/qmd
  是否支持外部 semaphore、request proxy、per-stage single-flight wrapper、
  provider adapter 或环境变量限流。
- 若 semaphore 只包裹“启动一个 GraphRAG workflow 子进程”，则无法控制该
  子进程内部并发请求数量，也无法保证 OpenAI/Jina 全局 provider slot 与真实
  API call 一一对应。
- 设计没有给出防止单本书在一个子进程内部独占全部 provider 容量的可执行机制。

必须修复：
- 明确 provider concurrency 的实施边界：按 provider call 限流、按 subprocess
  限流，或通过本地 proxy/adapter 统一限流。若只能按 subprocess 限流，应修改
  文档中的“所有请求共享 semaphore”表述，并给出保守容量模型。
- 为 GraphRAG/qmd 子进程定义可验证的并发契约、配置传递与测试方法。

## 5. 事件、checkpoint 与 manifest 持久化原子性

判定：WARN

依据：
- `eventWriterLane` 明确保护 `events.jsonl`，`checkpointWriterLane` 保护
  checkpoint 文件。
- `derived_run_manifest` 要求 run 级统计从 item checkpoint 与事件派生。
- coordinator crash 恢复要求扫描 checkpoint 与 events 重建 manifest。

问题：
- “原子追加”只以 writer lane 形式出现，未定义 JSONL 单条事件写入的
  `O_APPEND`、single write、newline、flush/fsync 或 partial tail 修复规则。
- checkpoint 与 manifest 未说明是否采用 temp-file + rename、fsync parent dir、
  generation number 或 checksum。
- 未定义 event sequence、event idempotency key 或 duplicate event 处理规则。

建议：
- 补充 event append durability contract：单行 JSON 编码、单次 append、flush、
  fsync 策略、启动时截断或隔离不完整尾行。
- 补充 checkpoint/manifest atomic replace 规则与重放去重规则。

## 6. Writer lanes、临界区与死锁控制

判定：WARN

依据：
- 设计列出 `catalogWriterLane`、`qmdIndexWriterLane`、`eventWriterLane` 与
  `checkpointWriterLane`，容量均为 1。
- worker completion 要求 final checkpoint、`item_completed` event 与 manifest
  refresh durable 后再释放 leases。

问题：
- 未规定跨 lane 获取顺序。例如 completion 路径可能依次写 checkpoint、event、
  manifest，而 failure 路径可能以不同顺序写 event、checkpoint。
- 未说明是否允许 nested lane acquisition，也未定义异常、取消、timeout 时的
  lane release 行为。
- `manifestWriterLane` 在 hard invariant 中出现，但 `writerLanes` 清单没有
  独立定义该 lane；catalogWriterLane 的 protects 列表包含 manifest。这会造成
  实施时 lane 名称和责任边界不一致。

建议：
- 增加固定 lane acquisition order 或声明禁止嵌套获取。
- 统一 `manifestWriterLane` 与 `catalogWriterLane` 的关系，避免实现歧义。

## 7. 失败分类、恢复与重入

判定：PASS

依据：
- transient provider failure、permanent provider failure、artifact gate
  failure、worker crash 与 coordinator crash 均有行为定义。
- transient failure 记录 `nextRetryAt` 和 retry budget，并允许其他书继续推进。
- permanent provider failure 映射为 `failed_stop_until_fixed`，停止 coordinator
  并保留已完成与可恢复状态。
- 恢复要求从 checkpoint 与 events 重建 manifest，expired running item 可恢复。

残余风险：
- retry budget 数值、backoff 算法与 stop policy 的默认值未展开，但不阻断设计
  审计通过。

## 8. CLI、环境变量与 secret 契约

判定：WARN

依据：
- CLI required 列出 `--run-id`、`--source-dir`、`--state-root`、
  `--qmd-index-path`、`--config`、`--project-dotenv` 与 `--log-root`。
- parallel options 覆盖 book、OpenAI、Jina 与 local CPU 并发。
- dotenv precedence、secret redaction、子进程最小环境与 shell 覆盖诊断均有
  明确要求。

问题：
- 未定义并发参数的有效范围、非法值处理、CLI 与 env 同时存在时的优先级、以及
  默认值来源的一致性校验。
- `--project-dotenv` 被列为 required，但设计没有说明不允许读取 secret 的
  status/doctor 如何在不泄露值的前提下展示 precedence 与覆盖来源。
- 未列出 provider model、endpoint、GraphRAG/qmd 子命令配置的最小必要 env
  allowlist。

建议：
- 增加 config resolution table，明确 CLI > env > config/default 的优先级、
  validation error 与 redacted diagnostic format。
- 增加子进程 env allowlist 与禁止透传规则。

## 9. 测试与验收可实施性

判定：WARN

依据：
- unit tests 覆盖重复 claim、duplicate bookId、expired lease、manifest 派生
  与 writer lane 串行化。
- integration tests 覆盖顺序兼容、两本书同时推进、provider 等待互不阻塞、
  transient failure 与 invalid API key。
- production dry run 明确不能作为 completed 证据，真实 EPUB、真实 qmd 命令与
  真实 GraphRAG 构建才可验证完成。

问题：
- 缺少 fault-injection 验收：worker crash、coordinator crash、partial JSONL、
  SQLite locked、GraphRAG 子进程被 kill、磁盘写入失败。
- 缺少 provider semaphore 跨子进程验证方法，这是当前设计最大的可实施性风险。
- 未定义 acceptance 的可量化判定，例如事件时间重叠窗口、最大并发、重试上限、
  status-json 字段一致性检查。

建议：
- 增加 fault-injection test group 与最小生产验收脚本约束。
- 为每条 acceptance criterion 绑定可检查 artifact、事件字段或命令输出。

## 10. 生产观测与运维可诊断性

判定：WARN

依据：
- required events 覆盖 batch、worker、item、command、provider retry、lease、
  manifest 与完成状态。
- status-json 字段覆盖 coordinator、book concurrency、provider concurrency、
  item counts、active workers、active provider slots 与 retry。
- log requirements 要求每本书独立 log root，并禁止输出 provider secrets。

问题：
- 缺少 writer lane wait time、provider slot wait time、queue depth、stage
  duration、retry budget remaining、SQLite lock retry count 等生产诊断指标。
- 未说明事件 schema 的必备 correlation fields，例如 `itemId`、`bookId`、
  `workerId`、`stage`、`commandId`、`producerRunId`、`fencingToken`。
- 未定义 stuck detection 或 idle-resource diagnosis，用于判断“provider 等待时
  其他书是否继续推进”。

建议：
- 扩展 observability schema，增加 correlation fields、durations、wait times、
  lane utilization 与 retry counters。
- 增加 status-json 对 stuck/idle/backpressure 的可诊断字段。

## 总体结论

判定：FAIL

设计覆盖了多数生产约束，尤其是 coordinator 单例、book lease、GraphRAG 产物
隔离、派生 manifest 和失败恢复。但 provider semaphore 与子进程边界没有可执行
实施机制，导致“所有实际 provider request 全局限流”这一核心生产 invariant
无法被证明。事件/checkpoint 原子性、writer lane 顺序、qmd SQLite 细节、测试
注入与生产观测也需要补充后再进入实现冻结。
