# Implementation Audit R10 - Agent B

Verdict: PASS

## Criteria Results

### I01_single_durable_boundary: PASS

- shared store 声明 `shared-durable-state-store` 边界，并固定
  `targetMapping`、exclusive temp、owner evidence、checksum commit meta、
  preflight reconcile 和 local state projection guarantee：
  `src/job-state/durable-state-store.ts:39`。
- runner adapter 声明等价 durable boundary：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。
- shared store durable 写入路径使用 owner sidecar、exclusive temp、pending
  checksum meta、rename、checksum rename 和 parent fsync：
  `src/job-state/durable-state-store.ts:465`。
- runner JSON/JSONL adapter 在同一语义下写入、分类失败并发布 durable failure
  event：`scripts/graphrag/batch-epub-workflow.mjs:4212`、
  `scripts/graphrag/batch-epub-workflow.mjs:4265`。

### I02_target_mapping_enforcement: PASS

- 设计要求每个生产 durable 目标能追溯唯一 lane、owner、durableKind、
  laneTimeoutMs 和 releaseOn，且 preflight scope 由 targetMapping 派生：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`。
- runner targetMapping 覆盖 catalog、book YAML、checkpoint、manifest、
  status、lock、provider slot、subprocess、book lease、settings、DSPy、QMD
  manifest、nested LanceDB row-count 和 qmd index：
  `scripts/graphrag/batch-epub-workflow.mjs:238`、
  `scripts/graphrag/batch-epub-workflow.mjs:419`。
- 未映射生产 durable target fail-closed：
  `scripts/graphrag/batch-epub-workflow.mjs:2555`、
  `src/job-state/durable-state-store.ts:1885`。
- qmd index lock 仍有 acquire/release、generation、fencingTokenHash 和 owner
  evidence 测试：`test/cli.test.ts:4915`。

### I03_temp_identity_exclusive_create: PASS

- shared store tempId 包含 `randomUUID()` operationId：
  `src/job-state/durable-state-store.ts:1760`。
- runner durable operation evidence 同样包含随机 operationId，测试 hook 仅在
  test hooks 下覆盖 tempId：
  `scripts/graphrag/batch-epub-workflow.mjs:2407`。
- shared store durable write 使用 `wx` exclusive create：
  `src/job-state/durable-state-store.ts:483`、
  `src/job-state/durable-state-store.ts:499`。
- runner temp/create collision 在 EEXIST 下分类为
  `durable_temp_create_collision`，且保留 foreign temp：
  `scripts/graphrag/batch-epub-workflow.mjs:4188`、
  `test/cli.test.ts:2752`。
- 同毫秒 YAML 写入测试证明 temp 不复用且 catalog 无丢失：
  `test/book-job-state.test.ts:421`。

### I04_temp_owner_evidence: PASS

- shared store owner evidence 包含 tempId、operationId、targetLocator、lane、
  owner、runnerSessionId、worker/item/book scope、ownerPid/Host、createdAt、
  leaseGeneration、targetGeneration、targetChecksumBefore 和 fencingTokenHash：
  `src/job-state/durable-state-store.ts:1760`。
- runner owner evidence 投影包含对应字段：
  `scripts/graphrag/batch-epub-workflow.mjs:4309`。
- preflight 对 temp owner evidence 读取后投影到 blocker、event metadata 与
  lockOwnerEvidence：
  `scripts/graphrag/batch-epub-workflow.mjs:4486`、
  `scripts/graphrag/batch-epub-workflow.mjs:4747`。
- nested sidecar preflight 测试断言 owner evidence 中 tempId 与
  targetChecksumBefore 被保留：
  `test/cli.test.ts:3464`。

### I05_inflight_cleanup_safety: PASS

- shared store cleanup 检查 target 匹配、owner 创建时间、cleanup fence、
  target generation 未推进、stale TTL、owner alive、lease expired/local
  dead，并在删除后写 recovery record：
  `src/job-state/durable-state-store.ts:969`、
  `src/job-state/durable-state-store.ts:1014`。
- runner cleanup 对 fresh temp、缺失 owner evidence、generation advanced 和
  live owner 均保留，不删除活跃 writer：
  `scripts/graphrag/batch-epub-workflow.mjs:4348`。
- runner preflight 对无法清理的 temp fail-closed 为
  `durable_preflight_unresolved_temp`：
  `scripts/graphrag/batch-epub-workflow.mjs:4486`。
- 测试覆盖 fresh/stale、owner evidence 缺失和 generation advanced：
  `test/cli.test.ts:2883`、`test/cli.test.ts:2977`、
  `test/cli.test.ts:3049`。

### I06_atomic_commit_and_checksum_recovery: PASS

- shared store 写入顺序覆盖 temp fsync、pending meta、target rename、
  checksum temp/rename、committed meta 和 parent fsync：
  `src/job-state/durable-state-store.ts:481`。
- shared recovery 覆盖 checksum missing、pending、old、invalid/mismatch、
  backfill 和 quarantine/stop-until-fixed：
  `src/job-state/durable-state-store.ts:575`。
- runner checksum recovery 与 preflight checksum blocker 仍投影
  `checksumRecoveryDecision=stop_until_fixed`：
  `scripts/graphrag/batch-epub-workflow.mjs:4533`、
  `scripts/graphrag/batch-epub-workflow.mjs:4559`。
- partial checksum sidecar crash-window 测试断言 preflight blocked、
  `local_state_integrity` 和 stop-until-fixed：
  `test/cli.test.ts:3280`。

### I07_rename_enoent_classification: PASS

- 设计固定 rename ENOENT taxonomy 为 `temp_collision`、
  `reconciler_mistaken_deletion`、`concurrent_takeover`、
  `generation_advanced`、`filesystem_or_external_mutation`，证据不足时
  fail-closed 到 filesystem/external mutation：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:641`。
