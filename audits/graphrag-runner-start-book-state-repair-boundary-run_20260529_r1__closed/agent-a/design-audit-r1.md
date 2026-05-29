# GraphRAG Runner Start Book State Repair Boundary 设计审计 R1

## 结论

FAIL。

`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 已覆盖
`targetMapping` 派生扫描、provider request 只读启动诊断、`stop_until_fixed`
和 startup recovery manifest 的基本字段，但仍未充分约束
`runner_start` 对 book-scoped durable targets（书级持久化目标）的可写修复边界、
mutation budget（变更预算）、停止语义、状态摘要和恢复入口。

本轮不建议继续实施。需要先修正完善设计并补平缺失契约，再进入实现修复。

## 审计范围

- 审计对象：真实 runner `epub-batch-20260529-after-audit-close-1`。
- 失败阶段：`runner_start`。
- 主要失败：book-scoped durable checksum mismatch 被
  `durable_preflight_blocked` 阻断。
- 伴随现象：停止前出现大量 `durable_yaml_target_quarantined` 与
  `durable_json_target_quarantined` 事件。
- 设计对象：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`。

## 证据摘要

- `reports/status.json` 记录：
  - `totalItems: 38`
  - `eventLines: 1422`
  - `durableChecksumMetaBackfilled: 198`
  - `durableYamlTargetQuarantined: 1137`
  - `durableJsonTargetQuarantined: 86`
  - `durablePreflightBlocked: 1`
  - `affectedBooks: 38`
- `manifest.json` 的 `metadata.startupRecovery` 记录：
  - `stage: runner_start`
  - `scopeCount: 162`
  - `targetCount: 0`
  - `mutationCount: 0`
  - `decision: created_before_preflight`
- `events.jsonl` 记录：
  - sequence 1 起已有 `durable_checksum_meta_backfilled`。
  - sequence 3 起已有 `durable_yaml_target_quarantined`。
  - sequence 1422 才出现 `durable_preflight_blocked`，并包含
    `failedStage: runner_start`、`blockerCount: 1223`。
  - 大量 quarantine 事件标记为 `failedStage: durable_state`，未被
    startup recovery summary 计入 `mutationCount`。

## 已有设计约束

- `targetMappingContract.preflightScopeRule` 要求 `runner_start` 从
  `targetMapping` 派生扫描范围，不能维护独立手写 durable 目录清单。
- `durableStatePreflight.runnerStart` 要求启动时先创建或加载最小
  startup recovery manifest，字段包含 `scopeCount`、`targetCount`、
  `mutationCount`、样本、`decision` 和 `explicitRepairHint`。
- 同段允许 `runner_start` 对 critical catalog、current run 和
  book-scoped target 执行 bounded writable repair，并声明每个目录默认
  最多扫描 200 个 primary targets、报告 10 个样本、执行 1 个 writable
  quarantine，超过上限必须 `stop_until_fixed`。
- `provider_request_fingerprint` 已单独收窄为
  read-only capped diagnostic，`mutationCount` 必须为 0，且 normal
  `runner_start` 不得 quarantine primary target。
- `beforeResumeBook` 已要求 book-scoped preflight 递归扫描注册的嵌套
  production targets，并在 checksum 不一致时先
  `repair/quarantine/stop_until_fixed`。

## 阻塞项

### A1. book-scoped runner_start 的可写边界仍过宽

设计把 provider request family 明确收窄为只读，但没有为 book-scoped
family 建立同等明确的 family policy（族策略）。现有规则允许 normal
`runner_start` 对 book-scoped target 执行 bounded writable repair 和 primary
quarantine，却没有说明哪些 book-scoped target 只能只读诊断、哪些只能
sidecar-only repair、哪些可进入 primary bundle quarantine。

这会让实现把 `job.yaml`、`runs/*.yaml`、`output/*.json` 等历史书级状态都
视为启动期可写修复对象。真实事件中 38 本书均受影响，说明设计未能把
normal startup recovery 与显式 repair/migrate-only 边界隔离清楚。

建议操作：修正完善设计、补平。

### A2. mutation 上限没有全局预算和可审计计数定义

设计只写了“每个目录默认 1 个 writable quarantine”，但没有定义
`mutationCount` 的计数口径。以下操作是否计入 mutation 未被硬性列出：

- checksum meta backfill
- checksum backfill
- primary bundle quarantine
- sidecar-only quarantine
- lock/temp/owner 文件创建或删除
- recovery event append
- recovery summary 或 manifest 更新

同时，设计缺少 runner_start 级别的 global mutation budget（全局变更预算）、
per-book budget（单书预算）、per-target-family budget（目标族预算）和
event budget（事件预算）。因此即使“每目录 1 个 quarantine”成立，仍可能在
多本书、多目录、多 target family 下累积成大规模变更。

真实 manifest 中 `mutationCount: 0`，但 events 中已有 198 次 meta backfill、
1137 次 YAML quarantine 和 86 次 JSON quarantine，说明设计没有把
summary 与事件流的计数一致性设为不可违反约束。

建议操作：补充设计、修正完善设计。

### A3. fail fast 与 stop_until_fixed 的时序不够严格

设计声明“首次 blocker 后 fail fast”，但未规定：

