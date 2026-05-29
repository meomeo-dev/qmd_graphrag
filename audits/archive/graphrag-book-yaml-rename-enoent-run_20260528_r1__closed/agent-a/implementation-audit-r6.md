# Implementation Audit R6

审计对象：GraphRAG 多书并行 Runner 当前实现。

审计基准：仅使用 `agent-a/criteria.md` 中固定 10 条 Implementation
Audit Criteria，未新增或改变标准。

结论：PASS

## 阻断项

未发现阻断项。

## R6 重点结论

R5 阻断项已关闭。`batch-epub-workflow.mjs` 在启动 `main()` 前安装
`SIGTERM` 与 `SIGINT` handler；外部终止信号进入
`handleTerminationSignal()` 后会记录 `batch_stop_requested`，再调用
`terminateActiveSubprocesses()`。该函数遍历 `activeChildProcesses`，
并通过 `terminateProcessTree()` 对非 Windows 平台的 detached child
process group 调用 `process.kill(-child.pid, signal)`。

`spawnCommand()` 仍以 `detached: process.platform !== "win32"` 启动
resume child，但在 spawn 后立即将 child 写入 `activeChildProcesses`。
因此测试 helper 或外部控制器只向 batch runner parent 发送 `SIGTERM`
时，runner 能继续清理 detached resume child，不再只杀 parent。

新增测试 `test/graphrag-runner-signal-cleanup.test.ts` 覆盖该失败路径：

- 使用 fake resume child 记录自身 PID 后永久运行；
- 等待 child 启动并确认 `processAlive(childPid) === true`；
- 向 batch runner parent 发送 `SIGTERM`；
- 断言 runner exit code 为 `1`；
- 断言事件包含 `batch_stop_requested` 与
  `batch_active_subprocesses_terminating`，reason 为
  `runner_signal_SIGTERM`；
- 断言 subprocess registry 中对应 child 状态为 `killed` 或 `exited`；
- 断言 `processAlive(childPid) === false`。

本轮验证后执行进程残留检查，未发现遗留的
`batch-epub-workflow.mjs`、`resume-book-workspace.mjs`、
`fake-signal-resume.mjs` 或 `qmd-batch-signal-cleanup` 进程。

## Criteria 覆盖结果

1. PASS。Durable atomic rename `ENOENT` 分类为
   `local_state_integrity`、`durable_temp_rename_enoent`、
   `retryable: false` 与 `stop_until_fixed`。实现保留
   `failedSyscall: rename`、`errno: ENOENT`、`renameCause`、
   `tempId`、`operationId`、target locator、lane、owner、
   lease generation 与 `completedPublishRule: forbidden`。
   证据：`src/job-state/durable-state-store.ts:1336` 至 `1394`，
   `DurableStateError` 默认值位于 `src/job-state/durable-state-store.ts:219`。

2. PASS。`resume-book-workspace.mjs` 捕获 `DurableStateError` 后输出单行
   `QMD_GRAPHRAG_DURABLE_FAILURE` typed envelope，包含固定 criteria
   要求字段。证据：`scripts/graphrag/resume-book-workspace.mjs:120`
   至 `175`，输出点位于同文件 `1527` 至 `1534`。

3. PASS。父 runner 在 legacy text classifier 前先解析 typed envelope。
   envelope 可解析时，`BatchCommandCheck` 使用 envelope evidence，并保留
   父 runner 调度的 command name，例如 `resume-book-1`。证据：
   `scripts/graphrag/batch-epub-workflow.mjs:2940` 至 `3060`，
   `9610` 至 `9628`。

4. PASS。`BatchCommandCheck`、item checkpoint、`command_failed`、
   `item_failed`、durable failure events、`status.json` 与
   `recovery-summary.json` 无损投影 durable evidence。证据：
   `scripts/graphrag/batch-epub-workflow.mjs:2838` 至 `2907`、
   `3135` 至 `3157`、`9653` 至 `9685`；聚焦测试断言位于
   `test/cli.test.ts:3990` 至 `4047`。

