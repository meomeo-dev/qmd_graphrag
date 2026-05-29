# Durable YAML/JSON Temp Collision 实施审计 R4

## Overall

FAIL。

固定 criteria 共 10 条：6 条 PASS，4 条 FAIL。

本轮实现已关闭多项 R3 阻塞点：runner temp owner evidence 已包含
lease generation 与 fencing hash，lock release 已做 owner/fencing guarded
release，pending checksum meta crash window 已增加 abandoned pending recovery，
`before_claim` 与 `before_resume_book` durable preflight 已接入，batch schema、
failure classifier 与 rename ENOENT 事件/ checkpoint / recovery summary 投影
也已对齐。

仍未满足固定基准的点集中在：单一 durable 边界（single durable boundary）仍
有内联实现和旁路，stale lock recovery 未完整校验 generation/fencing 且共享
store 不记录 recovery evidence，temp cleanup 未验证 target generation 未推进，
以及 fault-injection 测试矩阵仍未覆盖 live stale temp、directory fsync fault、
checksum partial/pending meta runner 闭环等场景。

## Criteria Checklist

### I01_temp_identity_exclusive_create

PASS。共享 durable store 与 runner replace 写入都使用 target path 派生 temp、
pid、timestamp、UUID operationId，并以 exclusive create 写入。

证据：`src/job-state/durable-state-store.ts:1279`、
`src/job-state/durable-state-store.ts:253`、
`src/job-state/durable-state-store.ts:862`、
`scripts/graphrag/batch-epub-workflow.mjs:2163`、
`scripts/graphrag/batch-epub-workflow.mjs:2171`、
`scripts/graphrag/batch-epub-workflow.mjs:3694`。

### I02_single_durable_boundary

FAIL。repository、capability catalog、settings projection、python bridge、
durable-json 多数路径已复用共享 store，但 runner 仍保留独立 durable
replace/reconcile/lock 实现；repository legacy fallback 和 DSPy pointer restore
仍有未声明旁路。

证据：`scripts/graphrag/batch-epub-workflow.mjs:3694`、
`scripts/graphrag/batch-epub-workflow.mjs:4163`、
`scripts/graphrag/batch-epub-workflow.mjs:4496`、
`src/job-state/durable-state-store.ts:136`、
`src/job-state/repository.ts:1926`、
`src/job-state/repository.ts:2124`、
`src/dspy/policy-store.ts:547`。

### I03_lock_owner_fencing

FAIL。lock owner 字段与 guarded release 已补强，但 stale lock 删除前未要求
generation/fencing 可校验；共享 store stale lock recovery 也不记录
`durable_lock_recovered` 或等价 evidence。

证据：`scripts/graphrag/batch-epub-workflow.mjs:4502`、
`scripts/graphrag/batch-epub-workflow.mjs:4411`、
`scripts/graphrag/batch-epub-workflow.mjs:4486`、
`src/job-state/durable-state-store.ts:1308`、
`src/job-state/durable-state-store.ts:603`、
`src/job-state/durable-state-store.ts:577`。

### I04_live_temp_cleanup_safety

FAIL。fresh、ownerless、missing generation/fencing、owner alive 与 remote unproven
temp 会被保留，reconcile 也持有 per-target lock；但 runner 与共享 store
cleanup 删除 stale temp 前均未验证 target generation 未推进。共享 store cleanup
删除后也缺少 fsync/event evidence。

证据：`scripts/graphrag/batch-epub-workflow.mjs:3828`、
`scripts/graphrag/batch-epub-workflow.mjs:3871`、
`scripts/graphrag/batch-epub-workflow.mjs:4174`、
`src/job-state/durable-state-store.ts:651`、
`src/job-state/durable-state-store.ts:1227`。

### I05_checksum_commit_recovery

PASS。target-new/checksum-old、target-new/checksum-missing、pending meta 与
checksum mismatch 均有收敛或 fail-closed 逻辑；pending meta 与当前
target/checksum 不一致时不再误隔离旧有效 target，而是 backfill
`abandoned_pending_commit_recovered`。

