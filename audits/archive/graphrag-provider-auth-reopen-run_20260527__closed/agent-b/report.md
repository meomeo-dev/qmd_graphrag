# Provider Auth Reopen 设计审计报告

## 结论

不通过。

目标行为方向正确，但当前方案和现有实现尚未充分满足可审计
reopen/retry 机制。现有代码会把 provider 401/403 失败作为
stop_until_fixed，并在处理其他 item 前停止批处理。仓库中可见的 reopen
路径主要服务于本地 GraphRAG projection 与 artifact gate 修复；未看到
等价的 provider-auth 配置指纹门禁重开路径。

该设计需要补齐 secret-safe、fingerprint-gated、idempotent、
summary-consistent 的 provider-auth reopen 阶段，并明确排除
status-json 与 migrate-only 执行边界后，才可通过。

## 证据摘要

- `scripts/graphrag/batch-failure-classifier.mjs:21` 至 `31` 将所有 4xx
  provider status code 分类为 permanent 且不可重试。
- `scripts/graphrag/batch-epub-workflow.mjs:748` 至 `761` 通过 401/403 与
  auth 相关文本识别 provider auth failure。
- `scripts/graphrag/batch-epub-workflow.mjs:4331` 至 `4338` 使
  provider-auth stop_until_fixed checkpoint 停止批处理。
- `scripts/graphrag/batch-epub-workflow.mjs:4466` 至 `4475` 在处理 pending
  item 前检查 stop condition，因此旧 auth 失败会阻止 resume。
- `scripts/graphrag/batch-epub-workflow.mjs:3844` 至 `4016` 展示了本地
  artifact gate reopen 的结构：metadata、失败字段清理和 event 记录均
  已有模式，但该路径排除 provider-auth failure。
- `scripts/graphrag/batch-epub-workflow.mjs:3001` 至 `3060` 维护 manifest
  计数一致性，并在 status-json 模式中避免 manifest 写入。
- `scripts/graphrag/batch-epub-workflow.mjs:3086` 至 `3218` 构造 recovery
  summary projection，并以 status-json 输出而非直接写 summary。
- `scripts/graphrag/batch-epub-workflow.mjs:4432` 至 `4435` 在 status-json
  后返回；当前 main flow 会先调用 updateManifest，其安全性依赖
  updateManifest 内部的 statusJson 写入门禁。
- `scripts/graphrag/batch-epub-workflow.mjs:4436` 至 `4456` 允许
  migrate-only migration 写入；该路径不得扩展为 provider-auth reopen
  或真实执行。
- `src/contracts/batch-run.ts:77` 至 `122` 与 `216` 至 `255` 提供弹性
  metadata 表面，但未类型化 provider-auth reopen 专用字段。
- `test/cli.test.ts:5677` 至 `5874` 与 `5876` 至 `6035` 验证了
  provider-auth failure 会在后续 book 前停止，但没有 changed-fingerprint
  reopen fixture。

## 基准审计结果

1. 安全与脱敏边界：部分满足
   现有 event 与 summary 路径会对 error text 做 redaction，provider
   request fingerprint catalog 也声明为 redacted。新设计仍必须增加硬性
   规则：provider readiness 与 fingerprinting 不得持久化原始配置值，
   也不得暴露可推断 secret 内容的字段。

2. Provider 可用性门禁：缺失
   当前 stop path 能识别 provider auth failure，但没有在状态变更前验证
   当前 provider 配置可用。若仅凭文件变化或 fingerprint 变化 reopen，
   可能在 provider 配置仍不可用时重复启动高成本 qmd/GraphRAG 工作。

3. 指纹变更门禁：缺失
   GraphRAG artifact 与 book state 已携带 providerFingerprint，但 batch
   checkpoint 没有记录 lastProviderAuthFailureFingerprint 或
   lastProviderAuthReopenFingerprint。因此“不同于上次失败且不同于上次
   重开”的不变量目前无法对旧 provider-auth checkpoint 强制验证。

4. 幂等重开语义：缺失
   若没有 last reopen fingerprint，用户修复一次配置后，重复调用可能
   反复清理失败字段并重启工作。设计必须让 same-fingerprint invocation
   成为 no-op，并给出 audit event 或 summary reason。

5. 状态迁移正确性：部分满足
   本地 artifact gate repair 已展示正确机械形态：failed 到 pending、
   清理 failedAt/errorSummary/failure 字段、重置 command checks，并保留
   metadata。provider-auth reopen 不能复用 local repair reason 字段，
   因为 auth repair 保护的是不同不变量。

