# GraphRAG EPUB Batch Provider Auth 恢复实现审计报告

结论：FAIL

## 范围

审计范围限于以下文件：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `docs/operations/graphrag-epub-resume-boost.md`
- `docs/operations/graphrag-epub-resume-commands.md`

未读取、复制或输出真实 `.env` 密钥值。审计只描述 present/missing、source、
fingerprint、redacted、readiness 和 blocked reason。未执行真实图书批处理，未调用
外部搜索或 provider API。

## 必须修复项

### 1. 状态投影把 stale producer lineage 误报为 artifact missing

- 文件：`scripts/graphrag/batch-epub-workflow.mjs:2881`
- 文件：`scripts/graphrag/batch-epub-workflow.mjs:2886`
- 文件：`scripts/graphrag/batch-epub-workflow.mjs:3079`
- 文件：`scripts/graphrag/batch-epub-workflow.mjs:3082`
- 文件：`test/cli.test.ts:9699`
- 文件：`test/cli.test.ts:9968`

`stageCandidateArtifacts()` 在进入详细校验前，先按 expected producer run id 过滤
GraphRAG stage artifact。若 artifact 存在但 producer run id 不匹配，候选集被过滤成
空集，`validateGraphStageEvidence()` 随后返回 `stage_artifact_missing`。这会丢失
“artifact 存在但 lineage stale”的事实。

相关测试 `status-json reopens completed items with stale GraphRAG producer lineage`
当前失败：预期 `stage_artifact_producer_run_mismatch:community_report`，实际得到
`stage_artifact_missing`。这影响真实批处理恢复前的用户判断：operator 会看到
“缺失 artifact”，而不是“已有 artifact 但 producer lineage 不匹配”，容易误判恢复
动作、重建范围或审计证据。

建议修复：不要在候选收集阶段丢弃 producer-run-mismatched artifacts。先按
book、stage、kind 收集候选，再在 `selectValidStageArtifacts()` 中保留并返回
`stage_artifact_producer_run_mismatch:<stage>`、`stage_artifact_provider_mismatch`、
`stage_artifact_fingerprint_mismatch` 等更精确原因。修复后保留并通过
`test/cli.test.ts:9699` 的 stale producer lineage 用例。

建议测试：

- 运行 `status-json reopens completed items with stale GraphRAG producer lineage`，
  断言 reason 为 producer run mismatch。
- 增加同类用例覆盖 `graph_extract`、`community_report`、`embed` 三个 producer
  stage，确保 artifact 存在但 producerRunId 不匹配时不退化为 missing。
- 继续保留 artifact 真缺失用例，确认真正缺失时仍返回 `stage_artifact_missing`。

## 通过项

dotenv 权威覆盖清晰。`loadDotenv()` 先读取项目根 `.env`，再读取
`graph_vault/.env`；当变量不属于初始 shell 环境时，`graph_vault/.env` 可覆盖项目根
同名变量（`scripts/graphrag/batch-epub-workflow.mjs:1804` 到
`scripts/graphrag/batch-epub-workflow.mjs:1816`）。`providerAuthSourceForKey()` 明确
投影 `graph_vault_dotenv_shadows_project_dotenv` 与
`process_env_shadows_dotenv`（`scripts/graphrag/batch-epub-workflow.mjs:841` 到
`scripts/graphrag/batch-epub-workflow.mjs:873`）。

initial shell env shadow 阻断且可观测。provider context 会记录
`providerAuthShadowedEnvNames`、`providerAuthCredentialSources`，并在存在 shadow 时将
readiness 设为 `process_env_shadows_dotenv`（`scripts/graphrag/batch-epub-workflow.mjs:875`
到 `scripts/graphrag/batch-epub-workflow.mjs:917`）。测试覆盖 shell env shadow 和
stale reopen metadata 被当前 readiness 覆盖（`test/cli.test.ts:6449` 到
`test/cli.test.ts:6659`）。

observed endpoint env shadow 已阻断。`providerAuthConfig()` 把 `JINA_API_BASE` 纳入
observed provider env（`scripts/graphrag/batch-epub-workflow.mjs:832` 到
`scripts/graphrag/batch-epub-workflow.mjs:837`），readiness 对所有 shadowed observed
env fail-closed。测试覆盖 `JINA_API_BASE` shadow 阻断，且 summary 不泄露 endpoint
原值（`test/cli.test.ts:6528` 到 `test/cli.test.ts:6600`）。

`OPENAI_BASE_URL` 已作为 required endpoint。OpenAI base URL env 被加入
`requiredEndpointNames`，并参与 `providerAuthMissingRequiredKeys` 判定
（`scripts/graphrag/batch-epub-workflow.mjs:815` 到
`scripts/graphrag/batch-epub-workflow.mjs:831`）。缺失 OpenAI base URL 的阻断测试通过
（`test/cli.test.ts:6867` 到 `test/cli.test.ts:6942`）。

