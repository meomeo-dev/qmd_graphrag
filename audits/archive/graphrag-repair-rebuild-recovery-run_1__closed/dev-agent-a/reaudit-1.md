# Development Reaudit: FAIL

## 基准逐条结论

1. PASS. Repair-only mode 仍只检查和修复本地 GraphRAG state；现有
   `repair-only validates query-ready projection without graph query calls`
   覆盖未发现 GraphRAG query calls 或 CLI command checks 进入 repair-only。
2. FAIL. 新增 identity sidecar validator 抛出的本地证据错误未被分类为
   local artifact gate，因此不能保证由 validated local evidence 修复后以
   `pending` 和 `continue_pending` reopen。
3. PASS. `requiresRealRebuild: true` 的 blocked repair 仍会把同一 item
   reopen 为 `pending`、`transient`、`retry_same_run_id`，并保留 rebuild
   stage。
4. PASS. `requiresRealRebuild: true` 分支仍将
   `localArtifactGateRepairBlocked` 置为 `undefined`，未标记为 manual
   blocked。
5. PASS. 非 real rebuild 的 blocked repair 仍保持 manual blocked，并通过
   `repairBlockedThisRun` 避免同一 runner invocation 内自旋。
6. PASS. Reopened real rebuild 仍复用原 batch run id 和 book identity，未创建
   新 batch 或新 book identity。
7. PASS. 既有 data compatibility 与 provider-auth/provider-status failures
   仍不会被重分类为 real-rebuild recoverable failures。
8. FAIL. 成功 projection repair 的 metadata 规则本身仍严格，但新增
   `sidecar evidence is invalid` 本地失败无法进入该 repair path，因此该场景
   不会获得要求的 reason、projection、evidence locator、producer run ids 和
   command check requirement。
9. FAIL. 事件和 checkpoint 字段可区分既有 `repaired`、`blocked`、
   `requires_real_rebuild` 场景；但新增 invalid sidecar evidence 场景会被分类为
   `unknown` permanent failure，无法进入对应 observable recovery state。
10. PASS. GraphRAG book-scoped output isolation 与 typed checkpoint
    persistence invariants 未发现新增破坏；相关 CLI 与 type tests 通过。

## 阻断问题

- `src/job-state/graphrag-book.ts:819`: `readGraphTextUnitIdentitySidecar`
  在 sidecar 存在但无法由 parquet evidence 验证时抛出
  `GraphRAG document identity sidecar evidence is invalid for query_ready`。
  这是本地 query-ready identity evidence gate，不是 provider 或 data
  compatibility failure。
- `scripts/graphrag/batch-failure-classifier.mjs:140`: 
  `isLocalArtifactGateFailureText` 未包含上述 `sidecar evidence is invalid`
  文本；分类结果为 `failureKind: "unknown"`、`retryable: false`。
- `scripts/graphrag/resume-book-workspace.mjs:225`: repair-only resume helper
  的 `isLocalArtifactGateError` 同样未包含上述文本，导致 standalone resume
  repair path 也无法稳定识别该本地 gate。
- 原因: 新增 GraphRAG identity validator/test 引入了一个新的本地 artifact gate
  错误文本，但 local artifact gate 分类器和 resume helper 没有同步扩展。
  该失败会绕过 repair-only projection repair/reopen 语义，破坏基准 2、8、9。

## 建议修复

- 将 `GraphRAG document identity sidecar evidence is invalid for query_ready`
  纳入 `batch-failure-classifier.mjs` 与 `resume-book-workspace.mjs` 的 local
  artifact gate 文本识别。
- 增加 CLI classifier test，直接断言该文本被识别为 local artifact gate，且
  `classifyFailure` 返回 `failureKind: "permanent"`、`retryable: false`。
- 增加 repair-only/reopen 覆盖，确认 invalid sidecar evidence 场景能产生
  `continue_pending` 或明确的 `requires_real_rebuild` observable state。

## 验证命令

```bash
node --input-type=module -e "import { classifyFailure, isLocalArtifactGateFailureText } from './scripts/graphrag/batch-failure-classifier.mjs'; const text='GraphRAG document identity sidecar evidence is invalid for query_ready: doc-1'; console.log(JSON.stringify({ isLocalArtifactGateFailureText: isLocalArtifactGateFailureText(text), classifyFailure: classifyFailure(text) }, null, 2));"
```

结果:

```json
{
  "isLocalArtifactGateFailureText": false,
  "classifyFailure": {
    "failureKind": "unknown",
    "retryable": false
  }
}
```

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-book-state.test.ts -t "GraphRAG identity sidecar|query-ready fallback"
```

结果: 1 test file passed；6 tests passed；29 skipped。

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "GraphRAG EPUB batch runner"
```

结果: 1 test file passed；54 tests passed；132 skipped。

```bash
npm run test:types
```

结果: 通过；`tsc -p tsconfig.build.json --noEmit` 无错误。
