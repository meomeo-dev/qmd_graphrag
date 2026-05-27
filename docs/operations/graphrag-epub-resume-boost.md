# GraphRAG EPUB 续跑速查

## 目标

本文件用于上下文恢复（context recovery）时快速接续图书处理，不替代完整
操作手册。完整规则见
`docs/operations/graphrag-epub-batch-runbook.md`。

当前任务边界：

- 处理 `inbox/软件工程与系统设计经典著作指南/` 下全部 EPUB。
- 一本书必须形成闭环（book closed loop）后才算完成。
- 闭环包括 qmd 构建状态、GraphRAG 构建状态、GraphRAG 查询状态，以及 27 个
  qmd CLI 子命令检查全部通过。
- 默认续跑必须真实执行 qmd 与 GraphRAG，不用 skipped/imported checkpoint
  代替完成状态。

## 固定路径

仓库根目录：

```text
/Users/jin/projects/qmd_graphrag
```

输入 EPUB：

```text
inbox/软件工程与系统设计经典著作指南
```

状态根目录：

```text
graph_vault
```

qmd 索引与配置：

```text
.qmd/index.sqlite
.qmd/index.yml
.env
```

Python sidecar：

```text
.venv-graphrag/bin/python
```

批次状态目录：

```text
graph_vault/catalog/batch-runs/<runId>
```

## 审计收口状态

`audit/` 和 `audits/` 顶层目录使用状态后缀：

- `__open`：当前仍需关注和收口的审计案例（audit case）。
- `__closed`：历史审计案例，默认不再作为恢复入口。

当前唯一打开的审计案例：

```text
audits/graphrag-query-ready-parallel-runner-run_20260527_r1__open
```

该案例覆盖两个事实：

- 当前真实阻塞是
  `Code Complete, Second Edition (Steve McConnell [Steve McConnell]).epub`
  在 `resume-book-2` 失败：
  `query_ready requires completed graph_extract, community_report and embed stages`。
  这是 producer-lineage / 当前 checkpoint 调和问题，不能继续保持
  `unknown + stop_until_fixed`。
- 用户提出并行 runner 设计问题：Jina 请求时 GraphRAG 不会请求 ChatGPT，资源可能
  闲置。但当前系统尚不支持多个无协调 writer 同时处理同一 runId，多 runner 只能
  在 item/book lease、catalog writer lane、qmd index lane、provider semaphore 和
  fencing token 完成后启用。

前序 GraphRAG qmd build gate 开发审计已关闭：

```text
audit/graphrag-qmd-build-gate-dev-run_20260527_r5__closed
```

当前修复与复审必须写入同一个 `__open` 目录，不能为同一失败项新建 r2、r3
等审计目录。

收口规则：

- 上下文恢复时先找 `audit/*__open`，只允许存在一个打开目录。
- 同一失败项的修复复审写入当前 `__open` 目录，例如
  `agent-a/reaudit-after-fix.md`。
- 三个代理在同一固定基准下复审全部 PASS 后，才把目录从 `__open` 重命名为
  `__closed`。
- 若出现新问题且不属于当前打开案例，必须先明确关闭或保留当前案例状态，再创建
  新的 `__open` 审计案例。

## 当前正式续跑批次

优先恢复同一个 runId：

```text
epub-batch-20260527-real-resume-1
```

该 runId 是当前全量真实批次（full real batch）的恢复点。不要因为上下文丢失
而新建 runId，除非显式要开启新的审计批次或重新定义任务边界。

最近只读状态快照（2026-05-27T11:47:03Z）：

- 总数（total）：38 本。
- completed：5 本。
- pending：32 本。
- running：0 本。
- failed：1 本。
- recoveryDecision：`stop_until_fixed`。
- retryableItemCount：2。
- failed item：`Code Complete, Second Edition (Steve McConnell [Steve McConnell]).epub`。
- failedStage：`resume-book-2`。
- errorSummary：
  `query_ready requires completed graph_extract, community_report and embed stages`。
