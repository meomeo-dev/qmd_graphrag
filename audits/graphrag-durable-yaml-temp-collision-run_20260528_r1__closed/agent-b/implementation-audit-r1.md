# GraphRAG Durable YAML Temp Collision 实施审计 r1

## 结论

Fail。

## 阻塞项

### I01_single_durable_boundary

- `src/job-state/repository.ts:497`
- `src/graphrag/capability-catalog.ts:538`
- `src/job-state/durable-json.ts:30`
- `scripts/graphrag/batch-epub-workflow.mjs:3046`
- `src/graphrag/settings-projection.ts:268`
- `src/integrations/python-bridge.ts:107`
- `src/dspy/policy-store.ts:194`

当前实现仍有多套私有 durable replace helper。它们的 lock、temp cleanup、
checksum、owner evidence、failure classification 和 fsync 语义不一致，并未收敛到
设计中的单一 durableStateStore 或等价 adapter。

这会影响真实 runner 恢复：同一批次中 catalog、checkpoint、manifest/status、
settings、subprocess registry 或外部 helper 写入失败时，恢复逻辑无法用统一证据
判断 temp 归属、commit 窗口和 ENOENT 原因，只能退化为普通异常或 checksum
quarantine。

### I04_temp_owner_evidence

- `src/job-state/repository.ts:507`
- `src/graphrag/capability-catalog.ts:552`
- `src/job-state/durable-json.ts:37`
- `scripts/graphrag/batch-epub-workflow.mjs:3050`
- `scripts/graphrag/batch-epub-workflow.mjs:4331`

这些 durable temp path 包含 `pid`、`Date.now()` 和 UUID，但没有写入可恢复读取的
owner evidence。temp 文件、sidecar、lock owner record 或 durable event 中均没有
与 temp 绑定的 `tempId`、`operationId`、`targetLocator`、`leaseGeneration`、
`fencingTokenHash` 和 owner 范围证据。

这会影响真实 runner 恢复：当 `rename(temp, target)` 报 ENOENT 或恢复扫描发现
orphan temp 时，runner 无法判断 temp 是当前 writer、旧 generation、误删、碰撞
还是外部文件系统问题，不能满足 stop_until_fixed 前的可诊断证据要求。

### I05_inflight_cleanup_safety

- `src/job-state/repository.ts:587`
- `src/graphrag/capability-catalog.ts:514`
- `src/job-state/durable-json.ts:78`
- `scripts/graphrag/batch-epub-workflow.mjs:3084`
- `scripts/graphrag/batch-epub-workflow.mjs:3151`

temp cleanup 主要依据 basename 前缀与 mtime 超过 stale TTL 删除。实现没有读取 temp
owner evidence，没有确认 owner pid 或 lease 已失效，没有校验 target generation
是否由该 operation 推进，也没有保证 cleaner 对所有 cleanup 路径都持有可诊断的
per-target lock。runner 脚本中的 `durable_json_temp_reconciled` 与
`durable_yaml_temp_reconciled` 事件只记录 locator，缺少 tempId、operationId、
owner、staleAgeMs 和 cleanupReason。

这会影响真实 runner 恢复：长时间运行或暂停的 writer 可能留下未过期后变成
stale 的 in-flight temp。恢复删除后，后续 writer 的 rename 会得到 ENOENT，但
系统无法证明这是调和误删，也无法把证据落到 checkpoint/status 中。

### I06_atomic_commit_and_checksum_recovery

- `src/job-state/repository.ts:515`
- `src/graphrag/capability-catalog.ts:555`
- `src/job-state/durable-json.ts:41`
- `scripts/graphrag/batch-epub-workflow.mjs:3055`
- `scripts/graphrag/batch-epub-workflow.mjs:3118`
- `scripts/graphrag/batch-epub-workflow.mjs:3175`

写入顺序是 target rename 后再写 checksum sidecar。若 target 已更新但 checksum
缺失，当前 reconcile 会直接 backfill checksum；若 checksum mismatch，则直接
quarantine target。实现没有使用 generation/owner evidence 判断
`target-new/checksum-old`、`target-new/checksum-missing` 是否属于当前 commit，也没有
把 crash window 收敛结果记录为 committed、retryable repair 或 stop_until_fixed。

