# Dev Agent A Design Audit

## 结论 (Verdict)

FAIL.

设计方向可实施，但当前设计文档未满足 Dev Agent A 的全部 10 条固定基准。
主要缺口集中在可验证性 (verifiability)、证据边界 (evidence bounds)，以及
early-stop 与 Python bridge 子进程生命周期的接口契约。

## 阻断问题 (Blocking Issues)

### A-1: 缺少基准要求的测试验收设计

- 基准: #10。
- 设计位置: `docs/architecture/graphrag-partial-output-early-stop.md:33-69`。
- 相关实现位置:
  `test/graphrag-book-state.test.ts:746-805`,
  `test/cli.test.ts:1918-1942`,
  `src/integrations/python-bridge.ts:28-72`。

设计说明了 watcher、offset、终止和 fallback，但没有测试计划或验收矩阵。
现有测试只覆盖 stage-end health gate 的 offset 行为和 failure classifier，
没有覆盖 active-stage watcher、当前 Python bridge 子进程终止、终止后不得解析
partial stdout，以及 healthy log 的 early-stop non-regression。

建议修正:

- 在设计文档中新增 `Test Plan` 或 `Acceptance Tests` 小节。
- 覆盖 current-offset 行为: 旧日志中有 partial-output 信号时不得 early stop。
- 覆盖 process termination: watcher 检测到当前 stage 追加信号后，只终止当前
  `graphrag_index` Python bridge 子进程。
- 覆盖 stdout settlement: 子进程已写出 JSON partial stdout 时，early stop 仍
  reject，不得解析为 `GraphRagIndexResponse`。
- 覆盖 retry classification: early-stop 错误文本进入 batch 后得到
  `failureKind=transient`、`retryable=true`、`recoveryDecision=retry_same_run_id`。
- 覆盖 healthy logs: 当前 offset 之后没有 actionable partial-output 信号时，
  GraphRAG index 正常完成，query 和 DSPy bridge 不受影响。

### A-2: 证据边界未明确，不能保证满足 sanitized bounded evidence

- 基准: #9。
- 设计位置: `docs/architecture/graphrag-partial-output-early-stop.md:71-80`。
- 相关实现位置:
  `src/job-state/graphrag-book.ts:205-216`,
  `scripts/graphrag/batch-epub-workflow.mjs:1023-1035`,
  `scripts/graphrag/resume-book-workspace.mjs:107-109`。

设计要求错误文本包含 stage、failure kind、sanitized log evidence、locator 和
offset，但没有规定 evidence line 数量、单行长度、总错误长度或结构化字段顺序。
batch redaction 会截断到 1000 字符；如果 early-stop error 携带过多日志，可能
丢失 stage、locator 或 offsets，无法稳定满足审计基准。

建议修正:

- 明确 evidence contract，例如最多 20 条 actionable lines，每行最多 240 字符。
- 错误文本固定包含:
  `GraphRAG stage report partial-output failure`,
  `stage`,
  `failureKind=partial_output`,
  `logLocator`,
  `logStartOffset`,
  `logEndOffset`,
  `evidence`.
- locator 使用项目相对或 vault 相对路径；不要输出未清洗的绝对路径。
- 使用现有 sanitization/redaction 边界，避免 token、URL credential、绝对路径
  或 provider payload 泄漏。
- 将 evidence bound 写入设计和测试断言。

### A-3: bridge early-stop 接口和 settlement 规则仍不够可实施

- 基准: #3、#4、#10。
- 设计位置: `docs/architecture/graphrag-partial-output-early-stop.md:39-47`,
  `docs/architecture/graphrag-partial-output-early-stop.md:57-69`。
- 相关实现位置:
  `src/contracts/graphrag.ts:78-89`,
  `src/integrations/graphrag.ts:286-331`,
  `src/integrations/python-bridge.ts:28-72`,
  `scripts/graphrag/resume-book-workspace.mjs:1262-1287`。

设计说 early stop opt-in 需要 `reportDir`、`stage`、`logStartOffset`，但当前
`GraphRagIndexRequestSchema` 只有 `reportDir`，没有 `stage` 或 `logStartOffset`。
`callPythonBridge` 目前也不暴露 child-control 或 abort/watcher option。若不明确
接口，开发时容易出现两类风险: watcher 在 bridge 外部无法终止子进程，或检测
与 `close`/stdout parse 竞态时错误地 resolve 成功。

建议修正:

- 在设计中明确 TS-only API 形状，例如:
  `earlyStop?: { stage; reportDir; logStartOffset }`，且只对
  `command="graphrag_index"` 生效。
- 明确 watcher 由拥有 `ChildProcess` 的 `callPythonBridge` 或等价 bridge 层
  启动和停止；不得使用 `killall`、进程名匹配或跨 book/process-group 清理。
- 明确 settle-once 规则:
  检测到 partial-output 后记录 early-stop error，停止 watcher，向当前 child
  发送 `SIGTERM`，必要时只对同一 child PID 升级 `SIGKILL`。
- 明确如果 early-stop error 已记录，`close` handler 必须 reject 该错误，
  不得解析 stdout；如果进程先正常退出，watcher 停止，stage-end health gate
  继续作为 correctness fallback。

## 基准核对 (Baseline Check)

- #1 PASS: 设计指定只监控当前 `reportDir/indexing-engine.log`，并从
  `graphRagIndexLogOffset` 开始读取。
- #2 PASS with clarification: 设计通过复用 `assertGraphRagStageReportHealthy`
  的 actionable partial-output patterns 覆盖三类信号；建议在文档中显式列出
  `Community Report Extraction Error`、`error generating community report`、
  `No report found for community`。
- #3 FAIL: 设计意图正确，但缺少 bridge child-control API 和禁止误杀的具体
  settlement/termination 规则。
- #4 FAIL: 设计声明必须 reject，但缺少终止与 stdout parse 竞态的可执行规则。
- #5 PASS: `GraphRAG stage report partial-output failure` 已可被 batch classifier
  归为 retryable provider/transient failure，并由 batch runner 映射到
  `retry_same_run_id`。
- #6 PASS: 设计要求失败 attempt 不发布 producer manifest、`query_ready` 或
  `graph_query` capability；现有 stage-end 顺序也在 manifest 发布前做 health gate。
- #7 PASS: 设计保留 stage-end health checking 作为 fallback。
- #8 PASS: 设计声明已有完成阶段和其他 books 不应被修改，retry 复用既有
  resume plan。
- #9 FAIL: 设计未明确 bounded evidence lines 和截断/清洗规则。
- #10 FAIL: 设计缺少 active watcher、process termination、retry classification
  和 healthy log non-regression 的测试验收条款。

## 非阻断建议 (Recommendations)

- 复用 `checkGraphRagStageReportHealth` 或抽取共享 matcher，避免 watcher 与
  stage-end gate 的 pattern drift。
- early-stop error 使用小型结构化 JSON 片段，优先放置 stage、locator 和 offsets，
  防止 batch errorSummary 截断后丢失关键字段。
- `runGraphRagIndex` 当前会在 bridge 调用前写 provider request fingerprint artifact；
  该文件不是 producer manifest，但设计可明确失败 attempt 不写 cost ledger、不发布
  GraphRAG output producer manifest。
- 在 `resume-book-workspace.mjs` 中保持当前顺序: capture offset，调用
  `graphIndex`，执行 stage-end health gate，随后才写 producer manifest 和
  completeStage。
