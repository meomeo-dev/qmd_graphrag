# 实施汇总

## 结论

本轮实施审计通过。真实 batch 已越过本次 query_ready producer lineage gate，
本审计目录关闭为 `__closed`。

## 修复内容

1. Producer lineage recovery 采用当前 checkpoint 优先规则，旧 succeeded producer
   run record 不再覆盖当前 running、pending、failed 或 abandoned high-cost
   checkpoint。
2. Graph query capability 发布前检查当前 producer checkpoints；任一 producer
   checkpoint 非成功时不发布 capability。
3. `query_ready` 继续 fail-closed，只在 `graph_extract`、`community_report`
   和 `embed` 均具备当前成功 checkpoint 与 artifact evidence 时完成。
4. 目标错误文本进入 local artifact gate / producer lineage recovery 分类，不再作为
   generic unknown 永久阻塞整个 batch。
5. `requiresRealRebuild=true` 不再进入 provider recovery wait，而是记录
   `continue_pending` 并进入普通 GraphRAG rebuild。
6. parallel runner 仅形成设计边界；当前生产 runner 仍为单 writer。未来并行化必须先有
   item lease、book lease、provider semaphore、writer lane、fencing token 和 event
   aggregation。

## 验证

已通过：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 \
  test/cli.test.ts \
  -t "local artifact gate|query-ready projection|generic stop-until-fixed|provider recovery decisions typed|real GraphRAG rebuild"
```

已通过：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts
```

已通过：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 \
  test/integrations/contracts.test.ts -t "Data bus contracts"
```

已通过：

```bash
node --check scripts/graphrag/resume-book-workspace.mjs
node --check scripts/graphrag/batch-epub-workflow.mjs
node --check scripts/graphrag/batch-failure-classifier.mjs
node --check scripts/graphrag/batch-checkpoint-hydration.mjs
npm run test:types
git diff --check
```

## 下一步

使用同一 `runId` 恢复真实 batch。执行恢复时必须清除 shell 中的 provider 环境变量，
让项目 dotenv 解析路径接受真实验证。

## 关闭证据

真实 runner 使用同一 `runId` 恢复后，`Code Complete, Second Edition (Steve
McConnell [Steve McConnell]).epub` 的 local artifact gate repair 已成功：

- checkpoint status：`pending`。
- recoveryDecision：`continue_pending`。
- repairedProjection：`graph_capability`。
- `localArtifactGateRepairCompleted=true`。
- repair metadata 记录已复用的 `graph_extract`、`community_report`、`embed` 和
  `query_ready` producer run ids。
