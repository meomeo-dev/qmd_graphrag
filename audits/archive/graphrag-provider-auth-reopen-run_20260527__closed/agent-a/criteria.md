# Provider Auth Reopen 设计审计基准

## 范围

本基准用于审计 `scripts/graphrag/batch-epub-workflow.mjs` 中 provider
authentication stop checkpoint 的恢复设计。目标是：当当前 provider 配置指纹
（provider configuration fingerprint）变化且所需密钥存在（key present）
时，将旧的 provider auth `stop_until_fixed` 检查点重开为 `pending`，记录可审计
事件和 metadata，然后真实重新运行该书。禁止人工将书标记为 `completed`。

## 10 条基准

1. 状态机守卫（state-machine guard）

   只有满足以下条件的 item 可被重开：`status=failed`、
   `retryable=false`、`recoveryDecision=stop_until_fixed`，且失败证据明确为旧
   provider auth failure，例如 checkpoint 或失败 commandCheck 中存在 `401`、
   `403`、`INVALID_API_KEY`、`unauthorized`、`forbidden` 或认证失败文本。其他
   permanent、data compatibility、local artifact gate、unknown failure 不得被该
   机制重开。

2. 当前配置变化与密钥存在双门禁（fingerprint-and-presence gate）

   重开必须同时证明当前 provider request boundary/config fingerprint 与失败时
   记录的 fingerprint 不同，并证明当前所需 provider key 环境变量存在且非空。
   证明只能保存为 `present`、env var 名称、红acted fingerprint 或 change flag；
   不得保存或输出密钥值、可逆密钥 hash、raw `.env` 内容或 provider payload。

3. 失败时 fingerprint 追溯兼容（failure fingerprint provenance）

   新失败与旧检查点都必须能关联 provider fingerprint。优先使用 checkpoint
   metadata 中的 failure-time provider fingerprint；缺失时可从 book job、
   stage checkpoint、producer manifest 或命令上下文推导，并在 metadata 中记录
   `fingerprintSource` 和 `legacyFingerprintMissing=true`。无法得到旧 fingerprint
   时不得自动重开，除非设计明确把它作为一次人工确认的 schema migration，并仍然
   不得跳过真实重跑。

4. 重开转换保持闭环（reopen transition integrity）

   重开只能把 item 从 `failed` 转为 `pending`，设置
   `recoveryDecision=continue_pending` 或等价的可运行决策，清除
   `failedAt`、`nextRetryAt`、`retryDelaySeconds`、provider recovery wait 标志和
   running ownership 字段。不得设置 `completedAt`，不得保留会阻止运行分支的
   failed 状态，不得删除原失败 commandCheck 的审计证据。

5. 事件与 metadata 可审计（audit event and metadata）

   每次重开必须写入专门事件，例如 `item_provider_auth_reopened`，并在 checkpoint
   metadata 与 recovery summary 中暴露：`reopenedFromStatus`、
   `reopenedToStatus`、`reopenedFromRecoveryDecision`、`reopenReason`、
   `oldProviderFingerprint`、`currentProviderFingerprint`、`providerConfigChanged`、
   `requiredProviderKeys`、`providerKeysPresent`、`originalFailureKind`、
   `originalProviderStatusCode`、`originalFailedStage`、`normalCommandChecksRequired`、
   `reopenAttemptCount`、`reopenedAt`。所有字段必须经过 redaction。

6. 幂等与防无限重开（idempotency and bounded reopen）

   同一旧失败 fingerprint 到同一当前 fingerprint 的重开最多发生一次。重复运行
   batch 时不得重复追加重开事件、不得反复清空失败证据、不得无限尝试。若重跑后仍
   是 provider auth failure 且 fingerprint 未再变化，必须保持
   `stop_until_fixed`。若 fingerprint 再次变化，可按有界计数重新开放；计数和上限
   必须持久化。

7. `status-json` 只读关系（read-only status projection）

   `--status-json` 可以投影“可重开/不可重开”诊断、fingerprint change 和 key
   presence 状态，但不得写 checkpoint、manifest、events、producer manifest、logs
   或 graph vault runtime 状态。其输出不得让失败 item 显示为已重开后的持久状态，
   除非明确标记为 projection。

8. `migrate-only` 关系（migration-only behavior）

   `--migrate-only` 只允许 schema hydration、event/log redaction migration 和
   只迁移 metadata，不得执行 provider auth 重开后真实运行，也不得把 failed item
   伪装为 completed。若需要在迁移阶段补齐失败时 fingerprint，只能写
   migration-specific metadata/event，并保持 item 的 terminal failed 状态。

9. 旧 checkpoint schema 兼容（legacy schema compatibility）

   恢复机制必须兼容旧 checkpoint 缺少 `providerStatusCode`、commandCheck
   `recoveryDecision`、failure-time provider fingerprint、source identity 或
   policy字段的情况。兼容策略必须 fail-closed：无法确认 provider auth、无法确认
   fingerprint change、无法确认 key presence 时不重开，只输出诊断。

10. 真实重跑与验收闭环（real rerun acceptance loop）

    重开后的 item 必须进入正常 `markItemRunning -> runItem -> runCliChecks` 路径，
    重新执行 EPUB normalization、GraphRAG resume/build、27 个 qmd command checks
    和 graph query checks。只有这些检查全部通过且 GraphRAG artifacts 与
    provider/stage/content fingerprints 验证通过时，才能写 `completed`。测试必须覆盖
    旧 401 checkpoint 重开后真实调用 runner、失败不完成、成功才完成、重复运行不重复
    重开、`status-json` 只读、`migrate-only` 不运行、密钥脱敏。
