# GraphRAG Durable YAML Temp Collision 设计审计报告

## 结论

不通过。

`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 已定义
writer lane、同目录 temp、fsync、atomic rename、父目录 fsync、checksum
或 generation，以及部分恢复调和要求。但这些约束不足以覆盖当前真实失败：
`epub-batch-20260527-real-resume-1` 中
`item-45c6c3f72a50-f5252de5` 在 `resume-book-2` 发生 durable YAML
temp rename `ENOENT`。

根本缺口是：设计没有把 temp 文件唯一性（temporary file uniqueness）、
exclusive create、in-flight temp 保护、rename ENOENT 分类、以及 durable
写入事件化观测写成生产硬约束。因此，当前设计不能证明并行 runner 在
同一进程多 worker、快速连续写入、恢复调和或接管场景下不会丢失 temp 文件，
也不能给出确定恢复路径。

## 审计范围

- 设计对象：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`。
- 实现参照：
  `src/job-state/repository.ts`、
  `src/graphrag/capability-catalog.ts`、
  `src/job-state/durable-json.ts`、
  `scripts/graphrag/batch-epub-workflow.mjs`。
- 当前失败：
  `resume-book-2` 阶段 durable YAML temp file rename `ENOENT`。
- 非本轮范围：
  provider auth、query_ready lineage、GraphRAG 产物语义正确性、
  OpenAI/Jina 限流策略。

## 基准结果

- `C01_writer_lane_target_coverage`：不通过。设计列出 catalog、
  checkpoint、manifest/status 等 lane，但未完整覆盖 book job、
  artifact manifest、producer run record、run record 等 YAML 写入目标。
- `C02_writer_lane_enforcement_boundary`：不通过。设计没有要求
  repository、capability catalog 和 batch runner 脚本共用同一 durable
  writer lane/adapter；模块私有文件锁仍可能绕过 lane 语义。
- `C03_fencing_before_durable_commit`：部分通过。设计要求 checkpoint、
  event、catalog、manifest、qmd index 和 book-scoped artifact 写入前校验
  fencing token，但没有把 temp 创建、rename、checksum 写入和父目录 fsync
  全部列为 fencing 保护阶段。
- `C04_temp_file_collision_resistance`：不通过。设计只要求同目录 temp，
  没有禁止 `pid + Date.now()`，也没有要求 UUID、单调序列或 runner session
  等抗碰撞字段。
- `C05_exclusive_temp_creation_and_ownership`：不通过。设计没有要求
  exclusive create，也没有要求 temp 文件记录 owner、lane、worker 或
  generation，恢复流程无法可靠识别 temp 归属。
- `C06_atomic_commit_state_contract`：部分通过。设计要求 fsync 与
  atomic rename，但没有明确 target、checksum/generation、CAS 和事件状态在
  每个中断点的收敛规则。
- `C07_in_flight_temp_reconciliation_safety`：不通过。设计允许 temp 存在且
  target generation 未更新时删除 temp，但没有 owner、stale age 或活跃 lane
  保护，存在删除 in-flight temp 的设计风险。
- `C08_rename_enoent_failure_policy`：不通过。设计没有定义 temp rename
  `ENOENT` 的 failureKind、retryable、recoveryDecision、重试条件或停止条件。
- `C09_observability_for_durable_writes`：不通过。requiredEvents 中没有
  durable YAML temp 创建、rename ENOENT、temp 碰撞、commit retry 或隔离事件；
  status-json 也没有 durable write failure 的最小诊断字段。
- `C10_fault_injection_acceptance`：不通过。fault injection 只覆盖
  checkpoint temp left behind before rename，没有覆盖 temp 名碰撞、
  活跃 temp 被调和删除、rename ENOENT 和 checksum/generation 中断恢复。

## 关键证据

- 设计第 187-243 行定义 writer lanes 和 durable write contract，但
  `yamlOrJsonReplace` 只要求同目录 temp、fsync、atomic rename、父目录 fsync、
  generation 或 checksum；没有 temp 唯一性、exclusive create 或 ENOENT
  策略。
