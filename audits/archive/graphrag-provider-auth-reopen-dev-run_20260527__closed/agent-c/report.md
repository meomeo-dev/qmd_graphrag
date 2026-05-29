# Provider Auth Reopen 开发审计报告

## 结论

审计结论：不通过（Fail）。

当前实现具备 provider auth failure 识别、legacy checkpoint reopen、同
fingerprint 去重、attempt limit、closed-loop command checks 与 summary
projection 的基础机制；但生产安全性（production safety）和测试完整性
（test completeness）仍不足。尤其是测试 runner override 可被普通环境或
dotenv 激活、auth readiness 未覆盖 OpenAI Responses 运行时必需 base URL、
root `.env` 与 `graph_vault/.env` 的 precedence/shadow 语义不够安全，且新增
测试只覆盖正路径。

本审计未读取或输出任何 `.env` 密钥值。只记录 `.env` present/missing、
redacted fingerprint 语义、source/shadow 类别和 checkpoint 状态。

## 审计范围

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- 只读参考：`scripts/graphrag/batch-checkpoint-hydration.mjs`、
  `docs/operations/graphrag-epub-resume-boost.md`、
  `catalog/data-bus.catalog.yaml`

## 验证记录

- `npm run test:types`：通过。
- `node --check scripts/graphrag/batch-epub-workflow.mjs`：通过。
- `node --check scripts/graphrag/batch-checkpoint-hydration.mjs`：通过。
- 未运行新增 provider-auth E2E 用例：当前仓库 root `.env` 与
  `graph_vault/.env` 均存在。该用例会触发 batch 脚本解析真实 dotenv；
  为满足“不读取/输出 `.env` 密钥值”的审计约束，本轮未执行。

## 当前真实 runId 风险快照

只读 JSON 采样时间：`2026-05-27T03:47:30.087Z`。

runId：`epub-batch-20260527-real-resume-1`。

状态摘要：

- manifest：`running`。
- total：38。
- running：1。
- pending：37。
- completed：0。
- failed：0。
- qmdBuildStatus：38 个 `pending`。
- graphBuildStatus：31 个 `failed`、5 个 `succeeded`、1 个 `running`、
  1 个 `stale`。
- graphQueryStatus：38 个 `pending`。
- 当前 provider auth stop candidate：0。
- 当前 active command：`resume-book-1`。
- runner heartbeat 存在且较新。

续跑风险判断：

- 当前真实 runId 已有写入 runner。不得启动第二个同 runId 写入 runner。
- 该状态已不同于 runbook 中较早的 `failed provider auth` 快照；继续处理图书前
  必须重新执行只读状态检查。
- 若 active runner 后续再次产生 provider auth failure，新实现会进入
  `stop_until_fixed` 或 legacy reopen 逻辑。此路径在当前测试中缺少足够负向
  覆盖，不建议作为已审计通过的生产恢复路径。

## 基准审计

