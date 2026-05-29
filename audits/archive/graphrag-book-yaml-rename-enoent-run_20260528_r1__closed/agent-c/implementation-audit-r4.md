# Implementation Audit R4

审计对象：GraphRAG 多书并行 Runner 的 R3 修复后实现。

审计基准：仅使用 `agent-c/criteria.md` 中固定 10 条 Implementation Audit
Criteria。

结论：FAIL

## 阻断项

### 1. book-scoped YAML child-envelope 闭环测试仍不可通过

- 违反 criteria：7。
- 位置：
  - `test/cli.test.ts:3923`
  - `test/cli.test.ts:3925`
  - `test/cli.test.ts:4004`
  - `test/cli.test.ts:4013`
  - `test/cli.test.ts:4033`
- 证据：
  - R4 聚焦执行：
    `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
    --testTimeout 180000 test/cli.test.ts -t
    "resume-book child projects|durable subprocess envelope|settings projection
    rejection is observable|invalid source settings projection rejection is
    observable"`。
  - 三个 Type DD 要求的 primary YAML target 用例均在测试自身 45 秒超时：
    `job.yaml`、`checkpoints.yaml`、`artifacts.yaml`。
  - 失败点均指向 `test/cli.test.ts:3925` 参数化测试声明，说明 R3 后关键
    regression 闭环仍不是可运行、可审计的测试闭环。
  - 残留夹具显示 child 已写出 `QMD_GRAPHRAG_DURABLE_FAILURE`，父 runner 也
    写入了 checkpoint、`command_failed`、`item_failed` 与 recovery summary；
    但测试进程未在断言窗口内稳定完成，因此 criteria 7 的测试闭环要求未满足。
- 修复要求：
  - 使 `job.yaml`、`checkpoints.yaml`、`artifacts.yaml` 三个用例在普通
    vitest 运行中稳定完成。
  - 消除失败后进入额外 provider-auth、repair 或等待路径导致的超时；若这些路径
    是必要行为，应显式缩短/门控测试路径并断言不会削弱 durable failure 投影。
  - 保持测试逐面断言 child stderr envelope 到 commandCheck、item checkpoint、
    `command_failed`、`item_failed`、`--status-json` 与 recovery summary 的字段。

### 2. 聚焦回归套件仍有 settings projection summary 断言失败

- 违反 criteria：8。
- 位置：
  - `test/cli.test.ts:9521`
  - `test/cli.test.ts:9656`
  - `scripts/graphrag/batch-epub-workflow.mjs:2318`
  - `scripts/graphrag/batch-epub-workflow.mjs:2332`
  - `scripts/graphrag/batch-epub-workflow.mjs:10928`
  - `scripts/graphrag/batch-epub-workflow.mjs:11022`
- 证据：
  - 用例 `settings projection rejection is observable in checkpoint events and
    summary` 失败。
  - 实际 summary item 的 `activeCommand` 为 `resume-book-1`，测试期望为
    `repair-local-artifact-gate-1`。
  - 拒绝 metadata 本身存在，但 R3 后 summary active command 投影语义与测试闭环
    不一致，导致 user-owned `graph_vault/settings.yaml` 拒绝策略的可观测回归测试
    不能通过。
- 修复要求：
  - 明确 settings projection rejection 的权威 active command：若拒绝发生在
    resume-book boundary，测试应期望 `resume-book-*`；若 repair-only pass 应成为
    summary 权威，则实现必须稳定投影 `repair-local-artifact-gate-*`。
  - 保持 checkpoint、events、summary 至少一处可观测
    `settingsProjectionDecision=rejected_user_owned`、
    `settingsProjectionReason=settings_projection_rejected_user_owned_or_invalid`，
    且不得覆盖 user-owned `graph_vault/settings.yaml`。

### 3. status-json read-only 聚焦文件仍包含超时回归用例

- 违反 criteria：9。
- 位置：
  - `test/graphrag-runner-status-json-readonly.test.ts:218`
  - `test/graphrag-runner-status-json-readonly.test.ts:278`
  - `test/graphrag-runner-status-json-readonly.test.ts:329`
  - `scripts/graphrag/batch-epub-workflow.mjs:4434`
  - `scripts/graphrag/batch-epub-workflow.mjs:4605`
