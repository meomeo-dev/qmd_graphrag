# GraphRAG Partial-Output Early Stop Design Reaudit 1

结论：PASS

## 审计范围

本复审固定使用 `baseline.md` 的 10 条基准，基准未变更。复审对象为修订后的
`docs/architecture/graphrag-partial-output-early-stop.md`。本报告仅判断设计
是否补齐前次阻断项，不代表源码实现已通过验收。

## 总体判断

修订设计已补齐前次 FAIL 的核心缺口。新增的 `Interface Contract`、
`Child Lifecycle`、`Failed Attempt Output`、`Observability` 和 `Test Plan`
把 watcher lifecycle、child cleanup、secret redaction、source/dist runtime
compatibility、fake long-running bridge testability 从意图描述提升为可执行
设计合同（executable design contract）。

设计仍有实现阶段需要严格验证的点，例如 stage-owned cleanup 的精确文件边界、
跨平台 kill 行为、以及 source/dist 测试是否真实覆盖构建产物。但这些已经作为
设计要求写入文档，不再构成本轮设计审计阻断。

## 基准逐条复判

1. PASS。设计要求 watcher 在 bridge 运行期间扫描当前阶段追加日志，并在发现
   actionable partial-output evidence 后终止当前 Python bridge child，能减少
   provider waste，而不是仅在 stage 完成后重标记失败。

2. PASS。设计把 early stop 定义为 TypeScript bridge runtime option，并明确
   只由 `runGraphRagIndex` 在 `graphrag_index` 场景传入；`graphQuery`、DSPy、
   qmd search/query、Jina embedding 均不得接收 watcher option。

3. PASS。设计继续依赖现有 batch failure classifier，将
   `GraphRAG stage report partial-output failure` 分类为 retryable provider
   recovery，并未要求改变 provider transient precedence 或
   data-compatibility fail-closed 逻辑。

4. PASS。设计新增 watcher lifecycle 要求：poll interval 默认不低于 250 ms、
   无 busy wait，并且在 successful child exit、child error、early-stop
   termination、forced kill 等路径清理 timer 和 file descriptor。该合同足以
   防止设计层面的 spin 与 watcher leak。

5. PASS。设计新增 settle-once child lifecycle：检测后停止 polling、只向当前
   child PID 发送 `SIGTERM`，bounded grace period 后对同一 PID 发送 `SIGKILL`，
   child close 后用已存 early-stop error 拒绝；同时禁止 early-stop 后解析
   stdout 为成功响应。

6. PASS。设计新增 evidence 脱敏和边界：最多 20 行、每行清洗并截断到 240
   字符，log locator 必须相对化，禁止绝对私有路径、URL credentials、API
   keys、provider payload bodies、environment values 泄露，并要求 batch log
   redaction 只是第二道防线。

7. PASS。设计未改变 GraphRAG settings projection 或
   `concurrent_requests: 5` 默认值，并要求现有调用者不受新增 optional runtime
   option 影响。

8. PASS。设计新增 source/dist invariant 和测试要求：source-runtime execution
   through `tsx` 与 built `dist` 必须共享同一实现路径，watcher path 必须通过
   source runtime 测试并保持可从 built `dist` 使用。

9. PASS。设计保留 stage-end health gate，并明确 watcher missed signal 或
   process exits first 时由 `assertGraphRagStageReportHealthy` 兜底。这识别了
   provider error without recognizable log line 的 residual risk。

10. PASS。设计新增 fake long-running bridge 测试计划：追加 partial-output log
    后只终止当前 fake Python bridge child，验证 stdout 不被解析为成功，并且不
    需要真实 provider calls。

## 前次阻断项复审

- watcher lifecycle：已补齐。设计定义了 owner、poll interval 下限、无 busy
  wait、settle 后清理 timer/file descriptor，以及所有 child 退出路径。
- child cleanup：已补齐。设计明确 `SIGTERM` 到 `SIGKILL` 的升级、同一 child
  PID、settle-once、early-stop error 优先和 stdout 不解析。
- secret redaction：已补齐。设计明确 evidence 数量、长度、清洗、locator
  相对化，以及 secrets、URL credentials、绝对路径和完整 provider payload 的
  禁止输出边界。
- source/dist runtime compatibility：已补齐。设计要求 source 与 dist 共享
  实现路径，并在测试计划中覆盖 built `dist` 可用性。
- fake long-running bridge testability：已补齐。设计要求 fake bridge 长运行、
  追加日志触发 early stop、验证 child termination、retry classification 和
  stdout settlement。

## 实现验收关注点

- `resume-book-workspace.mjs` 必须能够把 `stage` 与 `logStartOffset` 传入
  `runGraphRagIndex` 或等价 runtime-only option，否则设计合同会落空。
- stage-owned cleanup 必须有白名单或 attempt isolation，不能误删 prior
  successful-stage artifacts、其他 books、catalog、batch manifest 或 command
  logs。
- source/dist compatibility 测试必须真实运行 build 后入口，不能只检查导出名。
