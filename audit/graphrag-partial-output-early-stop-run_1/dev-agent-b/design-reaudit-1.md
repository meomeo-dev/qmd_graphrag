# GraphRAG partial-output early stop 设计复审报告

结论：PASS。

## 审计范围

本次复审固定使用
`audit/graphrag-partial-output-early-stop-run_1/dev-agent-b/baseline.md`
中的 10 条基准，基准未变更。复审对象为修订后的
`docs/architecture/graphrag-partial-output-early-stop.md`。

重点复核前次 FAIL 项：

- 失败 attempt 残留 GraphRAG 输出的清理或隔离机制。
- 同一 `runId` retry 时 artifact 采纳语义。
- 旧 completed-item recovery 与 local artifact gate repair 的测试要求。

## 前次 FAIL 复核

1. PASS：失败 attempt 残留输出已有明确处理规则。

   修订文档新增 `Failed Attempt Output`，要求 killed Python process 留下的
   partial files 不能被下一次 successful attempt 采纳。设计规定在重试
   GraphRAG producer stage 前，若同 stage 前一 checkpoint 因 transient 或
   early-stop partial-output marker 失败，必须删除该 stage owned outputs；
   或者使用 attempt-scoped temporary output，并仅在 stage health 与 artifact
   gate 都通过后原子发布。直接复用 book-scoped output 且不清理、不隔离被
   明确判定为不可接受。

2. PASS：同一 `runId` retry 的 artifact 采纳语义已补齐。

   修订文档继续要求下一次同一 `runId` 从 `BookResumePlan.nextStage` 恢复，
   同时新增 stage-owned cleanup 或 attempt-scoped publish 作为同一 stage
   `runId` 复用下的 artifact 边界。这样失败 attempt 输出不会因 producer
   manifest 或后续 artifact scan 被混入成功 attempt。该设计保留既有
   `BookResumePlan` 恢复入口，同时补足前次发现的 attempt 边界缺口。

3. PASS：旧 completed-item recovery 与 local artifact gate repair 测试要求
   已补齐。

   修订文档 `Test Plan` 明确要求 existing recovery non-regression：旧
   completed-item recovery 和 local artifact gate repair tests still pass。
   该要求直接覆盖基准 10。

4. PASS：watcher 接口边界已明确。

   修订文档新增 `Interface Contract`，将 early stop 定义为 TypeScript bridge
   option，而不是 Python bridge request field 或 GraphRAG public contract。
   `stage`、`reportDir`、`logStartOffset`、`outputDir` 和 `logLocator` 作为
   runtime-only bridge option 传递；query、DSPy、qmd search/query 和 Jina
   embedding paths 不接收该 option。该约束避免了修改公共 GraphRAG 请求契约
   或误影响非 index 调用。

## 逐条基准结论

1. PASS。设计继续保留
   `book_id + processing_stage + command_check` 作为 recovery unit。

2. PASS。设计明确 early stop 不是第二状态源，并通过正常 batch checkpoint
   path 持久化 failed command check、retry timing 和 `recoveryDecision`。

3. PASS。heartbeat ownership 仍归外层 batch runner 命令；watcher 属于
   TypeScript bridge child lifecycle，不接管 batch `runnerHeartbeatAt`。
   设计还明确 watcher 不在 batch runner 内实现，不使用 process-name matching
   或 process-group cleanup。

4. PASS。early stop rejection 仍进入正常 `command_failed`、
   `command_retry_scheduled` 和 retry budget 行为，且错误文本保持
   classifier 可识别。

5. PASS。retry budget exhausted 后仍进入 provider recovery wait，要求保持
   `retryable=true`、`retryExhausted=false`、
   `recoveryDecision=retry_same_run_id` 和 `nextRetryAt`。

6. PASS。下一次同一 `runId` run 从 `BookResumePlan.nextStage` 恢复。新增
   cleanup/attempt isolation 规则补足同一 stage `runId` retry 的 artifact
   attempt 边界。

7. PASS。设计现在明确禁止 incomplete partial-output artifacts 被采纳：重试
   前清理 stage-owned outputs，或使用 attempt-scoped temporary output 并在
   health gate 与 artifact gate 后原子发布。

8. PASS。实现边界仍位于 TypeScript bridge adapter；未要求修改
   `vendor/graphrag`。

9. PASS。配置默认安全且 batch 无需用户操作。watcher 是 opt-in runtime
   option，polling 有 bounded default，且不影响 query、DSPy 或其他路径。

10. PASS。测试计划明确要求旧 completed-item recovery 与 local artifact gate
    repair tests 继续通过。

## 残余实现注意事项

- Stage-owned cleanup 的具体文件集合必须与真实 GraphRAG 输出保持一致，且
  删除记录应只包含相对 locator，避免泄露私有路径。
- 如果采用 cleanup 而不是 attempt-scoped publish，必须保证只删除当前 stage
  owned outputs，不删除 prior successful-stage artifacts、catalog、batch
  manifests、command logs 或其他 books。
- 实现测试应覆盖 source runtime 与 built `dist` 两条路径，避免 watcher 只在
  `tsx` 开发路径可用。
