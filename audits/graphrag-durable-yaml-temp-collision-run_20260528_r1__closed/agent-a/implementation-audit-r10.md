# Implementation Audit R10 - Agent A

Verdict: PASS

审计基准为
`agent-a/implementation-criteria.yaml` 的 10 条固定 implementation criteria。
本轮只读代码、设计文档与验证记录；仅写入本报告。未读取 `.env` 或 secrets，
未启动真实 EPUB runner，未处理 inbox 真实图书。

## Criteria Results

- I01_single_durable_state_boundary: PASS。
  共享 durable boundary 声明 `targetMapping`、exclusive temp、owner
  evidence、checksum commit meta、lock release 与 preflight reconcile：
  `src/job-state/durable-state-store.ts:39`。runner 侧等价 adapter 集中
  durable evidence、failure projection 与 DurableStateError：
  `scripts/graphrag/batch-epub-workflow.mjs:2447`、
  `scripts/graphrag/batch-epub-workflow.mjs:2686`。JSON/YAML 读前
  reconcile 与 durable 写入均走共享函数：
  `scripts/graphrag/batch-epub-workflow.mjs:5514`、
  `scripts/graphrag/batch-epub-workflow.mjs:6540`。

- I02_target_mapping_and_lane_enforcement: PASS。
  runner `durableTargetMappingTable` 覆盖 catalog、book、run、batch、provider、
  DSPy、book output、LanceDB row-count 与 SQLite targets：
  `scripts/graphrag/batch-epub-workflow.mjs:238`。未映射生产 durable
  target 会抛 `durable_target_mapping_missing`：
  `scripts/graphrag/batch-epub-workflow.mjs:2555`。JSON/YAML lock、
  qmd index lock、provider slot 与 book lease 都在 per-target lock 或
  lane 内执行，并在 finally 释放：
  `scripts/graphrag/batch-epub-workflow.mjs:5321`、
  `scripts/graphrag/batch-epub-workflow.mjs:3348`、
  `scripts/graphrag/batch-epub-workflow.mjs:3708`。

- I03_collision_resistant_temp_creation: PASS。
  runner tempId 包含 pid、timestamp 与 UUID operationId：
  `scripts/graphrag/batch-epub-workflow.mjs:2447`。owner sidecar、primary
  temp 与 checksum temp 使用 `wx` exclusive create：
  `scripts/graphrag/batch-epub-workflow.mjs:4045`、
  `scripts/graphrag/batch-epub-workflow.mjs:4208`。碰撞分类为
  `durable_temp_create_collision`：
  `scripts/graphrag/batch-epub-workflow.mjs:4188`。测试覆盖同毫秒与 forced
  temp collision：`test/book-job-state.test.ts:421`、
  `test/cli.test.ts:2752`。

- I04_owner_evidence_and_cleanup_safety: PASS。
  owner evidence 包含 target、tempId、operationId、runner/session、owner、
  generation、fencing、createdAt、expiresAt 与 checksum-before：
  `scripts/graphrag/batch-epub-workflow.mjs:2447`。cleanup decision 校验
  stale TTL、owner evidence、target match、generation/fencing、target
  checksum、owner alive 与 lease expiry：
  `scripts/graphrag/batch-epub-workflow.mjs:4348`。不可安全删除的 temp 在
  preflight 中阻断：
  `scripts/graphrag/batch-epub-workflow.mjs:4486`。测试覆盖 fresh/stale temp、
  owner evidence 缺失与 generation advanced：
  `test/cli.test.ts:2883`、`test/cli.test.ts:2977`、
  `test/cli.test.ts:3049`。

- I05_lock_freshness_fencing_and_takeover: PASS。
  JSON lock owner 记录 runnerSessionId、generation、fencing hash、
  operationId、heartbeatAt、expiresAt 与 mapping evidence：
  `scripts/graphrag/batch-epub-workflow.mjs:5321`。stale lock recovery 要求
  expired/dead/recovery fence：
  `scripts/graphrag/batch-epub-workflow.mjs:5183`。提交前后验证 current
  fencing，旧 generation 被拒绝：
  `scripts/graphrag/batch-epub-workflow.mjs:5252`。qmd index file lock 使用
  同类 owner/fence 与 release 规则：
  `scripts/graphrag/batch-epub-workflow.mjs:3348`。

- I06_atomic_replace_and_fsync_boundary: PASS。
  runner JSON durable replace 顺序为 owner evidence、exclusive temp
  write/fsync、pending checksum meta、atomic rename、checksum temp
  write/fsync、checksum rename、committed meta、parent directory fsync：
  `scripts/graphrag/batch-epub-workflow.mjs:4208`。file fsync 与 directory
  fsync 失败均分类为 local state integrity 并禁止 completed publication：
  `scripts/graphrag/batch-epub-workflow.mjs:2878`、
  `scripts/graphrag/batch-epub-workflow.mjs:2926`。共享 store 同步实现
  durable replace 与 fsync 边界：
  `src/job-state/durable-state-store.ts:465`、
  `src/job-state/durable-state-store.ts:1244`。

- I07_checksum_generation_crash_window_recovery: PASS。
  runner JSON/YAML reconcile 区分 target-new/checksum-old、missing checksum、
  pending meta、metadata backfill 与 mismatch quarantine：
  `scripts/graphrag/batch-epub-workflow.mjs:4863`、
  `scripts/graphrag/batch-epub-workflow.mjs:4998`。commit evidence 要求
  checksum、operationId、runnerSessionId、fencingTokenHash 与 targetGeneration：
  `scripts/graphrag/batch-epub-workflow.mjs:4082`。共享 store 同步覆盖
  crash window 分支：
  `src/job-state/durable-state-store.ts:575`。测试覆盖 pending meta、
  partial checksum sidecar 与 checksum mismatch：
  `test/cli.test.ts:3207`、`test/cli.test.ts:3280`。