- shared store 的 async/sync rename ENOENT 均抛
  `durable_temp_rename_enoent`，含 failedSyscall、errno 和 renameCause：
  `src/job-state/durable-state-store.ts:1306`、
  `src/job-state/durable-state-store.ts:1335`。
- shared store cause inference 仅返回固定 5 类：
  `src/job-state/durable-state-store.ts:1364`。
- runner adapter 也仅返回固定 5 类，并保持 `DurableStateError`
  `retryable=false`、`recoveryDecision=stop_until_fixed`：
  `scripts/graphrag/batch-epub-workflow.mjs:4116`、
  `scripts/graphrag/batch-epub-workflow.mjs:4145`、
  `scripts/graphrag/batch-epub-workflow.mjs:2686`。
- runner rename ENOENT 测试断言 checkpoint、durable_replace_failed event、
  item_failed event 与 recovery summary 的 stop-until-fixed evidence：
  `test/cli.test.ts:3611`。
- shared quarantine rename ENOENT 测试断言 failedSyscall、errno、renameCause、
  tempId 与 operationId：`test/book-job-state.test.ts:539`。

### I08_status_event_schema_observability: PASS

- contracts 在 command check、checkpoint、manifest durableFailureSummary、
  event 和 recovery summary item 中包含 lane、targetLocator、tempId、
  operationId、renameCause、lockOwnerEvidence、checksumRecoveryDecision 等
  durable diagnostics：
  `src/contracts/batch-run.ts:134`、
  `src/contracts/batch-run.ts:188`、
  `src/contracts/batch-run.ts:344`、
  `src/contracts/batch-run.ts:371`、
  `src/contracts/batch-run.ts:423`。
- runner durableProjection 保留 failureKind、localFailureClass、retryable/
  recoveryDecision 所需字段、renameCause、lock owner 和 generation/fencing
  evidence：
  `scripts/graphrag/batch-epub-workflow.mjs:2720`。
- preflight blocker event 明确写入 `failureKind=local_state_integrity`、
  `retryable=false`、`recoveryDecision=stop_until_fixed` 并投影 durable
  evidence：`scripts/graphrag/batch-epub-workflow.mjs:4722`。
- manifest 和 recovery summary 从 checkpoint/failed command 反投影 durable
  fields：`scripts/graphrag/batch-epub-workflow.mjs:8062`、
  `scripts/graphrag/batch-epub-workflow.mjs:8185`。

### I09_direct_call_chain_coverage: PASS

