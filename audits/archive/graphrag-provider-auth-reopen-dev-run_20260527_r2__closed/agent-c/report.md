# GraphRAG EPUB Batch Provider Auth 恢复补丁审计报告

结论：FAIL

## 范围

审计范围限于以下文件：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `docs/operations/graphrag-epub-resume-boost.md`

未直接打开、复制或输出真实 `.env` 密钥值。报告只描述 present/missing、
source、fingerprint、readiness 和 blocked reason 等字段语义。

## 必须修复项

### 1. 非必需 provider dotenv shadow 未阻断 reopen

- 文件：`scripts/graphrag/batch-epub-workflow.mjs:909`
- 文件：`scripts/graphrag/batch-epub-workflow.mjs:911`
- 文件：`docs/operations/graphrag-epub-resume-boost.md:141`

实现会收集所有 observed provider 变量的 shadow：
`providerAuthSourceForKey()` 对与 dotenv 不同的初始 shell env 返回
`process_env_shadows_dotenv`，`providerAuthContext()` 将其加入
`shadowedEnvNames`。但是 readiness 只检查
`requiredShadowedEnvNames`，也就是只对 required keys/endpoints 的 shadow
fail-closed。当前 observed env 包括 `JINA_API_BASE`，而 required names 只包括
OpenAI API key、Jina API key 和 OpenAI base URL。因此，当 `JINA_API_BASE`
在初始 shell env 中遮蔽 `graph_vault/.env` 时，summary 会记录 shadow，但
`readinessStatus` 仍可能为 `ready`，provider auth checkpoint 仍可 reopen。

这与文档中“若 shell env 与权威 dotenv 不同，批处理会判定为遮蔽并阻断
provider auth reopen”的边界不一致。该变量虽当前不是 reopen 必需项，但它仍是
provider endpoint 配置，允许 shadow 下 reopen 会降低恢复补丁的配置边界一致性。

要求修复：`providerAuthContext()` 的 readiness 应对 provider observed env 中的
shadow fail-closed，或将文档和测试明确改成只阻断 required provider 变量。基于本
次审计基准，应采用前者，并补充 `JINA_API_BASE` shadow 阻断测试。

## 通过项

dotenv 解析和加载边界基本成立。`parseDotenvText()` 只处理 `KEY=value` 与
`export KEY=value`，忽略注释、空行和非法变量名；`loadDotenv()` 先加载项目根
`.env`，再加载 `graph_vault/.env`，且只有变量不在初始 shell env 中时才允许
`graph_vault/.env` 覆盖项目根 `.env`。

provider auth context 的可观测字段是脱敏字段。实现输出 key presence、credential
source、readiness、missing keys、shadowed env names、root/vault dotenv
fingerprints 和 current provider auth fingerprint；schema 在
`src/contracts/batch-run.ts:270` 到 `src/contracts/batch-run.ts:296` 接受这些字段，
未要求保存 secret 原文。

secret redaction 路径覆盖主要输出面。`redacted()`、`redactLog()` 和
`redactExactEnvValues()` 覆盖环境精确值、dotenv 精确值、URL credential、
Bearer token、API key 形态、base URL 形态和绝对路径；event、checkpoint
hydration、recovery summary 和命令日志写入均调用脱敏路径。

config fail-closed 主路径成立。provider 配置读取或验证失败时，
`providerAuthConfig()` 将状态设为 invalid；`providerAuthContext()` 投影为
`provider_auth_config_unreadable`；`providerAuthReopenDecision()` 在 context
不 ready 时返回 `blocked_provider_auth_not_ready`。

OpenAI Responses API readiness 已纳入 provider auth 边界。实现将
`OPENAI_BASE_URL` 或配置指定的 OpenAI base URL env 名列入 required endpoints；
缺失时投影为 `missing_required_keys`，测试覆盖了缺失 OpenAI base URL 的阻断。
Responses API endpoint、stream 和 strict structured output 也在配置验证中被约束。

provider auth reopen 有界且不会伪完成。候选条件限制为
`failed + retryable=false + stop_until_fixed` 且失败证据为 401、403 或认证失败文本；
reopen 后 checkpoint 只回到 `pending` 与 `continue_pending`，清空 command checks，
并写入 `normalCommandChecksRequired=true`。attempt count 使用现有 count 与
fingerprint 数量的最大值，达到 3 后阻断。

测试 hook 边界成立。`qmdRunner()` 与 `resumeRunnerArgs()` 同时要求 hook env 当前值
为 `1` 且变量名存在于脚本启动时的 `initialEnvNames`，因此 dotenv 加载后新增的
hook 变量不能激活 fake runner。

操作文档描述了只读观察、`env -u`、graph_vault dotenv 权威优先级、provider auth
reopen 条件、可观测字段和不持久化 `.env` 值的要求。文档本身不包含密钥原文。

## 验证

已运行以下聚焦测试，未启动真实批处理，未调用 provider API：

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli.test.ts -t "provider auth"
```

结果：1 个测试文件通过，10 个 provider auth 相关测试通过，188 个测试跳过。

```text
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli.test.ts \
  -t "test qmd runner hook is not activated from dotenv"
```

结果：1 个测试文件通过，1 个 test hook 边界测试通过，197 个测试跳过。

## 残余风险

当前测试未覆盖“非必需 provider env shadow”场景，例如 `JINA_API_BASE` 与
`graph_vault/.env` 不同但 required keys/endpoints 均 present 的组合。该缺口正是本
报告 FAIL 的直接原因。