- 未发现活跃的 `batch-epub-workflow` 或 `resume-book-workspace` 旧 runner。

快照只用于定位。继续前必须重新执行只读状态命令，不得相信旧时间点状态。

## 先只读观察

进入仓库根目录后执行：

```text
docs/operations/graphrag-epub-resume-commands.md#状态投影
```

`--status-json` 是只读投影（read-only projection）。它不执行 EPUB
规范化、GraphRAG、OpenAI Responses、Jina 或 qmd CLI 子命令，也不写入
manifest、checkpoint 或 event log。

观察点：

- `manifest.status` 是否为 `completed`、`running`、`incomplete` 或 `failed`。
- `completedItems` 是否等于 `totalItems`。
- 是否存在 `runningItems > 0`。
- `items[].runnerPid`、`runnerHost`、`runnerHeartbeatAt` 是否仍表示活跃 runner。
- `retryableItemCount`、`nextRetryAt` 和 `waitingForProviderRecovery` 是否说明
  需要等待 provider/network 恢复。

## 判断是否可启动写入续跑

先检查状态中的 runner PID：

```bash
ps -p <runnerPid> -o pid=,ppid=,stat=,etime=,command= || true
```

判定规则：

- 若 runner 进程仍存在，且 heartbeat 未过期，只观察，不启动第二个同 runId
  写入 runner。
- 若 runner 进程不存在、heartbeat 过期，或批次已因 provider recovery wait
  limit 退出为 `incomplete`，使用同一个 runId 启动写入续跑。
- 若 `manifest.status=completed` 且 `completedItems == totalItems`，停止，不再
  续跑。
- 若存在 `failed` 且 `recoveryDecision=stop_until_fixed`，先按故障分流处理，
  不用新 runId 掩盖失败。

默认 heartbeat TTL 由执行器按 `max(commandTimeoutSeconds * 2, 3600)` 计算。
当前默认 `commandTimeoutSeconds=21600`，所以 TTL 为 12 小时。

## 写入续跑命令

仅在确认没有活跃 runner 后执行：

```text
docs/operations/graphrag-epub-resume-commands.md#写入续跑
```

使用 `env -u` 的原因：

- 当前 shell 可能保留旧的 provider 环境变量。若 shell env 与权威 dotenv
  不同，批处理会判定为遮蔽（shadow）并阻断 provider auth reopen。
- 未被 shell env 预先占用时，dotenv 加载顺序是项目根 `.env` 后
  `graph_vault/.env`；同名变量以 `graph_vault/.env` 为当前批处理的权威值
  （authoritative value）。
- 若 shell 里的 `OPENAI_API_KEY` 或 `OPENAI_BASE_URL` 与
  `graph_vault/.env` 不同，`--status-json` 会将旧 provider auth 失败投影为
  `providerAuthReopenDecision=blocked_provider_auth_not_ready`，并显示
  `providerAuthReopenBlockedReason=process_env_shadows_dotenv`。
- 使用 `env -u` 后，执行器从 `graph_vault/.env` 加载当前配置，并可将旧 `401`
  provider auth stop checkpoint 有界重开（bounded reopen）。

续跑行为：

- 跳过已 completed item。
- 对 retryable transient failure 使用同一 runId 重试。
- 对 provider recovery wait item 等待 `nextRetryAt` 后继续。
- 对 stale completed 或缺失命令检查的 checkpoint 降级后补跑。
- 不把 `skipped`、`importedCompletedItems` 或旧 seed 当作真实完成。

## Provider Auth 恢复机制

provider auth failure 包括 HTTP `401`、`403`、`INVALID_API_KEY`、
`unauthorized`、`forbidden` 或明确 authentication failure 文本。该类失败保持
`failureKind=permanent`、`retryable=false`、`recoveryDecision=stop_until_fixed`，
不会进入 transient provider wait。

