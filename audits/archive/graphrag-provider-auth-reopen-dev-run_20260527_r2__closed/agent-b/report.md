# GraphRAG EPUB Batch Provider Auth Reopen 审计报告

结论：FAIL

## 范围

审计对象：

- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `docs/operations/graphrag-epub-resume-boost.md`

审计重点为并发、状态机和幂等性：`status-json` 只读性、
`migrate-only` 不重开、同 runId 活跃 runner 风险、failed/pending/running
投影、以及 provider auth refail 后是否清理 stale eligibility。

## 必须修复项

### 1. `--migrate-only` 会重开 completed checkpoint

文件：`scripts/graphrag/batch-epub-workflow.mjs:2141`

`loadCheckpoint()` 在进入 `migrateOnly` 分支前无条件执行：

- `hydrateCheckpoint(...)`
- `downgradeCompletedIfClosedLoopInvalid(...)`
- `recoverOrphanedRunningCheckpoint(...)`
- `recoverProviderTransientCheckpoint(...)`

其中 `downgradeCompletedIfClosedLoopInvalid()` 在
`scripts/graphrag/batch-epub-workflow.mjs:3383` 对 `completed` checkpoint
做闭环校验，并在证据不完整时把 item 改为 `pending`。主入口随后先
`updateManifest()`，再进入 `if (migrateOnly)` 分支
（`scripts/graphrag/batch-epub-workflow.mjs:5033` 到
`scripts/graphrag/batch-epub-workflow.mjs:5039`），因此 migrate-only 已经可能
产生状态重开。

现有测试还把该行为固化为期望：
`test/cli.test.ts:8147` 的用例名为
`migrate-only reopens completed items without real GraphRAG evidence`，
并断言 manifest 变为 `running/pendingItems: 1`
（`test/cli.test.ts:8257` 到 `test/cli.test.ts:8279`）。

这违反基准 3：`--migrate-only` 只能做迁移，不应重开 completed、failed、
skipped 或 provider-auth checkpoint。必须把闭环降级/重开逻辑从 migrate-only
路径隔离，或改为只读诊断输出；同时更新对应测试，防止该行为再次成为
契约。

### 2. 同 runId 双写入 runner 缺少代码级互斥

文件：`scripts/graphrag/batch-epub-workflow.mjs:1275`

`applyProviderAuthReopenPass()` 基于启动时加载到内存的 `checkpoints` map
计算 provider auth reopen decision，并在 `saveCheckpoint()` 时直接写入
pending checkpoint（`scripts/graphrag/batch-epub-workflow.mjs:1307` 到
`scripts/graphrag/batch-epub-workflow.mjs:1309`）。写入本身有文件锁，但锁内
没有重读 checkpoint，也没有 CAS 检查“该 item 仍是同一个 failed
checkpoint”。两个同 runId runner 同时启动时，二者都可能从相同 failed 快照
判定可重开，并先后写入各自的 pending metadata/event。

文件：`scripts/graphrag/batch-epub-workflow.mjs:4809`

`markItemRunning()` 同样基于调用方传入的 `checkpoint` 快照构造 running 状态，
再调用 `saveCheckpoint()` 写入（`scripts/graphrag/batch-epub-workflow.mjs:4844`
到 `scripts/graphrag/batch-epub-workflow.mjs:4847`）。文件锁只串行化写入，
但不阻止两个 runner 都从同一个 pending 快照进入 running 并各自启动
`runItem()`。第二个写入会覆盖第一个 runner lease，导致两个真实 GraphRAG/qmd
工作流并发执行同一 item，且第一个 runner 后续 heartbeat 只能发现 lease
不匹配退出，不能阻止已经开始的高成本工作。

文档明确禁止“已有活跃 runner 时启动第二个同 runId 写入 runner”
（`docs/operations/graphrag-epub-resume-boost.md:370`），但源码缺少同 runId
全局写入 runner lease 或 per-item compare-and-set。现有测试覆盖了“已有
fresh remote running checkpoint 时不抢占”
（`test/cli.test.ts:7667`、`test/cli.test.ts:7899`），没有覆盖两个 runner
从 pending/failed 同时竞争启动的场景。

必须新增代码级保护：在 checkpoint 锁内重读并校验期望状态、runner lease、
attempt/fingerprint，只有 CAS 成功才允许 reopen 或 mark running；或者增加
runId 级 writer lock，确保同一 runId 同时只有一个写入 runner。

## 通过项

- `--status-json` 主路径未落盘：`event()` 在 status-json 下直接返回
  typed item（`scripts/graphrag/batch-epub-workflow.mjs:1790` 到
  `scripts/graphrag/batch-epub-workflow.mjs:1805`），`writeTypedJson()` 在
  status-json 下返回 parsed value 而不写文件
 （`scripts/graphrag/batch-epub-workflow.mjs:1873` 到
  `scripts/graphrag/batch-epub-workflow.mjs:1879`），主入口在
  `printStatusAndExit()` 后返回（`scripts/graphrag/batch-epub-workflow.mjs:5035`
  到 `scripts/graphrag/batch-epub-workflow.mjs:5037`）。

- provider auth candidate 边界合理：只处理 failed、不可重试、
  `stop_until_fixed` 且具有 provider auth 证据的 checkpoint
 （`scripts/graphrag/batch-epub-workflow.mjs:1005` 到
  `scripts/graphrag/batch-epub-workflow.mjs:1010`）。

- provider auth readiness fail-closed 覆盖了配置不可读、缺失 required names、
  shell env shadow、attempt limit、同 fingerprint 已重开、failure fingerprint
  未变化等条件（`scripts/graphrag/batch-epub-workflow.mjs:1028` 到
  `scripts/graphrag/batch-epub-workflow.mjs:1067`）。

- refail 后 stale eligibility 被清除：runtime failure metadata 写入
  `providerAuthReopenDecision=blocked_provider_auth_fingerprint_unchanged`、
  `providerAuthReopenEligible=false`、`providerAuthConfigChanged=false`
 （`scripts/graphrag/batch-epub-workflow.mjs:1155` 到
  `scripts/graphrag/batch-epub-workflow.mjs:1181`），并有测试覆盖
 （`test/cli.test.ts:6979` 到 `test/cli.test.ts:7088`）。

- schema 已允许 recovery summary 暴露 provider auth 观测字段，同时字段形态为
  status/source/fingerprint/presence 等摘要语义
 （`src/contracts/batch-run.ts:270` 到 `src/contracts/batch-run.ts:295`）。

- docs 明确说明 provider auth 状态、事件和 summary 只保存 present/missing、
  source 和 redacted fingerprint，不保存 `.env` 值
 （`docs/operations/graphrag-epub-resume-boost.md:247` 到
  `docs/operations/graphrag-epub-resume-boost.md:249`）。

## 测试记录

已运行：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli.test.ts \
  -t "provider auth|remote running|migrate-only reopens completed"
```

结果：1 个测试文件通过；15 个相关测试通过；183 个测试按过滤条件跳过。

该测试集没有触发真实 provider API；相关用例使用 `--status-json`、fixture、
测试 hook 或 fake runner。

## 残余风险

- 现有测试验证了状态投影和单 runner 状态机，但没有并发启动两个同 runId
  写入 runner 的竞争测试。
- `--migrate-only` 的现有测试期望与本审计基准相反；修复后需要同步更新
  测试，否则测试会继续保护错误行为。
