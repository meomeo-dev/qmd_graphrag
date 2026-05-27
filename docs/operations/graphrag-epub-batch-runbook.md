# GraphRAG EPUB 批量闭环操作手册

## 目标

批量 EPUB 处理以一本书为闭环单位（book-closed-loop unit）。每本书完成以下
步骤后才标记为 completed：

- EPUB 规范化为 `graph_vault/input/*.md`。
- qmd corpus registration、embedding 与 GraphRAG stage resume 完成。
- `qmd query --graphrag` 对该书 capability scope 可执行。
- qmd CLI 子命令检查通过。

批量执行不得把 inbox 作为恢复单位。恢复单位保持为 `bookId + stage`，批量层
只记录调度状态。

## 状态文件

批量运行目录为：

```text
graph_vault/catalog/batch-runs/<runId>/
```

必需文件：

- `manifest.json`：`BatchRunManifest`，记录 runId、sourceRootName、
  stateRootLocator、qmdIndexLocator、configLocator、item 计数和当前状态。
- `items/<itemId>.json`：`BatchItemCheckpoint`，记录单本 EPUB 的 source
  locator、normalized locator、status、attempts、bookId、errorSummary、
  `qmdBuildStatus`、`graphBuildStatus`、`graphQueryStatus` 和 CLI check 结果。
- `events.jsonl`：`BatchEventLog`，逐行记录 batch/item/command 事件。
- `recovery-summary.json`：批次观测摘要，记录每本书的 qmd/GraphRAG
  构建状态、GraphRAG query 检查状态、失败分类、下一次重试时间
  （next retry time）和恢复决策。发生 settings projection repair 时，摘要还必须
  记录 rewrite/reject decision、source fingerprint、project config locator、
  settings locator、evidence locator、active stage、active command 和 redacted
  reason。

状态取值：

- `pending`：未开始。
- `running`：当前 item 正在执行。
- `completed`：当前 item 的 GraphRAG 闭环和 CLI 检查通过。
- `failed`：当前 item 未完成。`failureKind`、`retryable` 和
  `recoveryDecision` 决定是否由同一 `runId` 自动恢复。

`running` checkpoint 必须写入 `runnerSessionId`、`runnerHost`、`runnerPid` 和
`runnerHeartbeatAt`。同一 `runId` 再次启动时，执行器校验 runner ownership：

- fresh remote `runnerHost` 或其他 `runnerSessionId` 表示该 item 由其他
  runner 拥有；正式运行和 `--status-json` 只观测，不抢占、不递增 attempts。
- ownership 字段缺失、`runnerHeartbeatAt` 超过 TTL，或当前主机找不到原
  `runnerPid` 时，item 降级为 `pending`。
- 降级事件写入 `item_running_recovered`，checkpoint 写入
  `orphanedRunnerDetectedAt`、`failureKind=transient`、`retryable=true` 和
  `recoveryDecision=retry_same_run_id`。

`BatchRunManifest` 必须记录 `pendingItems`、`runningItems`、`completedItems`、
`skippedItems`、`importedCompletedItems` 和 `failedItems`。批次完成条件只接受
`completedItems == totalItems`。`skippedItems` 是调度跳过记录，不得抵扣真实闭环
完成。

## 恢复规则

批量恢复顺序固定：

1. 读取 `manifest.json` 和 `items/*.json`。
2. 跳过 `completed` item。
3. 对第一个非 completed item 调用单书 resume。
4. 单书 resume 读取 `BookResumePlan.nextStage`。
5. `nextStage` 为 `null` 时只运行查询和 CLI 检查。
6. `nextStage` 非空时只执行该 stage，不重跑已完成 stage。

同一 runId 再次运行不会重跑已 completed item。`failed` item 只有在
`retryable=true` 且 `recoveryDecision=retry_same_run_id` 时自动重试。当前单
runner 发现 `failed + retryable=false + recoveryDecision=stop_until_fixed` 时会停止
调度后续图书，防止永久失败被新书进度掩盖。唯一例外是本地 query-ready、
graph-query readiness gate 或 producer-lineage gate 已被当前代码分类为可低成本修复
时，执行器必须先进入 repair path，可把 item 重新打开为 `pending`，写入
`item_local_artifact_gate_repair` 或等价 recovery event，并设置
`recoveryDecision=continue_pending` 或 repair 要求的同 runId 续跑决策。该 reopen
不得写入 `completed`，也不得绕过后续 qmd 与 GraphRAG query command checks。更换
runId 会创建新的批量审计记录，但单书仍由 `BookResumePlan.nextStage` 防止重复
高成本 stage。

