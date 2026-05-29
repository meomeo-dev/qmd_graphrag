# Implementation Audit R2 Agent C

## Verdict

PASS.

R2 使用 `implementation-audit-criteria.md` 中同一 10 条固定基准，
未新增或改变基准。R1 的 blocker 已收敛：book-scoped `.tmp-*` 和
`.lock` 在 normal `runner_start` 下进入 read-only blocking diagnostic，
不执行 cleanup 或 lock recovery；fail-fast 在首个 blocker 后停止；失败
manifest 与 recovery-summary 保留 `blocked_before_claim`、`runId`、`stage`
和 `stop_until_fixed`。

## Criteria Results

1. Type DD traceability: PASS.
   - Type DD 固定 normal `runner_start` 对 book-scoped target 的零 mutation、
     first blocker fail-fast、`blocked_before_claim` 与 temp/lock 只读阻断。
     Evidence:
     `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273`,
     `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1279`,
     `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1283`,
     `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1395`.
   - 模块拆分计划要求把 startup preflight 辅助逻辑拆入新模块，runner 文件
     仅保留流程接线。Evidence:
     `docs/records/2026-05-29-runner-start-preflight-module-plan.md:20`,
     `docs/records/2026-05-29-runner-start-preflight-module-plan.md:28`,
     `docs/records/2026-05-29-runner-start-preflight-module-plan.md:53`.

2. Read-only inspection: PASS.
   - book-scoped primary target 通过 `bookScopedReadOnly` 分支调用
     `durableReadOnlyPrimaryDiagnostic`，避免 normal `runner_start` 进入
     writable reconcile。Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:5662`,
     `scripts/graphrag/batch-epub-workflow.mjs:5664`,
     `scripts/graphrag/batch-epub-workflow.mjs:6027`.
   - read-only primary diagnostic 只读取 primary、checksum 与 checksum meta。
     Evidence:
     `scripts/graphrag/runner-startup-preflight.mjs:207`,
     `scripts/graphrag/runner-startup-preflight.mjs:214`,
     `scripts/graphrag/runner-startup-preflight.mjs:242`.

3. No sidecar mutation: PASS.
   - checksum missing、mismatch、meta missing、meta invalid 与 meta conflict
     均被投影为 diagnostic，不 backfill、quarantine 或 rename。Evidence:
     `scripts/graphrag/runner-startup-preflight.mjs:223`,
     `scripts/graphrag/runner-startup-preflight.mjs:235`,
     `scripts/graphrag/runner-startup-preflight.mjs:243`,
     `scripts/graphrag/runner-startup-preflight.mjs:250`,
     `scripts/graphrag/runner-startup-preflight.mjs:257`.
   - focused test 断言 YAML checksum fault 不产生 quarantine/backfill。
     Evidence:
     `test/graphrag-runner-durable-preflight.test.ts:243`,
     `test/graphrag-runner-durable-preflight.test.ts:245`.

4. Temp and lock safety: PASS.
   - `.lock` 在 `bookScopedReadOnly` 下走
     `durableReadOnlyPreflightDecisionForLock`；`.tmp-*` 走
     `durableReadOnlyPreflightDecisionForTemp`；两者在 fail-fast 下直接返回。
     Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:5867`,
     `scripts/graphrag/batch-epub-workflow.mjs:5869`,
     `scripts/graphrag/batch-epub-workflow.mjs:5875`,
     `scripts/graphrag/batch-epub-workflow.mjs:5888`,
     `scripts/graphrag/batch-epub-workflow.mjs:5890`,
     `scripts/graphrag/batch-epub-workflow.mjs:5895`.
   - temp read-only diagnostic 即使 generic decision 会允许 cleanup，也返回
     blocker。Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:5549`,
     `scripts/graphrag/batch-epub-workflow.mjs:5556`,
     `scripts/graphrag/batch-epub-workflow.mjs:5557`.
   - focused tests 覆盖 temp 不 cleanup 和 lock fail-fast。Evidence:
     `test/graphrag-runner-durable-preflight.test.ts:358`,
     `test/graphrag-runner-durable-preflight.test.ts:419`,
     `test/graphrag-runner-durable-preflight.test.ts:435`,
     `test/graphrag-runner-durable-preflight.test.ts:442`,
     `test/graphrag-runner-durable-preflight.test.ts:506`,
     `test/graphrag-runner-durable-preflight.test.ts:508`.

5. Durable failure envelope: PASS.
   - durable preflight wrapper preserves incoming `durableMode` instead of
     overwriting read-only diagnostics with `strict`。Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:6048`,
     `scripts/graphrag/batch-epub-workflow.mjs:6051`.
   - failure manifest builder preserves failure kind, failed stage, local
     failure class, evidence projection, `runId` and `stage` in
     `startupRecovery`. Evidence:
     `scripts/graphrag/runner-startup-preflight.mjs:101`,
     `scripts/graphrag/runner-startup-preflight.mjs:105`,
     `scripts/graphrag/runner-startup-preflight.mjs:106`,
     `scripts/graphrag/runner-startup-preflight.mjs:107`,
     `scripts/graphrag/runner-startup-preflight.mjs:131`,
     `scripts/graphrag/runner-startup-preflight.mjs:132`.

