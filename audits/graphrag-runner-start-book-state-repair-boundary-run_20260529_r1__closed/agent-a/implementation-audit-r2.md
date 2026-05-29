# Agent A Implementation Audit R2

## Verdict

PASS

本轮只使用
`audits/graphrag-runner-start-book-state-repair-boundary-run_20260529_r1__open/agent-a/implementation-audit-criteria.md`
中的 10 条固定基准。未新增、删除或改写审计基准。

R1 失败项已复核通过：fail-fast、book-scoped temp/lock read-only
diagnostic、firstBlocker durableMode、startupRecovery runId/stage 均有实现与
测试证据。

## R1 Failure Recheck

### A1. Fail-fast

Status: PASS

Evidence:

- `scripts/graphrag/batch-epub-workflow.mjs:5867` 至 `5876`：
  lock blocker 进入 `blockers` 后在 `failFast` 下立即返回。
- `scripts/graphrag/batch-epub-workflow.mjs:5888` 至 `5896`：
  temp blocker 进入 `blockers` 后在 `failFast` 下立即返回。
- `scripts/graphrag/batch-epub-workflow.mjs:5899` 至 `5916`：
  JSON/YAML primary blocker 进入 `blockers` 后在 `failFast` 下立即返回。
- `scripts/graphrag/batch-epub-workflow.mjs:6020` 至 `6033`：
  target 层在发现 blocker 后停止后续 target 扫描。
- `test/graphrag-runner-durable-preflight.test.ts:442` 至 `509`：
  lock fixture 同时放置第二个 YAML checksum fault，断言 firstBlocker 只指向
  `runs/a.yaml`，不包含 `runs/b.yaml`。

### A2. Book-scoped temp/lock read-only diagnostic

Status: PASS

Evidence:

- `scripts/graphrag/batch-epub-workflow.mjs:5549` 至 `5561`：
  book-scoped temp 进入 `durableReadOnlyTempDiagnostic(...)`。
- `scripts/graphrag/batch-epub-workflow.mjs:5590` 至 `5604`：
  book-scoped lock 进入 `durableReadOnlyLockDiagnostic(...)`。
- `scripts/graphrag/runner-startup-preflight.mjs:159` 至 `182`：
  temp diagnostic 设置 `durableMode: "read_only_blocking_diagnostic"`、
  `normalRunnerAction: "no_book_scoped_mutation"` 与
  `maxRunnerStartMutationCount: 0`。
- `scripts/graphrag/runner-startup-preflight.mjs:185` 至 `201` 以及
  `285` 至 `319`：lock diagnostic 复用 read-only base，包含
  `repairAllowed: false`、`completedPublishRule: "forbidden"`、
  `normalRunnerAction: "no_book_scoped_mutation"`、
  `durableMode: "read_only_blocking_diagnostic"` 与
  `maxRunnerStartMutationCount: 0`。
- `test/graphrag-runner-durable-preflight.test.ts:390` 至 `435`：
  temp fixture 断言未触发 temp reconciliation，且 firstBlocker 为 read-only。
- `test/graphrag-runner-durable-preflight.test.ts:500` 至 `505`：
  lock fixture 断言 firstBlocker 为 read-only。

### A3. firstBlocker durableMode

Status: PASS

Evidence:

- `scripts/graphrag/batch-epub-workflow.mjs:6044` 至 `6053`：
  durable preflight 抛错时保留 `first.durableMode`，仅在缺失时回退为
  `"strict"`。
- `test/graphrag-runner-durable-preflight.test.ts:266` 至 `284`：
  YAML checksum mismatch 的 manifest 与 recovery summary 均保留
  `durableMode: "read_only_blocking_diagnostic"`。
- `test/graphrag-runner-durable-preflight.test.ts:426` 至 `432`：
  temp blocker 保留 read-only durableMode。
- `test/graphrag-runner-durable-preflight.test.ts:500` 至 `505`：
  lock blocker 保留 read-only durableMode。

### A4. startupRecovery runId/stage

Status: PASS

Evidence:

- `scripts/graphrag/runner-startup-preflight.mjs:127` 至 `143`：
  failure manifest 构造时写入 `startupRecovery.runId` 与
  `startupRecovery.stage: "runner_start"`。
- `scripts/graphrag/batch-epub-workflow.mjs:7456` 至 `7480`：
  startup recovery manifest 的常规写入路径固定带上 `runId` 与
  `stage: "runner_start"`。
- `test/graphrag-runner-durable-preflight.test.ts:256` 至 `264`：
  YAML failure manifest 断言 `runId` 与 `stage`。
- `test/integrations/contracts.test.ts:1874` 至 `1888`：
  contract fixture 覆盖 `startupRecovery.runId`、`stage` 与 operator action。

## Criteria Results

