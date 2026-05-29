# Agent A Implementation Audit R1

## Verdict

FAIL

本轮只使用
`audits/graphrag-runner-start-book-state-repair-boundary-run_20260529_r1__open/agent-a/implementation-audit-criteria.md`
中的 10 条固定基准。未新增、删除或改写审计基准。

未执行会写入工作区状态的端到端测试。本报告基于只读代码、
Type DD、计划文档与既有测试断言审计。

## Blocking Issues

### A1. `runner_start` 未在首个 book-scoped blocker 后严格 fail fast

Affected criteria: 1, 5

Type DD 要求 normal `runner_start` 在发现第一个 book-scoped checksum、
temp 或 lock blocker 后停止，并写入 `blocked_before_claim`。

Evidence:

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273`
  至 `1280` 要求 book-scoped 目标 read-only blocking diagnostic，并在第一个
  blocker 后 fail fast。
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1395`
  至 `1398` 重申只能记录 first blocker summary 并停止。
- `scripts/graphrag/batch-epub-workflow.mjs:5830` 至 `5834`
  对 `.lock` 文件先收集所有 lock blocker，没有在 `failFast` 下 break。
- `scripts/graphrag/batch-epub-workflow.mjs:5844` 至 `5860`
  对 temp 与 JSON primary blocker 使用 `continue`，跳过了后面的
  `failFast` 检查。
- `scripts/graphrag/batch-epub-workflow.mjs:5870`
  的 `failFast` break 只覆盖未提前 `continue` 的路径，不能保证首个
  book-scoped blocker 后立即停止。

Impact:

同一 book-scoped 目录内存在多个 lock、temp 或 JSON blocker 时，当前实现会继续
扫描并累计额外 blocker。该行为违反固定基准 5，也使 Type DD 的 first blocker
边界不可验证。

### A2. book-scoped temp/lock blocker 未统一投影为 read-only blocking diagnostic

Affected criteria: 1, 4

Primary JSON/YAML checksum 路径已经接入 read-only diagnostic，但 temp 与 lock
路径仍走通用 durable preflight blocker，并在抛错封装时被标记为 `strict`。

Evidence:

- `scripts/graphrag/batch-epub-workflow.mjs:5625` 至 `5632`
  只在 primary JSON/YAML 路径使用
  `durableReadOnlyPrimaryDiagnostic(...)`。
- `scripts/graphrag/batch-epub-workflow.mjs:5526` 至 `5544`
  temp blocker 返回 `durable_preflight_unresolved_temp`，但没有
  `durableMode: read_only_blocking_diagnostic`、
  `normalRunnerAction: no_book_scoped_mutation` 或
  `maxRunnerStartMutationCount: 0`。
- `scripts/graphrag/batch-epub-workflow.mjs:5547` 至 `5568`
  lock blocker 返回 `durable_preflight_live_lock`，同样没有 read-only blocking
  diagnostic 字段。
- `scripts/graphrag/batch-epub-workflow.mjs:5999` 至 `6005`
  durable preflight 抛错时把 evidence 覆盖为 `durableMode: "strict"`。
- `scripts/graphrag/runner-startup-preflight.mjs:249` 至 `280`
  read-only primary diagnostic 的基准字段存在，但当前只覆盖 primary path。

Impact:

固定基准 4 要求 checksum mismatch、missing checksum、checksum meta conflict、
invalid target、unknown temp、unresolved lock 都产生 read-only blocking
diagnostic。当前 unknown temp 与 unresolved lock 不满足该诊断契约。

### A3. 失败态 `startupRecovery` 丢失 Type DD 要求的 `runId` 与 `stage`

Affected criteria: 1

Type DD 要求最小 startup recovery manifest 至少包含 `runId`、`stage`、
`scopeCount`、`targetCount`、`mutationCount`、`firstSample`、`lastSample`、
`decision` 与 `explicitRepairHint`。初始写入路径包含 `runId` 与 `stage`，
但失败构造路径替换了 `startupRecovery` 对象，未保留这两个字段。

Evidence:

- `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1269`
  至 `1272` 规定最小 startup recovery manifest 字段。
- `scripts/graphrag/batch-epub-workflow.mjs:7411` 至 `7415`
  初始 `writeStartupRecoveryManifest(...)` 写入 `runId` 与
  `stage: "runner_start"`。
- `scripts/graphrag/runner-startup-preflight.mjs:124` 至 `136`
  `buildStartupPreflightFailureManifest(...)` 重新构造
  `metadata.startupRecovery`，只从 stats/update 写入 blocker、decision、
  recoveryDecision、nextOperatorAction 等字段，未写入 `runId` 或 `stage`。

