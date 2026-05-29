# Implementation Audit R9 - Agent A

Verdict: FAIL

审计基准为
`agent-a/implementation-criteria.yaml` 的 10 条固定 implementation criteria。
本轮只读代码、设计文档与验证记录；未读取 `.env`，未启动真实 EPUB runner。

## Criteria Results

- I01_single_durable_state_boundary: PASS。
  共享 store 声明 durable boundary 与 guarantees：
  `src/job-state/durable-state-store.ts:39`；runner adapter 声明等价边界：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。runner JSON/YAML
  reconcile、checksum backfill 与 quarantine 集中在 durable adapter：
  `scripts/graphrag/batch-epub-workflow.mjs:4787`，
  `scripts/graphrag/batch-epub-workflow.mjs:4922`。

- I02_target_mapping_and_lane_enforcement: PASS。
  设计要求生产 durable target 必须映射到唯一 lane/owner：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`。
  runner mapping 覆盖 catalog、run、provider、book output、row-count 与
  SQLite targets：`scripts/graphrag/batch-epub-workflow.mjs:238`。
  未映射生产 target 抛 `durable_target_mapping_missing`：
  `scripts/graphrag/batch-epub-workflow.mjs:2515`；
  shared store 同等阻断：
  `src/job-state/durable-state-store.ts:1885`。

- I03_collision_resistant_temp_creation: PASS。
  runner `tempId` 含 pid、timestamp 与 UUID operationId：
  `scripts/graphrag/batch-epub-workflow.mjs:2407`。owner sidecar 与 temp
  内容使用 `wx` exclusive create：
  `scripts/graphrag/batch-epub-workflow.mjs:4005`，
  `scripts/graphrag/batch-epub-workflow.mjs:4168`。碰撞分类为
  `durable_temp_create_collision`：
  `scripts/graphrag/batch-epub-workflow.mjs:4148`。
  同毫秒与 forced collision 测试见 `test/book-job-state.test.ts:421`、
  `test/cli.test.ts:2752`。

- I04_owner_evidence_and_cleanup_safety: PASS。
  owner evidence 含 tempId、operationId、target、lease/generation、fencing、
  createdAt、ownerPid 与 ownerHost：
  `scripts/graphrag/batch-epub-workflow.mjs:2407`。
  cleanup decision 校验 TTL、owner、target、generation、fencing、checksum、
  owner live 与 lease expiry：
  `scripts/graphrag/batch-epub-workflow.mjs:4308`。preflight 对未可安全清理的
  temp 返回阻断：
  `scripts/graphrag/batch-epub-workflow.mjs:4446`。测试见
  `test/cli.test.ts:2883`、`test/book-job-state.test.ts:618`。

- I05_lock_freshness_fencing_and_takeover: PASS。
  runner JSON lock owner 记录 runnerSessionId、generation、fencing hash、
  operationId、heartbeatAt 与 expiresAt：
  `scripts/graphrag/batch-epub-workflow.mjs:5245`。
  stale lock recovery 要求 expired/dead/fence evidence：
  `scripts/graphrag/batch-epub-workflow.mjs:5107`。
  提交前后验证 lock fencing：
  `scripts/graphrag/batch-epub-workflow.mjs:5176`；finally release：
  `scripts/graphrag/batch-epub-workflow.mjs:5217`。shared store lock owner
  同等字段见 `src/job-state/durable-state-store.ts:1798`。

- I06_atomic_replace_and_fsync_boundary: PASS。
  runner durable JSON replace 顺序包含 owner evidence、exclusive temp write、
  pending checksum meta、target rename、checksum temp、checksum rename、
  committed meta 与 parent fsync：
  `scripts/graphrag/batch-epub-workflow.mjs:4168`。
  shared store 对 directory fsync failure 分类为 local state integrity 并禁止
  completed publication：
  `src/job-state/durable-state-store.ts:1479`。
  directory fsync fault injection 测试见 `test/cli.test.ts:2821`。

- I07_checksum_generation_crash_window_recovery: PASS。
  runner JSON/YAML reconcile 区分 missing checksum、target-new/checksum-old、
  pending meta 与 checksum mismatch quarantine：
  `scripts/graphrag/batch-epub-workflow.mjs:4837`，
  `scripts/graphrag/batch-epub-workflow.mjs:4972`。commit meta 要求
  operationId、runnerSessionId、fencingTokenHash 与 targetGeneration：
  `src/job-state/durable-state-store.ts:1611`。测试见
  `test/book-job-state.test.ts:460`、`test/cli.test.ts:3280`。

- I08_rename_enoent_failure_classification: PASS。
  runner rename wrapper 将 ENOENT 分类为
  `local_state_integrity / durable_temp_rename_enoent`：
  `scripts/graphrag/batch-epub-workflow.mjs:4076`。cause matrix 覆盖
  temp_collision、reconciler_mistaken_deletion、concurrent_takeover、
  generation_advanced 与 filesystem_or_external_mutation：
  `scripts/graphrag/batch-epub-workflow.mjs:4105`。failure classifier 在
  provider transient 前识别 durable rename ENOENT：
  `scripts/graphrag/batch-failure-classifier.mjs:1`、
  `scripts/graphrag/batch-failure-classifier.mjs:83`。测试见
  `test/cli.test.ts:3611`。

- I09_resume_preflight_and_runner_recovery: FAIL。
  beforeResumeBook 与 beforeClaim 都调用 durable preflight：
  `scripts/graphrag/batch-epub-workflow.mjs:9111`、
  `scripts/graphrag/batch-epub-workflow.mjs:9709`。preflight 会写
  `durable_preflight_blocked` 并抛 `stop_until_fixed`：
  `scripts/graphrag/batch-epub-workflow.mjs:4646`。但扫描范围由
  `durablePreflightTargets()` 手写目录列表给出：
  `scripts/graphrag/batch-epub-workflow.mjs:4615`，未从
  `durableTargetMappingTable` 派生。设计明确要求扫描范围必须从
  targetMapping 派生并递归覆盖嵌套 targets：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:907`。

