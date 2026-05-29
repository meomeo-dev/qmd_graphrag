# Durable YAML Temp Collision 实施审计 R1

## 结论

fail

## 阻塞项

### I03/I04 lock owner 与 temp cleanup 未实现设计要求

- [src/job-state/repository.ts](/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:353)
- [src/job-state/repository.ts](/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:587)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:387)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:514)

repository 与 capability catalog 的 durable YAML lock 只写入 `process.pid`，
stale 判定只读取 pid 并调用 `processAlive()`；没有 host、runnerSessionId、
generation、fencingTokenHash、targetLocator、operationId、heartbeatAt 或
expiresAt。temp cleanup 只按 filename prefix 与 mtime 超过 stale TTL 删除，
没有 temp owner evidence、owner lease、target generation、per-target cleaner
身份或异常删除分类。

这会影响真实 runner 恢复：resume 或另一个 evidence reader 在恢复时无法区分
orphan temp 与仍属 live writer 的 temp。一旦长时间 GraphRAG/qmd 子进程或锁等待
跨过 stale TTL，清理路径仍可能删除 live temp；后续 writer rename 会再次出现
本次真实失败形态的 `ENOENT`，且没有足够 owner/fencing 证据可恢复。

### I05 target-new/checksum-old crash window 仍会误隔离有效 target

- [src/job-state/repository.ts](/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:515)
- [src/job-state/repository.ts](/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:579)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:555)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:508)
- [src/job-state/durable-json.ts](/Users/jin/projects/qmd_graphrag/src/job-state/durable-json.ts:41)
- [src/job-state/durable-json.ts](/Users/jin/projects/qmd_graphrag/src/job-state/durable-json.ts:72)
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3055)
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3115)

实现顺序仍是 rename target 后再写 checksum sidecar。若进程在 target rename
后、checksum rename 前崩溃，下一次 reconcile 读取到旧 checksum 与新 target
不匹配时会直接 quarantine target，并抛出 checksum mismatch。代码没有
generation/owner evidence，也没有 `checksumRecoveryDecision` 或 target-new/
checksum-old recovery matrix。

这会影响真实 runner 恢复：一个已经成功写入的新 checkpoint、catalog 或 item
state 可能在恢复时被误判为 corrupt 并隔离，导致 runner 丢失有效进度、无法从
磁盘状态继续，甚至阻止已完成书籍进入可验证恢复路径。

### I06 directory fsync failure 被吞掉，不能阻止 completed 发布

- [src/job-state/repository.ts](/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:624)
- [src/graphrag/capability-catalog.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/capability-catalog.ts:468)
- [src/job-state/durable-json.ts](/Users/jin/projects/qmd_graphrag/src/job-state/durable-json.ts:126)
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2025)
- [src/integrations/python-bridge.ts](/Users/jin/projects/qmd_graphrag/src/integrations/python-bridge.ts:123)

权威状态写入仍使用 best-effort directory fsync：catch 块直接吞掉错误，只留注释。
没有 `durable_fsync_failed`、`durable_directory_fsync_unsupported` 或
`durable_directory_fsync_uncertain` 分类，也没有 fsyncTarget、fsyncErrno、
fsyncPlatform、durableMode 或 `completedPublishRule=forbidden`。

这会影响真实 runner 恢复：在文件系统不支持目录 fsync 或 fsync 失败时，runner
仍可能继续写 completed checkpoint/event/manifest。崩溃后目录项 rename 可能未
持久化，但事件或 manifest 已暗示完成，恢复流程无法按设计 fail closed。

### I07 batch checkpoint/event/recovery schema 缺少本地 durable state 证据字段

- [src/contracts/batch-run.ts](/Users/jin/projects/qmd_graphrag/src/contracts/batch-run.ts:154)
- [src/contracts/batch-run.ts](/Users/jin/projects/qmd_graphrag/src/contracts/batch-run.ts:288)
- [src/contracts/batch-run.ts](/Users/jin/projects/qmd_graphrag/src/contracts/batch-run.ts:311)
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:526)
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:658)

