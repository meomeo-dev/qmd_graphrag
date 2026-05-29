# GraphRAG Provider Auth Reopen 审计报告

## 结论

FAIL

当前补丁已经实现 provider auth reopen 的主要状态机，并且指定命令全部通过。
但仍存在必须修复项：`status-json`/summary 投影会优先采用旧 metadata 中的
`providerAuthReopenDecision` 与 eligibility，而不是当前 provider auth context 的
实时判定；同时负向测试缺少 current fingerprint unchanged、already reopened 和
`--skip-dotenv` dotenv-not-loaded 等路径。该缺口会影响恢复决策的可观测性，并可能在
旧 checkpoint 或旧 summary 字段存在时给出过期的 reopen eligibility。

## 审计范围

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `docs/operations/graphrag-epub-resume-boost.md`

未读取或输出任何 `.env` 密钥值；仅审计 present/missing/source/fingerprint 字段语义。

## 必须修复项

1. `scripts/graphrag/batch-epub-workflow.mjs:1088`

   `providerAuthSummaryProjection()` 对 `providerAuthReopenDecision`、
   `providerAuthReopenEligible`、`providerAuthReopenReason`、
   `providerAuthReopenBlockedReason`、`providerAuthConfigChanged` 等字段优先使用
   `checkpoint.metadata`，只在 metadata 缺失时才使用当前
   `providerAuthReopenDecision()` 的判定。若旧 checkpoint 已保存
   `providerAuthReopenEligible=true`，后续 shell env shadow、missing
   `OPENAI_BASE_URL`、attempt limit 或 current fingerprint unchanged 时，
   `status-json` 仍可能投影旧的 eligible/reopen 结果。

   需要改为：summary/status-json 的决策字段以当前判定为准；历史 metadata 仅作为
   evidence 字段保留，例如 last decision、last reopen fingerprint、failure
   fingerprint、attempt count。阻断类字段必须能覆盖旧的 reopen eligibility。

2. `test/cli.test.ts:6406`

   现有 shell env shadow 用例覆盖旧 legacy checkpoint 被 shadow 阻断，但没有覆盖
   “metadata 已含旧 reopen eligibility 后，当前 context 变为 shadow/missing 时
   summary 必须阻断”的回归场景。由于源码当前优先旧 metadata，此类测试应失败，
   是必须补齐的保护用例。

3. `test/cli.test.ts:6981`

   “provider auth refailure clears stale reopen eligibility” 覆盖运行中再次 401 后会写入
   新失败 metadata，但未覆盖纯恢复入口的负向路径：失败 fingerprint 与 current
   fingerprint 相同时必须产生
   `blocked_provider_auth_fingerprint_unchanged`，且不得 reopen。

4. `test/cli.test.ts:6904`

   attempt limit 覆盖了 `providerAuthReopenAttemptCount=3`，但缺少
   `providerAuthReopenedFingerprints` 已包含 current fingerprint 的
   `blocked_provider_auth_fingerprint_already_reopened` 用例。幂等保护需要直接测试同一
   fingerprint 已重开过时不会再次 pending。

5. `test/cli.test.ts:6406`

   `--skip-dotenv` 场景只覆盖 shell env shadow，没有覆盖 dotenv 文件存在但因
   `--skip-dotenv` 不加载、且 process env 缺少必需变量时的 `dotenv_not_loaded` /
   missing readiness 语义。必须添加负向测试，证明 E2E 不依赖真实 `.env`，且
   skip-dotenv 不会悄悄从 dotenv 恢复 provider auth。

## 已通过项

- Provider auth 识别覆盖 HTTP 401/403 和认证失败文本：
  `scripts/graphrag/batch-epub-workflow.mjs:778`。

- Reopen candidate 限定为 failed、non-retryable、stop-until-fixed、provider auth
  failure：`scripts/graphrag/batch-epub-workflow.mjs:1005`。

