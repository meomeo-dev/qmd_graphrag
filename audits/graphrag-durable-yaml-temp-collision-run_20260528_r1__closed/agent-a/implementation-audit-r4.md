# Durable YAML/JSON Temp Collision 实施审计 R4

## Overall

FAIL。

固定 criteria 共 10 条：5 条 PASS，5 条 FAIL。

R4 相比 R3 有实质修复：runner temp owner evidence 已携带
`leaseGeneration` 与 `fencingTokenHash`，temp cleanup 会保留缺少
generation/fencing 的 stale temp；JSON file lock release 已改为先确认
`operationId`、`runnerSessionId`、`generation`、`fencingTokenHash` 后再 unlink；
`removeStaleJsonLock()` 删除后会 fsync 父目录并写 `durable_lock_recovered`；
`writeJsonAtomic()` 在 target rename 前写入 `target_rename_pending` checksum meta；
`before_claim` 与 `before_resume_book` preflight 调用点已存在。

仍不能 PASS 的原因是固定基准要求的边界与覆盖面尚未闭合：runner 仍保留与
`src/job-state/durable-state-store.ts` 平行的 durable YAML/JSON/temp/checksum/lock
实现，而不是共享实现或明确等价 adapter；SQLite qmd index lock 仍是独立实现，
未写入 durable lane/owner/generation/fencing 证据，release 也未 guarded；checksum
recovery 仍只依赖 checksum meta 和 checksum 文件，未验证 generation/owner evidence
即可 backfill；preflight 只扫描 lock/temp，未扫描 target/checksum 不一致、
subprocess/provider/book lease 语义状态，也未覆盖 book-scoped durable targets；
fault injection 测试仍缺 forced temp id collision、resume-book orphan temp、
partial checksum sidecar 等固定场景。

## Criteria checklist