正常写入 runner 会在全局 stop 前执行 provider auth reopen pass：

- 只处理 `failed + retryable=false + stop_until_fixed` 且证据明确为 provider
  auth failure 的 checkpoint。
- 当前 provider context 必须 ready：必需 key present、OpenAI Responses 必需
  `OPENAI_BASE_URL` present、provider 配置可读且有效，并且没有旧 shell env
  遮蔽任何 observed provider dotenv，包括 `JINA_API_BASE` 这类 endpoint。
- provider auth 配置不可读或不符合运行时约束时，reopen 必须 fail-closed，
  投影为 `provider_auth_config_unreadable`，不得继续高成本路径。
- 新失败会记录当前 redacted provider auth fingerprint。
- 旧 checkpoint 若没有失败时 fingerprint，只允许当前 fingerprint 自动重开一次，
  并写 `legacyProviderAuthFingerprintMissing=true`。
- 同一 current fingerprint 已重开过或与失败 fingerprint 相同时，不会再次重开。
- 重开只把 item 改回 `pending` 和 `continue_pending`，不会写 `completed`。
- 之后必须重新走正常 `markItemRunning -> runItem -> runGraphResume -> 27 个 qmd
  command checks` 闭环。

观测字段：

- `providerAuthReopenDecision`
- `providerAuthReopenEligible`
- `providerAuthReopenReason`
- `providerAuthReopenBlockedReason`
- `providerAuthConfigChanged`
- `providerAuthFailureFingerprint`
- `currentProviderAuthFingerprint`
- `lastProviderAuthReopenFingerprint`
- `providerAuthConfigReadStatus`
- `providerAuthConfigReadError`
- `providerAuthRequiredKeys`
- `providerAuthRequiredEndpoints`
- `providerAuthRequiredNames`
- `providerAuthKeyPresence`
- `providerAuthCredentialSources`
- `providerAuthReadinessStatus`
- `providerAuthMissingRequiredKeys`
- `providerAuthShadowedEnvNames`
- `providerAuthDotenvShadowedEnvNames`
- `providerAuthRootDotenvFingerprints`
- `providerAuthGraphVaultDotenvFingerprints`
- `providerAuthRootDotenvPresent`
- `providerAuthGraphVaultDotenvPresent`
- `providerAuthReopenAttemptCount`
- `legacyProviderAuthFingerprintMissing`

事件：`item_provider_auth_reopen_blocked`、
`item_provider_auth_reopened`、`item_provider_auth_refailed`。

状态、事件和 summary 只保存 present/missing、来源（source）和 redacted
fingerprint，不保存 `.env` 值。解析到但被遮蔽的 dotenv secret 也会进入内存
脱敏集合，用于日志和事件清洗；不会持久化原值。

只读确认修复是否会被识别：

```text
docs/operations/graphrag-epub-resume-commands.md#provider-auth-修复识别
```

若目标 failed item 显示
`providerAuthReopenDecision=reopen_legacy_provider_auth_key_present` 或
`reopen_provider_auth_config_changed`，下一次写入 runner 会先重开该 item，再真实
重跑。

## GraphRAG Query Provider 恢复机制

GraphRAG query provider outage 的结构化签名（signature）：

```text
route=graphrag
stage=graphrag_query
provider=graphrag
capability=graph_query
code=provider_unavailable
```

该错误可能由 Jina/OpenAI/httpx/SSL/APIConnection 等上游网络或 provider 波动触发，
例如 `SSL: UNEXPECTED_EOF_WHILE_READING`。即使历史 payload 内部写有
`retryable=false`，批处理层也必须按运营恢复语义将该类错误重分类为 transient，
除非同时存在更强的永久证据，例如 401/403 provider auth、data compatibility 或
本地 artifact gate 失败。