provider config unreadable 已 fail-close。配置读取或运行时约束验证失败时，
`providerAuthConfigReadStatus=invalid`，readiness 投影为
`provider_auth_config_unreadable`（`scripts/graphrag/batch-epub-workflow.mjs:801` 到
`scripts/graphrag/batch-epub-workflow.mjs:812`，`scripts/graphrag/batch-epub-workflow.mjs:911`
到 `scripts/graphrag/batch-epub-workflow.mjs:913`）。坏 YAML 配置测试覆盖该路径
（`test/cli.test.ts:7062` 到 `test/cli.test.ts:7127`）。

secret redaction 覆盖主要输出面。`redacted()`、`redactLog()` 和
`redactExactEnvValues()` 覆盖 process env、dotenv exact value、URL credential、敏感
query 参数、Bearer token、API key 形态、base URL 形态和绝对路径
（`scripts/graphrag/batch-epub-workflow.mjs:1631` 到
`scripts/graphrag/batch-epub-workflow.mjs:1677`）。event、checkpoint hydration、
recovery summary、event migration 和 raw log migration 均进入脱敏路径
（`scripts/graphrag/batch-epub-workflow.mjs:1819` 到
`scripts/graphrag/batch-epub-workflow.mjs:1837`，
`scripts/graphrag/batch-epub-workflow.mjs:2144` 到
`scripts/graphrag/batch-epub-workflow.mjs:2161`，
`scripts/graphrag/batch-epub-workflow.mjs:3726` 到
`scripts/graphrag/batch-epub-workflow.mjs:3852`）。相关 redaction 测试通过
（`test/cli.test.ts:10145` 到 `test/cli.test.ts:10324`）。

provider auth reopen 有界且不会伪完成。候选条件限定为
`failed + retryable=false + stop_until_fixed` 且具备 401、403 或认证失败文本证据；重开
后只回到 `pending/continue_pending`，清空 command checks，并写入
`normalCommandChecksRequired=true`（`scripts/graphrag/batch-epub-workflow.mjs:1004` 到
`scripts/graphrag/batch-epub-workflow.mjs:1077`，
`scripts/graphrag/batch-epub-workflow.mjs:1185` 到
`scripts/graphrag/batch-epub-workflow.mjs:1273`）。闭环重跑测试通过
（`test/cli.test.ts:6228` 到 `test/cli.test.ts:6447`）。

恢复命令文档与实现基本匹配。命令附录提供只读 `--status-json`、使用 `env -u`
去除 provider shell shadow 的识别命令，以及真实写入续跑命令
（`docs/operations/graphrag-epub-resume-commands.md:3` 到
`docs/operations/graphrag-epub-resume-commands.md:62`）。速查文档说明
`graph_vault/.env` 权威优先级、provider auth reopen 条件、观测字段和禁止泄露密钥
要求（`docs/operations/graphrag-epub-resume-boost.md:140` 到
`docs/operations/graphrag-epub-resume-boost.md:219`）。

## 验证

已运行聚焦测试，未启动真实 EPUB batch 写入：

```text
CI=true node ./node_modules/vitest/vitest.mjs run test/cli.test.ts \
  -t "provider auth|test qmd runner hook is not activated from dotenv|redacts exact environment values|redacts URL credentials" \
  --reporter=verbose --testTimeout 60000
```

结果：通过。1 个测试文件通过，18 个测试通过，185 个测试跳过。

已运行包含恢复前状态投影的扩展过滤测试：

```text
CI=true node ./node_modules/vitest/vitest.mjs run test/cli.test.ts \
  -t "provider auth|redacts exact environment values|redacts URL credentials|status-json accepts portable book-scoped GraphRAG producer evidence|status-json reopens completed items when GraphRAG query check failed|status-json reopens completed items with incomplete command check set|status-json reopens completed non-transient failed checks|status-json reopens completed items with stale GraphRAG producer lineage|runtime provider auth failure|unrecoverable provider auth failure" \
  --reporter=verbose --testTimeout 60000
```

结果：失败。21 个测试通过，1 个测试失败，181 个测试跳过。失败项为
`status-json reopens completed items with stale GraphRAG producer lineage`，断言位置
`test/cli.test.ts:9968`。

## 残余风险

provider auth、dotenv、shadow、fail-close 和 redaction 主路径具备实现与测试覆盖。
当前阻断恢复的风险集中在只读状态投影的 producer lineage 可诊断性：它不会泄露密钥，
也不会把 item 伪标 completed，但会降低恢复前状态命令对每本书 GraphRAG build stale
原因的可解释性。该问题修复并通过对应测试前，不建议恢复真实图书处理。
