# Implementation Audit R1

结论：FAIL。

审计基准固定于 `agent-c/criteria.md`，共 10 条。本报告按该固定基准审计
GraphRAG 多书并行 Runner 的真实恢复门控、durable failure 投影、测试充分性、
settings projection 安全性与维护性。

## 阻断问题

### 1. 不完整 subprocess envelope 可被当作完整证据接收

- 违反基准：3、5。
- 位置：
  - `scripts/graphrag/batch-epub-workflow.mjs:2915`
  - `scripts/graphrag/batch-epub-workflow.mjs:2937`
  - `scripts/graphrag/batch-epub-workflow.mjs:3013`
- 证据：
  - `parseDurableFailureEnvelope` 只要求行内包含
    `QMD_GRAPHRAG_DURABLE_FAILURE`，随后解析 JSON。
  - `durableEnvelopeMissingFields` 只检查 `failureKind`、
    `localFailureClass`、`recoveryDecision`、`targetLocator`、`tempId`、
    `operationId`、`failedSyscall`、`errno`、`renameCause`、`lane`、
    `targetMappingOwner`、`leaseGeneration` 与 `completedPublishRule`。
  - Type DD 要求的 `schemaVersion`、`marker`、`status`、`retryable`、
    `failedStage`、`itemId`、`bookId` 与 `workerId` 未被纳入缺失字段检查。
  - `normalizeDurableFailureEnvelope` 会从父 runner 上下文回填 `itemId`、
    `bookId`、`workerId`，并在缺失字段列表为空时返回非
    `evidenceIncomplete` 的完整 durable failure。
- 影响：
  - 若 child 输出被截断、被旧脚本替换，或缺少 Type DD 要求的 envelope
    身份字段，父 runner 可能仍将其当作完整证据写入 commandCheck、
    checkpoint、event 与 summary。
  - 这会削弱 fail-closed 语义，导致审计链无法区分“child 自带完整证据”和
    “父进程推断/回填证据”。
- 建议修复：
  - 扩展 `durableEnvelopeMissingFields`，覆盖 Type DD 的全部 required fields。
  - 校验 payload 内 `schemaVersion`、`marker`、`status` 与 `retryable`。
  - 若允许父进程回填少数字段，必须在 Type DD 中显式定义例外，并在输出中
    保留 `evidenceIncomplete=true` 或等价 diagnostic。
  - 增加 malformed envelope 测试，断言
    `durable_subprocess_evidence_incomplete`、`unavailableFieldSentinels` 与
    `stop_until_fixed`。

### 2. book-scoped YAML rename ENOENT 的测试闭环不满足 Type DD 字段覆盖

- 违反基准：4、7。
- 位置：
  - `test/cli.test.ts:3749`
  - `test/cli.test.ts:3852`
  - `test/cli.test.ts:3895`
- 证据：
  - 现有测试 `resume-book child projects book YAML rename ENOENT into command check`
    只注入 `checkpoints.yaml`。
  - Type DD acceptance case 要求覆盖
    `graph_vault/books/{bookId}/job.yaml`、`checkpoints.yaml` 与
    `artifacts.yaml` 三类 book-scoped YAML target。
  - 该测试未断言 commandCheck、item checkpoint、events、status-json 与
    recovery summary 全部包含 `tempId`、`operationId`、`targetLocator`、
    `renameCause`、`lane`、`targetMappingOwner`、`leaseGeneration` 与
    `completedPublishRule`。
  - 该测试未在失败后执行 `--status-json`，因此没有验证 status-json 观测面。
- 影响：
  - 实现可能在 `job.yaml` 或 `artifacts.yaml` 路径上回归，仍通过当前测试。
  - 实现可能丢失 root-cause 字段、从 typed envelope 退化到 legacy stderr
    分类，仍通过当前测试。
  - status-json 可能无法投影该 durable failure，当前测试不会发现。
