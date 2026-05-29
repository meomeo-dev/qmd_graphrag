# Implementation Audit R1 Agent C

## Verdict

FAIL.

当前实现已把 book-scoped primary YAML/JSON 的 `runner_start` 校验改为
read-only diagnostic，但 book-scoped temp/lock 路径仍未完全符合固定基准。
正常 `runner_start` 对 `.tmp-*` 和 `.lock` 的扫描仍复用通用 preflight
判断，缺少 book-scoped 专用的 read-only blocking envelope，且 stale temp
with complete owner evidence 会被视为非 blocker。该行为不满足 Type DD 对
unknown temp、unresolved lock 和零 mutation boundary 的要求。

## Criteria Results

1. Type DD traceability: FAIL.
   - Type DD 要求 normal `runner_start` 对 book-scoped target 不执行 temp
     cleanup，并在 unknown temp 或 lock owner 不可判定时 fail fast 到
     `blocked_before_claim`。
   - Evidence:
     `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1273`,
     `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1279`,
     `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1395`,
     `docs/architecture/graphrag-parallel-runner.type-dd.yaml:1400`.
   - Implementation only routes primary YAML/JSON through
     `durableReadOnlyPrimaryDiagnostic`; temp/lock still use generic helpers.
     Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:5830`,
     `scripts/graphrag/batch-epub-workflow.mjs:5845`,
     `scripts/graphrag/batch-epub-workflow.mjs:5625`.

2. Read-only inspection: PASS.
   - Book-scoped primary validation is routed through the read-only helper when
     `bookScopedReadOnly` is true, avoiding writable reconciliation helpers.
   - Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:5625`,
     `scripts/graphrag/batch-epub-workflow.mjs:5979`,
     `scripts/graphrag/runner-startup-preflight.mjs:152`.
   - The helper reads primary, checksum, and checksum meta state and returns
     diagnostics without invoking `reconcileDurableJsonTarget` or
     `reconcileDurableYamlTarget`.
     Evidence: `scripts/graphrag/runner-startup-preflight.mjs:155`.

3. No sidecar mutation: PASS.
   - Missing, mismatched, invalid, or conflicting primary checksum sidecars are
     projected as diagnostics in the read-only helper.
   - Evidence:
     `scripts/graphrag/runner-startup-preflight.mjs:171`,
     `scripts/graphrag/runner-startup-preflight.mjs:183`,
     `scripts/graphrag/runner-startup-preflight.mjs:190`,
     `scripts/graphrag/runner-startup-preflight.mjs:198`,
     `scripts/graphrag/runner-startup-preflight.mjs:205`.
   - Focused test asserts no quarantine or checksum backfill events for mapped
     book YAML mismatch.
     Evidence: `test/graphrag-runner-durable-preflight.test.ts:240`.

4. Temp and lock safety: FAIL.
   - The scanner processes lock files through `durablePreflightDecisionForLock`
     without a book-scoped-specific envelope.
     Evidence: `scripts/graphrag/batch-epub-workflow.mjs:5830`.
   - The scanner processes `.tmp-*` files through
     `durablePreflightDecisionForTemp` without a book-scoped-specific envelope.
     Evidence: `scripts/graphrag/batch-epub-workflow.mjs:5845`.
   - `durablePreflightDecisionForTemp` returns `null` when
     `durableTempCleanupDecision` says `remove: true`, so a stale temp with
     complete owner evidence is treated as no blocker during normal
     `runner_start`.
     Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:5526`,
     `scripts/graphrag/batch-epub-workflow.mjs:5533`,
     `scripts/graphrag/batch-epub-workflow.mjs:5534`.
   - Writable reconciliation paths still remove stale temps in normal durable
     reconciliation helpers.
     Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:6147`,
     `scripts/graphrag/batch-epub-workflow.mjs:6287`.
   - No focused test covers book-scoped `.tmp-*` or `.lock` during
     `runner_start`; existing focused test covers only primary YAML checksum
     mismatch.
     Evidence: `test/graphrag-runner-durable-preflight.test.ts:154`.

5. Durable failure envelope: PASS.
   - Startup durable failure manifest preserves failure kind, failed stage,
     local failure class, target evidence, and `stop_until_fixed`.
   - Evidence:
     `scripts/graphrag/runner-startup-preflight.mjs:97`,
     `scripts/graphrag/runner-startup-preflight.mjs:99`,
     `scripts/graphrag/runner-startup-preflight.mjs:101`,
     `scripts/graphrag/runner-startup-preflight.mjs:102`,
     `scripts/graphrag/runner-startup-preflight.mjs:120`.
   - Focused test asserts these fields for primary YAML mismatch.
     Evidence: `test/graphrag-runner-durable-preflight.test.ts:230`.