6. 批处理调度语义：缺失
   pre-loop stop check 当前早于任何 provider-auth reopen 决策执行。除非
   reopen 阶段先于该 check，否则旧 failed auth checkpoint 仍会阻塞
   pending books。

7. Manifest 与 summary 一致性：部分满足
   updateManifest 与 buildRecoverySummary 提供了强一致性落点。缺失部分是
   provider-auth reopen metadata 在 checkpoint 与 recovery summary schema
   中的类型化投影，以及 failed-to-pending 后的 manifest count 测试。

8. 闭环真实执行要求：部分满足
   现有 completed 判定需要 command checks、qmd evidence 与 GraphRAG
   evidence。provider-auth reopen 设计必须显式保持该门禁，不能用
   readiness 或 reopen metadata 标记完成。

9. 模式边界正确性：部分满足
   status-json 设计目标是无工作输出 typed payload，migrate-only 与正常
   执行路径分离。provider-auth reopen 必须放在 status-json 与
   migrate-only return 之后，或用显式 mode guard 保护，否则状态查询或
   migration 可能改变调度状态。

10. 可测试性与旧 run resume 覆盖：缺失
    现有测试证明 stop-before-next-book 与本地 projection reopen，但没有
    证明 provider-auth reopen、changed fingerprint gate、unchanged
    fingerprint refusal、legacy checkpoint 处理、status-json no-write、
    migrate-only boundary，或 reopen 后真实 qmd/GraphRAG execution。

## 必须修复项

1. 在第一次 stop_until_fixed 预处理检查前增加显式 provider-auth reopen
   decision stage。

   该阶段只检查 retryable=false、recoveryDecision=stop_until_fixed 且具有
   provider-auth evidence 的 failed checkpoint。它必须先于
   `shouldStopBatchBeforeProcessing` 可中断主循环的位置执行。它不得重开
   data_compatibility、本地 artifact gate 或 unknown permanent failure。

2. 定义类型化 provider-auth reopen metadata。

   checkpoint、event 与 summary 应至少包含：
   providerAuthReopenVersion、providerAuthReopenReason、
   providerAuthReadinessStatus、currentProviderConfigPresent、
   currentProviderFingerprint、lastProviderAuthFailureFingerprint、
   lastProviderAuthReopenFingerprint、reopenedFromStatus、reopenedToStatus、
   reopenedFromRecoveryDecision、reopenedFailedStage、reopenedAt、
   providerAuthReopenAttemptCount。

   这些字段只能包含 present、fingerprint、change、readiness 值，不得包含
   原始 provider 配置。

3. 在新 auth 失败发生时记录 auth-failure fingerprint。

   新 401/403 失败应在 checkpoint metadata 与 event 中持久化 redacted
   provider boundary fingerprint。对于缺少该值的 legacy failure，设计
   必须选择一个可审计行为：

   - 阻塞 reopen，并记录 reason
     `missing_last_provider_auth_failure_fingerprint`。
   - 仅在可从可信历史记录中推导 redacted fingerprint 且不读取 secret 的
     情况下，允许一次性 migration。

   对缺少可比较历史 fingerprint 的 legacy failure 静默 reopen 不满足
   需求不变量。

4. 同时强制两个 fingerprint comparison。

   当前 fingerprint 必须不同于 last auth-failure fingerprint，也必须
   不同于 last auth-reopen fingerprint。若任一 comparison 相等或未知，
   item 必须保持 failed，batch 必须保持 stop_until_fixed，并在 summary
   中提供 redacted reason。

5. 在状态突变前要求 provider readiness。

   readiness check 必须发生在清理失败字段前。readiness 失败时 checkpoint
   必须保持 failed，只产生 redacted event 或 summary projection。
   readiness 应基于结构和 provider boundary，不得暴露 secret values。

6. 保证 reopen transition 原子且幂等。

   对每个 reopened item，应以一致顺序写 checkpoint、更新 manifest counts、
   写 recovery summary、追加 provider-auth reopen event。之后使用相同
   current fingerprint 的 invocation 不得改变 item state；正常模式最多
   追加 no-op event，status-json 模式只能输出 read-only projection。

