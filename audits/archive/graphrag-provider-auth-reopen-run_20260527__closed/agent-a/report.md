# Provider Auth Reopen 设计审计报告

## 结论

总体结论：不通过（FAIL）。

当前 `scripts/graphrag/batch-epub-workflow.mjs` 已能识别旧 provider auth
failure，并会在进入处理循环前对 `401`、`403`、`INVALID_API_KEY` 等
`stop_until_fixed` 检查点停批。这满足“不要在坏 provider auth 下继续消耗高成本”
的保护目标，但不满足本次目标：在当前 provider 配置指纹变化且密钥存在后，自动、
有界、可审计地把旧 provider auth stop 检查点重开为 `pending` 并真实重跑该书。

当前实现没有 provider auth reopen gate，没有记录失败时 provider fingerprint 的
专用字段，没有 key presence 检查，没有 `item_provider_auth_reopened` 事件，也没有
防止同一 fingerprint pair 无限重开的持久计数。因此用户修复 `graph_vault/.env`
之后，旧 failed item 仍会被 `shouldStopBatchBeforeProcessing` 拦截，batch 会继续
停在 `stop_until_fixed`。

## 审计依据

- `BatchItemCheckpointSchema` 支持 `failed`、`pending`、`completed`、
  `retryable`、`recoveryDecision`、`commandChecks` 和 metadata，但未定义 provider
  auth reopen 专用 metadata 字段。
- `checkpointHasUnrecoverableProviderAuthFailure` 通过 checkpoint 级或 commandCheck
  级 `providerStatusCode` 以及 `invalid api key`、`invalid_api_key`、
  `unauthorized`、`forbidden`、`authentication` 文本识别 provider auth failure。
- `shouldStopBatchAfterFailure` 对 `status=failed`、`retryable=false`、
  `recoveryDecision=stop_until_fixed` 且 data compatibility 或 provider auth 的
  item 返回 true。
- `main` 在处理任何 item 之前调用 `shouldStopBatchBeforeProcessing`，命中后写
  batch stopped 事件并 break，不会尝试恢复该 failed item。
- `statusJson` 路径在 `loadCheckpoint`、`event`、`updateManifest` 中基本保持只读；
  `migrateOnly` 路径只做迁移、summary 和 event，不执行正常 item 运行。
- `runItem` 的 completed 写入要求先执行 normalize、GraphRAG resume/build、27 个
  qmd command checks、graph build 和 graph query checks；这是正确的真实重跑闭环。
- Provider fingerprint 已存在于 book job、stage checkpoint、artifact 和 producer
  manifest 语义中，但现有 batch item checkpoint 未保存 provider auth failure
  发生时的专用 fingerprint，也未比较当前 fingerprint 与旧 fingerprint 后决定重开。
- `loadDotenv` 只加载项目根 `.env` 到当前 Node 进程；GraphRAG 运行时可能依赖
  `graph_vault/.env` 与 `settings.yaml` 同目录加载。恢复 gate 需要验证“运行时将会
  使用的 key present”，而不能假设项目根 `.env` 与 `graph_vault/.env` 一致。

## 逐条审计

| # | 基准 | 结论 | 说明 |
|---|---|---|---|
| 1 | 状态机守卫 | 部分通过 | provider auth stop 已被识别并停批，但没有把该识别用于安全重开。 |
| 2 | fingerprint 与 key presence 双门禁 | 不通过 | 没有比较当前 provider fingerprint 与失败时 fingerprint，也没有 key present gate。 |
| 3 | 失败 fingerprint 追溯兼容 | 不通过 | batch item checkpoint 没有 failure-time provider fingerprint provenance。 |
| 4 | 重开转换保持闭环 | 不通过 | provider auth failed item 没有 failed -> pending 转换。 |
| 5 | 事件与 metadata 可审计 | 不通过 | 没有 provider auth reopen 专用事件或 metadata。 |
| 6 | 幂等与防无限重开 | 不通过 | 没有 fingerprint pair、reopenAttemptCount 或 reopen 上限。 |
| 7 | `status-json` 只读关系 | 部分通过 | 现有只读语义良好，但未投影 provider auth 可重开诊断。 |
| 8 | `migrate-only` 关系 | 部分通过 | 现有 migrate-only 不运行 item，符合边界；但缺少 provider auth metadata 迁移策略。 |
| 9 | 旧 checkpoint schema 兼容 | 不通过 | hydration 可补失败分类，但无法 fail-closed 判断 fingerprint change 与 key presence。 |
| 10 | 真实重跑闭环 | 部分通过 | pending item 会走真实运行闭环；缺失的是把旧 provider auth failed item 安全转为 pending。 |