| 基准 | 结果 | 审计意见 |
| --- | --- | --- |
| C01 候选边界 | 部分通过 | 候选条件要求 `failed`、`retryable=false`、`stop_until_fixed` 和 auth 证据，边界基本正确。但文本 token 包含宽泛的 `authentication`，存在误判非 provider auth permanent failure 的风险。 |
| C02 Auth 上下文完整性 | 不通过 | `providerAuthContext()` 记录 key presence、credential source 与 fingerprint，但 `requiredKeyNames` 只包含 API key，不包含 OpenAI Responses 运行时必需的 `OPENAI_BASE_URL`。配置读取失败时 `providerAuthConfig()` 使用空配置继续，属于 fail-open。 |
| C03 Dotenv 兼容性 | 不通过 | `loadDotenv()` 固定 root `.env` 优先，`graph_vault/.env` 只能补缺；当两者同名不同值时，graph_vault 修复值会被 root 值遮蔽。source 投影无法表达 root-over-vault shadow，shadowed dotenv 值也不进入 exact redaction 集合。 |
| C04 指纹安全 | 部分通过 | env value 只保存短 hash，当前 provider auth fingerprint 是组合 hash，未发现直接持久化密钥值。遗留风险是 shadowed dotenv 值未进入通用 redaction exact-value 列表。 |
| C05 Reopen 幂等与上限 | 通过 | 同一 current fingerprint 会被 `providerAuthReopenedFingerprints` 阻止重复 reopen；`maxProviderAuthReopenAttempts=3` 提供硬上限；blocked event 可观察。 |
| C06 Reopen 后闭环准入 | 通过 | reopen 后 checkpoint 回到 `pending`，清空旧 command checks，设置 `normalCommandChecksRequired=true`，完成仍需 GraphRAG build、GraphRAG query 与 27 个 command checks。 |
| C07 生产安全停机策略 | 不通过 | unresolved auth failure 会停止当前 runner，这是正确的。但新增 `QMD_GRAPHRAG_TEST_QMD_RUNNER` 测试 hook 可通过普通 env/dotenv 激活，可能绕过真实 qmd 命令检查；代码也未在存在 active runner 时阻止另一个进程执行 reopen pass 写入。 |
| C08 旧 checkpoint 兼容 | 部分通过 | legacy checkpoint 缺少 failure fingerprint 时可被标记并 reopen，且 refail 后同 fingerprint 不会重复 reopen。但首次 legacy reopen 只能证明“当前 key present”，不能证明 key 已相对失败时变化。 |
| C09 观测与契约投影 | 部分通过 | checkpoint metadata、events、summary schema 已增加 provider auth reopen 字段；事件通过 `redactJsonValue()` 脱敏。契约和 catalog 尚未把 provider auth source/shadow 语义固化为枚举或 catalog 规则。 |
| C10 测试覆盖与可验证性 | 不通过 | 新增测试只覆盖 legacy reopen 正路径和运行时 auth stop。缺少 missing key、unchanged fingerprint、attempt limit、shadow、`--skip-dotenv`、root/vault precedence、refail no-reopen、summary redaction 等关键负向测试。 |

## 必须修复项

1. 隔离测试 runner override，禁止生产 dotenv 激活。

   证据：

   - `qmdRunner()` 在 `QMD_GRAPHRAG_TEST_QMD_RUNNER=1` 且
     `QMD_GRAPHRAG_QMD_RUNNER` 存在时执行任意 Node 脚本。
   - `loadDotenv()` 会在主流程开始时加载 root `.env` 与 `graph_vault/.env`。

   风险：

   - `.env` 中若残留测试变量，生产 batch 可执行假 qmd runner。
   - 假 runner 返回成功时，27 个 qmd command checks 可能被伪造为 passed。

   修复要求：

   - test runner override 必须只在测试进程显式、安全地启用。
   - 启用信号不得来自 root `.env` 或 `graph_vault/.env`。
   - 建议要求不可由 dotenv 注入的父进程 allowlist，例如
     `QMD_GRAPHRAG_ENABLE_TEST_HOOKS=1`，并在 `loadDotenv()` 前记录来源。

2. 将 OpenAI Responses base URL 纳入 auth readiness。

   证据：

   - `providerAuthConfig()` 的 `requiredKeyNames` 只包含 OpenAI/Jina API key。
   - runtime provider config 要求 `OPENAI_BASE_URL` 存在。

   风险：

   - `OPENAI_API_KEY` present 但 `OPENAI_BASE_URL` missing 时，reopen decision 可
     判定 ready，随后高成本图书仍会失败。

   修复要求：

   - `requiredKeyNames` 或等价 readiness 必须覆盖运行时必需的 auth endpoint
     输入。
   - 若某 provider 有默认 base URL，必须在代码和 summary 中明确 source。
   - missing required endpoint 时必须 blocked，不得 reopen。

3. 明确并测试 root `.env` 与 `graph_vault/.env` 的 precedence/shadow 规则。

   证据：

   - `loadDotenv()` 先加载 root `.env`，再加载 `graph_vault/.env`，且只补充
     `process.env[key] == null` 的变量。
   - `providerAuthSourceForKey()` 能表达 `process_env_shadows_dotenv`，但不能表达
     root 与 graph_vault 之间的 shadow。

   风险：

   - operator 只修复 `graph_vault/.env` 时，root `.env` 的旧值仍会获胜。
   - summary 可能显示 `project_dotenv`，但没有说明 graph_vault 存在不同值被遮蔽。
   - shadowed dotenv 值不在 `process.env` 中时，不能被 exact-value redaction
     覆盖。

   修复要求：

   - 明确 root 与 graph_vault 的 authoritative source。
   - 对同名不同 fingerprint 的 dotenv 值输出 redacted source/shadow 状态。
   - 将所有解析到的 dotenv secret 值加入内存 redaction 集合，但不得持久化值。

