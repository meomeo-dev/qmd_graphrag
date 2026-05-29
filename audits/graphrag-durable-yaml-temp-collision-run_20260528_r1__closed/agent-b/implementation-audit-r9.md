# Implementation Audit R9 - Agent B

Verdict: PASS

## Criteria Results

### I01_single_durable_boundary: PASS

- 生产共享边界由 `DurableAdapterContract` 声明 targetMapping、exclusive
  temp create、owner evidence、checksumCommitMeta、targetGenerationFence、
  guardedLockRelease、preflightReconcile 与 localStateFailureProjection：
  `src/job-state/durable-state-store.ts:39`。
- repository、capability catalog、settings projection、python bridge、DSPy
  policy store 与 durable-json 均进入 shared durable store：
  `src/job-state/repository.ts:70`、
  `src/graphrag/capability-catalog.ts:31`、
  `src/graphrag/settings-projection.ts:7`、
  `src/integrations/python-bridge.ts:151`、
  `src/dspy/policy-store.ts:55`、
  `src/job-state/durable-json.ts:1`。
- runner adapter 声明等价 durable boundary，并列出相同 guarantee 集合：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。
- shared store 与 runner adapter 均在 durable replace 中创建 owner sidecar、
  exclusive temp、checksum pending/committed meta、rename、checksum rename
  与 parent fsync：
  `src/job-state/durable-state-store.ts:465`、
  `scripts/graphrag/batch-epub-workflow.mjs:4168`。

### I02_target_mapping_enforcement: PASS

- 设计 targetMapping 覆盖 catalog、book YAML、item checkpoint、manifest、
  status、run lock、provider slot、subprocess registry、book lease、settings、
  qmd index 与 row-count sidecar 等生产目标：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241`。
- runner targetMapping 表覆盖 batch items、manifest、events、status、
  recovery summary、coordinator lock、provider slots、subprocesses、book
  leases、provider requests、cost accounting、DSPy、qmd manifests、LanceDB
  row-count 与 qmd index：
  `scripts/graphrag/batch-epub-workflow.mjs:238`。
- runner 对生产未映射 target fail-closed：
  `scripts/graphrag/batch-epub-workflow.mjs:2515`。
- shared store 对 `/graph_vault/`、`.qmd/index.sqlite`、`index.sqlite`
  与 sqlite lock 等生产 target fail-closed：
  `src/job-state/durable-state-store.ts:1885`、
  `src/job-state/durable-state-store.ts:1935`。
- qmd index 命令锁测试仍覆盖 acquire/release evidence：
  `test/cli.test.ts:4915`。

### I03_temp_identity_exclusive_create: PASS

- shared store tempId 包含 `randomUUID()` 生成的 operationId：
  `src/job-state/durable-state-store.ts:1764`。
- runner tempId 包含 `randomUUID()` 生成的 operationId，测试 hook 仅在
  test hooks 启用时覆盖：
  `scripts/graphrag/batch-epub-workflow.mjs:2407`、
  `scripts/graphrag/batch-epub-workflow.mjs:2459`。
- shared store 与 runner JSON path 使用 `wx` exclusive create：
  `src/job-state/durable-state-store.ts:483`、
  `src/job-state/durable-state-store.ts:500`、
  `scripts/graphrag/batch-epub-workflow.mjs:4182`、
  `scripts/graphrag/batch-epub-workflow.mjs:4203`。
- EEXIST 被分类为 `durable_temp_create_collision`，不会覆盖 foreign temp：
  `src/job-state/durable-state-store.ts:1553`、
  `scripts/graphrag/batch-epub-workflow.mjs:4148`。
- 同毫秒与 forced collision 测试覆盖：
  `test/book-job-state.test.ts:421`、
  `test/cli.test.ts:2752`。

### I04_temp_owner_evidence: PASS

- shared store owner evidence 包含 tempId、operationId、targetLocator、
  lane、owner、runnerSessionId、workerId、itemId、bookId、ownerPid、
  ownerHost、createdAt、expiresAt、leaseGeneration、targetGeneration、
  targetChecksumBefore 与 fencingTokenHash：
  `src/job-state/durable-state-store.ts:1760`。
- runner owner evidence 包含对应字段，并带 absoluteTargetLocator 供本地
  定位：
  `scripts/graphrag/batch-epub-workflow.mjs:2407`。
- runner typed JSON 写入从目标值派生 item/book/worker/generation/fencing
  context：
  `scripts/graphrag/batch-epub-workflow.mjs:2486`、
  `scripts/graphrag/batch-epub-workflow.mjs:5438`。
- cleanup、preflight 与 event projection 会读取 owner evidence：
  `scripts/graphrag/batch-epub-workflow.mjs:4269`、
  `scripts/graphrag/batch-epub-workflow.mjs:4420`。

### I05_inflight_cleanup_safety: PASS

- shared store cleanup 检查 owner target、createdAt、cleanup fence、
  target generation 未推进、stale TTL、owner alive、lease expired 与
  local owner dead：
  `src/job-state/durable-state-store.ts:969`。
- shared cleanup 删除后写 `.durable-recovery.jsonl`，包含 tempId、
  operationId、cleanupReason、staleAgeMs 与 owner evidence：
  `src/job-state/durable-state-store.ts:1014`、
  `src/job-state/durable-state-store.ts:1078`。
- runner cleanup decision 同样保留 fresh temp、owner evidence 缺失 temp、
  target generation advanced temp 与 live owner temp：
  `scripts/graphrag/batch-epub-workflow.mjs:4308`。
- runner cleanup 删除 stale temp 后写 `durable_json_temp_reconciled` 或
  `durable_yaml_temp_reconciled` event：
  `scripts/graphrag/batch-epub-workflow.mjs:4809`、
  `scripts/graphrag/batch-epub-workflow.mjs:4944`。
- 相关测试覆盖 fresh、owner evidence 缺失、owner-dead stale 与 generation
  advanced：
  `test/cli.test.ts:2883`、
  `test/cli.test.ts:2977`、
  `test/cli.test.ts:3049`、
  `test/book-job-state.test.ts:618`。

### I06_atomic_commit_and_checksum_recovery: PASS

- shared store 写入顺序覆盖 owner sidecar、temp fsync、pending checksum
  meta、target rename、checksum temp、checksum rename、committed meta 与
  parent fsync：
  `src/job-state/durable-state-store.ts:481`、
  `src/job-state/durable-state-store.ts:489`、
  `src/job-state/durable-state-store.ts:499`、
  `src/job-state/durable-state-store.ts:506`、
  `src/job-state/durable-state-store.ts:509`。
- shared recovery 处理 checksum missing、pending、old、mismatch/quarantine
  与 checksum backfill：
  `src/job-state/durable-state-store.ts:1097`、
  `src/job-state/durable-state-store.ts:1415`。
- runner JSON durable path 有相同 pending/committed checksum sequence：
  `scripts/graphrag/batch-epub-workflow.mjs:4168`。
- checksum crash-window 测试覆盖 pending meta、partial checksum sidecar 与
  shared checksum recovery：
  `test/book-job-state.test.ts:460`、
  `test/cli.test.ts:3207`、
  `test/cli.test.ts:3280`。

### I07_rename_enoent_classification: PASS

- 设计文档要求 rename ENOENT 固定为 `local_state_integrity`、
  `retryable=false`、`recoveryDecision=stop_until_fixed`、
  `localFailureClass=durable_temp_rename_enoent`，并限定 5 个 cause：
  `temp_collision`、`reconciler_mistaken_deletion`、
  `concurrent_takeover`、`generation_advanced`、
  `filesystem_or_external_mutation`：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:636`。