| ID | 判定 | 依据 |
| --- | --- | --- |
| I01_single_durable_state_boundary | FAIL | shared store 提供 durable YAML/JSON read/write/reconcile/lock：`src/job-state/durable-state-store.ts:77`, `src/job-state/durable-state-store.ts:236`, `src/job-state/durable-state-store.ts:476`。runner 仍内联 temp/checksum/lock/reconcile/failure projection：`scripts/graphrag/batch-epub-workflow.mjs:2171`, `scripts/graphrag/batch-epub-workflow.mjs:3694`, `scripts/graphrag/batch-epub-workflow.mjs:4163`, `scripts/graphrag/batch-epub-workflow.mjs:4496`。两者不是 shared implementation 或 adapter，且语义仍不完全等价。 |
| I02_target_mapping_and_lane_enforcement | FAIL | runner 与 shared store 均有路径推断 mapping：`scripts/graphrag/batch-epub-workflow.mjs:2257`, `src/job-state/durable-state-store.ts:1389`。provider slot release 有 generation/fencing guard：`scripts/graphrag/batch-epub-workflow.mjs:3187`。但 qmd index SQLite lock 独立于 durable mapping，只写 pid/session/runId 等字段，未写 lane、targetMappingOwner、generation、fencing，也无 guarded release：`scripts/graphrag/batch-epub-workflow.mjs:2901`, `scripts/graphrag/batch-epub-workflow.mjs:2936`, `scripts/graphrag/batch-epub-workflow.mjs:2977`。 |
| I03_collision_resistant_temp_creation | PASS | runner tempId 包含 pid、Date.now、UUID operationId：`scripts/graphrag/batch-epub-workflow.mjs:2171`；temp 与 sidecar 使用 `wx` exclusive create：`scripts/graphrag/batch-epub-workflow.mjs:3578`, `scripts/graphrag/batch-epub-workflow.mjs:3706`。shared store 同样用 pid、Date.now、randomUUID 和 `wx`：`src/job-state/durable-state-store.ts:1279`, `src/job-state/durable-state-store.ts:862`。EEXIST 分类为 `durable_temp_create_collision`：`scripts/graphrag/batch-epub-workflow.mjs:3674`, `src/job-state/durable-state-store.ts:1118`。 |
| I04_owner_evidence_and_cleanup_safety | PASS | runner operation evidence 写入 owner、target、createdAt、expiresAt、leaseGeneration/targetGeneration、fencingTokenHash：`scripts/graphrag/batch-epub-workflow.mjs:2171`。cleanup 保留 fresh、owner missing/invalid、target mismatch、generation/fencing missing、owner alive、remote unproven temp，仅在 owner dead 或 lease expired 且 evidence 完整时删除：`scripts/graphrag/batch-epub-workflow.mjs:3828`。reconcile 事件写 cleanupReason、staleAgeMs、lockOwnerEvidence：`scripts/graphrag/batch-epub-workflow.mjs:4173`, `scripts/graphrag/batch-epub-workflow.mjs:4182`。shared store 也要求 cleanup fence：`src/job-state/durable-state-store.ts:651`, `src/job-state/durable-state-store.ts:1227`。 |
| I05_lock_freshness_fencing_and_takeover | PASS | runner JSON lock owner 记录 generation、fencingTokenHash、heartbeatAt、expiresAt、operationId：`scripts/graphrag/batch-epub-workflow.mjs:4501`。callback 前后调用 `assertJsonLockStillOwned()`，旧 generation/fencing 会被拒绝：`scripts/graphrag/batch-epub-workflow.mjs:4445`, `scripts/graphrag/batch-epub-workflow.mjs:4524`。release 前执行 `jsonLockOwnedBy()` guard：`scripts/graphrag/batch-epub-workflow.mjs:4478`, `scripts/graphrag/batch-epub-workflow.mjs:4486`。stale lock recovery 检查 expiry 和 owner pid，unlink 后 fsync 并写 `durable_lock_recovered`：`scripts/graphrag/batch-epub-workflow.mjs:4411`。shared store release 与 stale-writer rejection 也已 guarded：`src/job-state/durable-state-store.ts:577`, `src/job-state/durable-state-store.ts:1234`。 |
| I06_atomic_replace_and_fsync_boundary | PASS | runner replace 顺序包含 owner sidecar、temp write/fsync、pending meta、rename target、checksum temp write/fsync、rename checksum、committed meta、parent fsync：`scripts/graphrag/batch-epub-workflow.mjs:3694`。file fsync 与 directory fsync 失败分类为 durable local state 且禁止 completed：`scripts/graphrag/batch-epub-workflow.mjs:2522`, `scripts/graphrag/batch-epub-workflow.mjs:2554`。shared store 顺序与分类对应：`src/job-state/durable-state-store.ts:253`, `src/job-state/durable-state-store.ts:862`, `src/job-state/durable-state-store.ts:1044`。 |
| I07_checksum_generation_crash_window_recovery | FAIL | runner 与 shared store 能处理 checksum missing、target_new_checksum_old、pending meta、invalid meta/mismatch：`scripts/graphrag/batch-epub-workflow.mjs:4211`, `scripts/graphrag/batch-epub-workflow.mjs:4226`, `scripts/graphrag/batch-epub-workflow.mjs:4233`, `scripts/graphrag/batch-epub-workflow.mjs:4240`; `src/job-state/durable-state-store.ts:386`, `src/job-state/durable-state-store.ts:396`, `src/job-state/durable-state-store.ts:409`。但 backfill 未验证 generation/owner evidence，即可把 `target_new_checksum_old` 或 missing checksum 收敛为 committed checksum，未满足设计中“target 内容有效且 generation/owner evidence 可验证”的 crash-window 矩阵：`docs/architecture/graphrag-parallel-runner.type-dd.yaml:535`。 |
| I08_rename_enoent_failure_classification | PASS | runner `renameWithDurableEvidence()` 对 ENOENT 抛 `DurableStateError`，包含 `durable_temp_rename_enoent`、target、tempId、operationId、owner/session/generation/fencing evidence、failedSyscall、errno、renameCause、completedPublishRule：`scripts/graphrag/batch-epub-workflow.mjs:3631`, `scripts/graphrag/batch-epub-workflow.mjs:2171`, `scripts/graphrag/batch-epub-workflow.mjs:2294`。事件/checkpoint/recovery summary 测试覆盖 stop-until-fixed：`test/cli.test.ts:2963`。 |
| I09_resume_preflight_and_runner_recovery | FAIL | `before_resume_book` 与 `before_claim` 调用点存在：`scripts/graphrag/batch-epub-workflow.mjs:8268`, `scripts/graphrag/batch-epub-workflow.mjs:8866`。preflight 会扫描 run dirs 中的 temp/lock 并写 `durable_preflight_blocked` 后抛错：`scripts/graphrag/batch-epub-workflow.mjs:3953`, `scripts/graphrag/batch-epub-workflow.mjs:3974`, `scripts/graphrag/batch-epub-workflow.mjs:4029`。但 `durablePreflightTargets()` 只返回 manifest/items/providerSlot/subprocess/bookLease 目录，未扫描 book-scoped YAML/JSON、catalog/settings/DSPy/LanceDB sidecars 或 qmd index SQLite；preflight 也不调用 checksum/generation reconcile，不检查 provider slot、book lease、subprocess registry 的 live/stale 语义状态：`scripts/graphrag/batch-epub-workflow.mjs:4019`。这低于 criteria 要求。 |
| I10_regression_tests_and_observability | FAIL | observability schema 已包含 localFailureClass、targetLocator、lane、tempId、operationId、lockOwnerEvidence、checksumRecoveryDecision、fsyncTarget/fsyncErrno/fencingTokenHash 等字段：`src/contracts/batch-run.ts:134`, `src/contracts/batch-run.ts:226`, `src/contracts/batch-run.ts:347`, `src/contracts/batch-run.ts:399`。已有 same-ms temp、active/stale temp、lock timeout、rename ENOENT、provider slot stale release 等测试：`test/book-job-state.test.ts:420`, `test/book-job-state.test.ts:459`, `test/cli.test.ts:2609`, `test/cli.test.ts:2718`, `test/cli.test.ts:2805`, `test/cli.test.ts:2963`, `test/cli.test.ts:3783`。但固定要求中的 forced temp id collision、directory fsync fault injection、target-new/checksum-missing、partial checksum sidecar、resume-book orphan temp 等测试未见对应名称或断言。 |