Batch item checkpoint、event log 与 recovery summary schemas 仍没有一等字段
`localFailureClass`、`redactedEvidenceLocator`、`tempId`、`operationId`、
`completedPublishRule`、`lockOwnerEvidence` 或 `checksumRecoveryDecision`。
batch runner 的本地内联 schemas 也同样缺失这些字段。

这会影响真实 runner 恢复：即使底层 durable write 发生 rename `ENOENT`、live
temp deletion、checksum crash-window mismatch 或 lock timeout，runner 也无法在
最权威的 item checkpoint、event、status-json 与 recovery summary 中稳定表达
可修复本地代码缺陷。恢复和复审只能看到通用错误摘要，无法安全决定 stop、
repair 或 resume。

### I07/I08 batch runner 未发出 durable state failure 事件，classifier 只做粗粒度匹配

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3137)
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3204)
- [scripts/graphrag/batch-failure-classifier.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:55)

batch runner reconcile 失败时只发出 `durable_json_target_quarantined` 或
`durable_yaml_target_quarantined`，metadata 只包含 locator、quarantineLocator 和
reason。它没有发出设计要求的 `durable_replace_failed`、
`durable_lock_timeout`、异常 `durable_temp_reconciled`，也没有在对应
`item_failed` 事件中强制写入 failureKind、localFailureClass、
recoveryDecision、failedStage 与 redactedEvidenceLocator。

failure classifier 已加入 `local_state_integrity` 与 `local_state_lock_timeout`
粗粒度识别，但 `localFailureClass` 只有 `durable_state_integrity` 或
`durable_state_lock_timeout`，不能区分 `durable_temp_rename_enoent`、
`durable_live_temp_deleted`、checksum crash-window mismatch 或 fsync boundary。

这会影响真实 runner 恢复：真实失败中的 rename `ENOENT` 仍无法在事件流里稳定
定位成 temp collision/live temp deletion/checksum window/fsync boundary，恢复
状态可能继续依赖文本推断，无法满足“不得降级为 unknown/provider transient”的
实施要求。

### I02/I08/I09 settings projection、python bridge 与 DSPy durable 写入仍未纳入统一契约

- [src/graphrag/settings-projection.ts](/Users/jin/projects/qmd_graphrag/src/graphrag/settings-projection.ts:268)
- [src/integrations/python-bridge.ts](/Users/jin/projects/qmd_graphrag/src/integrations/python-bridge.ts:107)
- [src/dspy/policy-store.ts](/Users/jin/projects/qmd_graphrag/src/dspy/policy-store.ts:194)
- [src/dspy/policy-store.ts](/Users/jin/projects/qmd_graphrag/src/dspy/policy-store.ts:202)

这些直接调用链虽然已使用 uuid temp 与 `wx`，但没有 per-target lock、checksum
sidecar、read-before-reconcile、owner evidence、generation/fencing、directory
fsync strict failure 分类或 local state integrity 事件。settings projection 写入
`graph_vault/settings.yaml` 是 Type DD targetMapping 中的生产 YAML target；
python bridge subprocess registry 也在 single durable boundary 的 owning modules
内。

这会影响真实 runner 恢复：settings 或 subprocess registry 的半写、rename
crash 或 directory fsync failure 仍可能被当作普通文件状态处理。resume-book
启动前的 durableStatePreflight 无法基于 checksum/owner evidence 判断这些状态
是否可用，从而可能继续执行或错误恢复。

### I10 缺少针对本次失败形态的 fault injection 测试

- [test/book-job-state.test.ts](/Users/jin/projects/qmd_graphrag/test/book-job-state.test.ts:1489)
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:3878)

现有相关测试覆盖 redaction、checksum backfill/quarantine、provider/SQLite
分类等通用行为，但未覆盖同 pid 同毫秒多 worker 写入、同目标并发、
reconcile 遇 live temp、rename `ENOENT` 后 item checkpoint/event/status-json/
recovery summary 字段、target-new/checksum-old crash window、directory fsync
unsupported/uncertain 以及异常 `durable_temp_reconciled` 事件。

这会影响真实 runner 恢复：本次生产失败的触发条件无法被测试稳定复现，也无法
证明修复后不会误删 live temp、不会发布错误 completed、不会丢失事件层分类
字段。