- shared store 的 `renameWithEvidence()` 与 sync 版本在 ENOENT 时抛出
  `DurableStateError`，持久 evidence 包含 failedSyscall、errno 与
  renameCause：
  `src/job-state/durable-state-store.ts:1306`、
  `src/job-state/durable-state-store.ts:1335`。
- shared store 的 `inferRenameEnoentCause()` 只返回固定 5 类 taxonomy：
  `generation_advanced`、`temp_collision`、
  `reconciler_mistaken_deletion`、`concurrent_takeover`、
  `filesystem_or_external_mutation`：
  `src/job-state/durable-state-store.ts:1364`。
- runner adapter 的 `renameWithDurableEvidence()` 同样在 ENOENT 时抛出
  `durable_temp_rename_enoent`，带 failedSyscall、errno、renameCause、
  completedPublishRule 与 redactedEvidenceLocator：
  `scripts/graphrag/batch-epub-workflow.mjs:4076`。
- runner adapter 的 `inferRenameEnoentCause()` 与 shared store 的返回集合
  一致：
  `scripts/graphrag/batch-epub-workflow.mjs:4105`。
- `DurableStateError` 在 shared store 和 runner 中均固定
  `retryable=false` 与 `recoveryDecision=stop_until_fixed`：
  `src/job-state/durable-state-store.ts:219`、
  `scripts/graphrag/batch-epub-workflow.mjs:2646`。
- runner rename ENOENT 测试断言 checkpoint、durable_replace_failed event、
  item_failed event 与 recovery summary 均含 stop-until-fixed evidence：
  `test/cli.test.ts:3611`。
- shared quarantine rename ENOENT 测试断言 failedSyscall、errno、
  renameCause、tempId 与 operationId：
  `test/book-job-state.test.ts:539`。

### I08_status_event_schema_observability: PASS

- contracts 的 command check、checkpoint、manifest durableFailureSummary、
  event 与 recovery summary item 均包含 durable diagnostics 字段：
  `src/contracts/batch-run.ts:134`、
  `src/contracts/batch-run.ts:188`、
  `src/contracts/batch-run.ts:344`、
  `src/contracts/batch-run.ts:371`、
  `src/contracts/batch-run.ts:423`。
- runner local durable evidence/projection 包含 lane、targetLocator、tempId、
  operationId、failureKind、localFailureClass、retryable/recoveryDecision
  投影所需字段、renameCause、lockOwnerEvidence、checksumRecoveryDecision、
  owner 与 generation evidence：
  `scripts/graphrag/batch-epub-workflow.mjs:2606`、
  `scripts/graphrag/batch-epub-workflow.mjs:2680`。
