# 设计审计报告 Agent B

## 结论

FAIL。

type-dd 当前不足以约束真实 runner
`epub-batch-20260529-after-audit-close-1` 暴露的问题：新 run 在
`runner_start` 验证旧 book-scoped durable state 时，既被允许对
book-scoped target 执行 bounded writable repair，又缺少足够明确的启动阶段
全局写入上限、summary 先行规则、事件预算和 fail-fast 边界。该缺口允许实现
在 item checkpoint 仍为 0 时，对 38 个 book 产生大量
quarantine/backfill 事件，最后才因 book-scoped durable checksum mismatch
阻塞。

这属于设计漂移风险（design drift risk）：实现可以声称遵守
`runner_start 可执行 bounded writable repair`，但实际行为已经偏离
`runner_start` 作为新 run 启动验证与恢复入口的状态机边界。

## 审计范围

- 审计对象：真实 runner `epub-batch-20260529-after-audit-close-1`。
- 失败阶段：`runner_start`。
- 触发失败：book-scoped durable checksum mismatch。
- 关键目标：`graph_vault/books/book-9f587b71073a-ad95ce2f/job.yaml`。
- 观测计数：
  - `totalItems`: 38
  - `itemCheckpointFiles`: 0
  - `eventLines`: 1422
  - `durableChecksumMetaBackfilled`: 198
  - `durableYamlTargetQuarantined`: 1137
  - `durableJsonTargetQuarantined`: 86
  - `durablePreflightBlocked`: 1
  - `affectedBooks`: 38

## 固定审计基准

1. 新 run 的 `runner_start` 必须先建立或加载 startup recovery manifest，
   然后才允许任何可写恢复。
2. `runner_start` 对旧 book-scoped state 的写入权限必须由状态机明确授权，
   不能从普通 repair writer 语义隐式继承。
3. 若允许启动期可写修复，必须同时定义 per-target、per-book、per-directory、
   per-run 的 mutation cap。
4. 若允许启动期 quarantine，必须明确 primary bundle、checksum sidecar、
   checksum meta sidecar 的隔离边界。
5. 启动期 repair summary 必须在首次写入前存在，并记录 scope、cap、样本、
   mutationCount、quarantineCount、backfillCount 和 decision。
6. 发现第一个不可收敛 blocker 后必须 fail fast，不能继续跨 38 个 book 扩散
   写入。
7. `itemCheckpointFiles` 为 0 时，启动期事件不得模拟 item-level 进度，也不得
   形成大量无法由 item checkpoint 闭环解释的变更流。
8. `--status-json` 必须能只读预告同一 scope 的风险；若 status-json 不能给出
   同等诊断，normal runner_start 不得直接进入大规模写修复。
9. `migrate-only` 或 explicit repair 与 normal `runner_start` 必须在命令模式、
   summary、事件类型和 cap 上可区分。
10. type-dd 必须给实现和审计提供单一判断口径，避免每轮审计以新解释重定
    “bounded writable repair” 的含义。

## 设计发现

### B-1: `runner_start` 的 book-scoped 写修复边界不闭合

type-dd 在 `durableStatePreflight.runnerStart` 中写明：对 critical catalog、
current run、book-scoped target，`runner_start` 可执行 bounded writable
repair，并在首次 blocker 后 fail fast。每个目录默认最多扫描 200 个 primary
targets、报告 10 个样本、执行 1 个 writable quarantine。

该规则没有同时给出 per-run 与 per-book 的硬上限，也没有定义当 38 个 book
同时存在旧 state 风险时，启动期是否应在首个 book blocker 后停止。真实观测中
出现 1137 次 YAML quarantine、86 次 JSON quarantine、198 次 checksum meta
backfill，说明“每个目录 1 个 writable quarantine”不足以约束跨 book 扩散。

判定：FAIL。

### B-2: summary 先行规则存在，但未能覆盖大量写入闭环

type-dd 要求先创建或加载最小 startup recovery manifest，并记录
`mutationCount`、`firstSample`、`lastSample`、`decision` 与
`explicitRepairHint`。但当前设计没有明确要求：

- summary 必须在第一笔 backfill/quarantine 前持久化。
- summary 必须记录 cap 被消耗到第几层：target、book、directory、run。
- summary 必须能解释为什么 item checkpoint 为 0 时仍允许大量 recovery event。
- summary 必须在 cap 命中后阻止继续扫描或继续 mutation。

