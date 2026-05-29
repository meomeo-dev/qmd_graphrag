# GraphRAG Durable YAML Temp Collision 设计修复复审

## 结论

Fail。

本次补充已覆盖 `C04` 的 temp 唯一性主缺口，并部分改善 `C06`、`C07`
和 `C08`。但按既有 10 条固定基准复审，设计仍未通过。阻塞项如下。

## 阻塞项

### C01_writer_lane_target_coverage

仍未通过。

`writerLanes` 仍只列出 catalog、qmd index、events、book checkpoints、
item checkpoint、manifest/status。固定基准要求覆盖所有 durable YAML/JSON
目标，包括 book job、artifact manifest、producer run record、graph
capability、item checkpoint、manifest、status 和 run lock。

当前设计未把以下目标映射到唯一 lane、持有者、超时策略和释放规则：

- `graph_vault/books/**/job.yaml`
- `graph_vault/books/**/artifacts.yaml`
- `graph_vault/books/**/runs/*.yaml`
- `graph_vault/catalog/batch-runs/{runId}/coordinator-lock.json`
- durable checksum/generation sidecar 文件

### C02_writer_lane_enforcement_boundary

仍未通过。

设计补充了 `durableYamlLock`，但固定基准要求所有 durable writer 通过
coordinator 管理的 lane 进入 critical section，并禁止模块私有锁绕过 lane。
当前设计没有明确 repository、capability catalog、batch manifest、run lock
和脚本入口必须使用同一 lane 协议，也没有禁止独立 helper 使用私有文件锁直接
执行 durable replace。

### C03_fencing_before_durable_commit

仍未通过。

设计仍只在高层要求 checkpoint、event、catalog、manifest、qmd index 和
book-scoped artifact 提交前验证 fencing token。固定基准要求每次 temp 创建、
rename、checksum/generation 写入和父目录 fsync 前，都必须验证当前 item
lease、book lease 或 coordinator generation。

当前 `temporaryFileLifecycle` 没有把 fencing 校验列入 create、rename、
checksum 写入和 parent fsync 的前置条件，因此旧 runner 或旧 worker 仍缺少
逐阶段被拒绝的设计保证。

### C05_exclusive_temp_creation_and_ownership

仍未通过。

设计要求 temp path 全局唯一，但没有要求 temp 文件使用 exclusive create
或等价机制创建，也没有要求 temp 文件本身或伴随 owner record 记录写入者归属。
固定基准要求 temp 冲突必须在写入开始时显式发现，恢复流程必须能判断 temp
属于活跃写入者、已完成提交、陈旧孤儿文件或未知证据。

当前设计只有 `durableYamlLock.ownerRecord`，没有定义 temp owner evidence。

### C06_atomic_commit_state_contract

仍未通过。

设计定义了 temp fsync、rename、checksum 和父目录 fsync 顺序，但仍未定义
compare-and-swap 与每个中断点的失败语义。固定基准要求任一中断点恢复后，
target、checksum/generation 和事件状态都能收敛到 committed、retryable 或
stop_until_fixed。

当前设计没有 durable replace 状态机，也没有覆盖以下中断点的收敛规则：

- temp fsync 成功后进程退出
- rename 成功但 checksum/generation 未写入
- checksum/generation 写入成功但父目录 fsync 失败
- target generation 已变化时的 CAS 失败
- durable event 与 target commit 状态不一致

### C07_in_flight_temp_reconciliation_safety

仍未通过。

设计已禁止仅凭 basename 前缀删除未过期 temp，并要求超过 stale TTL 或
writer-dead 证据后才能删除。但固定基准要求 temp 删除同时受 owner、stale age、
lane/lock 状态和 target generation 共同约束，且删除动作必须事件化并可追溯到
具体 temp id。

当前设计没有要求 temp owner，未要求检查 lane/lock 状态，也没有要求
`durable_yaml_temp_reconciled` 类事件携带 temp id 与删除依据。

### C08_rename_enoent_failure_policy

仍未通过。

设计新增了 atomic rename `ENOENT` 分类为 `local_state_integrity`，但固定基准
要求区分 temp 名碰撞、调和误删、并发接管、目标已被其他 generation 更新和底层
文件系统错误，并给出 retry/stop 规则。

当前设计没有完整区分这些原因，也没有明确 `local_state_integrity` 对应的
`retryable`、`recoveryDecision`、重试次数、重新读取 CAS 或停止条件。

### C09_observability_for_durable_writes

仍未通过。

`observability.requiredEvents` 和 `requiredStatusJsonFields` 未补充 durable
YAML/JSON 写入观测。固定基准要求事件和 status-json 暴露 durable write、
temp 创建、temp 调和、rename ENOENT、重试和隔离诊断，并包含 lane、target
locator、temp id、runnerSessionId、workerId、leaseGeneration、failureKind、
retryable、recoveryDecision 和时间戳。

当前设计仍缺少这些事件和 status 字段。

### C10_fault_injection_acceptance

仍未通过。

`validationRequirements.faultInjection` 仍只包含
`checkpoint temp file left behind before rename`。固定基准要求覆盖 durable
temp 碰撞、活跃 temp 被调和删除、rename ENOENT、checksum/generation 中断和
恢复重启。

当前设计未把上述故障注入列为验收项，也未要求用事件、status-json、
checkpoint、target 文件和测试断言证明系统不会丢失已提交状态或误标未提交状态。