这会影响真实 runner 恢复：真实 batch 在 target rename 后、checksum rename 前崩溃
时，恢复可能接受一个缺少 commit owner 的 target，或把有效的新 target 当作
checksum mismatch 隔离，导致 manifest/checkpoint 与实际已提交状态分叉。

### I07_rename_enoent_classification

- `src/job-state/repository.ts:514`
- `src/graphrag/capability-catalog.ts:554`
- `src/job-state/durable-json.ts:40`
- `scripts/graphrag/batch-epub-workflow.mjs:3054`
- `scripts/graphrag/batch-failure-classifier.mjs:63`
- `scripts/graphrag/batch-failure-classifier.mjs:246`
- `scripts/graphrag/batch-epub-workflow.mjs:8111`

写入路径没有捕获 rename ENOENT 并生成 `localFailureClass:
durable_temp_rename_enoent`、`renameCause`、`targetLocator`、`tempId`、
`operationId`、`failedSyscall` 和 `errno`。failure classifier 只能把包含
`ENOENT`、`rename`、`.tmp-` 等文本的错误粗略归为 `local_state_integrity`，且使用
通用 `durable_state_integrity` 类。

这会影响真实 runner 恢复：真实失败会进入 stop_until_fixed，但缺少区分 temp
碰撞、调和误删、并发接管、generation 更新和底层文件系统错误的持久证据，后续
resume 无法判定应修复 lock/temp、重建 checksum，还是调查外部文件系统。

### I08_status_event_schema_observability

- `src/contracts/batch-run.ts:154`
- `src/contracts/batch-run.ts:288`
- `src/contracts/batch-run.ts:311`
- `scripts/graphrag/batch-epub-workflow.mjs:650`
- `scripts/graphrag/batch-epub-workflow.mjs:8182`
- `scripts/graphrag/batch-epub-workflow.mjs:6261`

contracts 和 runner 的 item checkpoint、event、recovery summary 仍只原生支持
`failureKind`、`retryable`、`recoveryDecision`、`failedStage` 等通用字段。实现没有
一等字段或稳定 metadata 投影来持久化 `localFailureClass`、`renameCause`、
`targetLocator`、`tempId`、`operationId`、`lockOwnerEvidence`、
`checksumRecoveryDecision`、`completedPublishRule` 和 durable state diagnostics。

这会影响真实 runner 恢复：即使底层检测到 local state integrity 失败，status-json
和 recovery-summary 也无法展示 operator 需要的 temp/lock/checksum 证据，导致
stop_until_fixed 无法闭环到确定修复动作。

### I09_direct_call_chain_coverage

- `src/graphrag/settings-projection.ts:268`
- `src/integrations/python-bridge.ts:107`
- `src/dspy/policy-store.ts:194`
- `src/dspy/policy-store.ts:202`

直接调用链中的 settings projection、python bridge subprocess registry 和 dspy policy
store 仍使用私有 temp+rename helper。settings projection 与 python bridge 没有
checksum sidecar 或 crash-window recovery；dspy policy store 没有 parent directory
fsync。三者均没有 temp owner evidence 或 rename ENOENT 分类。

这会影响真实 runner 恢复：设计 targetMapping 把 `graph_vault/settings.yaml`、
subprocess registry 等纳入 durable 状态边界。若这些文件在 resume-book 或 batch
恢复期间半提交，runner 无法用同一 local_state_integrity 机制阻止继续 claim 或
提供可操作的恢复证据。

### I10_fault_injection_tests

- `test/book-job-state.test.ts:409`
- `test/cli.test.ts:12380`
- `test/cli.test.ts:12440`

现有测试覆盖同毫秒 durable YAML temp 路径抗碰撞，以及部分 checksum corrupt
quarantine。但未覆盖 forced temp create collision、活跃 temp 调和、owner-dead
stale temp、rename ENOENT 分类矩阵、target-new/checksum-old、
target-new/checksum-missing、checksum sidecar partial write、lock timeout
owner evidence、status-json/recovery-summary 诊断字段。

这会影响真实 runner 恢复：当前测试不能证明真实失败
`durable YAML temp rename ENOENT` 会以可观测、可恢复、不可误完成的方式落盘，也
不能防止未来改动重新引入 temp 碰撞或误删活跃 temp。