7. 只清理调度失败字段。

   有效 reopen 时设置 status=pending，并将 recoveryDecision 设为
   continue_pending，除非设计能证明 retry_same_run_id 更合适。清理
   failedAt、errorSummary、failureKind、retryable、retryExhausted、
   failedStage、nextRetryAt、retryDelaySeconds 与 commandChecks。历史 auth
   failure evidence 必须保存在 metadata 与 events 中。

8. 保留正常 qmd 与 GraphRAG 验收门禁。

   Reopen metadata 不得满足 qmdBuildStatus、graphBuildStatus、
   graphQueryStatus 或固定 command-check set。下一次正常执行必须运行 qmd
   并 resume GraphRAG，且只有相同 evidence gate 通过后才能 completed。

9. 保持 status-json 只读。

   status-json 不得写 checkpoint、manifest、recovery-summary、events、
   migrated manifests 或 raw log migrations。测试应比较 provider-auth
   stopped run 在 status-json 前后的 file mtime 或 content hash。

10. 保持 migrate-only 不参与 provider-auth reopen。

    migrate-only 可以执行 schema backfill 或 raw log/output manifest 迁移，
    但不得执行会改变 item scheduling 的 provider readiness check，不得
    reopen provider-auth failure，也不得执行 qmd 或 GraphRAG。

## 建议设计形态

增加窄边界函数，例如
`reopenProviderAuthFailuresAfterConfigChange(items, checkpoints, manifest)`。
调用点应位于 checkpoint load 与 manifest refresh 后，但必须在
status-json 与 migrate-only 返回之后，或由显式 mode guard 保护。

每个 candidate item 的流程：

- 确认 status=failed、retryable=false、recoveryDecision=stop_until_fixed，
  且 provider-auth evidence 来自 providerStatusCode 401/403 或分类后的
  auth text。
- 解析当前 provider readiness 与当前 redacted provider boundary
  fingerprint。
- 比较 current fingerprint 与 lastProviderAuthFailureFingerprint、
  lastProviderAuthReopenFingerprint。
- 若 readiness 不可用、fingerprint 缺失或 fingerprint 未变化，则保持
  failed，并输出 redacted blocked/no-op reason。
- 若所有门禁通过，则将 checkpoint 改写为 pending，清理调度失败字段，
  清空 commandChecks，设置 recoveryDecision=continue_pending，并加入
  provider-auth reopen metadata。
- 追加专用 event，例如 `item_provider_auth_reopened`。
- 正常模式下重新运行 updateManifest 并写 recoverySummary。

## 必需测试矩阵

- 新 provider 401 failure 记录 redacted auth-failure fingerprint，并在后续
  pending item 前停止。
- 同一 run 在 provider config repair 且 changed fingerprint 后，将 failed
  item reopen 为 pending，并启动正常 qmd/GraphRAG execution。
- current fingerprint 等于 last failure fingerprint 时，item 保持 failed，
  recoveryDecision 保持 stop_until_fixed。
- current fingerprint 等于 last reopen fingerprint 时，行为幂等且不重启
  work。
- 缺少当前 provider readiness 时，item 保持 failed 且输出 redacted reason。
- 缺少历史 fingerprint 的 legacy failed item 遵循显式策略，不得静默
  reopen。
- 混合 run 中，一个 provider-auth item 被 reopen、另一个 item 为 pending
  时，manifest failedItems/pendingItems 与 summary counts 一致。
- 对 provider-auth stopped run 执行 status-json 时，只输出 projected
  decision，不改变任何持久化文件。
- 对 provider-auth stopped run 执行 migrate-only 时，只执行 migration
  writes，不 reopen、不执行工作。
- reopened item 未通过正常 command checks、qmdBuildStatus、
  graphBuildStatus 与 graphQueryStatus 前不能 completed。

## 建议项

- 将 provider-auth reopen metadata 加入 `src/contracts/batch-run.ts` 的类型
  表达，而不是只依赖 untyped metadata record。
- 在 `catalog/data-bus.catalog.yaml` 增加 provider-auth reopen notes，与现有
  local projection reopen notes 保持并列。
- 使用可区分 blocked、no-op 与 successful reopen 的 event name：
  `item_provider_auth_reopen_blocked`、
  `item_provider_auth_reopen_noop`、
  `item_provider_auth_reopened`。
- 保持旧 failure text redacted 且有长度限制；机器判断应使用 metadata
  reason code，而非依赖 message text。
- 增加小型 invariant helper，校验不可能的 reopened state，例如存在
  reopenedToStatus 但缺少 currentProviderFingerprint，或 same-fingerprint
  reopen 却清理了失败字段。
