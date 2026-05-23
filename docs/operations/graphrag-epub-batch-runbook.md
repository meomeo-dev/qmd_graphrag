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

- `manifest.json`：`BatchRunManifest`，记录 runId、sourceDir、stateRoot、
  qmdIndexPath、configPath、item 计数和当前状态。
- `items/<itemId>.json`：`BatchItemCheckpoint`，记录单本 EPUB 的 source
  locator、normalized locator、status、attempts、bookId、errorSummary 和
  CLI check 结果。
- `events.jsonl`：`BatchEventLog`，逐行记录 batch/item/command 事件。

状态取值：

- `pending`：未开始。
- `running`：当前 item 正在执行。
- `completed`：当前 item 的 GraphRAG 闭环和 CLI 检查通过。
- `failed`：当前 item 重试耗尽或遇到非 transient 错误。

## 恢复规则

批量恢复顺序固定：

1. 读取 `manifest.json` 和 `items/*.json`。
2. 跳过 `completed` item。
3. 对第一个非 completed item 调用单书 resume。
4. 单书 resume 读取 `BookResumePlan.nextStage`。
5. `nextStage` 为 `null` 时只运行查询和 CLI 检查。
6. `nextStage` 非空时只执行该 stage，不重跑已完成 stage。

同一 runId 再次运行不会重跑已 completed item。更换 runId 会创建新的批量审计
记录，但单书仍由 `BookResumePlan.nextStage` 防止重复高成本 stage。

## Provider 限流与重试

以下错误归类为 transient failure：

- `Concurrency limit exceeded`
- `rate limit`
- `timeout`
- HTTP `429`
- HTTP `500`
- HTTP `502`
- HTTP `503`
- HTTP `504`

批量执行器对 transient failure 做有限重试和退避。重试耗尽后：

- 当前 item 标记为 failed。
- `events.jsonl` 写入 redacted error summary。
- 批量停止，不继续处理后续 item。
- 已 completed item 保持 completed，不回滚。

## 子命令检查

每本书闭环后运行 CLI 检查集：

- `qmd --version`
- `qmd status`
- `qmd doctor --json`
- `qmd pull`
- `qmd update`
- `qmd embed --max-docs-per-batch 1`
- `qmd ls books`
- `qmd search` 的 json/csv/md/xml/files 输出
- `qmd vsearch --json`
- `qmd query --json`
- `qmd query --mode auto --json`
- `qmd query --graphrag --json`
- `qmd get`
- `qmd multi-get --json`
- collection/context/skills/dspy/cleanup 子命令

`qmd vsearch` 是向量检索（vector search）检查，只允许 embedding/vector
lookup，不允许 query expansion、OpenAI Responses generation、DSPy expansion、
rerank 或 GraphRAG provider。

## 密钥与日志

执行器加载项目 `.env`，但不打印密钥值。日志和状态文件只保存：

- provider 名称。
- status code 或错误分类。
- redacted message。
- 文件 basename 或 vault-relative locator。

`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`JINA_API_KEY` 等值不得写入
`graph_vault`、stdout、stderr、manifest 或 event log。