- I08_rename_enoent_failure_classification: PASS。
  runner rename wrapper 将 ENOENT 分类为
  `local_state_integrity / durable_temp_rename_enoent`，记录 target、tempId、
  operationId、failedSyscall、errno、renameCause 与 completedPublishRule：
  `scripts/graphrag/batch-epub-workflow.mjs:4116`。cause matrix 覆盖
  temp_collision、reconciler_mistaken_deletion、concurrent_takeover、
  generation_advanced 与 filesystem_or_external_mutation：
  `scripts/graphrag/batch-epub-workflow.mjs:4145`。测试断言 checkpoint、
  event 与 recovery summary 证据：
  `test/cli.test.ts:3611`、`test/cli.test.ts:3725`。

- I09_resume_preflight_and_runner_recovery: PASS。
  beforeResumeBook、beforeClaim 与 runner_start 分别调用 durable preflight：
  `scripts/graphrag/batch-epub-workflow.mjs:9187`、
  `scripts/graphrag/batch-epub-workflow.mjs:9785`、
  `scripts/graphrag/batch-epub-workflow.mjs:10599`。R10 修复后
  `durablePreflightTargets()` 从 `durableTargetMappingTable` 读取每个
  `preflightScopes`，缺失 scope 会 strict fail，bookId/runId/itemId 按当前
  item 实例化，并合并 recursive 标记：
  `scripts/graphrag/batch-epub-workflow.mjs:4655`。nested book output 与
  LanceDB row-count scopes 标记 recursive：
  `scripts/graphrag/batch-epub-workflow.mjs:400`、
  `scripts/graphrag/batch-epub-workflow.mjs:419`。blocker 写
  `durable_preflight_blocked` 并 stop_until_fixed：
  `scripts/graphrag/batch-epub-workflow.mjs:4722`。

- I10_regression_tests_and_observability: PASS。
  测试覆盖 same-ms temp、forced temp collision、active/stale temp reconcile、
  stale lock owner、rename ENOENT、directory fsync、checksum crash window、
  resume/preflight orphan temp 与 R10 mapped YAML target：
  `test/book-job-state.test.ts:421`、`test/cli.test.ts:2752`、
  `test/cli.test.ts:2883`、`test/cli.test.ts:3386`、
  `test/cli.test.ts:3611`、`test/cli.test.ts:2821`、
  `test/cli.test.ts:3280`、`test/cli.test.ts:3464`、
  `test/graphrag-runner-durable-preflight.test.ts:114`。checkpoint/event/status
  暴露 localFailureClass、recoveryDecision、target、tempId、operationId、
  lock owner、fsync 与 checksum evidence：
  `scripts/graphrag/batch-epub-workflow.mjs:2646`、
  `scripts/graphrag/batch-epub-workflow.mjs:2720`、
  `scripts/graphrag/batch-epub-workflow.mjs:4747`。

## Blocking Findings

None.

## R9 Closure

R9 Agent A 阻塞项已关闭。

`beforeClaim`、`beforeResumeBook` 与 `runner_start` 不再维护独立手写 durable
目录清单。扫描根由 `durableTargetMappingTable` 的 `preflightScopes` 派生：
`scripts/graphrag/batch-epub-workflow.mjs:4655`。每个 mapping 条目均声明
`preflightScopes`，SQLite/qmd index 专属锁条目明确为空 scope，并由
`durablePreflightDecisionForQmdIndexLock()` 单独检查：
`scripts/graphrag/batch-epub-workflow.mjs:435`、
`scripts/graphrag/batch-epub-workflow.mjs:4585`。book-scoped scopes 使用当前
`item.bookId` 实例化；无法实例化时不生成对应 root：
`scripts/graphrag/batch-epub-workflow.mjs:4692`。嵌套 output 与 LanceDB
row-count scopes 使用 recursive scan：
`scripts/graphrag/batch-epub-workflow.mjs:400`、
`scripts/graphrag/batch-epub-workflow.mjs:419`。

设计文档已同步 `preflightScopeRule`，明确每个 targetMapping 条目必须派生
scan root、bookId scope 用当前 bookId 实例化、通配或深层 pattern 必须
recursive，且 beforeClaim、beforeResumeBook 与 runner_start 不得维护独立
手写清单：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:241`。durable
preflight 章节同步要求递归覆盖 book-scoped output 中的 nested durable
targets 与 sidecars：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:913`。

新增测试覆盖非原手写目录的 mapped YAML target：
`test/graphrag-runner-durable-preflight.test.ts:114`。该测试在
`books/{bookId}/runs/legacy.yaml` 注入 checksum fault，断言
`before_claim` durable preflight stop_until_fixed、quarantine、checkpoint 与
recovery summary 证据均存在：
`test/graphrag-runner-durable-preflight.test.ts:135`、
`test/graphrag-runner-durable-preflight.test.ts:190`。

## Verification Reviewed

审阅了 R10 前置验证记录：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:96`。
记录显示 `node --check`、`npm run test:types`、R10 preflight test、4 项聚焦
CLI 测试与 12 项 durable regression 测试均通过：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:98`、
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:106`、
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:112`。

本轮额外运行轻量验证：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`: PASS。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-runner-durable-preflight.test.ts`: PASS，1 test passed。
