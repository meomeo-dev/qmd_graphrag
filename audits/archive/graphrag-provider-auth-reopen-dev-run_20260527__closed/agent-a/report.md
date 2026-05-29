# Provider Auth Reopen 开发审计报告

## 结论

不通过。

当前实现已经具备 provider auth failure 的基本重开路径：旧
`401/403` 或 `INVALID_API_KEY` 类 `stop_until_fixed` checkpoint 会先迁移为
`pending`，清空旧失败状态，再进入 GraphRAG resume 与 qmd CLI 闭环检查。
实现也避免把重开项直接标记为 `completed`，并把 summary schema 同步到了
公共契约。

不通过原因是有界重开计数存在可降级缺陷，且关键阻断路径缺少回归测试。该缺陷
不一定影响全新写入的 happy path，但会削弱旧 checkpoint 或不完整 metadata
场景下的 hard bound（硬上限）语义。

未执行测试。审计约束要求本代理只写指定审计目录，不修改或生成其他仓库状态。

## 基准结果

| # | 基准 | 结果 | 依据 |
|---|---|---|---|
| 1 | 状态机守卫 | 通过 | `providerAuthReopenDecision` 仅接受 `failed`、`retryable=false`、`stop_until_fixed` 且 provider auth failure 的 checkpoint。见 `scripts/graphrag/batch-epub-workflow.mjs:925`。 |
| 2 | 状态迁移语义 | 通过 | `reopenProviderAuthCheckpoint` 写入 `pending`、`continue_pending`，清除旧失败、retry、runner 字段与旧 command checks，并保留原始失败元数据。见 `scripts/graphrag/batch-epub-workflow.mjs:1064`。 |
| 3 | 真实闭环 | 通过 | 重开后只进入正常 item loop；`completed` 只在 `runItem` 完成 GraphRAG 与 27 个 qmd checks 后写入。见 `scripts/graphrag/batch-epub-workflow.mjs:4548`、`:4593`。 |
| 4 | 有界与防循环 | 不通过 | 同一 fingerprint 防重复存在，但 `providerAuthReopenAttemptCount` 可被 `reopenedFingerprints.length` 覆盖为更小值。见 `scripts/graphrag/batch-epub-workflow.mjs:904`、`:1066`。 |
| 5 | 配置变化判定 | 通过 | 非 legacy 比较失败 fingerprint 与当前 fingerprint；legacy 缺失 fingerprint 时标记 `legacyProviderAuthFingerprintMissing`。见 `scripts/graphrag/batch-epub-workflow.mjs:931`、`:980`、`:991`。 |
| 6 | secret hygiene | 通过 | 写入事件前递归 redaction，summary 中只投影 fingerprint、presence、source 等概念。见 `scripts/graphrag/batch-epub-workflow.mjs:1478`、`:1522`、`:1642`、`:1000`。 |
| 7 | shell env shadow 处理 | 部分通过 | 必需 key 被 shell env 覆盖 `.env` 时会返回 `process_env_shadows_dotenv` 并阻断重开。缺少专项测试；非必需 base URL 只记录 source，不阻断。见 `scripts/graphrag/batch-epub-workflow.mjs:812`、`:849`。 |
| 8 | schema 与契约一致性 | 通过 | 脚本 summary schema 与 `src/contracts/batch-run.ts` 新增字段一致。见 `scripts/graphrag/batch-epub-workflow.mjs:570`、`src/contracts/batch-run.ts:270`。 |
| 9 | 只读与迁移边界 | 通过 | `--status-json` 在重开 pass 前返回，`writeTypedJson` 在 status mode 不落盘；`--migrate-only` 在重开 pass 前返回。见 `scripts/graphrag/batch-epub-workflow.mjs:1725`、`:4877`、`:4879`、`:4883`、`:4913`。 |
| 10 | 测试覆盖 | 不通过 | 只新增 legacy reopen 成功闭环测试，缺少 unchanged blocked、重复 fingerprint、attempt limit、shadow blocked、migrate-only auth 边界和 status-json auth 投影测试。见 `test/cli.test.ts:6064`。 |

## 必须修复项

1. 修复 provider auth reopen attempt count 降级问题。

   当前 `providerAuthReopenAttemptCount` 读取时取
   `max(reopenedFingerprints.length, metadata.providerAuthReopenAttemptCount)`，
   但写回时固定使用 `reopenedFingerprints.length`。若旧 checkpoint 已有较大的
   `providerAuthReopenAttemptCount`，但 `providerAuthReopenedFingerprints` 缺失或
   不完整，下一次重开会把计数写小，削弱总次数上限。

   证据：

   - 读取计数：`scripts/graphrag/batch-epub-workflow.mjs:904`
   - 写回计数：`scripts/graphrag/batch-epub-workflow.mjs:1084`
   - event 中写入同一降级后的计数：`scripts/graphrag/batch-epub-workflow.mjs:1120`

   修复要求：

   - 写回计数应基于旧计数单调递增，例如
     `max(providerAuthReopenAttemptCount(checkpoint) + 1,
     reopenedFingerprints.length)`。
   - block 判断继续使用硬上限 `maxProviderAuthReopenAttempts`。
   - checkpoint metadata 与 reopen event 必须写同一个单调计数。
   - 增加覆盖“metadata 只有 attempt count、没有完整 fingerprint array”的测试。