- checksum mismatch 是否在发现即成为 blocker；
- quarantine 写入本身是否必须立即终止后续扫描；
- 进入 `stop_until_fixed` 后是否允许继续扫描其他 bookId；
- 进入 `stop_until_fixed` 后是否允许继续做 sidecar backfill 或 quarantine；
- `durable_preflight_blocked` 是否必须紧邻首个 blocker 写入。

真实事件中 sequence 3 已出现 `job.yaml` checksum mismatch quarantine，
但 sequence 1422 才出现 `durable_preflight_blocked`，并报告
`blockerCount: 1223`。这表明现有设计不足以防止“先大规模 mutation，再统一
blocked”的行为。

建议操作：修正完善设计、修剪错误设计。

### A4. startup recovery summary 只约束创建，不约束收敛

设计要求先创建或加载最小 startup recovery manifest，但没有要求在每次
mutation、首次 blocker、停止前和异常退出前更新或封存该 summary。也没有规定
summary 必须与 `events.jsonl` 中的 mutation 事件做一致性校验。

真实 manifest 停留在 `decision: created_before_preflight`、
`targetCount: 0`、`mutationCount: 0`，但事件流显示已发生大量可写操作。
这使操作者无法仅凭 manifest 判断 runner_start 是否已经修改状态根
（state root），也无法可靠选择恢复入口。

建议操作：补平、修正完善设计。

### A5. book-scoped 恢复入口未明确

现有 `explicitRepairHint` 示例指向 provider request durable repairs，
但本次 primary target 是 `graph_vault/books/.../job.yaml`。设计没有为
book-scoped `runner_start` 阻断定义明确恢复入口，例如：

- normal rerun 是否只能 read-only 重试；
- 何时必须使用 explicit repair；
- explicit repair 是否按 bookId、target family 或 runId 分批；
- migrate-only 是否允许处理 book-scoped primary bundle；
- 修复后如何重开同一 batch run 或创建新 run；
- 恢复入口必须写入哪些 summary 与事件。

`stopUntilFixedResumePolicy` 说明同一 item 继续需要 explicit repair/resume，
但没有覆盖“runner_start 在 claim item 前阻断、38 本书均未进入 running”的
恢复路径。

建议操作：补充设计、补平。

### A6. 缺少 runner_start book-scoped 专属验收用例

`durableStateAcceptanceMatrix` 已包含 provider request 启动只读 capped、
book-scoped status-json 只读、beforeResumeBook book YAML preflight 等用例，
但没有专门验收 normal `runner_start` 遇到 book-scoped checksum mismatch
时的边界：

- 是否允许 primary quarantine；
- mutation budget 如何生效；
- 首个 blocker 后是否停止；
- startup summary 如何反映 mutation 与 blocker；
- recovery entry 如何提示。

缺少该用例会导致实现和审计继续围绕不同解释修复，形成标准漂移。

建议操作：补平。

## 建议操作判定

- 补充设计：需要。补充 book-scoped `runner_start` target family policy、
  recovery entry 和 acceptance case。
- 修正完善设计：需要。收紧 writable repair boundary、mutation budget、
  fail-fast 时序和 summary 收敛规则。
- 修剪错误设计：需要。删除或改写 normal `runner_start` 可对 book-scoped
  primary target 广义 quarantine 的歧义表达。
- 继续实施：不建议。当前设计仍允许实现产生大规模启动期 mutation。
- 修正：需要。实现修正应等设计收敛后进行。
- 修剪过度实施：可能需要。若现有实现已在 normal `runner_start` 执行多目标
  quarantine，应收敛到设计允许的显式 repair/migrate-only 路径。
- 补平：需要。补齐状态摘要一致性、恢复入口和专属验收矩阵。

## 建议设计约束

1. 为 book-scoped target family 增加 `runnerStartPreflightMode`：
   normal `runner_start` 默认只读诊断；若允许可写，只限 sidecar-only
   metadata repair，并且必须显式列出 target family。
2. 定义 `mutationCount` 为所有 state root mutation 的总数，包括 backfill、
   quarantine、temp/lock/owner 创建删除、event append 和 summary 写入。
3. 增加 runner_start global mutation budget、per-book budget、
   per-target-family budget 和 event budget；超过任一预算立即
   `stop_until_fixed`。
4. 明确首个 checksum mismatch blocker 的时序：发现后立即写入 capped
   diagnostic 和 blocked summary，不得继续扫描其他 bookId 或执行后续 mutation。
5. 要求 startup recovery summary 在 preflight 结束、首次 blocker、异常退出
   和停止前封存，并与 events 中的 mutation 事件数量一致；不一致时自身成为
   `local_state_integrity` blocker。
6. 为 book-scoped durable checksum mismatch 定义 explicit repair 入口，
   明确按 bookId 或 target family 分批、每批上限、summary 字段和恢复后的
   runner 入口。
7. 在 acceptance matrix 中新增
   `runner_start_book_scoped_checksum_mismatch_boundary`，固定验收上述约束。

## 最终判断

当前 type-dd 对 provider request 的启动边界已经较清晰，但对 book-scoped
durable targets 的 normal `runner_start` 仍存在可写边界和停止时序歧义。
在真实证据已经出现 1223 个 blocker 相关可写/失败事件的情况下，设计不能判定
为通过。必须先补平并收紧设计，再进入实现修复和实施审计。