- 设计第 403-415 行定义 partial write recovery，其中 checkpoint temp 的
  处理规则是“temp 文件存在且 target generation 未更新时删除 temp”。该规则
  没有要求确认 temp 是否属于活跃 writer。
- 设计第 460-512 行定义 required events 和 event schema，但缺少
  `durable_yaml_rename_enoent`、`durable_yaml_temp_collision`、
  `durable_yaml_commit_retried` 等可诊断事件。
- `src/job-state/repository.ts` 第 482-489 行使用
  `${path}.tmp-${process.pid}-${Date.now()}` 创建 temp 并 rename；第 532-535
  行会删除所有匹配目标前缀的 temp。
- `src/graphrag/capability-catalog.ts` 第 510-512 行使用同类
  `pid + Date.now()` temp；第 467-470 行会删除同前缀 temp。
- `src/job-state/durable-json.ts` 第 30-39 行也使用 `pid + Date.now()` temp；
  第 52-55 行会删除匹配前缀 temp。JSON 与 YAML durable replace 的风险模式
  一致。
- `scripts/graphrag/batch-epub-workflow.mjs` 第 3038-3040 行使用
  `${path}.${process.pid}.${Date.now()}.tmp`；第 3118-3126 行会调和删除
  YAML temp 并记录 `durable_yaml_temp_reconciled`，但设计没有规定活跃 temp
  保护条件。

## 必须补充或修正的设计点

1. 明确 durable YAML/JSON temp 命名契约。temp 名必须包含足够唯一性：
   runnerSessionId、writerLaneId、workerId、单调序列或 UUID；禁止仅依赖
   `process.pid` 与 `Date.now()`。
2. 要求 temp 使用 exclusive create。若 temp 已存在，必须分类为
   temp collision，并按 bounded retry 或 stop_until_fixed 处理。
3. 为 temp 写入 owner evidence。最小字段应包括 target locator、temp id、
   runnerSessionId、workerId、lane、leaseGeneration、createdAt 和 write
   generation。
4. 收紧 temp 调和规则。只有同时满足 owner 不存活、lane/lock 不活跃、
   temp 超过 stale age、target generation 未变化且无可完成 commit 证据时，
   才允许删除 temp。
5. 定义 rename `ENOENT` 恢复策略。若 target generation 未变化，可在同一
   lane 内重新执行 read-modify-write；若 generation 已变化，必须重新读取并
   CAS；若证据不足，进入 failed_retryable 或 stop_until_fixed。
6. 把 durable write commit 分解为可恢复状态机。状态至少覆盖
   temp_created、temp_fsynced、renamed、checksum_written、parent_fsynced、
   committed、retryable_failed 和 quarantined。
7. 扩展 writer lane 覆盖表。把 book job、artifact manifest、producer
   run record、book run record、graph capability publication、run lock、
   item checkpoint 和 manifest/status 全部映射到唯一 lane。
8. 统一 durable writer 边界。repository、capability catalog、batch runner
   脚本和 durable-json helper 必须遵守同一 lane、temp、checksum/generation
   与观测契约。
9. 扩展 requiredEvents 与 status-json。新增 durable YAML/JSON write started、
   temp created、temp collision、temp reconciled、rename ENOENT、commit
   retried、target quarantined、commit completed 等事件，并暴露 lane、
   target locator、temp id、generation、failureKind、retryable 和
   recoveryDecision。
10. 扩展 fault injection 与验收。必须覆盖同毫秒 temp 碰撞、调和误删活跃
    temp、rename ENOENT、checksum 写入失败、父目录 fsync 失败和恢复重启；
    验收证据必须来自事件、status-json、checkpoint、target 文件和测试断言。

## 复审入口

复审时保持 `criteria.yaml` 的 10 条基准不变。只有当设计文档明确补齐上述
硬约束，并能把每条约束绑定到实现边界、事件/status 证据和 fault injection
验收时，本轮设计审计才可改判通过。
