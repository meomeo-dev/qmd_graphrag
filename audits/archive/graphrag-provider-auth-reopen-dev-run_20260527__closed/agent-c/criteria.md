# Provider Auth Reopen 审计基准

审计对象：`scripts/graphrag/batch-epub-workflow.mjs`、
`src/contracts/batch-run.ts`、`test/cli.test.ts` 中 provider auth reopen 相关
实现、契约投影与测试。

## C01 候选边界（Candidate Boundary）

只允许重新打开满足以下全部条件的 checkpoint：

- `status=failed`。
- `retryable=false`。
- `recoveryDecision=stop_until_fixed`。
- 失败证据包含 HTTP `401`、HTTP `403` 或明确 provider auth 文本。

不得因为普通 permanent failure、data compatibility failure、本地 artifact gate
failure、transient provider failure 或 running/pending/completed 状态触发 auth reopen。

## C02 Auth 上下文完整性（Auth Context Completeness）

reopen 决策必须基于当前 provider auth context：

- 解析项目配置中的 provider 与 model 边界。
- 识别必需 key 与观测 key。
- 记录 key `present`/`missing`。
- 区分 `project_dotenv`、`graph_vault_dotenv`、
  `project_and_graph_vault_dotenv`、`process_env`、
  `process_env_shadows_dotenv`、`dotenv_not_loaded`。
- 不记录、输出或持久化密钥值。

## C03 Dotenv 兼容性（Dotenv Compatibility）

root `.env` 与 `graph_vault/.env` 的加载顺序、优先级和 `--skip-dotenv`
语义必须明确且兼容既有行为：

- 真实 process env 优先。
- root `.env` 可补齐缺失 env。
- `graph_vault/.env` 可补齐 root 与 process env 都缺失的 env。
- `--skip-dotenv` 不应注入 dotenv 值。
- 诊断投影只能表达存在性、来源与 shadow，不表达值。

## C04 指纹安全（Fingerprint Safety）

fingerprint 必须只用于比较与审计，不得泄漏密钥：

- env value fingerprint 只保存短 hash 或组合 hash。
- provider auth fingerprint 包含 provider config fingerprint 和 env value
  fingerprints。
- 失败 fingerprint 与当前 fingerprint 比较必须可解释。
- legacy checkpoint 缺少 failure fingerprint 时必须显式标记。

## C05 Reopen 幂等与上限（Idempotency And Limits）

reopen 必须可重复安全执行：

- 同一当前 provider auth fingerprint 不得重复 reopen。
- 必须记录 reopen fingerprint 集合。
- 必须有硬上限，防止同一 item 因连续换 key 而无限重跑高成本路径。
- blocked decision 必须可观察。

## C06 Reopen 后闭环准入（Closed-Loop Acceptance）

provider auth reopen 只能把 checkpoint 回到 pending/runnable 状态，不得直接
完成：

- 清空旧失败的 command checks。
- 设置 `normalCommandChecksRequired=true`。
- 后续完成仍必须通过 GraphRAG build、GraphRAG query 与固定 27 个 command
  checks。
- 完成时保留 reopen 元数据，便于追溯。

## C07 生产安全停机策略（Production Stop Safety）

未解决的 provider auth failure 必须停止当前批处理 runner，避免继续启动后续
高成本图书：

- auth failure 不得进入 transient provider recovery wait。
- unresolved auth failure 必须 `stop_until_fixed`。
- 当前 run 中存在活跃 runner 时，不得建议启动第二个同 runId 写入 runner。

## C08 旧 checkpoint 兼容（Legacy Checkpoint Compatibility）

旧 checkpoint 缺少 provider auth metadata 时，行为必须保守：

- 能识别旧的 `401`/`403` 和 auth 文本。
- 能标记 `legacyProviderAuthFingerprintMissing=true`。
- reopen 条件必须避免把未修复的旧 auth failure 误认为已修复。
- 兼容旧 command check 和 summary 投影 schema。

## C09 观测与契约投影（Observability And Contract Projection）

events、checkpoint metadata 与 recovery summary 必须提供足够但安全的操作信息：

- event 记录 reopen、blocked、refailed。
- summary 投影包含 decision、eligible、blocked reason、fingerprint、key
  presence、credential source、attempt count。
- 契约 schema 接受新增字段。
- 投影字段不得包含密钥值、Bearer token、raw provider body 或未脱敏路径。

## C10 测试覆盖与可验证性（Test Coverage And Verifiability）

测试必须覆盖实现风险面：

- legacy reopen 正路径。
- changed fingerprint reopen。
- unchanged fingerprint blocked。
- missing required key blocked。
- process env shadows dotenv blocked。
- attempt limit blocked。
- refail 后不重复同 fingerprint reopen。
- root `.env` 与 `graph_vault/.env` 优先级。
- `--skip-dotenv` 行为。
- recovery summary 与 event redaction。
- 当前真实 runId 续跑风险的只读检查。