## Findings

### High: durable state 边界仍不是单一共享边界

`I01` 仍 FAIL。runner 与 shared store 各自实现 durable operation evidence、
temp cleanup、checksum backfill、lock acquire/release 与 error projection：
`scripts/graphrag/batch-epub-workflow.mjs:2171`,
`scripts/graphrag/batch-epub-workflow.mjs:3694`,
`scripts/graphrag/batch-epub-workflow.mjs:4163`,
`scripts/graphrag/batch-epub-workflow.mjs:4496`;
`src/job-state/durable-state-store.ts:253`,
`src/job-state/durable-state-store.ts:476`,
`src/job-state/durable-state-store.ts:651`。

可执行修复：将 runner 的 YAML/JSON durable replace、checksum reconcile、lock
acquire/release、temp cleanup 收敛为 shared store adapter，或抽出一个
runner-compatible shared module，并以测试证明 runner 与 library store 使用同一
temp owner、lock release、checksum recovery 语义。

### High: SQLite qmd index lane/lock 未纳入 durable mapping/fencing

`I02` 仍 FAIL。`withQmdIndexFileLock()` 的 lock owner 只写 pid、session、runId、
host、command/item/book，不写 lane、targetMappingOwner、generation、
fencingTokenHash、operationId，也在 finally 中直接 unlink：`scripts/graphrag/batch-epub-workflow.mjs:2936`,
`scripts/graphrag/batch-epub-workflow.mjs:2945`,
`scripts/graphrag/batch-epub-workflow.mjs:2977`。

可执行修复：复用 durable target mapping，为 qmd index SQLite 写入
`qmdIndexWriterLane`、owner、timeout、releaseOn、generation、fencing hash 和
operationId；release 前确认当前 lock 仍归本 owner；timeout/recovery event 暴露同
durable JSON lock 一致的 evidence。

### High: checksum/generation crash window recovery 仍缺 generation/owner 验证