- `OPENAI_BASE_URL` 纳入 required endpoint：
  `scripts/graphrag/batch-epub-workflow.mjs:813`，
  contract summary 字段纳入 `providerAuthRequiredEndpoints`：
  `src/contracts/batch-run.ts:280`。

- Provider config fail closed：配置读取或校验失败时 readiness 为
  `provider_auth_config_unreadable`：
  `scripts/graphrag/batch-epub-workflow.mjs:799`、`:911`。

- Dotenv precedence 实现为 project dotenv 先加载，`graph_vault/.env` 后加载，且
  vault 只覆盖非启动时 shell env：
  `scripts/graphrag/batch-epub-workflow.mjs:1777`。

- 当前补丁引入 `--project-dotenv`，测试可指定临时 project dotenv，降低对真实仓库
  `.env` 的依赖：`scripts/graphrag/batch-epub-workflow.mjs:58`、
  `test/cli.test.ts:6636`。

- Test hook 隔离要求启动时 shell env 显式提供
  `QMD_GRAPHRAG_ENABLE_TEST_HOOKS` 与对应 hook 变量，dotenv 注入不能激活 hook：
  `scripts/graphrag/batch-epub-workflow.mjs:4010`、`:4024`；
  测试见 `test/cli.test.ts:6485`。

- 写入模式的 reopen pass 位于 batch stop 检查之前，reopen 后写回 checkpoint 并重走
  closed loop：`scripts/graphrag/batch-epub-workflow.mjs:5069`；
  closed-loop 测试见 `test/cli.test.ts:6185`。

- 运行中 provider auth refailure 会记录当前 runtime provider auth fingerprint，并把
  reopen eligibility 清为 false：
  `scripts/graphrag/batch-epub-workflow.mjs:1155`、`:5466`、`:5562`。

- Redaction 覆盖 env exact value、dotenv exact value、URL credentials、Bearer token、
  OpenAI/Jina key/base URL 文本：
  `scripts/graphrag/batch-epub-workflow.mjs:1586`、`:1602`、`:1617`、`:1631`。

## 测试结果

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：通过。
- `node --check src/contracts/batch-run.ts`：通过。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "provider auth|test qmd runner hook"`：通过，11 passed，187 skipped。

## must-fix 验证矩阵

- test hook 隔离：通过；dotenv 中的 qmd hook 未激活。
- `OPENAI_BASE_URL` readiness：通过；缺失 base URL 会阻断 reopen。
- root vs `graph_vault` dotenv precedence：实现通过，当前测试已使用
  `--project-dotenv` 隔离临时 root dotenv。
- provider config fail-closed：通过；无效 config 阻断 reopen。
- missing 负向测试：部分通过；API key 和 `OPENAI_BASE_URL` missing 已覆盖。
- unchanged 负向测试：未充分覆盖；缺少纯恢复入口的 unchanged fingerprint 用例。
- attempt 负向测试：部分通过；attempt limit 已覆盖。
- shadow 负向测试：部分通过；shell env shadow 已覆盖，但旧 metadata 覆盖当前阻断未覆盖。
- skip-dotenv 负向测试：不足；缺少 dotenv 存在但 skip-dotenv 后不得恢复的直接测试。
- refail 负向测试：通过运行中 refailure 路径。
- E2E 不依赖真实 `.env`：部分通过；`--project-dotenv` 改善隔离，但仍需补齐
  skip-dotenv/dotenv-not-loaded 与旧 metadata 阻断场景。

## 风险说明

当前实现的实际写入 reopen 决策由 `applyProviderAuthReopenPass()` 调用
`providerAuthReopenDecision()`，该路径会依据当前 context 阻断。因此主要风险集中在
`status-json`、recovery summary 和操作者判断层面：旧 metadata 可能让恢复窗口显示为
可重开，导致误判下一次写入 runner 的预期行为。修复 summary 投影优先级并补齐负向测试
后，该补丁可重新审计。