因此实现可以产生大量 recovery event，但审计无法从 type-dd 判断这些事件是否
仍处于 normal `runner_start` 合法边界内。

判定：FAIL。

### B-3: normal runner_start 与 explicit repair/migrate-only 的边界冲突

type-dd 的 `checksumCommit.reconcileModes.repairWriter` 允许 normal resume、
migrate-only 或 explicit repair 在持锁时执行 temp cleanup、checksum backfill、
checksum meta backfill 与 quarantine，同时又说 target family 可收窄许可。

对 provider request family，type-dd 已明确 normal `runner_start` 只能
read-only capped diagnostic，写修复必须进入 explicit repair 或 migrate-only。
但对 book-scoped target，type-dd 没有同等明确的 family policy。于是
book-scoped state 同时受两种解释支配：

- critical book-scoped state 可以在 normal `runner_start` 有界写修复；
- 新 run 验证旧 state 时应优先只读诊断，必要时要求 explicit repair 或
  migrate-only。

这会造成审计漂移：不同审计 Agent 可选择不同锚点，导致修复目标反复变化。

判定：FAIL。

### B-4: item checkpoint 为 0 时的事件权威性未定义

真实状态显示 `itemCheckpointFiles` 为 0，但 `events.jsonl` 已有 1422 行，并含
大量 quarantine/backfill 事件。type-dd 已强调 completed 不能从 event alone
发布，但没有对启动期 repair event 的权威性做相同约束：

- 启动期 recovery event 是否允许跨 book 大量追加？
- 这些事件是否必须被 startup recovery manifest 全量汇总？
- item checkpoint 为 0 时，后续 resume 是否以这些事件为修复证据、历史诊断，
  还是只作为审计线索？

缺少这些规定会让恢复闭环变成“先写大量事件，再失败”，而不是“先诊断、受控
修复、明确停止”。

判定：FAIL。

## 边界建议

type-dd 应在二选一策略中固定一种，避免实现和审计继续漂移。

### 方案 A: 允许 normal runner_start 修复 book-scoped state

若选择该方案，type-dd 必须补齐以下硬约束：

- startup recovery manifest 必须在第一笔 mutation 前 durable publish。
- 默认上限应同时包括：
  - per-target mutation cap；
  - per-book mutation cap；
  - per-directory quarantine cap；
  - per-run total mutation cap；
  - per-run event append cap。
- `runner_start` 遇到第一个 checksum mismatch primary blocker 后必须停止该
  book，并停止跨 book 继续 mutation，除非 summary 明确授权继续只读扫描。
- checksum meta missing 可作为低风险 backfill，但 checksum mismatch primary
  quarantine 必须比 sidecar-only backfill 更严格。
- summary 必须记录 `mutationCount`、`backfillCount`、`quarantineCount`、
  `affectedBookCount`、`firstBlocker`、`lastMutation`、`capExceeded` 与
  `nextRequiredCommand`。
- 当 item checkpoint 为 0 时，startup repair event 只能作为 startup recovery
  evidence，不能作为 item progress。

### 方案 B: normal runner_start 只读诊断，写修复进入 explicit repair/migrate-only

若选择该方案，type-dd 应改为：

- normal `runner_start` 对旧 book-scoped state 只做 read-only capped diagnostic。
- checksum mismatch、invalid target、unresolved temp/live lock 直接输出
  `stop_until_fixed` 与 explicit repair/migrate-only 提示。
- checksum/meta backfill、sidecar quarantine、primary bundle quarantine 只能在
  explicit repair 或 migrate-only 模式执行。
- explicit repair/migrate-only 必须有独立 command mode、repair summary、cap、
  dry-run/status-json 等价诊断，以及可重复运行的幂等语义。

从当前真实事故看，方案 B 更稳妥。它能防止新 run 在尚未生成 item checkpoint
时对旧 book-scoped state 执行大规模写入，也能把“验证旧 state”和“修复旧
state”拆成两个可审计阶段。

## 最终判定

当前 type-dd 对 `runner_start` 的 book-scoped durable checksum mismatch 修复
边界不通过设计审计。

必须先在 type-dd 中固定 normal `runner_start` 的权限模型：要么补齐有界可写
修复的全局 cap、summary 和 fail-fast 状态机；要么收敛为只读诊断，并把写修复
移动到 explicit repair/migrate-only。未固定前继续修改实现，会持续产生设计
漂移风险，审计标准也会在“启动期可写修复”和“显式修复命令”之间摆动。