证据：`src/job-state/durable-state-store.ts:253`、
`src/job-state/durable-state-store.ts:383`、
`src/job-state/durable-state-store.ts:396`、
`scripts/graphrag/batch-epub-workflow.mjs:3694`、
`scripts/graphrag/batch-epub-workflow.mjs:4211`、
`scripts/graphrag/batch-epub-workflow.mjs:4233`。

### I06_fsync_platform_failure

PASS。file fsync 与 parent directory fsync failure 会转为 local durable state
failure，并带 `fsyncTarget`、`fsyncErrno`、`fsyncPlatform`、`durableMode`、
`completedPublishRule=forbidden`。

证据：`src/job-state/durable-state-store.ts:1044`、
`src/job-state/durable-state-store.ts:1098`、
`scripts/graphrag/batch-epub-workflow.mjs:2522`、
`scripts/graphrag/batch-epub-workflow.mjs:2554`。

### I07_batch_observability_schema

PASS。checkpoint、event、status-json/recovery summary schema 已承载 durable
failure 字段，runner 通过 `durableProjection` 投影 failure evidence；rename
ENOENT 测试证明 checkpoint、event 与 recovery summary 不降级为
unknown/provider transient。

证据：`src/contracts/batch-run.ts:134`、
`src/contracts/batch-run.ts:226`、
`src/contracts/batch-run.ts:347`、
`src/contracts/batch-run.ts:399`、
`scripts/graphrag/batch-epub-workflow.mjs:2368`、
`scripts/graphrag/batch-epub-workflow.mjs:7310`、
`test/cli.test.ts:2963`。

### I08_failure_classifier_mapping

PASS。classifier 在 provider transient 规则之前识别 local durable state failure，
覆盖 rename ENOENT、live temp deletion、checksum window/mismatch、fsync failure
与 lock timeout，并固定 `retryable=false` 与 `stop_until_fixed`。

证据：`scripts/graphrag/batch-failure-classifier.mjs:1`、
`scripts/graphrag/batch-failure-classifier.mjs:83`、
`scripts/graphrag/batch-failure-classifier.mjs:102`、
`test/cli.test.ts:2574`。

### I09_direct_call_chain_coverage

PASS。受审 direct durable YAML/JSON write path 已基本纳入 durable store 或
runner equivalent helper：repository、capability catalog、settings projection、
durable-json、python bridge、DSPy policy store 与 runner checkpoint/manifest
writes 均具备 collision-resistant temp、lock、checksum 与 fsync 语义。

证据：`src/job-state/repository.ts:70`、
`src/job-state/repository.ts:400`、
`src/graphrag/capability-catalog.ts:31`、
`src/graphrag/capability-catalog.ts:730`、
`src/graphrag/settings-projection.ts:6`、
`src/graphrag/settings-projection.ts:259`、
`src/job-state/durable-json.ts:1`、
`src/integrations/python-bridge.ts:151`、
`src/dspy/policy-store.ts:55`、
`src/dspy/policy-store.ts:190`、
`scripts/graphrag/batch-epub-workflow.mjs:4648`。

### I10_fault_injection_tests

FAIL。已覆盖 same-ms temp、multi-worker runner、provider slot gating、qmd index
lock、rename ENOENT、部分 checksum recovery 与 event fields；但未覆盖 stale
live temp、directory fsync fault injection、checksum partial/pending meta runner
status-json 闭环，以及所有 local durable failures 的 checkpoint/event/status-json/
recovery summary 稳定输出。

证据：`test/book-job-state.test.ts:420`、
`test/book-job-state.test.ts:459`、
`test/cli.test.ts:2718`、
`test/cli.test.ts:2963`、
`test/cli.test.ts:3098`、
`test/cli.test.ts:3741`、
`test/cli.test.ts:4264`。

## Findings

### High: stale lock recovery 未完整 fencing，且共享 store 无 recovery evidence