本地 projection gate reopen 后，`BatchItemCheckpoint.metadata` 必须保留审计字段
（audit fields）：

- `reopenedFromStatus`：固定为历史状态，例如 `failed`。
- `reopenedToStatus`：固定为 `pending`。
- `reopenedFromRecoveryDecision`：历史恢复决策，例如 `stop_until_fixed`。
- `repairReason`：`graph_identity_projection_missing` 或
  `graph_query_capability_projection_missing`。
- `repairFailureText`：redacted persisted failure text。
- `repairedProjection`：`document_identity_map`、`graph_capability` 或二者。
- `repairEvidenceLocator`：sidecar、manifest 或 validated capability source
  locator。
- `reusedProducerRunIds`：`graph_extract`、`community_report` 和 `embed` run ids。
- `normalCommandChecksRequired`：固定为 `true`，表示 reopen 不等于 completed。

settings projection drift 使用同一 metadata/summary 投影面。真实失败文本
`graph_vault/settings.yaml is not the managed projection of .qmd/index.yml` 被分类为
`settings_projection_drift` 时，执行器必须使用与
`src/graphrag/settings-projection.ts` writer 等价的 loader 重新计算受管投影。若
`.qmd/index.yml` 有效、`settings.yaml` 带 qmd managed marker 且不是 user-owned
file，则 atomic rewrite `graph_vault/settings.yaml` 并继续当前
`BookResumePlan.nextStage`。若 source config invalid、缺少 managed marker 或会覆盖
user-owned file，则 fail-closed 并保留 redacted reason。重复同一 `runId` resume
必须幂等；第二次运行应观察到同一 fingerprint 和 projected content，不重复写入。
该修复不得删除、迁移、清空或标记 stale 任何
`graph_vault/books/<bookId>/output` 产物。

`events.jsonl` 和 `recovery-summary.json` 必须投影同一事实，操作者不应通过 raw
logs 才能判断为何从 `stop_until_fixed` 重新进入 pending repair。

从临时批次迁移到正式批次时，可用 `--completed-manifest <path>` 导入调度种子。
普通运行中导入只写入 checkpoint metadata 和 `importedCompletedItems` 统计，
item 仍保持 `pending` 并真实执行 qmd 与 GraphRAG 闭环。只有 `--migrate-only`
使用该种子生成 `skipped` checkpoint，用于只读迁移审计，不产生 `completed`
item。真实准入批次必须让每本 EPUB 形成 `completed` checkpoint。

旧 `completed` checkpoint 在加载时必须重新校验闭环证据。`qmdBuildStatus`
不得作为信任源；批量执行器必须从当前书的
`books/<bookId>/qmd/qmd_build_manifest.json` 重新计算 qmd 构建证据（build
evidence），并单独从 `commandChecks` 重新计算 27 个 CLI 检查证据。
缺少独立 qmd build manifest、缺少 27 个固定名称 command checks、任一
command check 非 `passed`、缺少真实 GraphRAG producer lineage，或
`graphBuildStatus.status` 不能重新计算为 `succeeded`、
`graphQueryStatus.status` 不能重新计算为 `succeeded` 的
checkpoint，必须降级为 `pending`，写入 `item_completed_reopened` 事件，并以
恢复证据决定下一步：若失败的 command check 是
`failureKind=transient` 且 `retryable=true`，则保持
`recoveryDecision=retry_same_run_id`、`retryExhausted=false`，等待同一
runId 恢复；缺失/不完整证据或非 transient command check 降级为
`recoveryDecision=continue_pending`，且不得写入
`retryExhausted=true`，避免把待修复/补跑状态误标为停止态。
该规则适用于 `--migrate-only`、`--status-json` 和正式运行。

`graphBuildStatus.status=succeeded` 的必要条件：

- `graph_extract`、`community_report`、`embed` 和 `query_ready` 都有非
  bootstrap 的 succeeded checkpoint。
