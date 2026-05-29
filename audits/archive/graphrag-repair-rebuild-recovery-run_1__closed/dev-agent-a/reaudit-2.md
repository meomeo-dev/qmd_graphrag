# Development Reaudit: PASS

## 基准逐条结论

1. PASS. Repair-only mode 仍只检查和修复本地 GraphRAG state。验证用例
   `repair-only validates query-ready projection without graph query calls`
   确认 repair-only body 未执行 GraphRAG query calls 或 CLI command checks。
2. PASS. 可由 validated local evidence 修复的 local artifact gate 会 reopen 为
   `pending`，并设置 `continue_pending`。新增
   `GraphRAG document identity sidecar evidence is invalid for query_ready`
   文本已进入 batch classifier 与 resume helper 的 local artifact gate 识别。
3. PASS. 需要 real GraphRAG work 的 local artifact gate 会 reopen 同一 item 为
   `pending`、`transient`、`retry_same_run_id`，并保留需要 rebuild 的 stage。
4. PASS. Repair-only blocked result 在 `requiresRealRebuild: true` 时未设置
   `localArtifactGateRepairBlocked`，避免误标记为 manual blocked。
5. PASS. Repair-only blocked result 在没有 `requiresRealRebuild: true` 时仍保持
   manual blocked，并通过本轮 blocked tracking 避免同一 runner invocation 自旋。
6. PASS. Reopened real rebuild 继续使用同一 batch run id 与 book identity，未创建
   新 batch 或新 book identity。
7. PASS. 既有 data compatibility 与 provider-auth/provider-status failures 未被
   重分类为 real-rebuild recoverable failures；混合 failure 测试仍通过。
8. PASS. 成功 projection repair 的 metadata 仍保持严格，包含 reason、
   projection、evidence locator、producer run ids 与 command check requirement；
   新增 invalid sidecar evidence projection gate 已纳入同一 metadata 覆盖。
9. PASS. Events 与 checkpoints 仍可区分 `repaired`、`blocked`、
   `requires_real_rebuild`。新增 real rebuild blocked/reopen 与 projection reopen
   用例均验证了可观测 recovery state。
10. PASS. GraphRAG book-scoped output isolation 与 typed checkpoint persistence
    invariants 未发现破坏；GraphRAG batch runner、identity sidecar 与 type checks
    均通过。

## 阻断问题

无。

## 验证命令

```bash
node --input-type=module -e "import { classifyFailure, isLocalArtifactGateFailureText } from './scripts/graphrag/batch-failure-classifier.mjs'; const text='GraphRAG document identity sidecar evidence is invalid for query_ready: doc-1'; console.log(JSON.stringify({ isLocalArtifactGateFailureText: isLocalArtifactGateFailureText(text), classifyFailure: classifyFailure(text) }, null, 2));"
```

结果:

```json
{
  "isLocalArtifactGateFailureText": true,
  "classifyFailure": {
    "failureKind": "permanent",
    "retryable": false
  }
}
```

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "classifies query-ready projection failures|reopens query-ready .*projection gate failures|repair-only blocked can reopen a real GraphRAG rebuild|repair-only validates query-ready projection without graph query calls|mixed data compatibility|mixed provider failure"
```

结果: 1 test file passed；10 tests passed；177 skipped。

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-book-state.test.ts -t "GraphRAG identity sidecar|query-ready fallback"
```

结果: 1 test file passed；6 tests passed；29 skipped。

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "GraphRAG EPUB batch runner"
```

结果: 1 test file passed；55 tests passed；132 skipped。

```bash
npm run test:types
```

结果: 通过；`tsc -p tsconfig.build.json --noEmit` 无错误。
