result: PASS

# 第 2 轮复审报告：GraphRAG query-ready recovery reopen

## 结论

本轮按固定基准复审最新修复轮，未发现阻断问题。第 1 轮遗留的
永久 provider 失败混入本地 projection gate 文本后仍进入 repair 的问题已修复：
`canRepairLocalArtifactGate` 已同时排除分类得到的 `providerStatusCode` 和
failed command check 上显式存在的 `providerStatusCode`。

本轮未修改源代码、baseline 或状态文件。验证结果采用 `status.yaml` 中记录的
最新通过项：focused 12 tests、`test/cli.test.ts` 180 tests、
`test/graphrag-book-state.test.ts` 25 tests、`npm run test:types`。

## 逐条基准审计

1. PASS。两条真实 failure text 已被分类为本地 artifact/projection gate，
   且 `failureKind="permanent"`、`retryable=false`。证据见
   `scripts/graphrag/batch-failure-classifier.mjs:47` 至 `52`、
   `scripts/graphrag/batch-failure-classifier.mjs:140` 至 `168`；
   回归测试见 `test/cli.test.ts:1789` 至 `1803`。

2. PASS。`checkpointFailureText` 同时读取 checkpoint 顶层 `errorSummary`
   和 failed command check 的 `errorSummary`，并用 `Set` 去重，避免重复
   文本污染 `repairFailureText`。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:637` 至 `643`；
   `repairFailureText` 使用同一函数生成，证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3251` 至 `3257`。

3. PASS。repair gate 已显式要求 `failed`、`retryable=false`、
   `recoveryDecision="stop_until_fixed"`、命中 local artifact/projection gate，
   并排除 `transient`、`data_compatibility`、分类得到的 provider status code
   和 failed command check 上的 provider status code。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:650` 至 `687`。
   混合 data compatibility 与 local projection 文本的负例见
   `test/cli.test.ts:4010` 至 `4156`；混合 provider failure 与 local
   projection 文本的负例见 `test/cli.test.ts:4158` 至 `4307`。

4. PASS。repair 成功后 checkpoint 写回 `status="pending"`，并设置
   `recoveryDecision="continue_pending"`，未直接写为 `completed`。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3372` 至 `3395`。

5. PASS。repair 成功路径清空旧 `failedAt`、`errorSummary`、`failureKind`、
   `retryable`、`retryExhausted`、`failedStage` 和旧 `commandChecks`，使后续
   command checks 重新建立事实。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3372` 至 `3387`。
   hydration 对已完成 repair 的 pending checkpoint 也清空旧失败事实，证据见
   `scripts/graphrag/batch-checkpoint-hydration.mjs:101` 至 `128`。

6. PASS。batch workflow 层通过 `RepairMetadataSchema` 强校验
   `reopenedFromStatus`、`reopenedToStatus`、`reopenedFromRecoveryDecision`、
   `repairReason`、`repairFailureText`、`repairedProjection`、
   `repairEvidenceLocator`、`reusedProducerRunIds` 和
   `normalCommandChecksRequired=true`。缺字段时转为 blocked，不写 reopened
   checkpoint/event。证据见 `scripts/graphrag/batch-epub-workflow.mjs:130`
   至 `154`、`scripts/graphrag/batch-epub-workflow.mjs:3251` 至 `3309`；
   负例测试见 `test/cli.test.ts:4309` 至 `4450`。

7. PASS。repair blocked 后 checkpoint 保持 `pending/continue_pending`，
   记录 blocked reason，并通过 `repairBlockedThisRun` 防止同一 runner
   invocation 内无限重复 repair。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3312` 至 `3354`、
   `scripts/graphrag/batch-epub-workflow.mjs:3810` 至 `3840`、
   `scripts/graphrag/batch-epub-workflow.mjs:3904` 至 `3908`。

8. PASS。成功 reopen 会写入
   `item_local_artifact_gate_repair_reopened` event，并与 checkpoint 复用同一份
   已校验 `repairMetadata`。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3356` 至 `3370`、
   `scripts/graphrag/batch-epub-workflow.mjs:3387` 至 `3394`。

9. PASS。repair 后不会直接完成 item，而是进入普通 item execution path；
   若普通闭环失败，最终失败反映新的失败阶段。证据见
   `scripts/graphrag/batch-epub-workflow.mjs:3887` 至 `3908`、
   `scripts/graphrag/batch-epub-workflow.mjs:4009` 至 `4040`、
   `scripts/graphrag/batch-epub-workflow.mjs:4041` 至 `4243`。
   回归测试断言 repair 后失败阶段为 `normalize-epub`，见
   `test/cli.test.ts:3980` 至 `4007`。

10. PASS。`--status-json` 路径不写 checkpoint、event log、recovery summary
    或 producer manifest；写入函数在 `statusJson` 下返回内存结果，producer
    manifest 迁移也被跳过。证据见
    `scripts/graphrag/batch-epub-workflow.mjs:853` 至 `879`、
    `scripts/graphrag/batch-epub-workflow.mjs:939` 至 `964`、
    `scripts/graphrag/batch-epub-workflow.mjs:970` 至 `975`、
    `scripts/graphrag/batch-epub-workflow.mjs:1218` 至 `1248`、
    `scripts/graphrag/batch-epub-workflow.mjs:3781` 至 `3785`。
    测试覆盖 checkpoint 内容不变和 recovery summary 不落盘，证据见
    `test/cli.test.ts:2381` 至 `2509`。

## 一致性复核

repair facts 在 checkpoint、event 和 recovery summary 三处一致：成功 reopen
event 与 checkpoint 复用同一份 `repairMetadata`，recovery summary 从 checkpoint
metadata 投影同一组字段。证据见
`scripts/graphrag/batch-epub-workflow.mjs:2525` 至 `2582`、
`scripts/graphrag/batch-epub-workflow.mjs:3356` 至 `3395`；测试见
`test/cli.test.ts:3963` 至 `4001`。
