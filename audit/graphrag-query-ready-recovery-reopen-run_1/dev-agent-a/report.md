result: FAIL

# 审计报告：GraphRAG query-ready recovery reopen

## 阻断发现

1. `data_compatibility` 的 `stop_until_fixed` checkpoint 可能被误送入本地
   artifact/projection repair。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:611` 至 `612`：
     `checkpointHasLocalArtifactGateFailure` 只对拼接后的失败文本执行
     `isLocalArtifactGateFailureText`，没有同时排除已分类的
     `data_compatibility`、provider/network transient，或其他非本地失败。
   - `scripts/graphrag/batch-epub-workflow.mjs:3557` 至 `3566`：
     data compatibility 的停批逻辑只有在
     `!checkpointHasLocalArtifactGateFailure(checkpoint)` 时生效。
     如果同一 checkpoint 的顶层错误或 failed command check 文本中混入
     local artifact gate token，停批会被跳过。
   - `scripts/graphrag/batch-epub-workflow.mjs:3748` 至 `3762`：
     对任何 `status=failed` 且 `retryable=false` 的 checkpoint，只要
     `checkpointHasLocalArtifactGateFailure` 为真就直接执行
     `repairLocalArtifactGate`，未再次校验 inferred failure kind。
   - `scripts/graphrag/batch-checkpoint-hydration.mjs:163` 至 `176` 会从
     checkpoint 顶层错误和 failed command check 错误推断失败类型；但主 runner
     的 repair gate 没有复用该分类结论。

   影响：

   - 违反基准 3。provider/network/data compatibility 失败不得进入本地重开
     （local reopen），但当前主路径可被混合失败文本绕过。
   - 一旦 data compatibility 失败文本和 artifact/projection gate 文本同时存在，
     runner 可能启动 repair-only 子进程，并把应停批的失败改写为
     `pending/continue_pending`。

   建议修复：

   - 将 repair gate 改为显式决策函数，例如
     `canRepairLocalArtifactGate(checkpoint)`。
   - 该函数应同时满足：checkpoint 为 `failed/stop_until_fixed`、
     `retryable=false`、`classifyFailure(checkpointFailureText(checkpoint))`
     结果不是 `transient` 或 `data_compatibility`、且文本命中
     `isLocalArtifactGateFailureText`。
   - 对 `checkpoint.failureKind === "data_compatibility"` 或 inferred
     `failureKind === "data_compatibility"` 的 checkpoint，应优先停批，
     不允许进入 repair。
   - 添加回归测试：顶层错误为 data compatibility、failed command check 含
     query-ready/artifact gate token；以及相反组合。断言没有
     `repair-local-artifact-gate-*` command、没有
     `item_local_artifact_gate_repair_reopened`，batch 仍为
     `stop_until_fixed`。

2. repair 成功 metadata 的必需字段没有在 batch workflow 层强校验。

   证据：

   - `scripts/graphrag/batch-epub-workflow.mjs:3160` 至 `3170`：
     `repairedProjection`、`repairEvidenceLocator`、`reusedProducerRunIds`
     直接从 `repairResult.resume?.*` 透传，可为 `undefined`。
   - `scripts/graphrag/batch-epub-workflow.mjs:887` 至 `891`：
     `writeTypedJson` 会调用 `withoutUndefined` 后落盘，未定义字段会从
     checkpoint/event metadata 中消失。
   - `scripts/graphrag/batch-epub-workflow.mjs:3216` 至 `3254`：
     reopen event 与 reopened checkpoint 都复用同一个未校验的
     `repairMetadata`。
   - `scripts/graphrag/batch-epub-workflow.mjs:337` 至 `379`：
     checkpoint `metadata` 只是自由 JSON record，没有 schema 强制这些
     repair metadata 字段存在。

   影响：

   - 违反基准 6 和 8 的强语义要求。repair 成功后 metadata 和 event log
     “必须包含”同一组 repair metadata；当前实现依赖 repair-only 子进程输出
     完整字段，而 batch 状态机自身不保证。

   建议修复：

   - 在 `repairLocalArtifactGate` 中校验 repair-only 成功输出，缺少
     `repairedProjection`、`repairEvidenceLocator` 或
     `reusedProducerRunIds` 时应视为 repair failed/blocked，不得写
     reopened checkpoint。
   - 为 repair metadata 建立专用 schema 或断言函数，并在 checkpoint 和 event
     写入前统一解析。
   - 添加回归测试：fake repair-only 返回 `status: "repaired"` 但缺少上述字段；
     断言不会生成缺字段的 reopened checkpoint/event。

## 逐条基准审计

1. FAIL。两条 query-ready/projection 文本已被分类为
   `permanent/retryable=false`，证据见
   `batch-failure-classifier.mjs:140` 至 `168` 和
   `test/cli.test.ts:1789` 至 `1803`。但 repair gate 对混合失败文本的边界
   仍不安全，导致本条只能作为分类子项通过，整体受阻断发现 1 影响。

2. PASS。`checkpointFailureText` 同时读取 checkpoint 顶层
   `errorSummary` 和 failed command check 的 `errorSummary`，并用 `Set`
   去重；证据见 `batch-epub-workflow.mjs:602` 至 `608`。

3. FAIL。主 runner 未先排除 data compatibility/provider 类失败，只要拼接文本
   命中 local artifact gate token 即可进入 repair；证据见阻断发现 1。

4. PASS。repair 成功后先返回 `status: "pending"`、
   `recoveryDecision: "continue_pending"`，未直接写 completed；证据见
   `batch-epub-workflow.mjs:3232` 至 `3255`，保存点见 `3761` 至 `3764`。

5. PASS。repair 成功路径清空旧 `failedAt`、`errorSummary`、`failureKind`、
   `retryable`、`retryExhausted`、`failedStage` 和 `commandChecks`；证据见
   `batch-epub-workflow.mjs:3232` 至 `3247`。hydration 对已完成 repair 的
   pending checkpoint 也清空旧事实；证据见
   `batch-checkpoint-hydration.mjs:101` 至 `128`。

6. FAIL。metadata 字段名在代码中被组装，但关键字段可为 `undefined` 并在落盘时
   被删除，缺少强校验；证据见阻断发现 2。

7. PASS。repair blocked 后 checkpoint 保持 `pending/continue_pending`，记录
   blocked reason，并用 `repairBlockedThisRun` 防止同一 runner invocation 内
   重复 repair；证据见 `batch-epub-workflow.mjs:3172` 至 `3214` 和
   `3671` 至 `3700`。

8. FAIL。成功 reopen event 使用同一 `repairMetadata`，且存在
   `item_local_artifact_gate_repair_reopened`；证据见
   `batch-epub-workflow.mjs:3216` 至 `3230`。但 metadata 未强校验，事件也可能
   缺少基准 6 要求的字段；证据见阻断发现 2。

9. PASS。repair 后会回到普通 item execution path；`markItemRunning` 清空旧失败
   字段，后续失败按新 command/stage 写入。证据见
   `batch-epub-workflow.mjs:3432` 至 `3471`、`3870` 至 `3901`、
   `4061` 至 `4088`。测试覆盖普通路径失败为 `normalize-epub`，证据见
   `test/cli.test.ts:3930` 至 `3964`。

10. PASS。`--status-json` 路径不写 checkpoint、event log、recovery summary，
    且跳过 producer manifest 迁移。证据见
    `batch-epub-workflow.mjs:770` 至 `795`、`856` 至 `891`、
    `1135` 至 `1165`、`2411` 至 `2415`、`3642` 至 `3647`。
    测试覆盖 checkpoint 内容不变和 recovery summary 不生成，证据见
    `test/cli.test.ts:2451` 至 `2507`。
