# GraphRAG Runner Start Book State Repair Boundary 设计审计 R2

## 结论

PASS。

最新 `docs/architecture/graphrag-parallel-runner.type-dd.yaml` 已闭合
Agent A/B/C 第 1 轮对固定审计对象提出的主要设计缺口。normal
`runner_start` 对既有 book-scoped durable target 的权限模型已经从
bounded writable repair 收敛为 read-only blocking diagnostic；可写 repair
被限定到 explicit repair 或 `migrate-only` 边界；startup recovery 的计数、
失败发布状态和 operator action 也已字段化。

本轮只做设计复审，未审计源码实现，未修改源码或 docs。

## 固定审计对象

- 审计对象：`runner_start` book-scoped durable checksum mismatch repair
  boundary。
- 设计锚点：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`。
- 审计依据：Agent A/B/C 第 1 轮报告中的固定问题集合。

## 复审结果

### A2-1. normal runner_start 的 book-scoped 边界已收敛

PASS。

type-dd 现在明确规定 normal `runner_start` 的可写范围只包含当前 runId 的最小
启动状态与 manifest 派生缓存。它不得对既有 book-scoped durable target 执行
checksum backfill、checksum meta backfill、temp cleanup、primary
quarantine、sidecar quarantine 或 corrupt rename。

book-scoped target 在 normal `runner_start` 中必须使用 read-only blocking
diagnostic。遇到 checksum mismatch、checksum missing、checksum meta
conflict、invalid target、unknown temp 或 lock owner 不可判定时，必须在第一
个 blocker 后 fail fast，并将 decision 写为 `blocked_before_claim`。

该规则消除了第 1 轮中 normal startup 被解释为可跨 38 本书扩散
quarantine/backfill 的设计漂移空间。

### A2-2. 可写修复入口已从 normal runner_start 移出

PASS。

type-dd 现在规定 book-scoped durable repair 只能通过 explicit repair 或
`migrate-only` 边界执行。该边界必须声明 `repairScope`、
`maxScannedTargets`、`maxReportedSamples`、`maxMutationCount`、`firstSample`、
`lastSample`、`mutationCount`、`limitHit` 与 `nextOperatorAction`，并将
summary 写入 manifest、status.json 或 recovery-summary。

book-scoped target family 规则还要求 explicit repair 或 `migrate-only` 按
bookId 和 target family bounded 执行，默认 `maxMutationCount` 为 1，超过上限
必须停止并保留 `nextOperatorAction`。

normal `runner_start` 只能复用这些 summary 作为只读证据，不能自行补写或扩大
修复。

### A2-3. 计数口径已具备可审计定义

PASS。

type-dd 已要求 `startupRecovery.targetCount` 与 `mutationCount` 从同一
preflight scan result 派生：

- `targetCount` 统计已检查 primary target 数。
- `degradedTargetCount` 统计异常 target 数。
- `mutationCount` 统计实际发生的 lock、temp、checksum、meta、backfill、
  quarantine、delete、rename 写操作。

同时，若任何 `durable_*_target_quarantined`、
`durable_*_checksum_backfilled`、`durable_checksum_meta_backfilled` 或
`durable_*_temp_reconciled` event 发生，`mutationCount` 必须同步递增，不能
保持 0。

这已覆盖第 1 轮中 manifest 显示 `mutationCount: 0`、但 events 已记录大量
mutation 的观测不一致问题。

### A2-4. 失败发布不再允许 ambiguous running

PASS。

type-dd 已规定 `runner_start` 在 item checkpoint 创建前失败时，manifest 不得
停留在 ambiguous running。必须写入 status failed、`failedAt`、
`recoveryDecision: stop_until_fixed`、`startupRecovery.decision:
blocked_before_claim`、`startupRecovery.firstBlocker` 与
`startupRecovery.nextOperatorAction`。

同一规则还要求 `activeProviderSlots`、`activeSubprocesses` 与
`activeBookLeases` 均为 0，且 recovery-summary 必须记录同一 first blocker 与
下一步动作。该设计闭合了 item checkpoint 为 0 时的启动失败终态。

### A2-5. nextOperatorAction 已字段化

PASS。

type-dd 已要求 `nextOperatorAction` 为字段化值，不得只写自然语言 hint。允许值
包括：

- `run_status_json`
- `run_explicit_repair`
- `run_migrate_only`
- `start_new_run_after_repair`
- `inspect_manual_state`

blocked book-scoped durable mismatch 的默认值为 `run_explicit_repair`。这满足
恢复自动化和审计验证对 next operator action 的字段化要求。

## 非阻塞注意项

1. startup recovery manifest 的最小字段列表仍包含旧字段
   `explicitRepairHint`。后续实现应以更强的
   `startupRecovery.nextOperatorAction` 为权威字段，`explicitRepairHint` 只能
   作为兼容性补充，不得作为唯一恢复动作来源。
2. type-dd 已给出 book-scoped target family 规则；后续实施审计仍需用固定测试
   证明 normal `runner_start` 对 book-scoped mismatch 为零 mutation、首个
   blocker 后 fail fast，并写出一致的 manifest/recovery-summary。

## 最终判断

第 2 轮设计复审通过。

当前 type-dd 已固定单一设计口径：normal `runner_start` 对既有 book-scoped
durable state 只做只读阻塞诊断；写修复只能进入 explicit repair 或
`migrate-only`。该设计足以避免继续以变化审计标准反复修复代码。