- 每个高成本 checkpoint 引用的 artifactId 存在于当前书的
  `artifacts.yaml`，磁盘文件或目录存在，且路径位于
  `books/<book_id>/output/`。
- `graph_extract` 包含 documents、text units、entities、relationships、
  communities、context 和 stats 产物。
- `community_report` 包含 community reports 产物。
- `embed` 包含 `books/<book_id>/output/lancedb`。
- `query_ready` 同时引用 community report 与 LanceDB index artifact。
- `books/<book_id>/output/qmd_output_manifest.json` 的 `bookId`、`sourceHash`、
  `documentId`、`contentHash`、`providerFingerprint`、`stageFingerprints` 和
  `outputDir` 与当前书一致。
- `outputDir` 必须是 `books/<book_id>/output`，不得是 host absolute path。
- `stageProducerRunIds.graph_extract/community_report/embed` 必须与对应
  stage checkpoint 的 `runId` 一致。
- 高成本 stage checkpoint 的 `inputFingerprint`、`stageFingerprint` 和
  `providerFingerprint` 必须与 book job identity 一致。
- 高成本 stage artifact 的 `producerRunId`、`stageFingerprint` 和
  `providerFingerprint` 必须与对应 stage checkpoint 和 book job identity 一致。
- `DocumentIdentityMap.metadata.qmdCorpusRegistered=true`，并且同一
  `bookId/documentId/contentHash` 已持久化 `graphDocumentId` 与非空
  `graphTextUnitIds`。若 `qmd_graph_text_unit_identity.json` 已存在但 catalog
  缺少这些 graph fields，恢复必须先校验 sidecar 与 output manifest，再低成本修复
  catalog projection。
- identity sidecar adoption 还必须校验
  `bookId/sourceId/sourceHash/documentId/contentHash/normalizedPath` 均与当前
  book job、qmd corpus registration 和 `qmd_output_manifest.json` 一致。
  `normalizedPath` mismatch 必须 fail-closed，不能按 title、路径片段或首行猜测。
- 历史 checkpoint 若因
  `GraphRAG document identity is missing for query_ready` 或
  `capabilityScope references unknown or not-ready graphCapabilityId(s)` 停在
  `stop_until_fixed`，当前 failure classifier 必须把它重分类为本地 artifact
  gate failure，并进入同一低成本 repair path。repair 只能补
  `DocumentIdentityMap`、producer manifest 或 `query_ready` capability projection；
  不能重跑 `graph_extract`、`community_report` 或 `embed`，也不能伪造已通过的
  command check。

必须有 focused regression 覆盖真实失败文本：

- `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`：
  从 persisted `stop_until_fixed` checkpoint reopen 到 pending repair，利用
  validated `qmd_graph_text_unit_identity.json` 或 book-scoped output 修复
  `DocumentIdentityMap`，随后重新进入 `query_ready` 与 27 个 command checks。
- `capabilityScope references unknown or not-ready graphCapabilityId(s):
  book-356ff4920cdf-0bbd8bdb:graph_query`：仅在 validated `query_ready` lineage、
  artifact lineage 和 document identity 均有效时，重建 graph capability
  projection，并重新运行 `qmd query --graphrag` command check。
- `graph_vault/settings.yaml is not the managed projection of .qmd/index.yml`：
  valid source config 与 managed settings mismatch 时安全重写受管投影，并继续
  当前 `BookResumePlan`；user-owned settings、invalid source config、default-loaded
  config 比较错误和重复 same-runId resume 必须分别有负例或幂等断言。
- 两个回归都必须断言 `graph_extract`、`community_report`、`embed` producer
  run ids 不变，且 checkpoint 未被直接写成 `completed`。settings projection
  回归还必须断言 book-scoped GraphRAG output 未被删除或标记 stale。
- 负例必须证明 provider/network failure、mixed-book output、stale sidecar、
  source/content mismatch、normalizedPath mismatch、missing producer lineage、
  incomplete artifacts、user-owned settings 和 invalid source config 不会被本地
  projection reopen 或 unsafe rewrite。

## Provider 限流与重试

以下错误归类为 transient failure：

- `Concurrency limit exceeded`
- `rate limit`
- `timeout`
- HTTP `429`
- HTTP `5xx`
- 结构化 GraphRAG query provider failure：
  `route=graphrag`、`stage=graphrag_query`、`provider=graphrag`、
  `capability=graph_query`、`code=provider_unavailable`