- 证据：
  - `status-json reports missing books checksum meta without state mutation` 通过，
    证明只读路径对缺失 checksum meta 不写 lock/temp/meta。
  - 同一聚焦文件中两个 repair-writer 用例在 30 秒超时：
    `repair writer records successful checksum meta backfill evidence` 与
    `repair writer quarantines invalid checksum meta sidecar only`。
  - 虽然这两个用例不是 `--status-json` 本体，但它们覆盖 read-only 与 repair
    writer 分界。当前文件整体不能通过，无法证明 R3 后 read-only/repair 分界的
    regression suite 已闭合。
- 修复要求：
  - 将 read-only 用例与 repair-writer 用例拆分，或稳定 repair writer 测试运行
    时间。
  - 保留 `--status-json` snapshot-before/after 断言，覆盖不得创建、删除、rename
    lock/temp/checksum/meta/quarantine/event/status/recovery-summary。

## 通过项

- criteria 1：Type DD 为 production-ready 设计，且包含 subprocess durable
  envelope、父 runner typed envelope 优先、fail-closed 与三类 book-scoped YAML
  验收。参见 `docs/architecture/graphrag-parallel-runner.type-dd.yaml:903`、
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:954`、
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1582`。
- criteria 2：shared durable store 对 book-scoped `job.yaml`、`artifacts.yaml`、
  `checkpoints.yaml` 建立 targetMapping，并将 rename ENOENT 分类为
  `local_state_integrity`、`durable_temp_rename_enoent`、`retryable=false`、
  `stop_until_fixed`。参见 `src/job-state/durable-state-store.ts:90`、
  `src/job-state/durable-state-store.ts:1336`。
- criteria 3：`resume-book-workspace` 对 `DurableStateError` 输出单行
  `QMD_GRAPHRAG_DURABLE_FAILURE` envelope。参见
  `scripts/graphrag/resume-book-workspace.mjs:120`、
  `scripts/graphrag/resume-book-workspace.mjs:1527`。
- criteria 4、5：父 runner 在 `runCommand` 中先解析 envelope，再走 legacy
  classifier；partial、malformed、missing envelope fail closed 为
  `durable_subprocess_evidence_incomplete`，并写 sentinel。参见
  `scripts/graphrag/batch-epub-workflow.mjs:2935`、
  `scripts/graphrag/batch-epub-workflow.mjs:2957`、
  `scripts/graphrag/batch-epub-workflow.mjs:3037`、
  `scripts/graphrag/batch-epub-workflow.mjs:9540`。
- criteria 6：真实 runner 门控仍保持关闭。
  `audits/graphrag-book-yaml-rename-enoent-run_20260528_r1__open/reports/status.json:133`
  显示 `resumeAllowed=false`。
- criteria 8：实现层面 settings projection 首次缺失会创建 managed projection，
  user-owned projection 会拒绝覆盖。参见
  `src/graphrag/settings-projection.ts:361`、
  `src/graphrag/settings-projection.ts:393`、
  `src/graphrag/settings-projection.ts:407`、
  `src/graphrag/settings-projection.ts:439`。

## 验证记录

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：PASS。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：PASS。
- `node --check scripts/graphrag/batch-failure-classifier.mjs`：PASS。
- `npm run test:types`：PASS。
- `test/graphrag-runner-durable-preflight.test.ts`：PASS。
- `test/graphrag-runner-status-json-readonly.test.ts`：FAIL，2 个用例超时。
- `test/cli.test.ts` 聚焦 durable envelope/settings 用例：FAIL，4 个失败。

## 维护性风险

criteria 10 需继续记录为风险并要求后续收敛：

- `scripts/graphrag/batch-epub-workflow.mjs`：11890 行。
- `src/job-state/graphrag-book.ts`：2209 行。
- `src/job-state/durable-state-store.ts`：2128 行。
- `scripts/graphrag/resume-book-workspace.mjs`：1542 行。

后续应拆分 runner durable adapter、envelope projection、status-json read-only
inspection、settings projection repair metadata 与测试 fixture helper。当前 R4
不因单纯行数判定阻断，但这些文件已显著超过 AGENTS.md 维护性阈值。
