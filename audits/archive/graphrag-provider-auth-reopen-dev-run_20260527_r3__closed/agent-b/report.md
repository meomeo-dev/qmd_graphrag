# GraphRAG EPUB Batch Provider Auth Reopen R3 审计报告

结论：PASS

## 范围

审计对象：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `docs/operations/graphrag-epub-resume-boost.md`
- `docs/operations/graphrag-epub-resume-commands.md`

审计重点为并发与恢复：`loadCheckpoint`、`--status-json`、`--migrate-only` 的
写入边界；`markItemRunning` 和 `applyProviderAuthReopenPass` 的锁与 CAS；
provider auth reopen 候选条件、重开后闭环要求、refail 后 eligibility 清理；
recovery-summary 当前 provider auth context 投影；running/stale/remote runner
投影安全性。

未读取或输出真实 `.env` 密钥值。审计仅使用 present/missing、source、
fingerprint、readiness、blocked reason 和 redacted error 等语义。

## 审计结果

### 1. 只读与迁移边界

`--status-json` 通过 `ensureDirs()` 只检查 `stateRoot` 和 `logRoot` 边界，不创建
目录或文件；`event()` 在 status-json 下返回 typed event 而不写
`events.jsonl`；`writeTypedJson()` 在 status-json 下仅返回 parsed value；
`lockedReadWriteTypedJson()` 在 status-json 下不加锁、不落盘。

主入口在 `printStatusAndExit()` 后返回，位于 provider auth reopen pass、真实
runner、raw log migration 之前。因此 `--status-json` 的 pending/stale/recovery
投影不会写回 manifest、checkpoint、event log 或 recovery summary。

`loadCheckpoint()` 的 `migrateOnly` 分支只执行 hydration、schema/invariant
补全和 build-status snapshot 写回，不再调用
`downgradeCompletedIfClosedLoopInvalid()`、`recoverOrphanedRunningCheckpoint()` 或
`recoverProviderTransientCheckpoint()`。非迁移路径才执行 completed 降级、orphan
runner 恢复和 transient provider recovery。`migrate-only preserves completed
items without real GraphRAG evidence` 测试已改为断言 completed 不被重开。

### 2. Provider Auth Reopen 状态机

`providerAuthReopenDecision()` 的候选条件限定为：

- `status === "failed"`
- `retryable === false`
- `recoveryDecision === "stop_until_fixed"`
- checkpoint 或 failed command check 明确包含 401、403、`INVALID_API_KEY`、
  unauthorized、forbidden 或 authentication failure 证据。

配置不可读、缺少 required key/endpoint、shell env shadow、缺少 current
fingerprint、attempt count 达上限、current fingerprint 等于 failure fingerprint、
或 current fingerprint 已在 reopened list 中时均 fail-closed。`JINA_API_BASE`
这类 observed endpoint shadow 已阻断，符合文档对 provider env shadow 的边界。

重开时只把 checkpoint 改回 `pending` 和 `continue_pending`，清空
`commandChecks`，清除 failed fields，写入 `normalCommandChecksRequired=true`、
`lastProviderAuthReopenFingerprint`、attempt count 和 redacted provider context。
后续仍必须经过 `markItemRunning -> runItem -> runGraphResume -> 27 个 qmd command
checks` 闭环；测试覆盖 legacy provider auth checkpoint 重开后完成完整 command
check 集合。

### 3. 并发与 CAS

`applyProviderAuthReopenPass()` 在真正写 checkpoint 前调用
`lockedReadWriteTypedJson()`，锁内重读当前 checkpoint，并比较 status、attempts、
failedAt、recoveryDecision、runnerSessionId 和 runnerHeartbeatAt。若同 runId
另一个 runner 已重开或改写 checkpoint，当前 runner 会抛错并拒绝重复重开。
锁内还会重新计算 provider auth decision，防止 stale in-memory decision 写入。