6. Publication durability: PASS.
   - Failed manifest and recovery summary publication use typed durable JSON
     writes and schemas.
   - Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:7466`,
     `scripts/graphrag/batch-epub-workflow.mjs:7478`,
     `scripts/graphrag/batch-epub-workflow.mjs:7479`,
     `scripts/graphrag/batch-epub-workflow.mjs:9725`.
   - Contract schema includes `startupRecovery`.
     Evidence: `src/contracts/batch-run.ts:109`,
     `src/contracts/batch-run.ts:695`,
     `src/contracts/batch-run.ts:732`.

7. Active-resource closure: PASS.
   - Startup failure manifest sets active provider slots, subprocesses, and
     book leases to zero before returning control.
   - Evidence:
     `scripts/graphrag/runner-startup-preflight.mjs:114`,
     `scripts/graphrag/runner-startup-preflight.mjs:115`,
     `scripts/graphrag/runner-startup-preflight.mjs:116`.
   - Focused test asserts the same published manifest state.
     Evidence: `test/graphrag-runner-durable-preflight.test.ts:244`.

8. Regression isolation: PASS.
   - `before_claim` and `before_resume_book` still call the default
     `durablePreflight` path without the runner-start target override or
     startup scan stats.
   - Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:10619`,
     `scripts/graphrag/batch-epub-workflow.mjs:11227`.
   - Module split plan explicitly preserves these semantics.
     Evidence:
     `docs/records/2026-05-29-runner-start-preflight-module-plan.md:51`.

9. File-size discipline: PASS.
   - New feature helper logic is placed in
     `scripts/graphrag/runner-startup-preflight.mjs`; the oversized runner file
     receives import/schema/wiring changes.
   - Evidence:
     `docs/records/2026-05-29-runner-start-preflight-module-plan.md:20`,
     `scripts/graphrag/batch-epub-workflow.mjs:38`,
     `scripts/graphrag/runner-startup-preflight.mjs:1`.
   - Line counts observed:
     `batch-epub-workflow.mjs` 12657 lines,
     `runner-startup-preflight.mjs` 281 lines,
     `src/contracts/batch-run.ts` 799 lines.

10. Verification evidence: PASS WITH COVERAGE GAP.
    - Passed:
      `node --check scripts/graphrag/batch-epub-workflow.mjs`.
    - Passed:
      `node --check scripts/graphrag/runner-startup-preflight.mjs`.
    - Passed:
      `npm run test:types`.
    - Passed:
      `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
      --testTimeout 120000 test/graphrag-runner-durable-preflight.test.ts`.
    - Passed:
      `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
      --testTimeout 120000 test/graphrag-runner-status-json-readonly.test.ts
      test/graphrag-runner-durable-state.test.ts`.
    - Passed:
      `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
      --testTimeout 120000 test/integrations/contracts.test.ts`.
    - Coverage gap remains for book-scoped `runner_start` temp and lock
      anomalies.

## Blocking Issues

1. Book-scoped temp anomalies can be silently treated as non-blocking during
   normal `runner_start`.
   - `durablePreflightScanDirectory` calls `durablePreflightDecisionForTemp`
     for `.tmp-*` under book-scoped scans.
   - `durablePreflightDecisionForTemp` returns `null` when stale temp cleanup
     would be allowed by the generic decision, instead of producing a
     read-only blocking diagnostic.
   - Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:5845`,
     `scripts/graphrag/batch-epub-workflow.mjs:5533`,
     `scripts/graphrag/batch-epub-workflow.mjs:5534`.

2. Book-scoped lock diagnostics are not normalized to the fixed runner-start
   read-only envelope.
   - `durablePreflightScanDirectory` calls the generic lock decision for
     `.lock` entries even when `bookScopedReadOnly` is true.
   - The returned diagnostic lacks the explicit book-scoped fields used by the
     primary diagnostic, including `normalRunnerAction:
     no_book_scoped_mutation`, `durableMode: read_only_blocking_diagnostic`,
     and `maxRunnerStartMutationCount: 0`.
   - Evidence:
     `scripts/graphrag/batch-epub-workflow.mjs:5830`,
     `scripts/graphrag/batch-epub-workflow.mjs:5547`,
     `scripts/graphrag/runner-startup-preflight.mjs:267`,
     `scripts/graphrag/runner-startup-preflight.mjs:273`,
     `scripts/graphrag/runner-startup-preflight.mjs:275`.

3. Verification does not exercise the failing temp/lock boundary.
   - The focused runner-start durable test covers primary YAML checksum
     mismatch and provider request mismatch, not book-scoped temp or lock
     anomalies.
   - Evidence:
     `test/graphrag-runner-durable-preflight.test.ts:154`,
     `test/graphrag-runner-durable-preflight.test.ts:281`.

