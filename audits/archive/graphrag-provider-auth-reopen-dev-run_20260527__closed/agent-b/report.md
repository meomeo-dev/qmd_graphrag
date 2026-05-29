# Provider Auth Failure Reopen 开发审计报告

## 审计范围

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`

执行的验证：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`

结果：语法检查通过。未读取 `.env` 密钥值，未修改业务源码，未回滚他人改动。

## 基准结论

1. 401/403 保持 permanent stop：通过。

   `checkpointHasUnrecoverableProviderAuthFailure` 对 401/403 明确识别；
   `shouldStopBatchAfterFailure` 将 provider auth failure 纳入 stop 条件；
   `canRepairLocalArtifactGate` 在存在 provider status code 时拒绝本地
   artifact 修复，避免被 local repair 误处理。运行时失败也写入
   `recoveryDecision=stop_until_fixed`。

2. reopen 候选范围限制：通过。

   `providerAuthReopenDecision` 要求 `status=failed`、`retryable=false`、
   `recoveryDecision=stop_until_fixed` 且命中 provider auth failure。非候选
   不重开。

3. 当前 fingerprint 和 ready 状态 gating：通过。

   `providerAuthContext` 基于配置、required key presence、credential source
   与 shadow 状态生成 `ready`。缺少 required key、required key 被
   `process_env_shadows_dotenv` 影响、或 current fingerprint 缺失时均阻断
   reopen。

4. 相同 fingerprint 不重复重开：部分通过。

   决策层会阻断两类重复：当前 fingerprint 已存在于
   `providerAuthReopenedFingerprints`，或当前 fingerprint 与失败 fingerprint
   相同。存在一个必须修复的审计状态问题：重开后若同一 fingerprint 再次
   失败，新的失败 checkpoint 继承旧 metadata，并叠加新的
   `providerAuthFailureFingerprint`。由于 object spread 顺序，旧
   `providerAuthReopenEligible=true`、`providerAuthReopenDecision=reopen_*`
   可能保留在 checkpoint 和 recovery summary 中。下一轮确实不会重复重开，
   但 summary 可能继续显示 eligible/reopen，和实际 blocked decision 不一致。

5. fingerprint 不可逆且无密钥泄露：通过，仍有建议项。

   key value 使用 sha256 截断摘要，`currentProviderAuthFingerprint` 是配置
   fingerprint 与 env value fingerprint 的组合摘要；事件写入前通过
   `redactJsonValue`，错误信息也通过 `redacted`/`redactLog`。未发现把 key
   fingerprint 当作可逆密钥材料使用或输出原始 key 值。建议将
   `envValueFingerprint` 的 12 hex 截断长度和威胁模型写入注释或设计记录，
   防止后续误用为安全证明。

6. `--status-json` 只读：通过。

   主流程在 `statusJson` 分支直接 `printStatusAndExit` 并 return，位于
   `applyProviderAuthReopenPass` 前。`event`、`writeTypedJson`、`ensureDirs`
   也有只读保护。未发现 status-json 会运行 normalize、resume、qmd checks。

7. `--migrate-only` 不运行 provider auth reopen 或真实构建：通过。

   主流程在 `migrateOnly` 分支执行迁移、summary、`batch_state_migrated`
   后 return，位于 provider auth reopen loop 前。不会进入
   `markItemRunning`、`runItem`、`runGraphResume`。

8. event/checkpoint/summary 可审计：部分通过。

   重开事件 `item_provider_auth_reopened`、阻断事件
   `item_provider_auth_reopen_blocked`、再次失败事件
   `item_provider_auth_refailed` 都包含 decision、reason、status code、
   fingerprint、attempt count、ready/key/source 信息。checkpoint metadata
   和 summary schema 也增加了 provider auth 字段。

   不通过点同基准 4：再次失败后 summary projection 优先读取旧 metadata，
   可能把已经失效的 `providerAuthReopenEligible=true` 和 `reopen_*` decision
   继续投影出来，降低审计可信度。

9. 重开后必须走 `markItemRunning -> runItem -> runGraphResume -> 27 qmd checks`：
   通过。

   `applyProviderAuthReopenPass` 只把 checkpoint 改为 pending；后续同一 loop
   中普通 pending 路径调用 `markItemRunning`，然后 `runItem`。`runItem`
   先 `runGraphResume`，再 `runCliChecks`；`requiredCommandCheckNames` 为 27
   项，`validateCommandChecks` 强制数量、唯一性和全部 passed。新增测试也
   断言 completed checkpoint 的 command check 名称等于 27 项固定列表。