1. PASS - Type DD alignment  
   Type DD 要求 normal `runner_start` 对 book-scoped durable target 使用只读阻断
   诊断并在首个 blocker 后停止：
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273` 至 `1280`、
   `1392` 至 `1400`。实现通过 book-scoped target 标记和 read-only scan 满足
   该边界：`scripts/graphrag/batch-epub-workflow.mjs:5952` 至 `5954`、
   `6020` 至 `6033`。

2. PASS - Zero mutation  
   Book-scoped primary path 在 `runner_start` 使用 read-only diagnostic：
   `scripts/graphrag/batch-epub-workflow.mjs:5662` 至 `5669`。temp/lock path
   使用 read-only diagnostic：
   `scripts/graphrag/batch-epub-workflow.mjs:5549` 至 `5561`、
   `5590` 至 `5604`。测试断言 mutationCount 为 0：
   `test/graphrag-runner-durable-preflight.test.ts:256` 至 `264`、
   `421` 至 `425`、`495` 至 `499`。

3. PASS - Forbidden events  
   Read-only runner-start 不进入 quarantine/backfill/temp reconciliation 路径。
   YAML test 明确断言未出现 quarantine/backfill 事件：
   `test/graphrag-runner-durable-preflight.test.ts:243` 至 `246`。temp test
   明确断言未出现 `durable_yaml_temp_reconciled`：
   `test/graphrag-runner-durable-preflight.test.ts:418` 至 `420`。

4. PASS - Read-only blocker  
   Checksum、missing sidecar、checksum meta、invalid target 由
   `durableReadOnlyPrimaryDiagnostic(...)` 覆盖：
   `scripts/graphrag/runner-startup-preflight.mjs:204` 至 `283`。unknown temp 与
   unresolved lock 分别由 read-only temp/lock diagnostic 覆盖：
   `scripts/graphrag/runner-startup-preflight.mjs:159` 至 `201`。

5. PASS - Fail fast  
   Directory scan 对 lock、temp、JSON primary、YAML primary blocker 均在
   `failFast` 下立即返回：
   `scripts/graphrag/batch-epub-workflow.mjs:5867` 至 `5916`。target scan 在
   blocker 后停止：
   `scripts/graphrag/batch-epub-workflow.mjs:6020` 至 `6033`。

6. PASS - Startup manifest failure  
   Failure manifest 写入 `status: "failed"`、`failedAt`、零 active slots、
   零 active subprocesses 与零 active book leases：
   `scripts/graphrag/runner-startup-preflight.mjs:109` 至 `122`。持久化路径写入
   manifest 与 recovery summary：
   `scripts/graphrag/batch-epub-workflow.mjs:7514` 至 `7528`。

7. PASS - Startup recovery fields  
   Failure startupRecovery 写入 `blocked_before_claim`、`stop_until_fixed`、
   `firstBlocker`、`nextOperatorAction`、`targetCount`、
   `degradedTargetCount` 与 `mutationCount`：
   `scripts/graphrag/runner-startup-preflight.mjs:87` 至 `97`、
   `127` 至 `143`。

8. PASS - Recovery summary parity  
   Recovery summary 从 manifest 复制同一 startupRecovery：
   `scripts/graphrag/batch-epub-workflow.mjs:9766` 至 `9768`。同一 summary 写入
   `recovery-summary.json` 与 `batch-status.json`：
   `scripts/graphrag/batch-epub-workflow.mjs:9773` 至 `9777`。

9. PASS - Provider request boundary  
   Provider request diagnostic 仍为 read-only capped diagnostic，且
   `maxRunnerStartMutationCount: 0`：
   `scripts/graphrag/batch-epub-workflow.mjs:5674` 至 `5697`、
   `5765` 至 `5779`。provider request scan 只返回 diagnostics，不返回
   blockers：
   `scripts/graphrag/batch-epub-workflow.mjs:5845` 至 `5857`。

10. PASS - Module boundary  
    新 startup-preflight 逻辑位于
    `scripts/graphrag/runner-startup-preflight.mjs`，当前 378 行。计划文档要求
    新模块承载 read-only diagnostic、stats、mutation event 计数与 failure
    manifest 构造：
    `docs/records/2026-05-29-runner-start-preflight-module-plan.md:20` 至 `33`。
    `batch-epub-workflow.mjs` 中保留流程接线与扫描调用，未发现新的独立功能模块
    继续沉入超长 runner 文件。

## Validation Evidence

已执行并通过：

```bash
node --check scripts/graphrag/batch-epub-workflow.mjs
node --check scripts/graphrag/runner-startup-preflight.mjs
npm run test:types
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 120000 \
  test/graphrag-runner-durable-preflight.test.ts
```

Result:

- `test/graphrag-runner-durable-preflight.test.ts`: 4 tests passed.

## Residual Risk

未执行完整测试矩阵。本轮 R2 的证据范围覆盖 Agent A R1 失败项和固定 10 条基准
所需的实现路径；完整回归仍应由主流程或最终实施审计汇总阶段执行。