该重分类只适用于 `stage=graphrag_query`。`stage=provider` 且消息为
`GraphRAG query provider is not configured.` 的 provider-not-configured
配置缺失仍为 non-retryable，不应进入 provider recovery wait。

状态投影应显示：

- `status=pending`
- `failureKind=transient`
- `retryable=true`
- `retryExhausted=false`
- `recoveryDecision=retry_same_run_id`
- `waitingForProviderRecovery=true`
- `nextRetryAt`
- `retryDelaySeconds`
- `providerRecoveryReason`

操作者动作：

- 先运行“状态投影”，确认没有活跃 runner，且目标 item 已从旧 failed 状态恢复为
  pending provider recovery wait。
- 等待 `nextRetryAt` 到达；如果时间已经过去，可直接用同一个 runId 写入续跑。
- 不删除 `graph_vault/books/<bookId>/output`，不新建 runId，不手改
  checkpoint 为 completed。
- 若再次失败且仍为 provider/network transient，继续按同一 runId 与
  provider recovery wait 机制恢复。

## 单本闭环准入

每本书只有满足以下条件才允许写入 `completed`：qmd build、GraphRAG build、
GraphRAG query 均为 `succeeded`；`commandChecks` 恰好包含 27 个固定名称检查
且全部 `passed`；GraphRAG 高成本阶段存在真实 producer lineage：
`graph_extract`、`community_report`、`embed`；`query_ready` 引用当前书的
book-scoped artifacts，输出目录必须是 `books/<bookId>/output`，不能是 host
absolute path。

固定命令检查集合以 `scripts/graphrag/batch-epub-workflow.mjs` 中
`requiredCommandCheckNames` 为准。完整列表见
`docs/operations/graphrag-epub-batch-runbook.md` 的“子命令检查”。

## 快速汇总命令

需要快速判断批次分布时，用命令附录中的本地 JSON 汇总脚本：

```text
docs/operations/graphrag-epub-resume-commands.md#快速汇总
```

## 常见故障分流

transient provider/network failure：典型文本包括 rate limit、timeout、
HTTP 429、HTTP 5xx、partial-output community report failure。不做设计审计，
不新建 runId；等待 `nextRetryAt` 后用同一 runId 续跑。若 provider recovery
wait limit 达到上限，批次可停在 `incomplete`，稍后仍用同一 runId 恢复。

local artifact gate failure：典型文本包括 GraphRAG document identity missing、
capability scope unknown、settings projection drift。执行器应优先走低成本
repair path，不能重跑高成本阶段或伪造 completed；repair 后仍必须重新进入
`query_ready` 与 27 个 command checks。

non-transient implementation/design failure：不通过新 runId 或手改 checkpoint
绕过。先在 `docs/` 中补充、修正或修剪设计，再按固定审计基准（fixed audit
criteria）做设计审计和开发审计。审计材料放入
`audit/<case>-run_<n>/<agent>/`，基准文件必须稳定保存。修复后从“先只读
观察”开始，用同一业务目标续跑。

## 禁止事项

- 禁止手动把 item checkpoint 改成 `completed`。
- 禁止删除、迁移或清空 `graph_vault/books/<bookId>/output` 来掩盖阶段门失败。
- 禁止把旧 run 的 skipped/imported checkpoint 当作真实完成。
- 禁止在已有活跃 runner 时启动第二个同 runId 写入 runner。
- 禁止把密钥、provider 原始请求体、响应体或 Bearer token 写入文档、日志或
  审计材料。

## 完成判定

最终停止条件只有一个：

```text
manifest.status == "completed"
completedItems == totalItems
failedItems == 0
runningItems == 0
pendingItems == 0
```

并且每个 completed item 均可从 checkpoint 重新计算出：

```text
qmdBuildStatus.status == "succeeded"
graphBuildStatus.status == "succeeded"
graphQueryStatus.status == "succeeded"
commandCheckStatus.status == "succeeded"
27 commandChecks all passed
```