- Jina/OpenAI/httpx/aiohttp/urllib3/APIConnection/SSL/TLS/DNS/connection reset
  等网络或 provider 连接错误

除 `429` 外的 HTTP `4xx` 归类为 permanent failure，不自动重试。

批量执行器对 transient failure 做退避重试。GraphRAG 单书 resume 使用长
transient budget；普通 qmd CLI 检查仍使用较短命令重试。默认策略：

- `--max-command-attempts 3`
- `--max-transient-command-attempts 12`
- `--retry-base-delay-seconds 30`
- `--retry-max-delay-seconds 300`
- `--retry-budget-seconds 7200`
- `--command-timeout-seconds 21600`

transient failure 发生后：

- command check 写入 `retryDelaySeconds` 和 `nextRetryAt`。
- item checkpoint 写入 `retryStartedAt`、`nextRetryAt`、`retryDelaySeconds`、
  `retryBudgetSeconds`、`failureKind=transient`、`retryable=true` 和
  `recoveryDecision=retry_same_run_id`。
- 预算内的 item 保持 `pending`，执行器等待 `nextRetryAt` 后自动重试。
- 批次继续处理其他 pending item，不因单本书等待上游恢复而停住。
- GraphRAG resume 使用 book-level retry budget。命令级 `attemptExhausted`
  只表示该命令当前尝试窗口结束；预算内不会写入 `command_retry_exhausted`
  作为终态事件。
- 当某本书的 `nextRetryAt` 尚未到达，执行器写入
  `item_retry_window_deferred`，继续处理其他可运行图书。只有当批次没有其他
  可运行图书时，执行器写入 `batch_wait_retry_window` 并等待最早的重试窗口。
- 单个命令超过 `commandTimeoutSeconds` 时按 transient timeout 处理，写入
  redacted command check，并进入相同退避恢复流程。
- GraphRAG stage 完成后，执行器只扫描本 stage 新增的
  `output/reports/indexing-engine.log` 片段。片段内出现 provider transient
  error、`Community Report Extraction Error` 或 `No report found for
  community` 时，本 stage 失败并进入相同恢复路径，不发布 stage checkpoint。
- `qmd-query-graphrag-json` 收到结构化
  `stage=graphrag_query`、`code=provider_unavailable` 时，执行器按 provider
  recovery wait 处理。`stage=provider` 的 provider-not-configured 配置缺失仍为
  non-retryable，不进入 provider recovery wait。历史 checkpoint 若已把 query
  stage payload 误写成
  `failureKind=unknown`、`retryable=false`、`recoveryDecision=stop_until_fixed`，
  当前加载、`--status-json` 和正式续跑都必须重分类为 transient pending。

重试预算耗尽后：

- 当前 item 进入 provider recovery wait，状态保持 `pending`。
- checkpoint 写入 `failureKind=transient`、`retryable=true`、
  `retryExhausted=false`、`recoveryDecision=retry_same_run_id`、`failedStage`、
  `nextRetryAt`、`retryDelaySeconds` 和 `waitingForProviderRecovery=true`。
- provider recovery wait 受 `maxProviderRecoveryWaits` 限制。达到上限后，
  当前 runner 写入 `batch_provider_recovery_wait_limit`，批次状态为
  `incomplete`，item 仍保持 `pending` 与 `retry_same_run_id`，由操作者或调度器在
  `nextRetryAt` 后使用同一 `runId` 恢复。
- `events.jsonl` 写入 redacted error summary、provider status code、
  retryable 标记和恢复决策。
- 默认继续处理后续 pending item。使用 `--fail-fast` 时在当前 item 失败后停止。
- 已 completed item 保持 completed，不回滚。
- 同一 `runId` 到达 `nextRetryAt` 后继续该 item；不要求操作者新建 runId。

GraphRAG 输出生产者 manifest 必须保存在每本书的 book-scoped output 目录：

- `qmd_output_manifest.json` 的 `outputDir` 使用 `books/<bookId>/output`，不得写
  host absolute path。
- `--migrate-only` 会把历史 absolute `outputDir` 重写为
  `books/<bookId>/output`，只在路径解析到当前 book-scoped output 时执行。