## 必须修复项

1. 增加 provider auth reopen 判定函数。

   建议新增独立函数，例如 `canReopenProviderAuthCheckpoint(item, checkpoint,
   currentProviderContext)`。该函数必须同时检查：

   - checkpoint 是 `failed`、`retryable=false`、
     `recoveryDecision=stop_until_fixed`。
   - 失败证据是 provider auth failure，来源可为 checkpoint providerStatusCode、
     failed commandCheck providerStatusCode 或 redacted errorSummary。
   - 当前 provider fingerprint 与失败时 provider fingerprint 不同。
   - 当前所需 provider key 环境变量存在且非空。记录值只能是 `present`，不得保存或
     输出实际密钥。
   - 同一旧 fingerprint 到当前 fingerprint 尚未重开过，且未超过有界上限。

2. 在失败 checkpoint 中保存 redacted provider auth provenance。

   当 runtime failure 被写为 non-retryable `stop_until_fixed` 时，metadata 应保存
   可审计字段，例如：

   - `failureProviderFingerprint`
   - `failureProviderFingerprintSource`
   - `failureProviderConfigLocator`
   - `failureProviderKeyRefs`
   - `failureProviderKeyPresence`，值只能是 `present` 或 `missing`
   - `failureProviderAuthDetected=true`

   对旧 checkpoint，hydration 可补 `legacyFingerprintMissing=true`、分类和 status
   code，但不能在缺少旧 fingerprint 且无明确迁移规则时自动重开。

3. 在处理循环前执行 provider auth reopen，且早于停批检查。

   当前 `main` 先查 `shouldStopBatchBeforeProcessing`，因此 provider auth failed item
   没有机会恢复。必须在这一步之前，对 checkpoints 做一次 bounded reopen pass：

   - 命中条件时写 checkpoint 为 `pending`。
   - 更新 manifest 和 recovery summary。
   - 写 `item_provider_auth_reopened` 事件。
   - 然后让普通 pending 分支执行 `markItemRunning` 和 `runItem`。

   该 pass 不得用于 data compatibility stop 或其他 permanent failure。

4. 定义并持久化 reopen metadata。

   checkpoint metadata 至少应包含：

   - `reopenedFromStatus="failed"`
   - `reopenedToStatus="pending"`
   - `reopenedFromRecoveryDecision="stop_until_fixed"`
   - `reopenReason="provider_auth_config_changed_key_present"`
   - `oldProviderFingerprint`
   - `currentProviderFingerprint`
   - `providerConfigChanged=true`
   - `requiredProviderKeys`
   - `providerKeysPresent`
   - `originalFailureKind`
   - `originalProviderStatusCode`
   - `originalFailedStage`
   - `normalCommandChecksRequired=true`
   - `reopenAttemptCount`
   - `reopenFingerprintPair`
   - `reopenedAt`

   `recovery-summary.json` 应投影这些字段，便于 operator 审计。

5. 明确 `status-json` 和 `migrate-only` 语义。

   - `--status-json` 只能输出 projected diagnosis，例如
     `providerAuthReopenEligible=true`、`providerConfigChanged=true`、
     `providerKeysPresent={OPENAI_API_KEY:"present"}`，不得写入 checkpoint、manifest
     或 events。
   - `--migrate-only` 不得触发真实重开或运行。若用于补齐旧 schema 字段，只能写
     migration event 和 metadata，并保持 failed terminal 状态。

6. 防无限重开。

   重跑后如果仍然失败为 provider auth 且当前 fingerprint 没有再次变化，必须保持
   `failed/stop_until_fixed`。只有 fingerprint 再次变化且 key present 时才允许再次
   reopen，并受 `maxProviderAuthReopenAttempts` 或等价常量限制。重复启动同一 runId 不得
   重复写 `item_provider_auth_reopened` 事件。

