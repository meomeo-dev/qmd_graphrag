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
  `qmdBuildStatus`、`graphBuildStatus` 和 CLI check 结果。
- `events.jsonl`：`BatchEventLog`，逐行记录 batch/item/command 事件。

状态取值：

- `pending`：未开始。
- `running`：当前 item 正在执行。
- `completed`：当前 item 的 GraphRAG 闭环和 CLI 检查通过。
- `failed`：当前 item 未完成。`failureKind`、`retryable` 和
  `recoveryDecision` 决定是否由同一 `runId` 自动恢复。

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
导入只产生 `skipped` checkpoint 和 `importedCompletedItems` 统计，不产生
`completed` item。真实准入批次必须让每本 EPUB 形成 `completed` checkpoint。

旧 `completed` checkpoint 在加载时必须重新校验闭环证据。缺少
`qmdBuildStatus.status=succeeded` 或 `graphBuildStatus.status=succeeded` 的
checkpoint 必须降级为 `pending`，写入 `item_completed_reopened` 事件，并以
`recoveryDecision=continue_pending` 继续。该规则适用于 `--migrate-only` 和正式
运行。

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
- `books/<book_id>/output/qmd_output_manifest.json` 的 `bookId`、`sourceHash`
  和 `outputDir` 与当前书一致。

## Provider 限流与重试

以下错误归类为 transient failure：

- `Concurrency limit exceeded`
- `rate limit`
- `timeout`
- HTTP `429`
- HTTP `5xx`

除 `429` 外的 HTTP `4xx` 归类为 permanent failure，不自动重试。

批量执行器对 transient failure 做有限重试和退避。重试耗尽后：

- 当前 item 标记为 failed。
- checkpoint 写入 `failureKind=transient`、`retryable=true`、
  `retryExhausted=true`、`recoveryDecision=retry_same_run_id` 和 `failedStage`。
- `events.jsonl` 写入 redacted error summary、provider status code、
  retryable 标记和恢复决策。
- 默认继续处理后续 pending item。使用 `--fail-fast` 时在当前 item 失败后停止。
- 已 completed item 保持 completed，不回滚。

恢复操作使用相同 runId 重新执行：

```bash
npm run batch:epub -- \
  --run-id <same-run-id> \
  --source-dir <same-source-dir> \
  --state-root <same-state-root> \
  --qmd-index-path <same-qmd-index-path> \
  --config <same-config> \
  --log-root /tmp/qmd-<same-run-id>/logs \
  --max-command-attempts <same-value>
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
`graphBuildStatus.status=succeeded`。

`qmd vsearch` 是向量检索（vector search）检查，只允许 embedding/vector
lookup，不允许 query expansion、OpenAI Responses generation、DSPy expansion、
rerank 或 GraphRAG provider。

## 密钥与日志

执行器加载项目 `.env`，但不打印密钥值。日志和状态文件只保存：

- provider 名称。
- status code 或错误分类。
- redacted message。
- 文件 basename 或 project-relative portable locator。

`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`JINA_API_KEY` 等值不得写入
`graph_vault`、stdout、stderr、manifest 或 event log。