- `stageProducerRunIds` 记录每个高成本 stage 的真实 producer run。
- `query_ready` 阶段也会刷新 producer manifest，使恢复后的 portable manifest
  记录完整高成本 stage lineage。
- `query_ready` 只接受 `books/<bookId>/output` 下的
  `community_reports.parquet` 和 `lancedb`。共享 `graph_vault/output` 产物不得
  发布 graph capability。
- `qmd_graph_text_unit_identity.json` 是 GraphRAG documents/text units 的可验证
  repair evidence，不是 capability 发布事实源。`query_ready` 发布仍以
  `document-identity-map.yaml` 为读取源。
- sidecar repair 必须校验 `normalizedPath`。该字段是 normalized input locator
  contract，不参与 canonical identity，但决定当前 sidecar 能否被当前书 adoption。
- 有效 book-scoped output、producer lineage、qmd corpus registration 与 identity
  sidecar 已存在，但 catalog 缺失或陈旧时，失败归类为
  `graph_identity_projection_missing`。同一 runId resume 只补 catalog projection
  并重试 `query_ready`，不得重跑 `graph_extract`、`community_report` 或 `embed`。
- `graph_query_capability_projection_missing` 是 sibling 本地修复原因：当
  `query_ready` checkpoint、artifact lineage 和 document identity 均有效，但
  capability catalog 或 derived capability projection 尚未可读时，同一 runId resume
  只能重建 capability projection 并重新运行查询检查。
- identity repair 必须拒绝混书 output、source/content mismatch、空 text unit、
  text unit id 不存在、无效 `outputDir`、producer lineage 不一致，以及缺少有效
  sidecar 的多 GraphRAG document 歧义。
- `output/reports/indexing-engine.log` 只作为 stage health evidence 读取，不登记为
  query-ready graph artifact。
- stage gate 只接受当前 stage 对应 producer run 的 artifact。
- 历史失败文本
  `query_ready requires completed graph_extract, community_report and embed stages`
  表示 `query_ready` 门控发现 producer checkpoint 尚未调和。执行器应把它归入
  producer-lineage/local-artifact-gate recovery：若旧 producer lineage 可验证，则
  repair path 显式完成或调和 producer checkpoint；若不可验证，则返回
  `requiresRealRebuild=true` 和具体 rebuild stage。该错误不得保持
  `failureKind=unknown`。

## 并行 Runner 边界

当前正式批处理仍是单 writer runner。不要为了让 Jina 等待期间利用 OpenAI 或本地
资源而启动多个 `batch-epub-workflow` 进程写同一个 `runId`。

多 runner 并行启用前必须先实现以下资源控制：

- item lease 和 fencing token，保证同一 item 只有一个 writer。
- book lease，保证同一 `bookId` 的 checkpoint、artifact manifest 和 output 只有
  一个 writer。
- catalog writer lane，串行化 `graph_vault/catalog/*.yaml` 和 capability 发布。
- qmd index writer lane，串行化 `.qmd/index.sqlite`、corpus registration 和 qmd
  embedding 写入。
- provider semaphore，分别限制 OpenAI、Jina、GraphRAG LLM stage 和本地 CPU 工作。
- event/manifest aggregation，确保事件追加和 manifest 计数由 checkpoint 推导或由
  单协调器写入。

推荐的第一步不是多进程 runner，而是单进程 worker pool（single-process worker
pool）：一个 coordinator 拥有 manifest 和 catalog 写入，内部多个 worker 在 lease
和 semaphore 下处理不同书籍。该设计落地前，`status-json` 只用于观测，不能作为
启动第二个 writer 的许可。

恢复操作使用相同 runId 重新执行：

```bash
npm run batch:epub -- \
  --run-id <same-run-id> \
  --source-dir <same-source-dir> \
  --state-root <same-state-root> \
  --qmd-index-path <same-qmd-index-path> \
  --config <same-config> \
  --log-root /tmp/qmd-<same-run-id>/logs \
  --max-command-attempts <same-value> \
  --max-transient-command-attempts <same-value> \
  --retry-budget-seconds <same-value>
```

执行器跳过 completed item，只重试 retryable failed item 和继续 pending item。

恢复前执行安全状态迁移：