`I07` 仍 FAIL。R4 新增 pending meta，可区分
`abandoned_pending_commit_recovered`：`scripts/graphrag/batch-epub-workflow.mjs:3712`,
`scripts/graphrag/batch-epub-workflow.mjs:4233`。但是 `target_new_checksum_old`
与 checksum missing 分支只基于 checksum/meta target locator backfill：
`scripts/graphrag/batch-epub-workflow.mjs:4211`,
`scripts/graphrag/batch-epub-workflow.mjs:4226`;
shared store 同样如此：`src/job-state/durable-state-store.ts:386`,
`src/job-state/durable-state-store.ts:409`。

可执行修复：引入 durable generation/owner sidecar 或等价 commit record，并在
backfill 前验证 target generation、operation owner、leaseGeneration、
fencingTokenHash 与 commit evidence；证据缺失时 quarantine 或 stop_until_fixed，
不得直接 backfill。

### High: before_claim / before_resume_book preflight 覆盖面不足

`I09` 仍 FAIL。调用点已存在，但扫描范围只覆盖 run-root 下的少数目录，且扫描
逻辑只识别 `.tmp-` 与 `.lock`：`scripts/graphrag/batch-epub-workflow.mjs:3995`,
`scripts/graphrag/batch-epub-workflow.mjs:4019`,
`scripts/graphrag/batch-epub-workflow.mjs:4029`。固定 criteria 要求同时扫描
checksum/generation、subprocess registry、provider slot、book lease，并在
resume-book 前做 book-scoped durable state preflight。

可执行修复：preflight 入口复用 durable reconcile/checksum verifier，覆盖 manifest、
items、events/recovery summary、provider slots、subprocess registry、book leases、
book checkpoint/catalog YAML、settings/DSPy/LanceDB sidecars 与 qmd index SQLite。
对不可收敛 checksum、不可判定 lock owner、live/unknown temp、异常 lease/registry
状态统一写 `durable_preflight_blocked` 并 stop_until_fixed。

### Medium: fault injection 覆盖仍未达到固定测试矩阵

`I10` 仍 FAIL。已有 R4 测试覆盖 rename ENOENT、lock timeout、active/stale temp、
same-ms temp、provider slot stale release 等；但未见 forced temp id collision、
directory fsync fault injection、target-new/checksum-missing、partial checksum
sidecar、resume-book orphan durable temp 等固定场景。`QMD_GRAPHRAG_TEST_*` hooks
当前主要包含 lock wait、temp stale、rename ENOENT、command/resume/qmd test runner：
`scripts/graphrag/batch-epub-workflow.mjs:159`,
`scripts/graphrag/batch-epub-workflow.mjs:163`,
`scripts/graphrag/batch-epub-workflow.mjs:168`,
`scripts/graphrag/batch-epub-workflow.mjs:290`。

可执行修复：补齐固定矩阵的 fault hooks 与断言，尤其是 forced temp id collision、
checksum sidecar partial write、target-new/checksum-missing、directory fsync uncertain
传播到 checkpoint/event/status/recovery summary，以及 resume-book orphan temp 阻断。

## Residual risk for PASS items

- `I04` residual risk：cleanup 依赖本机 `processAlive()` 与 `expiresAt`；跨主机 owner
在 lease 未过期时会保留，符合安全优先，但可能需要人工修复 stale remote temp。
- `I05` residual risk：JSON file lock 没有持续 heartbeat refresh。当前 protected
critical section 前后有 fencing check，且 stale removal 需要 owner dead；长 critical
section 的可用性风险仍存在，但不再构成“旧 writer 删除新 lock”的完整性风险。
- `I08` residual risk：rename ENOENT 的 cause 固定为
`filesystem_or_external_mutation`，未细分完整 cause matrix；固定 criteria 要求分类为
local_state_integrity 并保留 evidence，当前满足。

## Evidence

读取并用于审计的关键文件：

- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-criteria.yaml`
- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r3.md`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/job-state/durable-state-store.ts`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `test/book-job-state.test.ts`
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`

验证依据：

- 用户提供的本轮验证结果包括 `node --check`、`npm run test:types`、CLI durable
  聚焦组、book-state durable 聚焦组，以及慢测 group 均 passed。
- 本审计未启动真实 EPUB runner，未处理真实 runId
  `epub-batch-20260527-real-resume-1`，未读取或打印 `.env` 内容。
- 本审计未修改 fixed criteria 文件；仅写入本 R4 报告文件。
