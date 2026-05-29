# Development Audit: PASS

审计对象（audit target）：当前未提交改动相对 10 条固定基准。
重点审计文件包括批处理恢复脚本、单书恢复脚本、GraphRAG 书状态、
CLI 测试、书状态测试；当前工作树还包含相关批处理契约
`src/contracts/batch-run.ts` 的恢复摘要字段扩展。

## 基准结果

1. PASS - Repair-only 模式不会执行 GraphRAG query 调用或 CLI command
   checks。`--repair-local-artifact-gate-only` 分支在创建运行时查询前返回，
   只执行本地状态同步、artifact 校验和 checkpoint 修复。
2. PASS - 可由本地证据修复的 artifact gate 会重开为 `pending`，
   `recoveryDecision` 为 `continue_pending`，并清理失败字段。
3. PASS - 需要真实 GraphRAG 工作的 artifact gate 会重开同一 item 为
   `pending`、`transient`、`retry_same_run_id`，并保留 `rebuildStage`
   作为后续重建阶段。
4. PASS - `requiresRealRebuild: true` 的 repair-only blocked 结果不会设置
   `localArtifactGateRepairBlocked` 或 blocked reason。
5. PASS - 不含 `requiresRealRebuild: true` 的 blocked 结果保持人工阻断
   状态，并通过本轮 blocked set 防止同一 runner invocation 内自旋。
6. PASS - real rebuild 重开后继续使用同一 batch `runId` 和同一 item；
   恢复 runner 使用原始 source identity 推导同一 book identity。
7. PASS - 既有 data compatibility 失败和 provider-auth 失败不会被重分类为
   real-rebuild recoverable。`data_compatibility`、provider status code 和
   provider command failure 会阻止本地 artifact gate repair。
8. PASS - 成功 projection repair 的 metadata 保持严格：包含 repair reason、
   projection、evidence locator、producer run ids，以及
   `normalCommandChecksRequired: true`。缺失 metadata 的 repaired 输出会降级为
   blocked。
9. PASS - events、checkpoints 和 recovery summary 可区分 `repaired`、
   `blocked`、`requires_real_rebuild`。新增字段覆盖 blocked event、
   checkpoint metadata 和 summary schema。
10. PASS - 保留 GraphRAG book-scoped output isolation 和 typed checkpoint
    persistence invariant。artifact/producer 校验仍以 book-scoped output 为
    边界；checkpoint 与 recovery summary schema 已同步类型化字段。

## 阻断问题

未发现阻断问题。

## 建议修复

无需阻断修复。建议合并前保留 `src/contracts/batch-run.ts` 在评审范围内，
因为当前恢复摘要字段扩展与 batch 脚本 schema 必须同步。若需要进一步
防御异常 runner 输出，可补充断言 `repairResult.bookId` 必须等于当前
checkpoint 或 item 的 book id。

## 验证

- PASS: `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/cli.test.ts -t "GraphRAG EPUB batch runner"`
  通过，54 passed。
- PASS: `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-book-state.test.ts -t
  "GraphRAG identity sidecar|text unit identity|book-scoped|query-ready"`
  通过，5 passed。
- PASS: `npm run test:types` 通过。
- 非阻断说明：较宽泛的完整文件/总测试命令分别在 120s 和 240s 超时；
  超时前未观察到相关用例失败，最终以定向审计用例和类型检查作为结论依据。