`markItemRunning()` 同样使用 `lockedReadWriteTypedJson()` 锁内重读 checkpoint，并
比较 status、attempts、completedAt、failedAt、runnerSessionId 和
runnerHeartbeatAt。只有 CAS 成功才写入本 runner 的 session/host/pid/heartbeat 并
进入真实 `runItem()`。该修复覆盖了两个同 runId runner 同时从同一 pending 或
刚重开的 checkpoint 启动的风险。

heartbeat monitor 和 `clearCommandHeartbeat()` 均在锁内校验 runner lease；失配时
不覆盖其他 runner 的状态。

### 4. Refail 与 Recovery Summary

runtime provider auth failure 通过 `providerAuthFailureMetadata()` 使用当前运行时
provider auth context 写入 failure fingerprint，并将
`providerAuthReopenDecision` 置为
`blocked_provider_auth_fingerprint_unchanged`、
`providerAuthReopenEligible=false`、`providerAuthConfigChanged=false`。`item_failed`
和 `item_provider_auth_refailed` 事件也使用该 redacted metadata。

`buildRecoverySummary()` 调用 `providerAuthSummaryProjection(item)`。对 provider
auth candidate，该投影重新调用当前 `providerAuthReopenDecision()`，因此
status-json 和 recovery-summary 使用当前 provider auth readiness、shadow 状态、
missing keys、attempt limit、fingerprint unchanged/duplicate 判断，而不是旧
metadata 中的 stale eligibility。旧 metadata 仅在非 candidate 历史投影中保留为
证据字段。

### 5. Runner 投影安全

`runningCheckpointIsOrphaned()` 对 fresh local/remote running checkpoint 保守：

- 本机 runner 只有 PID 不存在时才视为 orphan。
- remote runner 无法安全检查 PID，fresh heartbeat 继续持有 item。
- heartbeat 超过 `max(commandTimeoutSeconds * 2, 3600)` 后才视为 stale lease。

`--status-json` 对 stale running 只在 stdout 中投影为 retryable pending，磁盘上的
checkpoint 保持 running；normal run 会恢复 stale running 为 pending，再经
`markItemRunning()` CAS 后进入真实处理。测试覆盖 fresh remote 不被 status-json 或
normal run 抢占，以及 stale remote 在 status-json 中只投影、normal run 中恢复。

## 测试记录

已运行：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli.test.ts \
  -t "provider auth|remote running|migrate-only preserves completed"
```

结果：1 个测试文件通过；20 个相关测试通过；183 个测试按过滤条件跳过。

该测试集使用 fixture、`--status-json`、临时目录、fake runner 和测试 hook；未启动
真实图书处理，未调用真实 provider API。

## 通过基准映射

- 基准 1、2：通过。status-json 不创建目录、不写 JSON、不写 event、不写 summary。
- 基准 3：通过。migrate-only 不再重开 completed/failed/skipped/provider-auth
  checkpoint，不执行真实工作。
- 基准 4：通过。provider auth candidate 只限 failed、non-retryable、
  stop-until-fixed、明确 auth failure。
- 基准 5：通过。配置 unreadable、missing required key/endpoint、shell env
  shadow、fingerprint 缺失均阻断。
- 基准 6：通过。attempt limit、unchanged fingerprint、already reopened
  fingerprint 均阻断，attempt count 取历史上界。
- 基准 7：通过。checkpoint、event、summary 仅持久化 present/missing/source、
  fingerprint、readiness 和 redacted error；测试断言 provider secret 不出现在
  serialized state。
- 基准 8：通过。refail 后 checkpoint 与 summary 均为 blocked/false eligibility。
- 基准 9：通过。provider auth reopen 和 mark running 均锁内重读并 CAS。
- 基准 10：通过。fresh remote running 不抢占，stale/orphan running 只恢复为
  retryable pending，summary counts 与 item status 投影一致。

## 残余风险

未发现 must-fix。

残余风险主要是测试没有直接构造两个独立 Node 进程同时竞争同一个 pending item 的
压力场景；当前代码级 CAS 已覆盖该竞争窗口，现有测试覆盖 fresh/stale runner
投影与 provider auth reopen 幂等分支。若后续要提高置信度，可增加一个专门的
双进程竞争回归测试，断言只有一个 runner 能写入 `item_start` 并进入 fake runner。