- I10_regression_tests_and_observability: PASS。
  测试覆盖 same-ms temp、forced collision、active/stale temp reconcile、
  stale lock live/unknown owner、directory fsync、checksum crash window、
  nested row-count orphan temp 与 rename ENOENT：
  `test/book-job-state.test.ts:421`、`test/cli.test.ts:2752`、
  `test/cli.test.ts:2883`、`test/cli.test.ts:3386`、
  `test/cli.test.ts:2821`、`test/cli.test.ts:3280`、
  `test/cli.test.ts:3464`、`test/cli.test.ts:3611`。
  status/event/checkpoint 字段投影见
  `scripts/graphrag/batch-epub-workflow.mjs:2685`、
  `scripts/graphrag/batch-epub-workflow.mjs:4671`。
  该 PASS 不覆盖 I09 的 mapping-derived 实现缺口。

## Blocking Findings

### BF-01: durable preflight 扫描范围未从 targetMapping 派生

R8 Agent A 阻塞项要求 beforeClaim / beforeResumeBook durable preflight 从
targetMapping 派生扫描范围，并递归覆盖 book-scoped nested durable targets 与
sidecars。R9 实现补上了 book output 递归扫描，能够覆盖
`books/{bookId}/output/lancedb/*.lance/qmd_row_count.json` 的 `.tmp-*`、
`.owner.json`、`.lock`、`.sha256` 与 `.sha256.meta.json` 场景：
`scripts/graphrag/batch-epub-workflow.mjs:4572`、
`scripts/graphrag/batch-epub-workflow.mjs:4625`；
测试见 `test/cli.test.ts:3464`。

但扫描根仍是手写目录集合：
`scripts/graphrag/batch-epub-workflow.mjs:4615`。该函数没有读取或展开
`durableTargetMappingTable`，而 mapping 表本身包含不在该手写扫描集合中的
生产 durable targets，例如 `books/{bookId}/qmd/qmd_build_manifest.json`、
`catalog/provider-requests/*.json`、`graph_vault/output/lancedb/*.lance/`
下的 `qmd_row_count.json`、以及 `graph_vault/dspy/**/*.yaml/json`：
`scripts/graphrag/batch-epub-workflow.mjs:342`、
`scripts/graphrag/batch-epub-workflow.mjs:354`、
`scripts/graphrag/batch-epub-workflow.mjs:366`、
`scripts/graphrag/batch-epub-workflow.mjs:392`。

影响：新增或既有 targetMapping 条目不会自动进入 beforeClaim /
beforeResumeBook preflight。若这些生产 durable targets 出现 unknown/live temp、
partial checksum sidecar 或不可判定 lock owner，runner 可能继续 claim 或启动
resume-book，直到后续具体读写路径才发现问题。这不满足设计中的
mapping-derived preflight contract：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:913`、
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:924`。

建议修复：以 `durableTargetMappingTable` 为源生成 preflight scan roots。对
当前 runId、itemId、bookId 可实例化的 target 生成精确目录；对含 glob 或
深层 pattern 的条目标记 recursive scan；覆盖 sidecars 的 primary-target
normalization 规则。beforeClaim 与 beforeResumeBook 应使用同一派生函数，并用
至少一个非现有手写目录覆盖的 mapped target 做回归测试。

## R8 Closure

R8 Agent A 阻塞项未完全关闭。

- 已关闭部分：book-scoped `output` 目录改为 recursive scan，R9 测试能阻断嵌套
  LanceDB `qmd_row_count.json.tmp-*` orphan temp，且 fake resume script 未启动：
  `test/cli.test.ts:3464`。
- 未关闭部分：preflight 扫描范围仍未从 targetMapping 派生，仍依赖手写目录列表：
  `scripts/graphrag/batch-epub-workflow.mjs:4615`。

## Verification Reviewed

审阅了 R9 前置验证记录：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:84`。
记录显示 12 项聚焦 CLI 测试、type test、book-job-state、graphrag-book-state、
LLM、cost 与 contracts 验证均通过：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:91`、
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:107`、
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:112`。
本轮额外运行 `node --check scripts/graphrag/batch-epub-workflow.mjs`，结果通过。
