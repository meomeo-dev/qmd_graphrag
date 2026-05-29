# Batch Command Heartbeat Observability Audit Report

总体结论：FAIL。

当前补丁提升了长命令可观测性（observability），并能在正常路径写入
`runnerHeartbeatAt`、`currentCommand` 和 `currentCommandStartedAt`。但是
monitor 生命周期（monitor lifecycle）和 checkpoint 并发写入仍存在会导致
残留 monitor、错误新鲜 heartbeat、以及 checkpoint 语义回退的风险，需要再
进行一次实现修复。

## Scope

审计范围限定为当前未提交 diff：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`

固定基准使用：
`audit/batch-command-heartbeat-observability-run_1__closed/dev-agent-c/baseline.md`

## Criteria Result

1. PASS - monitor 使用 `detached: true`、`stdio: "ignore"` 和 `unref()`，
   正常情况下不会把主 batch runner 保活。
2. PASS - 正常命令完成后存在显式 `stop()` 路径，并调用
   `clearCommandHeartbeat()` 清理当前命令字段；异常安全缺口见 Finding 1。
3. FAIL - monitor 只用父 PID 存活检查（PID liveness check），父进程异常
   退出后遇到 PID 复用时可能继续写入 heartbeat。
4. PASS - monitor 目标路径是当前 item checkpoint，且用对象展开保留已读入的
   其他字段；并发覆盖风险见 Finding 2。
5. FAIL - monitor 和主 runner 同时整文件写 checkpoint，没有锁、原子
   rename 或版本检查，存在语义回退和 JSON 永久损坏风险。
6. PASS - 使用的 Node API 基本跨平台；Windows 信号语义存在残余风险，但不
   构成本轮主要阻塞项。
7. PASS - 长时间 GraphRAG 命令可通过新鲜 `runnerHeartbeatAt`、
   `currentCommand` 和 `currentCommandStartedAt` 与 stale/orphaned runner
   区分。
8. FAIL - stdout/stderr、command check、retry metadata 的 exactly-once
   持久化会受并发 stale monitor 写入影响，不能保证最终 checkpoint 中只记录
   一次且不丢失。
9. PASS - 新增测试使用本地 fake resume runner、临时文件和定时器，不依赖
   live LLM、GraphRAG 或网络。
10. FAIL - 当前补丁没有清楚记录 PID 复用、monitor cleanup 失败和 checkpoint
   并发写入的残余风险，无法据此判断上线边界。

## Findings

### Finding 1 - Monitor cleanup is not exception-safe

严重级别：High。

位置：

- `scripts/graphrag/batch-epub-workflow.mjs:1377`
- `scripts/graphrag/batch-epub-workflow.mjs:1378`
- `scripts/graphrag/batch-epub-workflow.mjs:3020`
- `scripts/graphrag/batch-epub-workflow.mjs:3021`
- `scripts/graphrag/batch-epub-workflow.mjs:3036`

`runCommand()` 在启动 heartbeat monitor 后直接调用 `spawnSync()`，随后才调用
`heartbeatMonitor?.stop()`。该清理没有放在 `finally` 中。若 `spawnSync()`、
参数校验、或后续维护代码在 stop 前同步抛错，detached monitor 会继续运行。
同时 `stop()` 先执行 `writeFileSync(stopPath, ...)`，该写入不在 `try` 中；
如果 stop file 写入失败，`monitor.kill("SIGTERM")` 不会执行。

影响：

monitor 可能在主 runner 仍存活时继续写 `currentCommand` 和
`runnerHeartbeatAt`，让外部观察者误判命令仍在运行。异常路径还可能跳过
stdout/stderr、command check 和 retry metadata 的记录。

建议修复：

将命令执行包在 `try/finally` 中，并让 `stop()` 全部 best-effort：stop file
写入和 `kill()` 都应分别捕获异常。更稳妥的方案是让 monitor 持有 parent
pipe/IPC，并在 pipe 关闭时退出，而不是仅依赖 stop file。

### Finding 2 - Concurrent full-file checkpoint writes can corrupt state

严重级别：High。

位置：

- `scripts/graphrag/batch-epub-workflow.mjs:981`
- `scripts/graphrag/batch-epub-workflow.mjs:985`
- `scripts/graphrag/batch-epub-workflow.mjs:1317`
- `scripts/graphrag/batch-epub-workflow.mjs:1329`
- `scripts/graphrag/batch-epub-workflow.mjs:1335`
- `scripts/graphrag/batch-epub-workflow.mjs:1399`

主 runner 的 `writeTypedJson()` 和 monitor 的 `writeHeartbeat()` 都对同一个
checkpoint JSON 做整文件 `writeFileSync()`。monitor 先读到 `running` 状态，
主 runner 随后写入 `completed`、`failed` 或追加 `commandChecks` 后，monitor
仍可能把旧 snapshot 带着新 heartbeat 写回，从而把状态回退成 `running` 或丢失
刚记录的 command check。

影响：

这不是单纯的临时读取失败，而是可能形成永久语义损坏（permanent semantic
corruption）：完成/失败结果被旧 running checkpoint 覆盖，恢复逻辑随后会把
仍在刷新的 heartbeat 视为活跃 runner。普通整文件写还可能在并发 truncation
和 write 之间留下不可解析 JSON。

建议修复：

优先把 heartbeat 写到独立 sidecar 文件，例如
`items/<itemId>.heartbeat.json`，恢复摘要再合并 checkpoint 与 heartbeat。
如果必须写主 checkpoint，需要使用 item 级锁、原子 temp+rename、版本/CAS
检查，并在写入前重新验证 status、session、command 和 checkpoint revision。

### Finding 3 - Parent-death detection is PID-only

严重级别：Medium。

位置：

- `scripts/graphrag/batch-epub-workflow.mjs:1296`
- `scripts/graphrag/batch-epub-workflow.mjs:1307`
- `scripts/graphrag/batch-epub-workflow.mjs:1310`
- `scripts/graphrag/batch-epub-workflow.mjs:1318`

monitor 使用 `process.kill(runnerPid, 0)` 判断父进程是否仍存活。父 runner
异常退出后，如果同一 PID 被其他进程复用，monitor 会继续认为父进程存活，并
持续刷新原 runner session 的 heartbeat。

影响：

stale/orphaned runner 会被伪装成 fresh running runner，破坏 orphan recovery
和人工排障判断。

建议修复：

使用 parent-owned pipe、IPC channel 或可检测 EOF 的文件描述符作为父进程
生命线（lifeline）。PID 可以保留为辅助诊断字段，但不应作为唯一退出条件。

### Finding 4 - Tests do not cover lifecycle failure modes

严重级别：Medium。

位置：

- `test/cli.test.ts:1508`
- `test/cli.test.ts:1590`
- `test/cli.test.ts:1607`

新增测试覆盖了长命令运行期间 checkpoint 能看到 heartbeat，但没有验证命令
结束后 monitor 退出、异常路径 stop、父进程死亡、并发写入不回退状态、以及
command check exactly-once 持久化。

影响：

当前测试会通过，但无法防止本报告列出的 stuck monitor 和 checkpoint corruption
回归。

建议修复：

增加 deterministic tests：fake command 正常结束后断言 `currentCommand` 清空；
父进程被终止后 monitor 停止刷新；故意制造 main checkpoint save 与 heartbeat
写入竞争时，最终状态不能从 `completed`/`failed` 回退到 `running`；失败命令
的 stdout/stderr 和 command check 只持久化一次。

## Verification

已运行以下只读检查和必要测试：

- PASS - `git diff --check -- scripts/graphrag/batch-epub-workflow.mjs src/contracts/batch-run.ts test/cli.test.ts`
- PASS - `npm run test:types`
- PASS - `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "updates batch checkpoint heartbeat while long commands run"`
- PASS - `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "status-json (recovers orphaned running item|does not steal fresh remote running items|projects stale remote running items)"`

未运行完整测试套件；本轮审计聚焦 batch command heartbeat observability 的
生命周期和 operational safety 风险。
