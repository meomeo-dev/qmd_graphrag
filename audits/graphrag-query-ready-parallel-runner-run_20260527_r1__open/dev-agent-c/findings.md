# 实施审计发现

## 结论

审计状态：pass。

复审确认，前次 C-BLOCKER-001 与 C-BLOCKER-002 已通过设计收敛、代码修复和
回归测试关闭。当前正式 runner 仍是单 writer（single writer），不会把多个无协调
runner 作为可用能力；producer lineage recovery 已保持 `query_ready`
fail-closed，并使可修复的 local artifact gate 不再阻断整个 batch 的恢复调度。

## 已关闭阻塞项

### C-BLOCKER-001：多 runner 并发边界不清

- Severity: High
- Blocking: No, resolved
- 状态：closed
- 主要证据：
  - `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
  - `docs/operations/graphrag-epub-batch-runbook.md`
  - `docs/operations/graphrag-epub-resume-boost.md`

当前文档已明确：

- production writer 仍为每个 batch run 一个 runner；
- 多个无协调 writer 不能同时处理同一 `runId`；
- 并行化应先实现单进程 worker pool，而不是直接启用多个 OS 进程；
- 未来最小控制面必须包括 item lease、book lease、provider semaphore、
  catalog writer lane、qmd index writer lane、fencing token 和 event
  aggregation。

该结论回答了用户关于“Jina 等待时 OpenAI/ChatGPT 资源闲置”的设计问题：
当前不能安全启动多个 runner；后续应在一个 coordinator 进程内用 worker pool 和资源
semaphore 解耦 Jina/OpenAI/qmd lane，避免 writer 竞争。

### C-BLOCKER-002：book-stage producer lineage 恢复分类不足

- Severity: High
- Blocking: No, resolved
- 状态：closed
- 主要证据：
  - `docs/architecture/graphrag-producer-lineage-recovery.type-dd.yaml`
  - `src/job-state/repository.ts`
  - `src/graphrag/capability-catalog.ts`
  - `scripts/graphrag/batch-failure-classifier.mjs`
  - `scripts/graphrag/batch-epub-workflow.mjs`
  - `test/book-job-state.test.ts`
  - `test/cli.test.ts`
  - `test/integrations/contracts.test.ts`

修复后的 producer lineage recovery 规则为：

- 当前非成功 high-cost producer checkpoint 胜过旧 succeeded run record；
- Graph query capability 不从当前非成功 producer checkpoint 暴露；
- `query_ready` 只接受当前 `graph_extract`、`community_report` 和 `embed`
  均成功且 artifact evidence 完整的 producer lineage；
- 目标错误文本
  `query_ready requires completed graph_extract, community_report and embed stages`
  被分类为 local artifact gate / producer lineage recovery，而不是 unknown；
- repair-only 可以复核 projection/lineage，无法证明安全复用时返回
  `requiresRealRebuild=true`，由普通 GraphRAG rebuild 重新产出上游 stage。

## 非阻塞项状态

### C-NONBLOCK-001：未来 provider lane 资源控制

- Severity: Medium
- Blocking: No
- 状态：covered by design

`graphrag-parallel-runner.type-dd.yaml` 已把 provider semaphore、writer lane、
fencing 和 event aggregation 列为最小控制面。当前不启用多 runner，因此该项不阻塞
恢复真实批处理。

### C-NONBLOCK-002：压缩后恢复索引

- Severity: Medium
- Blocking: No
- 状态：covered by runbook/boost

`graphrag-epub-resume-boost.md` 已固定当前 runId、open audit 目录、失败 item
特征、状态命令和恢复命令；runbook 记录 status-json、event log 与 provider recovery
观测字段。该项不阻塞继续恢复真实 batch。

## 验证

已执行：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 \
  test/cli.test.ts \
  -t "local artifact gate|query-ready projection|generic stop-until-fixed|provider recovery decisions typed|real GraphRAG rebuild"
```

结果：6 个相关 tests 通过。

已执行：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts
```

结果：51 个 tests 通过。

已执行：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 60000 \
  test/integrations/contracts.test.ts -t "Data bus contracts"
```

结果：24 个相关 tests 通过。