7. 保持真实重跑验收。

   provider auth reopen 不得直接写 `completed`，不得复用旧失败前的不完整 command
   checks 作为通过证据。成功完成仍必须依赖 `runItem` 中的 normalize、GraphRAG
   resume/build、完整 qmd command checks、graph build 和 graph query checks。

8. 修正 key presence 检查边界。

   因本次修复发生在 `graph_vault/.env`，设计必须检查 GraphRAG 实际 runtime 会读取
   的环境边界。可接受方案包括：

   - 由 batch 在不打印值的前提下解析 `graph_vault/.env` 的 key 名称与非空状态。
   - 或由 GraphRAG resume runner 输出 redacted key presence diagnosis。
   - 或保证 batch 会把 `graph_vault/.env` 中的 key 安全注入子进程。

   不可接受方案是只检查项目根 `.env` 后声称 GraphRAG provider auth 已修复。

9. 增加回归测试。

   至少覆盖：

   - 旧 `401`/`INVALID_API_KEY` failed checkpoint 在 fingerprint changed 且 key
     present 后被重开为 pending 并调用真实 runner。
   - key missing 时不重开。
   - fingerprint unchanged 时不重开。
   - 重开后再次 `401` 且 fingerprint unchanged 时保持 stop，不重复重开。
   - `status-json` 输出诊断但不写文件。
   - `migrate-only` 不运行 item。
   - 事件、checkpoint、recovery summary 和 logs 不包含密钥值。
   - 旧 schema 缺少 providerStatusCode 或 failure-time fingerprint 时 fail-closed。

## 建议项

1. 把 provider auth reopen 与 local artifact gate repair 分开实现。

   现有 local artifact gate repair 有自己的 `canRepairLocalArtifactGate` 和
   metadata schema。Provider auth reopen 应使用独立函数、独立事件名和独立 metadata
   字段，避免把“本地投影修复”和“外部凭据修复后重跑”混成一个恢复语义。

2. 明确 provider fingerprint 的来源优先级。

   建议顺序为：checkpoint metadata 的 failure-time fingerprint、失败 commandCheck
   metadata、book job `providerFingerprint`、producer manifest、stage checkpoint。
   若来源不是 failure-time 记录，应在 metadata 中标记 source 和 confidence，并优先
   fail-closed。

3. 给 operator 输出短诊断。

   `recovery-summary.json` 可以为 provider auth blocked item 显示：
   `blockedReason=provider_auth`、`providerAuthReopenEligible`、
   `providerConfigChanged`、`providerKeysPresent`、`nextAction`。该输出有助于区分
   “还没修好 key”和“已修好但需要写入续跑”。

4. 使用固定 redaction 测试哨兵。

   测试中设置 sentinel key 值后断言 checkpoint、events、stdout、stderr、log root、
   recovery summary 都不包含该值。只允许出现 env var 名称、`present` 和 redacted
   fingerprint。

5. 文档同步。

   `docs/operations/graphrag-epub-resume-boost.md` 和 batch runbook 应补充 provider
   auth reopen 规则：不得手工标 completed；修复 key 后用同 runId 正常续跑；如果
   `status-json` 显示 key present 且 fingerprint changed，写入 runner 会自动重开并
   真实重跑。

## 推荐设计形状

建议在 `loadCheckpoint` 之后、`shouldStopBatchBeforeProcessing` 之前构建当前
provider context：

- 从 `.qmd/index.yml`、managed `graph_vault/settings.yaml` 和 runtime defaults 计算
  当前 provider fingerprint，复用现有 provider boundary fingerprint 语义。
- 根据当前配置解析所需 provider env refs，例如 OpenAI 和 Jina 的 key env 名称。
- 只记录每个 key 是否 `present`。
- 对每个 checkpoint 调用 `maybeReopenProviderAuthCheckpoint`。
- 命中后写 checkpoint、manifest、summary 和 `item_provider_auth_reopened` event。
- 后续不走特殊完成路径，只让 item 作为普通 pending item 进入 `runItem`。

该设计可以保留当前 fail-fast stop 语义：如果 key 未修复、fingerprint 未变化或再次
失败，batch 仍然停止；只有可审计地证明 provider 配置边界变化且 key present 时才
开放一次真实重跑机会。
