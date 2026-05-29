# Batch Command Heartbeat Observability Reaudit 1

总体结论：PASS。

当前未提交实现已修复上一轮阻塞问题。`runCommand()` 使用 `finally` 关闭
heartbeat monitor；monitor 使用 fd 3 pipe 作为父进程 lifeline，不再仅依赖
PID；item checkpoint 写入统一经过 lock 和 atomic rename，降低状态回退
（state rollback）与 JSON 损坏风险。失败路径仍按每次 attempt 记录 stdout、
stderr、command check 与 retry metadata。

## Scope

复审范围限定为当前未提交 diff：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `test/integrations/contracts.test.ts`

固定基准：

- `audit/batch-command-heartbeat-observability-run_1__closed/dev-agent-c/baseline.md`

## Criteria Result

1. PASS - monitor 使用 detached child、ignored stdio、`monitor.unref()`，父端
   lifeline stream 也调用 `unref()`，命令结束后不会保活主 batch runner。
   参考：`scripts/graphrag/batch-epub-workflow.mjs:1495`、
   `scripts/graphrag/batch-epub-workflow.mjs:1500`。
2. PASS - `runCommand()` 在 `finally` 中调用 `heartbeatMonitor?.stop()` 和
   `clearCommandHeartbeat()`，正常命令完成后有显式 shutdown path。
   参考：`scripts/graphrag/batch-epub-workflow.mjs:3156`、
   `scripts/graphrag/batch-epub-workflow.mjs:3174`。
3. PASS - monitor 建立 fd 3 read stream lifeline，父端关闭或父进程退出会使
   monitor 收到 EOF/close/error 并退出；PID 只保留为辅助校验，不再是唯一父
   死亡检测条件。参考：
   `scripts/graphrag/batch-epub-workflow.mjs:1371`、
   `scripts/graphrag/batch-epub-workflow.mjs:1393`。
4. PASS - monitor 只锁定和更新当前 item checkpoint，并在写入前重新读取、
   校验 status/session/host/pid，其他字段通过对象展开保留。参考：
   `scripts/graphrag/batch-epub-workflow.mjs:1439`。
5. PASS - 主 runner 与 monitor 对 checkpoint 使用同一 `.lock` 文件，并通过
   temp file + `renameSync()` 原子替换，避免上一轮发现的并发整文件写入导致
   completed/failed 回退为 running 或 JSON 半写入。参考：
   `scripts/graphrag/batch-epub-workflow.mjs:983`、
   `scripts/graphrag/batch-epub-workflow.mjs:1006`、
   `scripts/graphrag/batch-epub-workflow.mjs:1404`、
   `scripts/graphrag/batch-epub-workflow.mjs:1410`。
6. PASS - 实现使用 Node 支持的 `spawn` stdio pipe、`openSync("wx")`、
   `renameSync()`、`process.kill(pid, 0)` 等 API，满足项目 Node 平台的可移植
   性（portability）要求。Windows signal 语义仍由 pipe lifeline 覆盖。
7. PASS - 长运行命令通过新鲜 `runnerHeartbeatAt`、`currentCommand` 和
   `currentCommandStartedAt` 暴露；status-json 与 recovery summary schema 均
   支持这些字段。参考：`src/contracts/batch-run.ts:104`、
   `src/contracts/batch-run.ts:242`。
8. PASS - 失败处理仍在每次 attempt 后写 stdout/stderr log，构造一个 command
   check，并在 catch/recovery 路径追加一次 retry metadata；新增锁避免 monitor
   覆盖该结果。参考：
   `scripts/graphrag/batch-epub-workflow.mjs:3178`、
   `scripts/graphrag/batch-epub-workflow.mjs:3202`、
   `scripts/graphrag/batch-epub-workflow.mjs:4346`、
   `scripts/graphrag/batch-epub-workflow.mjs:4516`。
9. PASS - 新增测试使用本地 fake resume runner、临时目录和 status-json，不依
   赖 live LLM、GraphRAG 或网络。参考：`test/cli.test.ts:1511`。
10. PASS - 残余风险可接受并已在本报告记录：stale lock TTL 为 120 秒，极端
   情况下 monitor 可能在父进程异常死亡后等待 stale-lock 清理周期才退出；该
   风险不会恢复上一轮的永久状态回退/JSON 损坏模式。

## Previous FAIL Recheck

- Monitor cleanup：已修复。`stop()` 的 stop-file 写入和 lifeline close 都是
  best-effort，并且从 `runCommand()` 的 `finally` 调用。
- Parent death：已修复。fd 3 lifeline 让 monitor 通过 pipe EOF 观察父进程
  生命周期，不再仅靠 PID liveness。
- Concurrent checkpoint writes：已修复。checkpoint writer 使用锁和 atomic
  rename；monitor 也在持锁后重新读取 checkpoint 再校验 runner identity。
- Exactly-once failure metadata：未发现回归。目标失败路径测试通过，新增锁
  避免 heartbeat 覆盖最终 command check。
- Residual risk：可接受。stale lock cleanup 可能延迟 monitor 退出，但不会保
  活主 runner，也不会造成高概率永久 corruption。

## Verification

已运行只读检查和测试：

- PASS - `git diff --check -- scripts/graphrag/batch-epub-workflow.mjs src/contracts/batch-run.ts test/cli.test.ts test/integrations/contracts.test.ts`
- PASS - `npm run test:types`
- PASS - `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "updates batch checkpoint heartbeat while long commands run"`
- PASS - `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/integrations/contracts.test.ts -t "accepts batch execution bus envelopes with real schemas"`
- PASS - `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "fail-fast transient failure persists recoverable pending checkpoint"`
- PASS - `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "keeps GraphRAG resume failures out of qmd build evidence"`
- PASS - local Node fd 3 pipe lifeline probe: parent-side pipe destroy caused child
  process to exit on EOF.

未运行完整测试套件；本轮复审聚焦 heartbeat monitor lifecycle、checkpoint
并发写入、failure metadata 与相关 contract/schema 变更。