4. 改为 fail-closed 的 provider auth config 读取。

   证据：

   - `providerAuthConfig()` 捕获配置读取错误后使用 `{}` 继续。

   风险：

   - `.qmd/index.yml` 语法或 provider 配置损坏时，reopen 可能按默认 key 名继续，
     将配置错误误判为 auth 已 ready。

   修复要求：

   - 配置不可读或 provider auth 相关配置无效时，reopen decision 必须 blocked。
   - summary 应给出 redacted blocked reason，不得继续高成本路径。

5. 补齐 provider auth reopen 负向测试。

   最低测试集：

   - missing `OPENAI_API_KEY` blocked。
   - missing `OPENAI_BASE_URL` blocked，或证明默认值有效。
   - unchanged failure fingerprint blocked。
   - current fingerprint already reopened blocked。
   - attempt limit blocked。
   - process env shadows dotenv blocked 或按设计 ready。
   - root `.env` shadows `graph_vault/.env` 的 source/shadow 投影。
   - `--skip-dotenv` 下 dotenv 不注入且 summary 安全。
   - refail 后同 fingerprint 不再 reopen。
   - events、checkpoint、summary 不包含 synthetic secret values。

6. 让新增 E2E 测试不依赖真实仓库 `.env` 状态。

   证据：

   - 新用例写入 tmpRoot `.env`，但 batch 脚本的 `root` 是仓库根。
   - 本地仓库存在 root `.env` 与 `graph_vault/.env` 时，执行该用例会解析真实
     dotenv。

   风险：

   - 本地测试不可审计复现。
   - 测试可能因真实 `.env` 影响 source/shadow 与 fingerprint 结果。

   修复要求：

   - 测试应使用 `--skip-dotenv` 加显式 synthetic env，或提供只加载临时
     stateRoot dotenv 的测试入口。
   - 测试断言必须覆盖 real root `.env` present 时不会读取或使用真实密钥值。

## 建议项

1. 将 provider auth decision、blocked reason、credential source 定义为 enum
   schema，而不是任意 string。

2. 在 `catalog/data-bus.catalog.yaml` 中补充 provider auth reopen 的事件、summary
   字段、source/shadow 语义与 redaction 不变量。

3. 在 recovery summary 中增加 `missingRequiredKeys`、`shadowedEnvNames`、
   `rootDotenvPresent`、`graphVaultDotenvPresent` 的 redacted projection，避免
   operator 需要读取 checkpoint metadata。

4. 将 legacy reopen decision 文案从 `key_present` 调整为更保守的
   `legacy_auth_context_ready_unverified_change`，避免暗示已证明 key 修复。

5. 将宽泛的 `authentication` 文本匹配收窄到 provider auth 上下文，例如 provider
   status code、`invalid_api_key`、`unauthorized`、`forbidden`、OpenAI/Jina/LiteLLM
   auth error pattern。

6. 在启动写入 runner 前增加 active runner guard。若同 runId 中存在 fresh
   heartbeat 的 running checkpoint，第二个进程不应执行 reopen pass 或任何写入。

7. 对 `providerAuthSummaryProjection()` 做只读成本控制。status projection 可以
   读取 present/missing 与 fingerprint，但应避免在无 auth candidate 时重复解析
   dotenv。

## 生产续跑建议

当前真实 runId 已处于 `running`，且有 active runner heartbeat。操作建议：

1. 只执行 `--status-json` 或本地 JSON 只读检查。
2. 不启动第二个同 runId 写入 runner。
3. 若 active runner 后续停在 provider auth failure，先检查 summary 中的
   `providerAuthKeyPresence`、`providerAuthCredentialSources`、
   `providerAuthReopenDecision`、`providerAuthReopenBlockedReason`。
4. 仅在测试 runner override、required auth inputs、dotenv precedence/shadow
   三类必须修复项完成后，才把 provider auth reopen 作为生产恢复机制通过审计。