```bash
npm run batch:epub -- \
  --run-id <same-run-id> \
  --source-dir <same-source-dir> \
  --state-root <same-state-root> \
  --qmd-index-path <same-qmd-index-path> \
  --config <same-config> \
  --log-root /tmp/qmd-<same-run-id>/logs \
  --max-command-attempts <same-value> \
  --migrate-only
```

`--migrate-only` 只读取并重写 manifest/checkpoint，使旧状态满足当前 schema。
该模式不执行 EPUB 规范化、GraphRAG stage、OpenAI Responses、Jina 或 qmd CLI
子命令。

观测当前批次状态使用：

```bash
npm run batch:epub -- \
  --run-id <same-run-id> \
  --source-dir <same-source-dir> \
  --state-root <same-state-root> \
  --qmd-index-path <same-qmd-index-path> \
  --config <same-config> \
  --log-root /tmp/qmd-<same-run-id>/logs \
  --status-json
```

该命令输出只读状态投影（read-only projection），不执行 EPUB、GraphRAG、
OpenAI Responses、Jina 或 qmd CLI 子命令，也不写 manifest、checkpoint 或
event log。孤儿 `running`、stale completed 和 retry exhausted 等恢复决策只反映在
stdout 的单一 JSON 对象中。

`recovery-summary.json` 与 `--status-json` 输出均受
`BatchRecoverySummarySchema` 约束。摘要记录批次恢复决策、重试策略、
`maxProviderRecoveryWaits`、`retryableItemCount`、最早 `nextRetryAt`，以及每本书的
`qmdBuildStatus`、`commandCheckStatus`、`graphBuildStatus`、
`graphQueryStatus`、runner ownership 和 orphan 检测状态。摘要不得包含密钥、
Bearer token、原始 provider 请求体或响应体。

GraphRAG query provider outage 的期望观测面：

- `status=pending`
- `failureKind=transient`
- `retryable=true`
- `retryExhausted=false`
- `recoveryDecision=retry_same_run_id`
- `failedStage=qmd-query-graphrag-json`
- `waitingForProviderRecovery=true`
- `nextRetryAt`
- `retryDelaySeconds`
- `providerRecoveryReason`

若同一批次中存在任意
`failed + retryable=false + recoveryDecision=stop_until_fixed` 的非 transient item，
当前 writer 必须停止调度后续图书。该规则不限于 provider auth 或 data
compatibility；泛化永久失败同样必须阻止后续 `command_start`。

## 只读验证命令

恢复前后使用只读命令验证 manifest 与 item checkpoint：

```bash
node - <runId> <<'NODE'
const fs = require("fs");
const path = require("path");
const runId = process.argv[2];
const root = path.join("graph_vault", "catalog", "batch-runs", runId);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const itemDir = path.join(root, "items");
const items = fs.readdirSync(itemDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(fs.readFileSync(path.join(itemDir, name), "utf8")));
const required = [
  "qmd-version", "qmd-status", "qmd-doctor-json", "qmd-pull", "qmd-update",
  "qmd-embed", "qmd-ls-books", "qmd-search-json", "qmd-search-csv",
  "qmd-search-md", "qmd-search-xml", "qmd-search-files", "qmd-vsearch-json",
  "qmd-query-json", "qmd-query-auto-json", "qmd-query-graphrag-json",
  "qmd-get-book", "qmd-multi-get-json", "qmd-collection-list",
  "qmd-collection-show-books", "qmd-context-list", "qmd-skills-list-json",
  "qmd-skills-get-json", "qmd-skills-path-json", "qmd-skill-show",
  "qmd-dspy-status-json", "qmd-cleanup",
];
const counts = items.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] || 0) + 1;
  return acc;
}, {});
for (const item of items.filter((value) => value.status === "completed")) {
  const names = (item.commandChecks || []).map((check) => check.name).sort();
  if (names.length !== required.length) throw new Error(`${item.itemId}: bad check count`);
  if (names.join("\n") !== [...required].sort().join("\n")) {
    throw new Error(`${item.itemId}: bad command check names`);
  }
  if (item.commandChecks.some((check) => check.status !== "passed")) {
    throw new Error(`${item.itemId}: command check failed`);
  }
  if (item.qmdBuildStatus?.status !== "succeeded") {
    throw new Error(`${item.itemId}: qmd build not succeeded`);
  }
  if (item.graphBuildStatus?.status !== "succeeded") {
    throw new Error(`${item.itemId}: GraphRAG build not succeeded`);
  }
}
for (const item of items.filter((value) => value.status === "failed")) {
  for (const key of ["failureKind", "retryable", "recoveryDecision", "failedStage"]) {
    if (item[key] == null) throw new Error(`${item.itemId}: missing ${key}`);
  }
}
console.log(JSON.stringify({ manifest, counts, itemCount: items.length }, null, 2));
NODE
```