- 建议修复：
  - 将测试参数化为 `job.yaml`、`checkpoints.yaml`、`artifacts.yaml` 三个目标。
  - 对 failed commandCheck、item checkpoint、`command_failed`、`item_failed`、
    `--status-json` 输出与 `recovery-summary.json` 逐面断言同一组 durable
    字段。
  - 增加显式断言：`failureKind !== "unknown"`、
    `failureKind === "local_state_integrity"`、`retryable === false`、
    `recoveryDecision === "stop_until_fixed"`。

## 通过证据

- Type DD 先行：`docs/architecture/graphrag-parallel-runner.type-dd.yaml:3`
  为 `production_ready_design`；审计状态记录 design audit R5 passed。
- Durable rename ENOENT 分类主路径：
  `src/job-state/durable-state-store.ts:1306` 与 `:1336` 将 async/sync rename
  ENOENT 转为 `DurableStateError`，携带
  `localFailureClass=durable_temp_rename_enoent`、`failedSyscall=rename`、
  `errno=ENOENT`、`renameCause` 与 `completedPublishRule=forbidden`。
- Legacy classifier 优先识别本地 durable failure：
  `scripts/graphrag/batch-failure-classifier.mjs:7` 在 provider 分类前处理
  local durable state failure，`scripts/graphrag/batch-failure-classifier.mjs:83`
  将其分类为 `local_state_integrity` 或 `local_state_lock_timeout`。
- Child envelope 输出主路径：
  `scripts/graphrag/resume-book-workspace.mjs:113` 构造 durable failure
  envelope，`:1501` 到 `:1510` 在 catch 分支向 stderr 输出 marker JSON。
- 父 runner typed envelope 优先级：
  `scripts/graphrag/batch-epub-workflow.mjs:9391` 到 `:9403` 在 legacy
  `classifyFailure` 前解析 envelope。
- checkpoint 与 summary 投影主路径：
  `scripts/graphrag/batch-epub-workflow.mjs:10593` 到 `:10831` 将
  commandCheck durable fields 写入 failed checkpoint；
  `scripts/graphrag/batch-epub-workflow.mjs:8734` 到 `:8750` 将 durable fields
  投影到 recovery/status item。
- 真实 runner 门控：
  `audits/graphrag-book-yaml-rename-enoent-run_20260528_r1__open/reports/status.json:100`
  到 `:106` 显示 implementation audit 尚未开始且 `realRunner.resumeAllowed=false`。
- Settings projection：
  `src/graphrag/settings-projection.ts:361` 到 `:405` 对缺失 settings projection
  执行 managed projection 创建，但 `:393` 到 `:395` 仍拒绝无 managed marker 的
  user-owned settings；同步路径 `:407` 到 `:451` 等价。
  `test/graphrag-book-state.test.ts:2736` 到 `:2802` 覆盖 user-owned settings
  不被覆盖。
- `--status-json` read-only：
  `scripts/graphrag/batch-epub-workflow.mjs:5210` 在 preflight 中跳过写入，
  `test/graphrag-runner-status-json-readonly.test.ts:219` 到 `:271` 覆盖缺失
  checksum meta 时不创建 lock、temp 或 meta。

## 维护性风险

- `scripts/graphrag/batch-epub-workflow.mjs` 当前约 11713 行。
- `test/cli.test.ts` 当前约 17464 行。
- `src/job-state/durable-state-store.ts` 当前约 1989 行。
- `scripts/graphrag/resume-book-workspace.mjs` 当前约 1516 行。

这些文件超过 AGENTS.md 的默认行数阈值。由于本轮目标集中在 durable recovery
修复，未判定为独立功能缺陷；但后续应拆分 runner durable adapter、envelope
projection、preflight reconciliation 与 CLI fixture，降低审计与回归测试成本。

## 验证记录

本轮审计未修改源码，未重新运行测试。审计依据为静态代码检查、既有验证记录与
固定实施审计基准。既有验证记录包括两个 `.mjs` 的 `node --check`、
`npm run test:types`、Type DD YAML parse，以及 durable/status-json/preflight
聚焦 Vitest。