Impact:

runner-start 失败后的最终 manifest 是操作者与恢复流程读取的权威状态。该状态
缺少 Type DD 的最小字段，固定基准 1 不通过。

## Criteria Results

1. FAIL - Type DD alignment  
   Blocked by A1, A2, and A3.

2. PASS - Zero mutation  
   Primary book-scoped JSON/YAML 路径使用 read-only inspection：
   `scripts/graphrag/batch-epub-workflow.mjs:5625` 至 `5632`；
   read-only helper 只读文件、checksum 与 checksum meta：
   `scripts/graphrag/runner-startup-preflight.mjs:152` 至 `230`。
   temp/lock 当前存在诊断形态问题，但未发现 normal `runner_start`
   在该路径直接修改 book-scoped primary、sidecar、temp、lock 或 owner 文件。

3. PASS - Forbidden events  
   Book-scoped primary path 未调用 `reconcileDurableJsonTarget(...)` 或
   `reconcileDurableYamlTarget(...)`，因此不会进入 quarantine/backfill 事件路径：
   `scripts/graphrag/batch-epub-workflow.mjs:6128` 至 `6266`、
   `6268` 至 `6365`。当前 blocker 事件为 `durable_preflight_blocked`：
   `scripts/graphrag/batch-epub-workflow.mjs:6008` 至 `6024`。

4. FAIL - Read-only blocker  
   Blocked by A2.

5. FAIL - Fail fast  
   Blocked by A1.

6. PASS - Startup manifest failure  
   `buildStartupPreflightFailureManifest(...)` 写入 `status: "failed"`、
   `failedAt`、`activeProviderSlots: 0`、`activeSubprocesses: 0`、
   `activeBookLeases: 0`：
   `scripts/graphrag/runner-startup-preflight.mjs:106` 至 `119`。
   `persistStartupPreflightFailure(...)` 持久化 manifest 与 recovery summary：
   `scripts/graphrag/batch-epub-workflow.mjs:7466` 至 `7480`。

7. PASS - Startup recovery fields  
   失败路径写入 `blocked_before_claim`、`stop_until_fixed`、`firstBlocker`、
   `nextOperatorAction`、`targetCount`、`degradedTargetCount`、
   `mutationCount`：
   `scripts/graphrag/runner-startup-preflight.mjs:84` 至 `94`、
   `124` 至 `136`。`runId/stage` 缺失作为 Type DD alignment 问题记录在 A3。

8. PASS - Recovery summary parity  
   `buildRecoverySummary(...)` 从 manifest 复制同一个 `startupRecovery`：
   `scripts/graphrag/batch-epub-workflow.mjs:9718` 至 `9720`。
   `writeRecoverySummary(...)` 将同一 summary 写入 `recovery-summary.json`
   与 `batch-status.json`：
   `scripts/graphrag/batch-epub-workflow.mjs:9725` 至 `9729`。

9. PASS - Provider request boundary  
   Provider request diagnostic 使用 read-only capped diagnostic，非阻塞，并设置
   `maxRunnerStartMutationCount: 0`：
   `scripts/graphrag/batch-epub-workflow.mjs:5637` 至 `5660`、
   `5728` 至 `5742`。扫描上限为 200：
   `scripts/graphrag/batch-epub-workflow.mjs:5745` 至 `5765`。
   provider-request scan 返回空 blockers：
   `scripts/graphrag/batch-epub-workflow.mjs:5808` 至 `5819`。

10. PASS - Module boundary  
    新增核心 startup preflight helper 位于
    `scripts/graphrag/runner-startup-preflight.mjs`，文件长度 281 行，承载
    schema、book-scoped mapping、read-only primary diagnostic、scan stats、
    mutation event classifier 与 failure manifest 构造。计划文档要求的拆分边界
    见 `docs/records/2026-05-29-runner-start-preflight-module-plan.md:20`
    至 `33`。`batch-epub-workflow.mjs` 仍有必要接线修改，但本轮未发现新增
    独立功能模块继续沉入大文件。

## Test Coverage Gaps

- 既有测试覆盖 book-scoped YAML checksum mismatch 的 read-only failure：
  `test/graphrag-runner-durable-preflight.test.ts:153` 至 `279`。
- 既有测试覆盖 provider request mismatch non-quarantine：
  `test/graphrag-runner-durable-preflight.test.ts:281` 至 `345`。
- 当前未覆盖多 lock、多 temp、JSON primary blocker 的 fail-fast 行为。
- 当前未覆盖失败 manifest 中 `startupRecovery.runId` 与
  `startupRecovery.stage` 的保留。
