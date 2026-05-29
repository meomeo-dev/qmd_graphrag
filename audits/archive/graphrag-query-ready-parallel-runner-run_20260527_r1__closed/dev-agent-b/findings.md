# 实施审计发现

## 结论

审计状态：pass。

本轮复审确认，前次阻塞项 F-001 已修复。`repair-only` 返回
`requiresRealRebuild=true` 后，batch runner 不再把该状态归入 provider recovery
wait，而是写入 `continue_pending`，清除 retry window，并在同一 runner invocation
中进入普通 `resume-book-*` 真实 GraphRAG rebuild 路径。

## 已关闭阻塞项

### F-001 repair-only real rebuild 被误归入 provider recovery wait

- Severity: High
- Blocking: No, resolved
- 状态：closed
- 范围：`resume-book-workspace` query_ready repair handling；真实 batch 状态恢复安全性。
- 主要位置：
  - `scripts/graphrag/batch-epub-workflow.mjs:792`
  - `scripts/graphrag/batch-epub-workflow.mjs:3851`
  - `scripts/graphrag/batch-epub-workflow.mjs:4885`
  - `scripts/graphrag/batch-epub-workflow.mjs:4935`
  - `test/cli.test.ts:4782`

修复后的实现满足以下不变量：

1. `requiresRealRebuild=true` 的 local artifact gate blocked checkpoint 使用
   `status=pending`、`retryable=false`、`recoveryDecision=continue_pending`。
2. 该 checkpoint 不写入 provider retry window，不设置 `nextRetryAt`，
   不设置 `retryDelaySeconds`。
3. metadata 中保留
   `localArtifactGateRepairRequiresRealRebuild=true` 和
   `localArtifactGateRepairRebuildStage`，用于后续观测和避免重复 repair-only。
4. `canRepairLocalArtifactGate()` 对已经标记真实重建需求的 checkpoint 返回
   `false`，防止同一 item 在 repair-only 与 rebuild 之间循环。
5. 后续调度进入普通 `resume-book-1` 路径，由真实 GraphRAG rebuild 重新产出
   producer evidence；失败时仍按真实 command failure fail-closed。

对应回归测试：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 \
  test/cli.test.ts \
  -t "repair-only blocked can reopen a real GraphRAG rebuild"
```

测试断言覆盖：

- repair-only 先被调用一次；
- 普通 `resume-book-1` 随后被调用一次；
- 不产生 `item_local_artifact_gate_repair_blocked_skip`；
- 不进入 `item_provider_recovery_wait`；
- checkpoint 保留真实重建 metadata；
- recovery summary 投影真实重建 stage。

## 已核验通过项

1. Batch checkpoint hydration 对 legacy repair-only blocked loop 进行受限恢复：
   event-proven 或 repair-command-proven `did not reach ready after 24 passes`
   可从 failed 调整为 pending；非 repair 命令不触发 hydration。
2. Query-ready producer gate 文本被归为 local artifact gate：
   `query_ready requires completed graph_extract` 不再停留在 generic unknown。
3. Provider auth/transient 分类优先于 local artifact repair：
   provider HTTP status code、transient 和 data compatibility failure 不进入
   local artifact repair。
4. Repair-only 入口不调用 GraphRAG query 高成本路径：
   `--repair-local-artifact-gate-only` 只执行 projection/lineage repair 检查。
5. 普通 local artifact gate blocked 不进入 24 pass 循环：
   blocked repair 立即返回，且同轮重复尝试会写入可观测 skip 事件。
6. Completed checkpoint 必须重新验证 qmd build、GraphRAG build、GraphRAG query
   和固定 command checks，不通过删除 output 或手改状态得到成功。
7. Fresh remote running 不被 `--status-json` 或普通 runner 抢占；stale running
   恢复带有审计 metadata。
8. Query-ready 发布 fail-closed：
   `query_ready=succeeded` 写入前必须验证 producer stage、artifact lineage
   和 graph identity。

## 验证

已执行专项验证：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 \
  test/cli.test.ts \
  -t "local artifact gate|query-ready projection|generic stop-until-fixed|provider recovery decisions typed|real GraphRAG rebuild"
```

结果：6 个相关 tests 通过。

补充验证：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts
```

结果：51 个 tests 通过。

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 \
  test/integrations/contracts.test.ts -t "Data bus contracts"
```

结果：24 个相关 tests 通过。