2. 补齐 provider auth reopen 的阻断路径测试。

   当前新增测试只证明 legacy checkpoint 可以重开并完成闭环。该测试不足以保护
   有界、防循环和 shadow 行为。

   必须新增测试覆盖：

   - 非 legacy `providerAuthFailureFingerprint == currentProviderAuthFingerprint`
     时阻断，保持 `failed stop_until_fixed`。
   - `providerAuthReopenedFingerprints` 已包含当前 fingerprint 时阻断。
   - `providerAuthReopenAttemptCount >= 3` 时阻断。
   - 必需 credential 被 shell `process.env` 覆盖修复后的 `.env` 时阻断，并只输出
     source/presence/fingerprint 概念。
   - `--migrate-only` 对 provider auth failure 不执行 reopen，不运行 GraphRAG/qmd。
   - `--status-json` 对 provider auth failure 只投影决策，不写 checkpoint、event log
     或 recovery summary。

3. 补齐 secret hygiene 的 provider auth 专项断言。

   现有 success test 检查 fake key 未进入 checkpoint/event/summary，已有迁移测试
   检查 URL secret redaction。但还缺少 provider auth blocked/refailed 路径上的
   raw credential 断言。

   修复要求：

   - 对 reopen blocked event、refailed event、status-json summary 分别断言不包含
     原始 credential。
   - 断言允许字段只包含 `present`、`missing`、fingerprint、change/source 类值。
   - 不在测试日志或快照中输出真实 `.env` 值。

## 建议项

1. 明确 project `.env` 与 graph vault `.env` 同名 key 不一致时的 precedence。

   当前 `loadDotenv` 先加载 project `.env`，再加载 graph vault `.env`，且不覆盖
   已存在 `process.env`。如果两者不同，source 会显示为 `project_dotenv` 或
   `graph_vault_dotenv`，但不会显式报告 dotenv conflict。建议在 summary/event 中
   增加 `project_and_graph_vault_dotenv_conflict` 类 source，或在运维文档中明确
   哪个 `.env` 是权威来源。

2. 考虑将 base URL shadow 也作为 blocking condition。

   当前只阻断必需 credential key 的 shell shadow。base URL 参与当前 provider auth
   fingerprint，但不是 required key，因此只记录 source，不阻断。若错误 base URL
   会导致 auth-like failure，建议将 observed auth transport keys 的 shadow 也纳入
   阻断，或在 blocked reason 中单独暴露为 warning。

3. 为 provider auth reopen 决策值收窄 schema。

   现在 `providerAuthReopenDecision` 与 reason 字段在 summary schema 中是
   `string().min(1)`。建议用 enum 固化已知值，避免拼写漂移影响审计查询。

4. 更新运维文档中的 provider auth reopen 操作说明。

   `docs/operations/graphrag-epub-resume-boost.md` 已强调 `--status-json` 只读和
   不手改 completed，但没有解释 provider auth reopen 的 summary 字段、blocked
   reason、fingerprint changed 判定和 shell env shadow 处理。建议增加一节
   “provider auth 修复后续跑”，说明只读观察字段与写入续跑预期事件。

5. 在测试中解析公共契约 schema。

   provider auth summary 字段已经同步到 `src/contracts/batch-run.ts`。建议至少一个
   CLI 测试把实际 `recovery-summary.json` 或 `--status-json` stdout 交给
   `BatchRecoverySummarySchema` 解析，防止脚本内 schema 与公共契约再次漂移。

## 通过项说明

状态机主路径符合目标：

- `applyProviderAuthReopenPass` 在 stop-before-processing 之前执行，因此修复后的
  legacy auth failure 不会继续被旧 `stop_until_fixed` checkpoint 卡住。
- 重开只写 `pending`，不写 `completed`。
- `runItem` 完成路径要求 GraphRAG build/query evidence 与完整 qmd command checks。
- runtime provider auth failure 会写回 `stop_until_fixed` 并阻止后续 item，本轮已有
  测试覆盖。

只读边界基本成立：

- `--status-json` 不调用 provider auth reopen pass。
- `event()` 在 status mode 不写 event log。
- `writeTypedJson()` 在 status mode 不落盘。
- 已有测试证明普通 status-json 不写 checkpoint 或 recovery summary。

密钥卫生基本成立：

- event metadata 递归 redaction 后写入。
- command stdout/stderr 日志写入前 redaction。
- provider auth summary 只投影 required key names、presence、credential source 和
  fingerprint，不投影 raw credential。