- repository YAML 读写通过 shared durable store：
  `src/job-state/repository.ts:70`、`src/job-state/repository.ts:400`。
- capability catalog 通过 shared durable YAML wrapper：
  `src/graphrag/capability-catalog.ts:31`、
  `src/graphrag/capability-catalog.ts:342`、
  `src/graphrag/capability-catalog.ts:350`、
  `src/graphrag/capability-catalog.ts:745`。
- durable-json 是 shared durable JSON thin wrapper：
  `src/job-state/durable-json.ts:1`。
- settings projection、python bridge 和 DSPy policy store 均调用 shared
  durable write APIs：
  `src/graphrag/settings-projection.ts:7`、
  `src/graphrag/settings-projection.ts:259`、
  `src/integrations/python-bridge.ts:11`、
  `src/integrations/python-bridge.ts:151`、
  `src/dspy/policy-store.ts:55`、
  `src/dspy/policy-store.ts:190`。
- batch runner adapter 保持 declared equivalent durable contract：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。

### I10_fault_injection_tests: PASS

- R10 状态记录显示 syntax check、type test、新 preflight 测试、4 项聚焦
  CLI 测试与 12 项 durable 聚焦 CLI 测试均 passed：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:95`。
- 本轮复跑 `node --check scripts/graphrag/batch-epub-workflow.mjs`：passed。
- 本轮复跑 `npm run test:types`：passed。
- 本轮复跑 `test/graphrag-runner-durable-preflight.test.ts`：1 passed。
- 本轮复跑 CLI 聚焦测试：4 passed，244 skipped。
- fault injection 覆盖 same-ms temp、forced temp collision、fresh/stale
  cleanup、owner evidence 缺失、generation advanced、partial checksum、
  live lock、nested row-count sidecar preflight、rename ENOENT 和 qmd index
  lock：`test/book-job-state.test.ts:421`、
  `test/cli.test.ts:2752`、`test/cli.test.ts:2883`、
  `test/cli.test.ts:2977`、`test/cli.test.ts:3049`、
  `test/cli.test.ts:3280`、`test/cli.test.ts:3386`、
  `test/cli.test.ts:3464`、`test/cli.test.ts:3611`、
  `test/cli.test.ts:4915`。

## Blocking Findings

None.

## R9 Closure

R9 Agent B 仍 PASS，且 R10 未引入 rename ENOENT taxonomy 回归。

R9 已确认 shared store 与 runner adapter 均固定 5 类 renameCause，并保持
`local_state_integrity`、`retryable=false`、
`recoveryDecision=stop_until_fixed` 与
`localFailureClass=durable_temp_rename_enoent`。R10 代码仍在 shared store
和 runner adapter 中返回同一固定集合：
`src/job-state/durable-state-store.ts:1364`、
`scripts/graphrag/batch-epub-workflow.mjs:4145`。

R10 mapping-derived preflight 改动没有削弱 durable failure projection：
preflight scan roots 来自 `durableTargetMappingTable.preflightScopes`，覆盖
nested book output 和 LanceDB row-count sidecar；阻塞事件仍发布
`local_state_integrity`、`retryable=false`、`stop_until_fixed` 和 durable
diagnostics。对应证据：
`scripts/graphrag/batch-epub-workflow.mjs:419`、
`scripts/graphrag/batch-epub-workflow.mjs:4655`、
`scripts/graphrag/batch-epub-workflow.mjs:4722`。

## Verification Reviewed

审阅的既有验证：

- R10 pre-audit verification：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:95`。
- R9 Agent B PASS 报告：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-audit-r9.md:1`。
- R9 closure 中的 taxonomy 说明：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-audit-r9.md:249`。

本轮运行的轻量验证：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：passed。
- `npm run test:types`：passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-runner-durable-preflight.test.ts`：
  1 passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 180000 test/cli.test.ts -t
  "durable preflight blocks partial checksum sidecar crash window|durable
  preflight blocks unresolved stale lock without fencing evidence|before-claim
  preflight blocks nested book output durable sidecar temp|rename ENOENT during
  durable checkpoint write is stop-until-fixed"`：4 passed，244 skipped。