## 子命令检查

每本书闭环后运行 CLI 检查集：

- `qmd-version`：`qmd --version`
- `qmd-status`：`qmd status`
- `qmd-doctor-json`：`qmd doctor --json`
- `qmd-pull`：`qmd pull`
- `qmd-update`：`qmd update`
- `qmd-embed`：`qmd embed --max-docs-per-batch 1`
- `qmd-ls-books`：`qmd ls books`
- `qmd-search-json`：`qmd search --json`
- `qmd-search-csv`：`qmd search --csv`
- `qmd-search-md`：`qmd search --md`
- `qmd-search-xml`：`qmd search --xml`
- `qmd-search-files`：`qmd search --files`
- `qmd-vsearch-json`：`qmd vsearch --json`
- `qmd-query-json`：`qmd query --json`
- `qmd-query-auto-json`：`qmd query --mode auto --json`
- `qmd-query-graphrag-json`：`qmd query --graphrag --graph-book-id <bookId>
  --json`
- `qmd-get-book`：`qmd get`
- `qmd-multi-get-json`：`qmd multi-get --json`
- `qmd-collection-list`：`qmd collection list`
- `qmd-collection-show-books`：`qmd collection show books`
- `qmd-context-list`：`qmd context list`
- `qmd-skills-list-json`：`qmd skills list --json`
- `qmd-skills-get-json`：`qmd skills get qmd --json`
- `qmd-skills-path-json`：`qmd skills path qmd --json`
- `qmd-skill-show`：`qmd skill show`
- `qmd-dspy-status-json`：`qmd dspy status --json`
- `qmd-cleanup`：`qmd cleanup`

每个 completed checkpoint 必须包含 27 个 `commandChecks`，名称集合必须与上述检查
集 exact match，且全部为 `passed`。缺项、重复项、额外项或失败项均不得写入
completed。
每个 completed checkpoint 必须同时包含 `qmdBuildStatus.status=succeeded`、
`commandCheckStatus.status=succeeded`、`graphBuildStatus.status=succeeded`
与 `graphQueryStatus.status=succeeded`。其中 `qmdBuildStatus` 来自独立 qmd
build manifest，`commandCheckStatus` 来自 27 个 CLI 子命令检查。

`qmd vsearch` 是向量检索（vector search）检查，只允许 embedding/vector
lookup，不允许 query expansion、OpenAI Responses generation、DSPy expansion、
rerank 或 GraphRAG provider。

## 密钥与日志

执行器加载项目 `.env`，但不打印密钥值。日志和状态文件只保存：

- provider 名称。
- status code 或错误分类。
- redacted message。
- 文件 basename 或 project-relative portable locator。

`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`JINA_API_KEY`、URL userinfo 和 URL query
credential 等值不得写入 `graph_vault`、stdout、stderr、manifest 或 event log。
redaction 覆盖 `api_key`、`token`、`access_token`、`sig`、`signature`、
`secret`、`password`、`credential` 和 `client_secret`。

## 提交边界

以下 generated runtime outputs 不得提交到源码仓库：

- `graph_vault/` 运行状态、GraphRAG output、batch checkpoint、provider request
  fingerprint、cost ledger 和 runtime catalog。
- `.qmd/*.sqlite*` qmd index 与本地查询缓存。
- `inbox/` 原始 EPUB。
- `tmp/`、`/tmp/qmd-*`、GraphRAG report logs 和 batch log root。
- 原始 provider 请求体、响应体、密钥、Bearer token、URL userinfo 或 query
  credential。

`audit/<case>-run_<n>/` 下的固定审计基准、代理报告、状态文件和最终报告可提交，
但只能包含脱敏事实、判定、测试命令和摘要，不得复制 runtime 大产物。
