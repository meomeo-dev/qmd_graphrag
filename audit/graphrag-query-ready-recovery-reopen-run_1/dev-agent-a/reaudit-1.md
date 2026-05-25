result: FAIL

# 复审报告：GraphRAG query-ready recovery reopen 修复轮

## 阻断发现

1. 永久 provider 失败混入本地 projection gate 文本时，仍可能进入本地
   repair。

   证据：

   - `scripts/graphrag/batch-failure-classifier.mjs:21` 至 `31`：
     provider `4xx` 文本会被分类为 `failureKind="permanent"`、
     `retryable=false`，并携带 `providerStatusCode`。
   - `scripts/graphrag/batch-epub-workflow.mjs:637` 至 `647`：
     repair gate 使用 checkpoint 顶层错误和 failed command check 错误的
     合并文本判断是否命中 local artifact/projection gate。
   - `scripts/graphrag/batch-epub-workflow.mjs:659` 至 `676`：
     `canRepairLocalArtifactGate` 已校验 `failed`、`retryable=false`、
     `stop_until_fixed`、local gate token，并排除 `transient` 与
     `data_compatibility`；但未排除 `providerStatusCode != null` 的永久
     provider 失败，也未检查 checkpoint 或 failed command check 上已有的
     `providerStatusCode`。

   影响：

   - 违反基准 3 中 provider 失败不得进入本地重开的要求。
   - 例如顶层错误为 `HTTP 401` 或 `status_code=401` 的 provider 失败，
     failed command check 又含
     `GraphRAG document identity is missing for query_ready` 时，
     `classifyFailure` 会返回 `permanent/retryable=false`，当前 gate
     不会拒绝，可能启动 `repair-local-artifact-gate-*` 并改写 checkpoint。

   建议修复：

   - 在 `canRepairLocalArtifactGate` 中显式拒绝
     `checkpointClassifiedFailure(checkpoint).providerStatusCode != null`。
   - 同时拒绝 checkpoint 顶层或 failed command check 已存在
     `providerStatusCode` 的 checkpoint，避免旧状态绕过文本分类。
   - 增加回归测试：provider `4xx` 顶层错误混入 query-ready projection
     文本、以及相反组合；断言不出现
     `item_local_artifact_gate_repair`、不执行
     `repair-local-artifact-gate-*`，checkpoint 保持
     `failed/stop_until_fixed` 或按 provider 策略停止。

## 逐条基准审计

1. PASS。两条真实 failure text 已被稳定识别为本地
   artifact/projection gate，分类结果为 `permanent` 且 `retryable=false`。
   证据见 `scripts/graphrag/batch-failure-classifier.mjs:140` 至 `168`，
   测试见 `test/cli.test.ts:1789` 至 `1803`。

2. PASS。`checkpointFailureText` 同时读取 checkpoint 顶层
   `errorSummary` 和 failed command check 的 `errorSummary`，并通过
   `Set` 去重，避免重复污染 `repairFailureText`。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:637` 至 `643`，
   `repairFailureText` 使用该结果，证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3237` 至 `3248`。

3. FAIL。`data_compatibility` 与 transient 混合 local projection 文本的
   repair 入口已被排除，但永久 provider 失败仍未排除。证据见阻断发现 1。

4. PASS。repair 成功后 checkpoint 写回 `pending`，并设置
   `recoveryDecision="continue_pending"`，未直接写为 `completed`。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3362` 至 `3372`。

5. PASS。repair 成功路径清空旧 `failedAt`、`errorSummary`、
   `failureKind`、`retryable`、`retryExhausted`、`failedStage` 和
   `commandChecks`。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3362` 至 `3377`。
   hydration 对已完成 repair 的 pending checkpoint 也清空旧失败事实，
   证据见 `scripts/graphrag/batch-checkpoint-hydration.mjs:101` 至 `128`。

6. PASS。batch workflow 层新增 `RepairMetadataSchema`，强制
   `reopenedFromStatus`、`reopenedToStatus`、
   `reopenedFromRecoveryDecision`、`repairReason`、`repairFailureText`、
   `repairedProjection`、`repairEvidenceLocator`、`reusedProducerRunIds`
   和 `normalCommandChecksRequired=true`。缺字段时转为 blocked，
   不写 reopened checkpoint/event。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:130` 至 `154`、
   `scripts/graphrag/batch-epub-workflow.mjs:3242` 至 `3300`，
   测试见 `test/cli.test.ts:4158` 至 `4298`。

7. PASS。repair blocked 后 checkpoint 保持
   `pending/continue_pending`，记录 blocked reason，并通过
   `repairBlockedThisRun` 防止同一 runner invocation 内重复 repair。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3302` 至 `3344`、
   `scripts/graphrag/batch-epub-workflow.mjs:3800` 至 `3829`、
   `scripts/graphrag/batch-epub-workflow.mjs:3889` 至 `3898`。

8. PASS。成功 reopen 会写入
   `item_local_artifact_gate_repair_reopened` event，并与 checkpoint 复用
   同一个已校验 `repairMetadata`。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3346` 至 `3360`、
   `scripts/graphrag/batch-epub-workflow.mjs:3377` 至 `3383`。

9. PASS。repair 后不会直接完成 item，而是通过下一轮普通 item execution
   path 重新执行；普通闭环失败会写入新的失败阶段。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3890` 至 `3898`、
   `scripts/graphrag/batch-epub-workflow.mjs:3999` 至 `4030`、
   `scripts/graphrag/batch-epub-workflow.mjs:4190` 至 `4225`。
   回归测试断言 repair 后失败阶段为 `normalize-epub`，见
   `test/cli.test.ts:3980` 至 `4007`。

10. PASS。`--status-json` 路径不写 checkpoint、event log、recovery
    summary 或 producer manifest；相关写入函数在 `statusJson` 下返回内存
    结果，producer manifest 迁移也被跳过。证据见
    `scripts/graphrag/batch-epub-workflow.mjs:843` 至 `869`、
    `scripts/graphrag/batch-epub-workflow.mjs:929` 至 `965`、
    `scripts/graphrag/batch-epub-workflow.mjs:1211` 至 `1238`、
    `scripts/graphrag/batch-epub-workflow.mjs:2484` 至 `2488`、
    `scripts/graphrag/batch-epub-workflow.mjs:3771` 至 `3775`。

## 验证说明

状态文件记录的 focused tests、producer manifest tests 与 typecheck 均已通过。
本轮复审未修改源代码、baseline 或状态文件。
