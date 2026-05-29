# 设计审计报告 Agent B 第 2 轮

## 结论

PASS。

最新 type-dd 已消除第 1 轮指出的主要设计漂移风险（design drift
risk）。对新 run 验证旧 book-scoped durable state 的 `runner_start`
状态机，文本已经明确收敛为只读阻断诊断（read-only blocking
diagnostic）：普通 `runner_start` 不得对既有 book-scoped durable target
执行 checksum backfill、checksum meta backfill、temp cleanup、primary
quarantine、sidecar quarantine 或 corrupt rename。

可写修复入口已从普通 `runner_start` 中移出，只能通过 explicit repair 或
`migrate-only` 边界执行，并要求声明修复范围、扫描上限、样本、mutation
count、limit hit 与字段化的下一步操作。

## 固定审计基准

1. 新 run 的 `runner_start` 必须先创建或加载 startup recovery manifest。
2. 普通 `runner_start` 对旧 book-scoped durable state 必须是只读诊断。
3. 普通 `runner_start` 不得大量 quarantine/backfill 旧 book-scoped state。
4. book-scoped checksum mismatch 必须在第一个 blocker 后 fail fast。
5. book-scoped normal `runner_start` 的 mutation budget 必须固定为 0。
6. `targetCount` 与 `mutationCount` 必须来自同一 preflight scan result。
7. 任何实际写操作事件必须同步反映到 `mutationCount`。
8. item checkpoint 创建前失败时不得留下 ambiguous running manifest。
9. 下一步操作必须是字段化值，不能只依赖自然语言 hint。
10. 可写修复必须通过 explicit repair 或 `migrate-only`，并有 bounded summary。

## 复审发现

### B2-1: 普通 runner_start 写权限已闭合

type-dd 现在明确规定 normal `runner_start` 的可写范围只包含当前 runId 的
最小启动状态与 manifest 派生缓存。对既有 book-scoped durable target，
normal `runner_start` 必须使用 read-only blocking diagnostic。

这一条直接禁止了第 1 轮事故中出现的启动期大规模 YAML quarantine、JSON
quarantine 与 checksum meta backfill。普通 `runner_start` 的
book-scoped mutation budget 也被固定为 0。

判定：PASS。

### B2-2: blocker 时序与 fail-fast 已明确

type-dd 已规定 normal `runner_start` 遇到 book-scoped checksum mismatch、
checksum missing、checksum meta conflict、invalid target、unknown temp 或
lock owner 不可判定时，必须在第一个 blocker 后 fail fast，并将 decision
写为 `blocked_before_claim`。

这解决了第 1 轮中“item checkpoint 为 0 但事件流已跨 38 本书扩散”的状态机
缺口。新的设计不允许在首个不可收敛 blocker 后继续扫描并产生额外
quarantine/backfill。

判定：PASS。

### B2-3: 计数口径已统一

type-dd 已要求 startupRecovery 的 `targetCount` 与 `mutationCount` 从同一
preflight scan result 派生：

- `targetCount` 统计已检查 primary target 数。
- `degradedTargetCount` 统计异常 target 数。
- `mutationCount` 统计实际发生的 lock、temp、checksum、meta、backfill、
  quarantine、delete、rename 写操作。

同时，任何 durable quarantine、checksum backfill、checksum meta backfill 或
temp reconcile event 发生时，`mutationCount` 必须同步递增，不能保持 0。

这消除了“manifest 显示 mutationCount 为 0，但 events 已大量 mutation”的
审计不可判定状态。

判定：PASS。

### B2-4: 恢复闭环与 operator action 已字段化

type-dd 已规定 item checkpoint 创建前失败时，manifest 不得停留在
ambiguous running。必须写入 failed 状态、`failedAt`、
`recoveryDecision stop_until_fixed`、`startupRecovery.decision
blocked_before_claim`、`startupRecovery.firstBlocker` 与
`startupRecovery.nextOperatorAction`，并保证 provider slot、subprocess 与
book lease 均为 0。

`nextOperatorAction` 也已字段化，允许值包括：

- `run_status_json`
- `run_explicit_repair`
- `run_migrate_only`
- `start_new_run_after_repair`
- `inspect_manual_state`

blocked book-scoped durable mismatch 的默认下一步为 `run_explicit_repair`。
这已经满足 explicit repair/migrate-only 的后续入口要求。

判定：PASS。

### B2-5: explicit repair/migrate-only 边界已可审计

type-dd 已规定 book-scoped durable repair 只能通过 explicit repair 或
`migrate-only` 边界执行。该边界必须声明 `repairScope`、
`maxScannedTargets`、`maxReportedSamples`、`maxMutationCount`、
`firstSample`、`lastSample`、`mutationCount`、`limitHit` 与
`nextOperatorAction`，并将 summary 写入 manifest、status.json 或
recovery-summary。

book-scoped target family 规则还要求 explicit repair 或 `migrate-only`
按 bookId 与 target family bounded 执行，默认 `maxMutationCount` 为 1，
超过上限必须停止并保留 `nextOperatorAction`。

判定：PASS。

## 剩余非阻塞事项

- 该结论只覆盖设计文本。实现仍需用固定审计基准验证：normal
  `runner_start` 对旧 book-scoped durable mismatch 是否真正零 mutation、
  fail fast，并写出字段化 recovery summary。
- 行为用例中已有 provider request 的 read-only capped case。后续实施审计
  应补足或确认 book-scoped normal `runner_start` 的对应测试用例。

## 最终判定

第 2 轮设计复审通过。

type-dd 最新文本已经固定权限模型：普通 `runner_start` 只负责验证与只读阻断
诊断；旧 book-scoped durable state 的可写修复只能进入 explicit repair 或
`migrate-only`。该设计足以防止继续用新的审计解释反复改变修复目标。