`withJsonFileLock` 和 shared `withDurableFileLock` 已写入 generation 与
fencingTokenHash，并在 commit 前后校验 owner。runner 与 shared release 也已
改为 guarded release，不再无条件 unlink 当前 lock。证据：
`scripts/graphrag/batch-epub-workflow.mjs:4445`、
`scripts/graphrag/batch-epub-workflow.mjs:4486`、
`src/job-state/durable-state-store.ts:1234`、
`src/job-state/durable-state-store.ts:577`。

缺口是 stale lock takeover/recovery：runner `removeStaleJsonLock()` 只校验
TTL、owner expiry 与 pid liveness 后删除 lock，未要求 generation/fencing
字段存在且可校验；shared `removeStaleDurableLock()` / sync 版本同样只校验
TTL、host 与 pid liveness。shared store 删除 stale lock 后没有写入
`durable_lock_recovered` 或等价可审计 evidence。证据：
`scripts/graphrag/batch-epub-workflow.mjs:4411`、
`src/job-state/durable-state-store.ts:603`、
`src/job-state/durable-state-store.ts:627`。

可执行修复：stale lock 删除前拒绝缺少 generation/fencingTokenHash/
runnerSessionId/operationId 的 owner；对可删除 lock 记录 recovery evidence。
共享 store 可通过 callback/event sink、sidecar recovery record，或向调用方返回
recovery decision，使 runner/status-json 能稳定呈现 `durable_lock_recovered`。

### High: temp cleanup 未证明 target generation 未推进

runner cleanup 已明显补强：owner evidence 缺失、createdAt 缺失、
target mismatch、generation/fencing 缺失、owner alive 与 remote unproven 均会
preserve；reconcile 删除 temp 时也在 per-target lock 内执行。证据：
`scripts/graphrag/batch-epub-workflow.mjs:3828`、
`scripts/graphrag/batch-epub-workflow.mjs:3871`、
`scripts/graphrag/batch-epub-workflow.mjs:3883`、
`scripts/graphrag/batch-epub-workflow.mjs:4174`。

固定 criteria 仍要求删除 temp 前验证 target generation 未推进。当前 runner
只把 `targetGeneration` 写进 operation evidence，但 cleanup decision 不读取当前
target checksum/meta/generation，也不比较 owner 的 generation/fencing 与当前
target 状态。shared store `removeStaleDurableTempsUnlocked()` 也只有 target
match、createdAt、cleanup fence、age 与 owner alive 校验，删除后没有 fsync
目录或事件化 evidence。证据：
`scripts/graphrag/batch-epub-workflow.mjs:2208`、
`scripts/graphrag/batch-epub-workflow.mjs:3828`、
`src/job-state/durable-state-store.ts:651`、
`src/job-state/durable-state-store.ts:683`。

可执行修复：temp owner sidecar 的 `targetGeneration`、`leaseGeneration` 与
`fencingTokenHash` 必须和当前 target checksum meta / generation sidecar 对比。
无法证明 target generation 未推进时 preserve 或 stop_until_fixed，不删除 temp。
shared store 删除 temp 后应 fsync parent directory，并记录 cleanup decision。

### Medium: durable 边界仍未完全收敛

TypeScript 侧多数模块已使用 `durable-state-store`：repository 写入经
`writeYamlFileDurable`，capability catalog 通过 `updateYamlUnknownDurable`，
settings projection 使用 durable YAML writer，python bridge 使用 durable JSON
writer，`durable-json.ts` 是共享 adapter。证据：
`src/job-state/repository.ts:70`、
`src/graphrag/capability-catalog.ts:31`、
`src/graphrag/settings-projection.ts:6`、
`src/integrations/python-bridge.ts:151`、
`src/job-state/durable-json.ts:1`。

但 runner 仍维护独立 JSON/JSONL replace、checksum reconcile、temp cleanup 与
lock 实现；这些实现虽接近共享 store，但不是单一边界。另有 legacy fallback
在 durable read 之后重新裸 `readFile` + `YAML.parse`，DSPy pointer restore 在
无 previous pointer 时直接 `rmSync` pointer YAML。证据：
`scripts/graphrag/batch-epub-workflow.mjs:3694`、
`scripts/graphrag/batch-epub-workflow.mjs:4163`、
`scripts/graphrag/batch-epub-workflow.mjs:4496`、
`src/job-state/repository.ts:1926`、
`src/job-state/repository.ts:2124`、
`src/dspy/policy-store.ts:547`。