6. Publication durability: PASS.
   - startup recovery manifest、failed manifest、recovery-summary 和
     status.json 均走 typed durable write path 与 schema。Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:7456`,
     `scripts/graphrag/batch-epub-workflow.mjs:7459`,
     `scripts/graphrag/batch-epub-workflow.mjs:7489`,
     `scripts/graphrag/batch-epub-workflow.mjs:7526`,
     `scripts/graphrag/batch-epub-workflow.mjs:9773`,
     `scripts/graphrag/batch-epub-workflow.mjs:9775`.
   - public contract schema includes diagnostic startup fields and
     `startupRecovery`。Evidence:
     `src/contracts/batch-run.ts:94`,
     `src/contracts/batch-run.ts:101`,
     `src/contracts/batch-run.ts:109`,
     `src/contracts/batch-run.ts:695`,
     `src/contracts/batch-run.ts:732`.

7. Active-resource closure: PASS.
   - failed startup manifest sets provider slots, subprocesses and book leases
     to zero before returning control. Evidence:
     `scripts/graphrag/runner-startup-preflight.mjs:117`,
     `scripts/graphrag/runner-startup-preflight.mjs:118`,
     `scripts/graphrag/runner-startup-preflight.mjs:119`.
   - focused YAML test asserts the published zero-resource state. Evidence:
     `test/graphrag-runner-durable-preflight.test.ts:247`,
     `test/graphrag-runner-durable-preflight.test.ts:251`,
     `test/graphrag-runner-durable-preflight.test.ts:253`.

8. Regression isolation: PASS.
   - `before_resume_book` and `before_claim` still call the default
     `durablePreflight` path without runner-start targets or startup scan stats.
     Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:10667`,
     `scripts/graphrag/batch-epub-workflow.mjs:11275`.
   - only `main()` runner-start path builds `runnerStartTargets` and attaches
     `startupScanStats` / `failFast`。Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:12093`,
     `scripts/graphrag/batch-epub-workflow.mjs:12094`,
     `scripts/graphrag/batch-epub-workflow.mjs:12106`,
     `scripts/graphrag/batch-epub-workflow.mjs:12110`.

9. File-size discipline: PASS.
   - new startup helper module is 378 lines; oversized runner file remains
     oversized but receives import/schema/wiring and small routing changes,
     while the new behavior body is in `runner-startup-preflight.mjs`.
     Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:38`,
     `scripts/graphrag/batch-epub-workflow.mjs:47`,
     `scripts/graphrag/runner-startup-preflight.mjs:159`,
     `scripts/graphrag/runner-startup-preflight.mjs:185`,
     `scripts/graphrag/runner-startup-preflight.mjs:204`.
   - observed line counts: `batch-epub-workflow.mjs` 12705,
     `runner-startup-preflight.mjs` 378, `src/contracts/batch-run.ts` 799,
     `test/graphrag-runner-durable-preflight.test.ts` 515,
     `test/integrations/contracts.test.ts` 3704.

10. Verification evidence: PASS.
    - Passed:
      `node --check scripts/graphrag/batch-epub-workflow.mjs`.
    - Passed:
      `node --check scripts/graphrag/runner-startup-preflight.mjs`.
    - Passed:
      `npm run test:types`.
    - Passed:
      `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
      --testTimeout 120000 test/graphrag-runner-durable-preflight.test.ts`
      with 4 tests passed, including temp and lock runner-start cases.
    - Passed:
      `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
      --testTimeout 120000 test/graphrag-runner-status-json-readonly.test.ts`
      with 8 tests passed.
    - Passed:
      `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
      --testTimeout 120000 test/graphrag-runner-durable-state.test.ts`
      with 11 tests passed.
    - Passed:
      `CI=true node --max-old-space-size=4096 ./node_modules/vitest/vitest.mjs
      run --reporter=verbose --testTimeout 240000 --pool=forks --maxWorkers=1
      --minWorkers=1 test/integrations/contracts.test.ts`
      with 72 tests passed.
    - Earlier parallel attempts produced timeouts/SIGTERM/SIGKILL under
      resource contention; sequential single-worker reruns passed.

## R1 Failure Recheck

1. Book-scoped temp anomalies no longer silently pass during normal
   `runner_start`; read-only temp diagnostics always return a blocker for an
   existing `.tmp-*` path and the focused test confirms the temp remains.
2. Book-scoped lock diagnostics are normalized to the read-only envelope and
   preserve `durableMode: read_only_blocking_diagnostic`,
   `normalRunnerAction: no_book_scoped_mutation`, and
   `maxRunnerStartMutationCount: 0`.
3. `before_claim` and `before_resume_book` default semantics remain outside
   the startup-only read-only boundary.
