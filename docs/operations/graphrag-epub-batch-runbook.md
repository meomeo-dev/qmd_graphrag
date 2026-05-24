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
  （next retry time）和恢复决策。

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
`retryable=true` 且 `recoveryDecision=retry_same_run_id` 时自动重试。`retryable=false`
的 failed item 保持 failed，并继续处理其他 pending item。更换 runId 会创建新的
批量审计记录，但单书仍由 `BookResumePlan.nextStage` 防止重复高成本 stage。

从临时批次迁移到正式批次时，可用 `--completed-manifest <path>` 导入调度种子。
普通运行中导入只写入 checkpoint metadata 和 `importedCompletedItems` 统计，
item 仍保持 `pending` 并真实执行 qmd 与 GraphRAG 闭环。只有 `--migrate-only`
使用该种子生成 `skipped` checkpoint，用于只读迁移审计，不产生 `completed`
item。真实准入批次必须让每本 EPUB 形成 `completed` checkpoint。

旧 `completed` checkpoint 在加载时必须重新校验闭环证据。`qmdBuildStatus`
不得作为信任源；批量执行器必须从 `commandChecks` 重新计算 qmd 构建状态。
缺少 27 个固定名称 command checks、任一 command check 非 `passed`、缺少真实
GraphRAG producer lineage，或 `graphBuildStatus.status` 不能重新计算为
`succeeded`、`graphQueryStatus.status` 不能重新计算为 `succeeded` 的
checkpoint，必须降级为 `pending`，写入 `item_completed_reopened` 事件，并以
`recoveryDecision=continue_pending` 继续。
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

## Provider 限流与重试

以下错误归类为 transient failure：

- `Concurrency limit exceeded`
- `rate limit`
- `timeout`
- HTTP `429`
- HTTP `5xx`

除 `429` 外的 HTTP `4xx` 归类为 permanent failure，不自动重试。

批量执行器对 transient failure 做退避重试。GraphRAG 单书 resume 使用长
transient budget；普通 qmd CLI 检查仍使用较短命令重试。默认策略：

- `--max-command-attempts 3`
- `--max-transient-command-attempts 12`
- `--retry-base-delay-seconds 30`
- `--retry-max-delay-seconds 300`
- `--retry-budget-seconds 7200`
- `--command-timeout-seconds 5400`

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

重试预算耗尽后：

- 当前 item 进入 provider recovery wait，状态保持 `pending`。
- checkpoint 写入 `failureKind=transient`、`retryable=true`、
  `retryExhausted=false`、`recoveryDecision=retry_same_run_id`、`failedStage`、
  `nextRetryAt`、`retryDelaySeconds` 和 `waitingForProviderRecovery=true`。
- `events.jsonl` 写入 redacted error summary、provider status code、
  retryable 标记和恢复决策。
- 默认继续处理后续 pending item。使用 `--fail-fast` 时在当前 item 失败后停止。
- 已 completed item 保持 completed，不回滚。
- 同一 `runId` 到达 `nextRetryAt` 后继续该 item；不要求操作者新建 runId。

GraphRAG 输出生产者 manifest 必须保存在每本书的 book-scoped output 目录：

- `qmd_output_manifest.json` 的 `outputDir` 使用 `books/<bookId>/output`，不得写
  host absolute path。
- `stageProducerRunIds` 记录每个高成本 stage 的真实 producer run。
- `query_ready` 阶段也会刷新 producer manifest，使恢复后的 portable manifest
  记录完整高成本 stage lineage。
- `query_ready` 只接受 `books/<bookId>/output` 下的
  `community_reports.parquet` 和 `lancedb`。共享 `graph_vault/output` 产物不得
  发布 graph capability。
- `output/reports/indexing-engine.log` 只作为 stage health evidence 读取，不登记为
  query-ready graph artifact。
- stage gate 只接受当前 stage 对应 producer run 的 artifact。

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
`retryableItemCount`、最早 `nextRetryAt`，以及每本书的 `qmdBuildStatus`、
`graphBuildStatus`、`graphQueryStatus`、runner ownership 和 orphan 检测状态。
摘要不得包含密钥、Bearer token、原始 provider 请求体或响应体。

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
集一致，且全部为 `passed`。缺项、重复项或失败项均不得写入 completed。
每个 completed checkpoint 必须同时包含 `qmdBuildStatus.status=succeeded` 与
`graphBuildStatus.status=succeeded`、`graphQueryStatus.status=succeeded`。

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