- event 写入前对 message 与 metadata 做 redaction：
  `scripts/graphrag/batch-epub-workflow.mjs:2315`、
  `scripts/graphrag/batch-epub-workflow.mjs:2363`、
  `scripts/graphrag/batch-epub-workflow.mjs:3833`。
- manifest 从 checkpoint 反推 durableFailureSummary，recovery summary item
  也投影 durableProjection：
  `scripts/graphrag/batch-epub-workflow.mjs:7947`、
  `scripts/graphrag/batch-epub-workflow.mjs:8078`。

### I09_direct_call_chain_coverage: PASS

- repository durable YAML 读写通过 shared durable store：
  `src/job-state/repository.ts:70`、
  `src/job-state/repository.ts:400`。
- capability catalog 通过 shared durable YAML unknown/update wrapper：
  `src/graphrag/capability-catalog.ts:31`、
  `src/graphrag/capability-catalog.ts:342`、
  `src/graphrag/capability-catalog.ts:745`。
- durable-json 是 shared store thin wrapper：
  `src/job-state/durable-json.ts:1`。
- settings projection 通过 shared durable YAML：
  `src/graphrag/settings-projection.ts:7`、
  `src/graphrag/settings-projection.ts:259`。
- python bridge subprocess registry 通过 shared durable JSON sync：
  `src/integrations/python-bridge.ts:151`。
- dspy policy store 通过 shared durable YAML/JSON/opaque write：
  `src/dspy/policy-store.ts:55`、
  `src/dspy/policy-store.ts:190`、
  `src/dspy/policy-store.ts:194`、
  `src/dspy/policy-store.ts:198`。
- batch runner 私有 adapter 已声明 shared equivalent contract 并补齐
  targetMapping、owner evidence、checksum、cleanup、lock 与 observability：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。

### I10_fault_injection_tests: PASS

- R9 前置验证记录 12 个 runner durable 聚焦测试、12 个 shared store durable
  测试、4 个 GraphRAG book-state 测试、contracts、LLM 与 cost 测试全部
  passed：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:84`。
- 本轮复跑 `node --check scripts/graphrag/batch-epub-workflow.mjs` 通过。
- 本轮复跑 `npm run test:types` 通过。
- 本轮复跑 runner rename ENOENT 聚焦测试通过：
  `test/cli.test.ts:3611`。
- 本轮复跑 shared quarantine rename ENOENT 聚焦测试通过：
  `test/book-job-state.test.ts:539`。
- fault injection 覆盖同毫秒 temp collision、forced temp collision、fresh/
  stale temp reconciliation、owner evidence 缺失、generation advanced、
  checksum pending/partial windows、lock timeout、nested durable sidecar
  preflight 与 qmd index lock：
  `test/book-job-state.test.ts:421`、
  `test/cli.test.ts:2752`、
  `test/cli.test.ts:2883`、
  `test/cli.test.ts:2977`、
  `test/cli.test.ts:3049`、
  `test/cli.test.ts:3207`、
  `test/cli.test.ts:3280`、
  `test/cli.test.ts:3464`、
  `test/cli.test.ts:4915`。

## Blocking Findings

None.

## R8 Closure

R8 Agent B blocker 已关闭。

R8 阻塞项要求 rename ENOENT cause matrix 实现固定 taxonomy：
`temp_collision`、`reconciler_mistaken_deletion`、`concurrent_takeover`、
`generation_advanced`、`filesystem_or_external_mutation`。R9 中 shared store
与 runner adapter 均实现并返回上述 5 个固定值，且 ENOENT failure 保持
`local_state_integrity`、`retryable=false`、`recoveryDecision=stop_until_fixed`
和 `localFailureClass=durable_temp_rename_enoent`。

剩余非阻塞风险：现有聚焦测试覆盖 runner `generation_advanced` 与 shared
store `filesystem_or_external_mutation` 的 renameCause 输出；其他 cause 分支
通过代码路径和固定返回集合审计确认，但未见逐 cause 的端到端断言。该风险不
改变本轮 I07 通过结论，因为固定 taxonomy 已实现，证据不足时也按设计
fail-closed 到 `filesystem_or_external_mutation`。

## Verification Reviewed

审阅的既有证据：

- R9 pre-audit verification：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:84`。
- R8 Agent B blocker：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-audit-r8.md:16`。
- 固定 Agent B criteria：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-criteria.yaml:23`。

本轮运行的轻量验证：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：passed。
- `npm run test:types`：passed。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 180000 test/cli.test.ts -t "rename ENOENT during durable checkpoint write is stop-until-fixed"`：
  1 passed, 247 skipped。
- `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/book-job-state.test.ts -t "classifies shared quarantine rename ENOENT with durable evidence"`：
  1 passed, 65 skipped。

本轮未启动真实 EPUB runner，未处理 inbox 真实图书，未读取或打印 `.env` /
secrets，未修改 fixed criteria。
