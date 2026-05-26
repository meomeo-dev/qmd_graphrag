# GraphRAG Partial-Output Early Stop Design Audit

结论：FAIL

## 审计范围

本审计固定使用 `baseline.md` 的 10 条基准，不修改基准。审计对象为
`docs/architecture/graphrag-partial-output-early-stop.md`，并只读参考以下实现
路径：

- `src/integrations/python-bridge.ts`
- `src/integrations/graphrag.ts`
- `src/job-state/graphrag-book.ts`
- `scripts/graphrag/resume-book-workspace.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/batch-failure-classifier.mjs`
- `test/cli.test.ts`
- `test/graphrag-book-state.test.ts`

## 总体判断

设计方向满足早停目标的一部分：它把 early stop 放在 GraphRAG index 的
Python bridge 边界，使用当前阶段 report log 与 stage-start offset，并保留
stage-end health gate 作为最终正确性门禁。这能覆盖 provider waste reduction
的核心意图。

但该设计仍缺少若干可执行合同（executable contract），不足以保证实现满足
全部基准。关键缺口集中在 child cleanup、secret redaction、dist/source
runtime compatibility、fake long-running bridge testability，以及 watcher
生命周期边界。因此本轮设计审计不能通过。

## 基准逐条结论

1. PASS。设计要求 watcher 在 bridge 运行中扫描追加日志，并在发现
   actionable partial-output signal 后终止 Python bridge child。这是早于
   stage 完成的 provider waste reduction，而不是 stage-end 失败重标记。

2. PASS。设计明确 early stop 必须 opt-in 于带有 `reportDir`、`stage`、
   `logStartOffset` 的 GraphRAG index calls，且 query 和 DSPy bridge calls
   不受影响。Jina embedding 不经过该 bridge 边界，也未被设计纳入。

3. PASS。现有分类器中 provider status code 和 transient 文本优先于
   data-compatibility；设计复用 `GraphRAG stage report partial-output
   failure` 文本进入 retryable provider recovery，没有要求改变该优先级。

4. FAIL。设计只说“bounded log watcher”，未定义 polling interval、最大读取
   窗口、timer 清理、EOF/close 竞态处理、log 文件不存在时的退避行为，或
   promise settle 后如何停止 watcher。因此无法证明 watcher 不 spin、不泄漏。

5. FAIL。设计说“terminates the Python bridge child”，但没有规定
   graceful-then-forceful escalation、超时、跨平台 signal 行为、stdin/stdout
   关闭、`error`/`close` 双重 settle 防护，或 child 已退出时的幂等清理。
   这不满足确定性 cleanup 测试要求。

6. FAIL。设计要求 sanitized evidence，但未指定复用 `sanitizeVaultText`、
   `redactLog`，或等价规则；也未规定 evidence 截断、绝对路径移除、URL
   credentials、Bearer token、`sk-*`、环境变量精确值、完整 provider payload
   的处理。当前健康检查会把原始 evidence line 放入错误 JSON，设计没有补上
   early-stop 专属脱敏合同。

7. PASS。设计不涉及 GraphRAG settings projection 或
   `concurrent_requests`，现有默认与可配置行为可保持不变。

8. FAIL。现有脚本会在 git checkout 下通过 `tsx` 导入 `src/index.ts`，发布包
   下导入 `dist/index.js`；`callPythonBridge` 通过 `resolveProjectPath`
   解析 `python/qmd_graphrag/bridge.py`。设计未说明新增 watcher/helper 会放在
   哪个已导出的 runtime 边界、是否会被 build 输出、是否能被
   `resume-book-workspace.mjs` 的 source/dist 动态导入同时访问，也未说明相对
   Python bridge 路径在 dist 运行时如何验证。

9. PASS。设计明确如果 watcher misses a signal 或 process exits first，
   stage-end health gate 仍会执行。这识别了 provider error without
   recognizable log line 或无可识别早停日志时的残余风险，只是无法减少该类
   provider waste。

10. FAIL。设计没有要求或描述 fake long-running bridge process 测试。现有测试
    只覆盖 stage-end report health 和 batch runner 行为，没有覆盖在真实 child
    长时间运行期间写入 partial-output 日志、触发 early stop、验证 child 被
    杀掉且 promise 拒绝的测试路径。

## 阻断问题

- 缺少 child cleanup 合同：必须定义先温和终止再强制终止
  （graceful-then-forceful escalation）的时序、信号、超时和幂等 settle。
- 缺少 watcher 生命周期合同：必须定义 polling 上限、读取增量策略、timer
  cleanup、process close/error 竞态处理，以及 log 文件暂不存在时的行为。
- 缺少脱敏合同：early-stop 错误中的 evidence、locator、stdout/stderr fallback
  必须经过统一脱敏，并限制 evidence 条数和长度，禁止完整 provider payload。
- 缺少 source/dist 运行合同：新增 API 必须在 `src/index.ts` 导出并进入
  `dist/index.js`，且 `resume-book-workspace.mjs` 在两种运行模式下都能传入
  `stage`、`reportDir`、`logStartOffset`。
- 缺少 fake long-running bridge 测试合同：测试必须不调用真实 provider，并
  验证 early stop 发生在 child 自然退出前。

## 建议验收条件

- 为 `callPythonBridge` 增加 index-only observer option，默认关闭，并由
  `runGraphRagIndex` 只在 GraphRAG stage 调用时传入。
- watcher 使用当前阶段 offset 读取追加内容，复用现有 actionable pattern，
  并在 promise resolve/reject/child close/error 后清理所有 timer 和 listener。
- child 终止采用 `SIGTERM` 后限时 `SIGKILL`，并处理 Windows 或已退出进程的
  幂等情况。
- early-stop error 只包含 stage、`partial_output`、脱敏 evidence、相对或脱敏
  log locator、offsets；不得包含原始 provider body、绝对私有路径或 secrets。
- 增加 fake bridge 测试：child 启动后持续运行，测试进程向
  `indexing-engine.log` 追加 `Community Report Extraction Error`，断言 bridge
  被提前终止、错误可分类为 retryable provider recovery、不会解析 partial
  stdout 为成功响应。