5. PASS。envelope missing、malformed 或 partial 时，父 runner 在可确认
   durable subprocess boundary 后 fail closed 为
   `durable_subprocess_evidence_incomplete`，并写入
   `evidenceIncomplete`、原因与 unavailable sentinels。证据：
   `scripts/graphrag/batch-epub-workflow.mjs:2972` 至 `3132`；
   测试位于 `test/cli.test.ts:4055` 至 `4198`。

6. PASS。`graph_vault/books/{bookId}/job.yaml`、`artifacts.yaml`、
   `checkpoints.yaml` 与 `runs/*.yaml` 映射到 `checkpointWriterLane`
   和 `repository` owner；book-scoped YAML target 未误投影为 run-level
   item JSON、checksum sidecar 或 shared catalog failure。证据：
   `src/job-state/durable-state-store.ts:90` 至 `99`；
   真实 child YAML 测试位于 `test/cli.test.ts:3924` 至 `4052`。

7. PASS。`graph_vault/settings.yaml` 首次缺失时创建 managed projection；
   已存在且 valid 的 managed projection 不重写；user-owned 或 invalid
   marker 被拒绝；invalid source config 在 projection build 阶段独立
   诊断。证据：`src/graphrag/settings-projection.ts:82` 至 `116`、
   `334` 至 `405`、`407` 至 `460`；测试位于
   `test/graphrag-book-state.test.ts:407`、
   `2693` 至 `2727`、`2773` 至 `2838`。

8. PASS。durable preflight 与 `--status-json` fail closed 报告 checksum
   mismatch、partial/missing checksum sidecar 等状态；`--status-json`
   为 read-only，不写 checkpoint、event、manifest、`status.json` 或
   `recovery-summary.json`。证据：`test/graphrag-runner-durable-preflight.test.ts:113`
   至 `200`；`test/graphrag-runner-status-json-readonly.test.ts:250`
   至 `308`。

9. PASS。测试真实覆盖 `resume-book-workspace.mjs` child process 中
   book-scoped YAML rename `ENOENT`，覆盖 `job.yaml`、`checkpoints.yaml`
   与 `artifacts.yaml`，未用 fake resume runner 替代真实 child，且未把
   checksum sidecar rename 当作 primary YAML rename。证据：
   `test/cli.test.ts:3924` 至 `4052`。

10. PASS。测试覆盖 malformed、missing required fields 与 partial
    envelope 的 fail-closed 行为，并覆盖 settings projection 首次缺失创建
    路径。类型检查、Type DD YAML parse、相关 `node --check` 与聚焦 Vitest
    已作为实施验证证据。R6 新增 signal cleanup 聚焦测试补齐 R5 对
    helper 外部终止路径的无 orphan 风险。

## 验证命令

本轮实际运行：

```text
node --check scripts/graphrag/batch-epub-workflow.mjs
```

结果：PASS。

```text
npx vitest run test/graphrag-runner-signal-cleanup.test.ts \
  --reporter=verbose --testTimeout=60000
```

结果：PASS，1 个测试文件通过，1 个测试通过，耗时约 15.19s。

```text
ps -axo pid,ppid,pgid,stat,command | \
  rg 'batch-epub-workflow\.mjs|resume-book-workspace\.mjs|\
fake-signal-resume\.mjs|qmd-batch-signal-cleanup' || true
```

结果：未发现相关残留进程。

已纳入本轮审计证据的既有聚焦验证：

```text
node --check scripts/graphrag/batch-epub-workflow.mjs
```

```text
npx vitest run test/graphrag-runner-signal-cleanup.test.ts \
  --reporter=verbose --testTimeout=60000
```

```text
child YAML/envelope/settings/status-json/preflight 聚焦回归
```

结果：已通过。

## 审计边界

- 未修改源码。
- 未修改 `criteria.md`。
- 未读取 `.env`。
- 未运行真实 EPUB 目录或生产 real runner。
- R6 signal cleanup 验证使用临时最小 EPUB fixture 与 fake resume child，
  只覆盖外部 `SIGTERM` 清理 detached child 的 runner 控制路径。

最终结论：PASS