10. 语法、逻辑、死锁、无限循环、schema、测试覆盖：部分通过。

    `node --check` 通过。主循环不会因同一 fingerprint 无限重开，因为重开后
    记录 current fingerprint，后续相同 fingerprint 会被阻断，且还有
    `maxProviderAuthReopenAttempts=3` 上限。shell env shadow 被纳入 ready 阻断。

    主要缺口是测试覆盖不足：当前新增测试覆盖 legacy checkpoint 修复 key 后
    成功重开并跑完整闭环；已有测试覆盖 401 stop 和 runtime auth stop。但未见
    针对以下路径的直接测试：403、非 legacy 失败 fingerprint 变化后重开、相同
    fingerprint 阻断、`providerAuthReopenedFingerprints` 阻断、shadow required
    env 阻断、`--status-json` 对 provider auth checkpoint 只读、`--migrate-only`
    对 provider auth checkpoint 不重开、重开后同 fingerprint 再失败的 summary
    投影。

## 必须修复项

1. 修复重开后再次失败的 provider auth metadata 继承污染。

   位置：`scripts/graphrag/batch-epub-workflow.mjs` 的失败 checkpoint 构造和
   `providerAuthSummaryProjection`。

   现象：重开成功进入真实运行后，如果同一 current fingerprint 仍然 401/403，
   失败 checkpoint 继承旧 metadata，再叠加新的 auth failure metadata。旧的
   `providerAuthReopenDecision=reopen_*`、
   `providerAuthReopenEligible=true`、
   `providerAuthReopenReason=*`、`providerAuthReopenBlockedReason=undefined`
   可能保留。下一次 summary 会优先使用旧 metadata，而不是重新计算出的
   `blocked_provider_auth_fingerprint_already_reopened` 或
   `blocked_provider_auth_fingerprint_unchanged`。

   影响：调度层面通常不会无限重开，但审计输出会错误显示 eligible/reopen。
   这直接违反“相同 fingerprint 不重复重开”的可审计表达要求。

   修复方向：在 provider auth runtime failure 写 checkpoint 时，清理旧 reopen
   eligibility/decision/reason 字段，或写入新的 blocked/refailed decision；
   同时让 `providerAuthSummaryProjection` 对 failed auth checkpoint 优先使用
   fresh `providerAuthReopenDecision(checkpoint)`，除非 metadata 明确记录的是
   当前失败后的 blocked decision。

2. 增加相同 fingerprint 不重复重开的直接回归测试。

   最小场景：checkpoint 含 `providerAuthFailureFingerprint` 等于当前
   `currentProviderAuthFingerprint`，或含
   `providerAuthReopenedFingerprints=[currentFingerprint]`；运行后应保持
   failed/stop_until_fixed，不产生 `item_provider_auth_reopened`，summary 显示
   blocked reason。

3. 增加 status-json 和 migrate-only 的 provider auth 专项测试。

   需要断言 provider auth failed checkpoint 在 `--status-json` 下不写
   checkpoint、events、manifest、summary，也不运行 fake resume/qmd；在
   `--migrate-only` 下不触发 `item_provider_auth_reopened`，不进入真实构建。

## 建议项

1. 增加 403 测试。

   当前静态逻辑覆盖 403，但测试主要是 401。建议用 403 checkpoint 和 runtime
   failure 各覆盖一次，避免后续分类器或文本匹配修改造成回归。

2. 增加 shell env shadow 阻断测试。

   构造 `.env` 中 repaired key 与 `process.env` 中不同 key，同时 required key
   被 shadow；应产生 `blocked_provider_auth_not_ready`，reason 为
   `process_env_shadows_dotenv`，且不重开。

3. 将 provider auth metadata 字段纳入共享 contract 之外的明确文档或 fixture。

   `src/contracts/batch-run.ts` 已允许 summary 字段，但 checkpoint metadata 仍是
   generic JSON record。建议在测试 fixture 或 YAML 约定中固定字段含义，便于
   后续审计和迁移。

4. 将 fingerprint 截断长度和不可逆使用边界写入注释。

   当前实现没有输出原始 key，但 12 hex 的 per-key value fingerprint 是短摘要。
   只应作为变化检测与去重信号，不应作为强安全标识或跨系统关联标识。

5. 减少 `providerAuthSummaryProjection` 的运行时环境依赖。

   summary projection 在没有 metadata 时会读取当前 `.env`/process env 重新计算
   decision。这样适合 status 展示，但对历史审计可能受当前 shell 影响。建议
   优先使用 checkpoint 中记录的 failure/current fingerprint 和 readiness
   evidence，仅在缺失时再计算当前 context，并在字段名上区分 current projection
   与 historical evidence。

## 总体结论

实现主路径基本满足需求：401/403 不被 transient 或 local repair 吞掉；修复 key
后能基于 current fingerprint 和 ready 状态重开；重开后进入正常 pending 执行
路径并强制完成 27 个 qmd checks；`status-json` 和 `migrate-only` 不进入重开
或真实构建。

发布前应先修复再次失败后的 metadata/summary 污染，并补齐相同 fingerprint、
status-json、migrate-only、shadow env、403 的回归测试。当前最大风险不是无限
循环，而是审计输出可能错误表达“仍可重开”，导致运维误判。