可执行修复：把 runner durable JSON/JSONL write、reconcile、lock recovery 与
cleanup 抽成共享 adapter，或让 runner 调用 shared store 并只保留 event/status
projection。legacy fallback raw reads 应在 durable lock 内完成，DSPy pointer
delete 应提供 durable delete adapter，包括 lock、fsync、checksum cleanup 与
failure classification。

### Medium: fault-injection 覆盖未达到固定矩阵

已有测试覆盖同 pid/同毫秒 temp、graph capability concurrent commits、
runner rename ENOENT、lock timeout evidence、fresh/stale temp reconcile、
provider slot capacity、qmd index file lock 与 terminal completion fence。证据：
`test/book-job-state.test.ts:420`、
`test/book-job-state.test.ts:3471`、
`test/cli.test.ts:2609`、
`test/cli.test.ts:2718`、
`test/cli.test.ts:2963`、
`test/cli.test.ts:3741`、
`test/cli.test.ts:4264`。

缺口仍包括：

- stale 但 owner pid 仍 live 的 temp cleanup，不仅是 fresh temp。
- remote owner 且 lease 未过期的 stale temp。
- directory fsync failure/unsupported 的真实 fault injection，而不仅是 classifier
  string test。
- runner 层 target-new/checksum-missing、checksum partial write、pending meta
  abandoned commit 的 status-json/recovery summary 闭环。
- stale lock owner 缺少 generation/fencing 时不得 takeover 的测试。
- 所有 local durable state failure 均证明不会发布错误 `item_completed`，并稳定
  写出 item checkpoint、event、status-json 与 recovery summary。

可执行修复：增加 test hook，仅在 `QMD_GRAPHRAG_ENABLE_TEST_HOOKS=1` 下触发
fsync、checksum partial、pending meta、live temp 与 lock owner fault；每个 fault
都断言 checkpoint/event/status-json/recovery summary 的 durable fields。

## Evidence

- 固定 criteria：`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-c/implementation-criteria.yaml`。
- R3 背景：`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-audit-r3.md`、`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-audit-r3.md`。
- Runner 实现：`scripts/graphrag/batch-epub-workflow.mjs:2171`、`:3694`、`:3828`、`:4029`、`:4163`、`:4411`、`:4486`、`:8268`、`:8866`、`:9120`。
- Shared durable store：`src/job-state/durable-state-store.ts:136`、`:253`、`:363`、`:476`、`:603`、`:651`、`:1044`、`:1279`、`:1308`。
- Batch contracts/schema：`src/contracts/batch-run.ts:134`、`:226`、`:347`、`:399`。
- Durable adapters/call chain：`src/job-state/durable-json.ts:1`、`src/job-state/repository.ts:70`、`src/graphrag/capability-catalog.ts:31`、`src/graphrag/settings-projection.ts:6`、`src/integrations/python-bridge.ts:151`、`src/dspy/policy-store.ts:55`。
- Failure classifier：`scripts/graphrag/batch-failure-classifier.mjs:1`、`:83`、`:102`。
- Tests reviewed：`test/book-job-state.test.ts:420`、`:459`、`:1670`、`:3269`、`:3471`、`test/cli.test.ts:2574`、`:2609`、`:2718`、`:2805`、`:2963`、`:3098`、`:3485`、`:3741`、`:3783`、`:4264`、`:12957`、`:13015`。
- 用户提供的已通过验证：`node --check` 两个 runner/classifier 脚本、
  `npm run test:types`、CLI durable 聚焦组、book-state durable 聚焦组，以及
  book-concurrency、provider slots、qmd command lock、terminal fence、
  non-transient/provider-slot stale release 等慢测。
