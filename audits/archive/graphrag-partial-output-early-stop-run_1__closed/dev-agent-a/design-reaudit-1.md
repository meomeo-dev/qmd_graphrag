# Dev Agent A Design Reaudit 1

## 结论 (Verdict)

PASS.

修订后的设计满足
`audit/graphrag-partial-output-early-stop-run_1__closed/dev-agent-a/baseline.md`
的 10 条固定基准。前次 FAIL 的测试验收设计、证据边界/清洗规则、bridge
early-stop 接口、子进程 termination/settle-once 规则均已补齐到可实施和可验证
程度。

## 前次 FAIL 复核 (Previous Failures)

### 测试验收设计

PASS.

- 设计位置: `docs/architecture/graphrag-partial-output-early-stop.md:196-221`。
- 已覆盖 current-offset watcher、active watcher、process termination、
  stdout settlement、retry classification、healthy non-regression、scope
  non-regression、source/dist compatibility 和 stage-end fallback。
- 满足基准 #10。

### 证据边界和清洗规则

PASS.

- 设计位置: `docs/architecture/graphrag-partial-output-early-stop.md:157-178`。
- 失败文本固定以前缀 `GraphRAG stage report partial-output failure` 开始，并包含
  `stage`、`failureKind`、`logLocator`、`logStartOffset`、`logEndOffset` 和
  `evidence`。
- evidence 明确限制为最多 20 条 actionable lines，单行清洗后截断到 240 字符。
- 设计要求 locator 使用相对路径，并禁止输出绝对私有路径、URL credential、API
  key、provider payload bodies 和环境值。
- 满足基准 #9。

### bridge early-stop 接口

PASS.

- 设计位置: `docs/architecture/graphrag-partial-output-early-stop.md:60-85`。
- early stop 被定义为 TypeScript bridge runtime-only option，不是 Python bridge
  request field，也不是 GraphRAG public contract。
- 该 option 只在 `graphrag_index` 且调用方提供 `stage`、`reportDir`、
  `logStartOffset` 时启用；GraphRAG query、DSPy、qmd search/query、Jina embedding
  不接收 watcher option。
- 满足基准 #1、#3、#8。

### 子进程 termination 和 settle-once

PASS.

- 设计位置: `docs/architecture/graphrag-partial-output-early-stop.md:87-108`。
- watcher 由拥有 `ChildProcess` 的 TypeScript bridge 层管理，禁止 process name
  matching、`killall` 和 process-group cleanup。
- 检测后只向当前 child PID 发送 `SIGTERM`，必要时只对同一 PID 升级 `SIGKILL`。
- 若 early-stop error 已记录，child close 后必须 reject；不得解析 partial 或 stale
  stdout 为 `GraphRagIndexResponse`。
- watcher 在成功、错误、early stop 和 forced kill 路径都必须清理 timer/file
  descriptor。
- 满足基准 #3、#4。

## 基准核对 (Baseline Check)

- #1 PASS: watcher 限定当前 `reportDir/indexing-engine.log`，从捕获的
  `graphRagIndexLogOffset`/`logStartOffset` 读取。
- #2 PASS: test plan 明确覆盖 `Community Report Extraction Error`、
  `error generating community report` 和 `No report found for community`。
- #3 PASS: termination 只作用于当前 Python GraphRAG index bridge child PID。
- #4 PASS: settle-once 规则保证 early stop 后 reject，且不解析 partial stdout。
- #5 PASS: 失败文本固定包含 classifier 已识别的 partial-output failure 文本，并保留
  `retry_same_run_id` 恢复路径。
- #6 PASS: 失败 attempt 不发布 producer manifest、`query_ready` 或 `graph_query`
  capability，并新增 residual output cleanup/isolation 要求。
- #7 PASS: stage-end health checking 仍是 correctness fallback。
- #8 PASS: cleanup 和 retry scope 明确不得触碰其他 books、完成阶段、catalog、
  batch manifests 或 command logs。
- #9 PASS: evidence 清洗、locator、offset 和 bounded lines 规则已明确。
- #10 PASS: test plan 覆盖 current-offset、termination、retry classification 和
  healthy log non-regression。

## 非阻断注意点 (Implementation Notes)

- 实现阶段需确保 `runGraphRagIndex`、`callPythonBridge` 和 source/dist runtime 使用
  同一 watcher 代码路径，避免测试只覆盖 source runtime。
- residual output cleanup 的 stage-owned artifact 列表需要和 artifact gate 的实际
  ownership 保持一致，避免误删 prior successful-stage artifacts。
