# GraphRAG partial-output early stop 设计审计报告

结论：FAIL。

## 审计范围

审计对象为
`docs/architecture/graphrag-partial-output-early-stop.md`，并固定使用
`audit/graphrag-partial-output-early-stop-run_1__closed/dev-agent-b/baseline.md`
中的 10 条基准。重点审计状态管理（state management）、heartbeat
ownership、retry budget 和同一 `runId` 恢复语义（same-runId resume
semantics）。

## 阻断发现

1. 失败尝试残留产物（residual artifacts）没有明确失效或清理机制。

   设计要求 early stop 后不得发布 GraphRAG artifacts、producer manifests、
   `query_ready` 或 `graph_query` capabilities，并说明下一次同一 `runId`
   会从 `BookResumePlan.nextStage` 重试同一 stage。但是设计没有规定在杀死
   Python bridge 后如何处理当前 stage 已写入磁盘的 parquet、LanceDB 或
   其他部分输出，也没有规定重试前必须清理 stage outputs、隔离 attempt
   output，或以 attempt-scoped marker 阻止旧文件被后续同一 stage `runId`
   采纳。

   该缺口直接影响基准 7，并削弱基准 6。同一 stage `runId` 恢复会使失败
   attempt 与后续 retry attempt 在 artifact producer lineage 上不可区分。
   若 GraphRAG 下次没有完全覆盖旧文件，后续成功路径仍可能在写入 producer
   manifest 后把残留文件记录为当前 stage artifact。现有实现路径显示
   `resume-book-workspace.mjs` 在健康检查后才写 producer manifest 并采纳
   artifact，但设计没有保证早停残留不会在下一次健康通过时被重新采纳。

2. 测试计划没有覆盖基准 10 的回归要求。

   设计文档没有定义必须新增或保留的测试矩阵（test matrix），尤其没有要求
   证明旧 completed-item recovery 与 local artifact gate repair 行为保持
   不变。现有测试中已有这些领域的回归覆盖，但本设计没有把它们列为必须
   保护的验收条件，因此不满足基准 10。

3. watcher 接口边界（interface boundary）定义不足，容易产生实现偏差。

   设计要求 early stop 对带有 `reportDir`、`stage` 和 `logStartOffset` 的
   GraphRAG index 调用 opt-in 生效，但当前 `GraphRagIndexRequest` 只有
   `reportDir`，没有 `stage` 或 `logStartOffset`。设计没有说明这些字段应进入
   public contract、runtime-only options，还是 Python bridge call options。
   这会影响状态归属、测试可观测性和“只扫描当前 stage appended bytes”的
   可验证性。

## 逐条基准结论

1. PASS。设计明确保留
   `book_id + processing_stage + command_check` 作为 recovery unit。

2. PASS。设计明确 early stop 不是第二状态源，并要求通过正常 checkpoint
   path 持久化。

3. PASS。设计要求 batch runner 在命令运行期间保持 ownership 与 heartbeat
   semantics；未发现要求把 heartbeat 转移给 Python bridge watcher。

4. PASS。设计要求错误进入正常 `command_failed`、
   `command_retry_scheduled` 和 retry budget 行为。

5. PASS。设计明确 retry budget exhausted 后进入 provider recovery wait，
   而不是 `stop_until_fixed`。

6. PARTIAL。设计要求下一次同一 `runId` 从 `BookResumePlan.nextStage`
   恢复，但未解决同一 stage `runId` 下失败残留 artifact 的 attempt 边界
   问题。

7. FAIL。设计声明不发布 incomplete artifacts，但没有定义残留输出清理、
   隔离或失效机制，不能证明部分输出不会在后续同一 `runId` retry 中被
   采纳。

8. PASS。设计把方案放在 TypeScript bridge adapter 边界，未要求修改
   `vendor/graphrag`。

9. PASS。设计为 batch 默认路径自动生效，不要求用户额外配置；但 watcher
   polling、bounds 和 failure mode 仍需在实现设计中固定。

10. FAIL。设计没有要求测试证明旧 completed-item recovery 与 local artifact
    gate repair 行为不变。

## 状态管理审计

设计总体遵守现有状态模型：早停错误由 bridge rejection 进入
`resume-book-*` command failure，再由 batch failure classifier 映射为
`retry_same_run_id`。这一点符合 `BatchItemCheckpoint` 单一状态源原则。

主要缺口在 stage output 的状态边界。`BookResumePlan.nextStage` 只能根据
checkpoint 与 artifact gate 判断阶段是否满足；如果失败 attempt 留下可被
后续 producer manifest 关联的文件，仅靠 checkpoint failed 状态不足以永久
阻止这些文件被下一次 retry 采纳。设计需要明确 stage output cleanup、
attempt-scoped output，或 failed-attempt artifact tombstone 之一。

## Heartbeat Ownership 审计

现有 heartbeat ownership 属于外层 batch runner 的 `resume-book-*` 命令，
而不是 Python bridge 子进程。设计中“TypeScript bridge caller owns the
child process”用于说明 kill boundary，不应改变 batch checkpoint 的
`runnerSessionId`、`runnerHost`、`runnerPid` 和 `runnerHeartbeatAt` 语义。

设计已写明 batch runner 必须保持 ownership 和 heartbeat semantics。实现时
应确保 watcher 只终止 Python bridge child，并让 outer `resume-book-*`
命令正常返回非零，以便 heartbeat monitor 由现有 `finally` 路径停止并清理
`currentCommand`。

## Retry Budget 审计

设计明确 early stop 错误文本包含
`GraphRAG stage report partial-output failure`，现有 classifier 可将其归为
retryable transient provider recovery。设计也明确 retry exhaustion 后应保持
`retryable=true`、`retryExhausted=false`、
`recoveryDecision=retry_same_run_id` 和 `nextRetryAt`。

该方向满足 retry budget 基准。实现仍应增加端到端测试，证明 early stop
失败经过 `command_failed`、`command_retry_scheduled` 或
`command_attempt_budget_exhausted`，并最终进入 provider recovery wait。

## 同一 `runId` 恢复审计

设计要求同一 `runId` 的下一次运行读取 checkpoint，并从
`BookResumePlan.nextStage` 重试同一 GraphRAG stage。该语义与现有
`reusableRunIdForStage` 方向一致。

阻断问题是同一 stage `runId` 复用与残留 artifact lineage 相互冲突。若不
引入 attempt 边界，失败 attempt 输出和 retry attempt 输出在 producer
manifest 写入后可能无法区分。设计必须补充“重试同一 stage 前清理当前 stage
outputs”或“产物必须绑定到成功 attempt marker”的规则。

## 建议修复

1. 在设计中新增 failed-attempt output 处理规则：early stop 后必须清理当前
   stage 可写 outputs，或将每次 attempt 写入 attempt-scoped 临时目录，仅在
   stage health 和 artifact gate 都通过后原子发布到 book-scoped output。

2. 明确 watcher option contract：`stage` 与 `logStartOffset` 应作为
   runtime/bridge 层显式 typed option，不能隐式从 `reportDir` 推断；query
   和 DSPy calls 必须保持无 watcher。

3. 增加测试验收矩阵：active log watcher 只扫描新 offset；早停不会解析
   partial stdout；早停失败进入正常 retry budget；retry exhaustion 进入
   provider recovery wait；同一 `runId` 从 `BookResumePlan.nextStage`
   恢复；旧 completed-item recovery 与 local artifact gate repair 不变。

4. 为残留 artifact 增加专门回归测试：构造 killed attempt 留下
   `community_reports.parquet` 或 LanceDB 片段的场景，断言下一次 retry 不会
   在未重新成功生成并通过当前 attempt gate 前发布 producer manifest、
   `query_ready` 或 `graph_query` capability。
