# Durable YAML/JSON Temp Collision 实施审计 R2

## 结论

总体结论：FAIL。

固定基准共 10 条：1 条 PASS，9 条 FAIL。

R2 实现较 R1 有实质进展：新增 `src/job-state/durable-state-store.ts`
统一了多数 TypeScript 侧 YAML/JSON 读写；batch runner 增加了辅助 JSON
过滤（auxiliary JSON filtering）、temp owner sidecar、strict directory fsync
分类、provider/book/subprocess lease sidecar 过滤、heartbeat fencing merge、
以及 test-only command check narrowing 的环境门控。

仍未达到固定 criteria 的 durable state 完整边界。主要阻塞点是：batch runner
仍保留一套语义不等价的本地 durable JSON/YAML/lock 实现；durable lock 缺少
完整 heartbeat/fencing/takeover 语义；temp cleanup 未验证 owner target、
generation、createdAt 与 lease evidence；checksum/generation crash-window
恢复缺少 generation 与完整分支；rename ENOENT 证据字段在 runner 侧不完整；
claim/resume-book 前没有强制 preflight stop_until_fixed。

## 重点关注项判定

- 辅助 JSON 过滤：通过。`isDurableAuxiliaryPath()`、
  `isDurablePrimaryJsonEntry()` 已排除 `.owner.json`、`.sha256`、
  `.sha256.meta.json`、`.tmp-*`、`.corrupt-*`、`.lock`；provider slots、
  subprocess records、book leases 均在读取列表时过滤 primary JSON。
- owner sidecar cleanup：部分实现但未通过基准。temp 创建已写 owner
  sidecar；runner 能保留 fresh temp 并清理 stale dead-owner temp。但 cleanup
  未验证 owner target、generation、createdAt，且允许 stale orphan temp
  without owner 删除。
- heartbeat fencing merge：部分通过。`mergeCurrentItemLeaseProjection()` 会在
  same runner/session/fencing 条件下保留较新的 `runnerHeartbeatAt` 与
  `leaseExpiresAt`。但 durable file lock 本身仍缺少持续 heartbeat 与
  pre/post commit fencing 验证。
- test-only command check narrowing：通过。`QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES`
  只在 `QMD_GRAPHRAG_ENABLE_TEST_HOOKS=1` 时生效，并拒绝 unknown、
  duplicate 与缺少 graph query checks 的集合。
- 生产完整命令矩阵：通过。未启用 test hooks 时使用
  `defaultRequiredCommandCheckNames`；`runCliChecks()` 仍枚举完整生产命令矩阵，
  且相关 CLI 测试通过。
- provider/book/subprocess lease sidecar 过滤：通过。对应读取函数过滤 durable
  auxiliary entries；相关 CLI 测试通过。

## 固定基准逐项判定

### I01_single_durable_state_boundary

判定：FAIL。

证据：

- `src/job-state/durable-state-store.ts:76` 至 `src/job-state/durable-state-store.ts:203`
  提供共享 YAML/JSON durable API。
- `src/job-state/durable-json.ts:1` 至 `src/job-state/durable-json.ts:17`
  已改为 adapter/re-export。
- `scripts/graphrag/batch-epub-workflow.mjs:2089` 至
  `scripts/graphrag/batch-epub-workflow.mjs:2311`、
  `scripts/graphrag/batch-epub-workflow.mjs:3321` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3848`、
  `scripts/graphrag/batch-epub-workflow.mjs:3881` 至
  `scripts/graphrag/batch-epub-workflow.mjs:4017` 仍保留本地 durable
  JSON/YAML/checksum/temp/lock/failure implementation。

缺口：

batch runner 内联实现不是共享 store 的 adapter，且与共享实现语义不等价：
lock owner schema、stale lock recovery、evidence whitelist、status-json
reconcile、checksum metadata 写入与 failure evidence 均不同。该重复边界覆盖
manifest、checkpoint、provider slot、subprocess registry、book lease、coordinator
lock 等本次事故核心状态，因此不满足单一 durable state 边界。

### I02_target_mapping_and_lane_enforcement

判定：FAIL。

证据：

- qmd index 已有 `qmdIndexWriterLane` 与 file lock：
  `scripts/graphrag/batch-epub-workflow.mjs:2685`、
  `scripts/graphrag/batch-epub-workflow.mjs:2988`、
  `scripts/graphrag/batch-epub-workflow.mjs:7464` 至
  `scripts/graphrag/batch-epub-workflow.mjs:7481`。
- provider slots 使用 provider semaphore 与 durable lease：
  `scripts/graphrag/batch-epub-workflow.mjs:2882` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3003`。
- book lease acquire/refresh/release 使用 per-book JSON lock：
  `scripts/graphrag/batch-epub-workflow.mjs:2535` 至
  `scripts/graphrag/batch-epub-workflow.mjs:2627`。

缺口：

实现没有完整 target mapping 表或等价代码路径，不能证明每个生产 YAML/JSON/
SQLite target 都映射到唯一 writer lane、owner、timeout 与 release-on-error
规则。`reconcileDurableRunFiles()` 在 coordinator lock 后直接遍历并调用
`reconcileDurableJsonTarget()`，未为每个 target 获取 per-target lock：
`scripts/graphrag/batch-epub-workflow.mjs:3848` 至
`scripts/graphrag/batch-epub-workflow.mjs:3862`。共享
`durable-state-store` 也只提供 per-file lock，未表达设计中的 lane/owner
mapping。checksum backfill、quarantine、lock recovery 等路径不能逐一证明在
对应 lane/per-target lock 内执行。

### I03_collision_resistant_temp_creation

判定：PASS。

证据：

- 共享 store tempId 包含 pid、Date.now 与 UUID operationId：
  `src/job-state/durable-state-store.ts:971` 至
  `src/job-state/durable-state-store.ts:976`。
- 共享 store temp 使用 exclusive create：
  `src/job-state/durable-state-store.ts:232` 至
  `src/job-state/durable-state-store.ts:243`、
  `src/job-state/durable-state-store.ts:705` 至
  `src/job-state/durable-state-store.ts:724`。
- runner tempId 包含 pid、Date.now 与 UUID operationId：
  `scripts/graphrag/batch-epub-workflow.mjs:2093` 至
  `scripts/graphrag/batch-epub-workflow.mjs:2108`。
- runner temp 使用 `flag: "wx"`：
  `scripts/graphrag/batch-epub-workflow.mjs:3412` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3425`。
- EEXIST 被分类为 `durable_temp_create_collision`：
  `src/job-state/durable-state-store.ts:913` 至
  `src/job-state/durable-state-store.ts:933`、
  `scripts/graphrag/batch-epub-workflow.mjs:3381` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3399`。

说明：

实现满足抗碰撞 identity 与 exclusive create 要求。forced temp id collision
测试仍缺失，计入 I10 测试覆盖缺口，不改变 I03 的实现判定。

### I04_owner_evidence_and_cleanup_safety

判定：FAIL。

证据：

- 共享 store 在 temp 创建前写 owner sidecar：
  `src/job-state/durable-state-store.ts:224` 至
  `src/job-state/durable-state-store.ts:233`。
- runner 在 temp 创建前写 owner sidecar：
  `scripts/graphrag/batch-epub-workflow.mjs:3405` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3413`。
- runner cleanup 会读取 owner sidecar 并发出 cleanup decision event：
  `scripts/graphrag/batch-epub-workflow.mjs:3510` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3552`、
  `scripts/graphrag/batch-epub-workflow.mjs:3686` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3699`。

缺口：

cleanup 未验证 owner evidence 的完整不变量。共享 store 只检查 stale mtime、
owner host/pid 与 processAlive：
`src/job-state/durable-state-store.ts:541` 至
`src/job-state/durable-state-store.ts:565`。runner cleanup 也未比较
owner.targetLocator、generation、createdAt 是否可信，且允许
`orphan_temp_without_owner` 删除：
`scripts/graphrag/batch-epub-workflow.mjs:3543` 至
`scripts/graphrag/batch-epub-workflow.mjs:3550`。这不满足“读取并验证
owner、target、generation、createdAt、stale TTL、owner-dead 或 lease-expired
证据后才能删除 temp”的固定基准。

### I05_lock_freshness_fencing_and_takeover

判定：FAIL。

证据：

- 共享 store lock owner 包含 runnerSessionId、generation、fencingTokenHash、
  targetLocator、operationId、heartbeatAt、expiresAt：
  `src/job-state/durable-state-store.ts:990` 至
  `src/job-state/durable-state-store.ts:1005`。
- runner item checkpoint heartbeat merge 已实现：
  `scripts/graphrag/batch-epub-workflow.mjs:4878` 至
  `scripts/graphrag/batch-epub-workflow.mjs:4903`。
- coordinator/book/provider leases 有 generation 与 fencingToken：
  `scripts/graphrag/batch-epub-workflow.mjs:2535` 至
  `scripts/graphrag/batch-epub-workflow.mjs:2627`、
  `scripts/graphrag/batch-epub-workflow.mjs:2855` 至
  `scripts/graphrag/batch-epub-workflow.mjs:2979`、
  `scripts/graphrag/batch-epub-workflow.mjs:4265` 至
  `scripts/graphrag/batch-epub-workflow.mjs:4335`。

缺口：

durable YAML/JSON file lock 没有完整 freshness/fencing/takeover 实施。共享
store 创建 lock 后不维护 heartbeat，不在提交前后重新验证当前 fencing；
stale lock break 只使用 mtime、host、pid：
`src/job-state/durable-state-store.ts:398` 至
`src/job-state/durable-state-store.ts:443`、
`src/job-state/durable-state-store.ts:495` 至
`src/job-state/durable-state-store.ts:516`。runner 的 JSON file lock owner
甚至不包含 generation、fencing hash、heartbeatAt、expiresAt：
`scripts/graphrag/batch-epub-workflow.mjs:3895` 至
`scripts/graphrag/batch-epub-workflow.mjs:3915`，stale cleanup 只检查
mtime 与 pid：`scripts/graphrag/batch-epub-workflow.mjs:3881` 至
`scripts/graphrag/batch-epub-workflow.mjs:3889`。旧 generation 写入拒绝主要存在
于 checkpoint/book lease 层，未落实到 durable lock commit boundary。

### I06_atomic_replace_and_fsync_boundary

判定：FAIL。

证据：

- 共享 store 写入顺序包含 temp write/fsync、rename、checksum write/rename、
  meta sidecar 与 parent directory fsync：
  `src/job-state/durable-state-store.ts:231` 至
  `src/job-state/durable-state-store.ts:251`。
- runner 写入顺序包含 temp write/fsync、rename、checksum write/rename、
  meta sidecar 与 parent directory fsync：
  `scripts/graphrag/batch-epub-workflow.mjs:3401` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3435`。
- directory fsync failure 在共享 store 与 runner 中分类为
  `durable_directory_fsync_uncertain`：
  `src/job-state/durable-state-store.ts:859` 至
  `src/job-state/durable-state-store.ts:884`、
  `scripts/graphrag/batch-epub-workflow.mjs:2293` 至
  `scripts/graphrag/batch-epub-workflow.mjs:2311`。

缺口：

file fsync failure 未统一分类为 local state integrity。共享 store
`writeFileDurable()` 中 `handle.sync()` 与后续 `fsyncSync()` 抛出的非 EEXIST
错误会原样传播：
`src/job-state/durable-state-store.ts:705` 至
`src/job-state/durable-state-store.ts:724`、
`src/job-state/durable-state-store.ts:913` 至
`src/job-state/durable-state-store.ts:935`。runner `writeFileDurable()` 也同样
原样抛出 file fsync 错误：
`scripts/graphrag/batch-epub-workflow.mjs:2323` 至
`scripts/graphrag/batch-epub-workflow.mjs:2335`。此外，standalone
`writeJsonAtomicSidecar()` 没有自身 parent directory fsync，依赖调用者后续 fsync，
用于 checksum metadata backfill 时边界不完整：
`src/job-state/durable-state-store.ts:671` 至
`src/job-state/durable-state-store.ts:679`、
`scripts/graphrag/batch-epub-workflow.mjs:3332` 至
`scripts/graphrag/batch-epub-workflow.mjs:3344`。

### I07_checksum_generation_crash_window_recovery

判定：FAIL。

证据：

- 共享 store 已区分 missing checksum、matching checksum、
  `meta.checksum === actual`、checksum mismatch quarantine：
  `src/job-state/durable-state-store.ts:329` 至
  `src/job-state/durable-state-store.ts:351`。
- runner 已区分 JSON/YAML missing checksum、`target_new_checksum_old`、
  checksum mismatch quarantine：
  `scripts/graphrag/batch-epub-workflow.mjs:3709` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3754`、
  `scripts/graphrag/batch-epub-workflow.mjs:3799` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3844`。

缺口：

实现没有 durable generation sidecar，也没有完整 crash-window matrix。missing
checksum 会在 target 可解析时直接 backfill；`meta.checksum === actual` 会直接
修复 `.sha256`；代码未证明 old target、new target old checksum、partial
sidecar、generation rewind、metadata partial write 等状态。该恢复依赖 target
文本与 checksum meta，不能满足 “checksum/generation sidecar 不一致时按 crash
window 收敛到 committed、repair 或 stop_until_fixed” 的完整基准。

本轮验证还暴露两项相关测试失败：

- `validates LanceDB row-count sidecars through durable checksums`：
  corrupt `.sha256` 后 `validateLanceDbDirectory()` 返回 `{ valid: true }`，未按
  现有测试预期阻断。
- `recovers and quarantines graph capability catalog durable checksum state`：
  corrupt `.sha256` 后 `loadGraphQueryCapabilities()` resolved，未按现有测试
  预期 reject/quarantine。

这两项失败不单独证明实现一定应 quarantine，但证明当前 crash-window 语义与
既有回归预期不一致，且缺少 generation 证据支撑自动 repair 的安全性。

### I08_rename_enoent_failure_classification

判定：FAIL。

证据：

- 共享 store 捕获 rename ENOENT 并生成
  `localFailureClass: "durable_temp_rename_enoent"`：
  `src/job-state/durable-state-store.ts:747` 至
  `src/job-state/durable-state-store.ts:773`。
- runner 捕获 rename ENOENT 并生成同类错误：
  `scripts/graphrag/batch-epub-workflow.mjs:3355` 至
  `scripts/graphrag/batch-epub-workflow.mjs:3379`。
- failure classifier 已优先识别 rename/temp ENOENT：
  `scripts/graphrag/batch-failure-classifier.mjs:100` 至
  `scripts/graphrag/batch-failure-classifier.mjs:115`。

缺口：

runner 侧 evidence 被 `localDurableEvidence()` whitelist 截断，`failedSyscall`
与 `errno` 没有进入持久 evidence；owner、generation、createdAt 等字段也未稳定
投影到 checkpoint/event/status/recovery summary：
`scripts/graphrag/batch-epub-workflow.mjs:2111` 至
`scripts/graphrag/batch-epub-workflow.mjs:2127`、
`scripts/graphrag/batch-epub-workflow.mjs:2164` 至
`scripts/graphrag/batch-epub-workflow.mjs:2187`。固定基准要求记录
cause、target、tempId、operationId、owner、generation、failedSyscall、errno、
recoveryDecision；当前 runner 只稳定保留其中一部分。因此仍不满足 I08。

### I09_resume_preflight_and_runner_recovery

判定：FAIL。

证据：

- runner 启动后会 acquire coordinator lock、reconcile durable run files、
  recover event tail：
  `scripts/graphrag/batch-epub-workflow.mjs:9051` 至
  `scripts/graphrag/batch-epub-workflow.mjs:9055`。
- coordinator lock acquire 后会恢复 stale provider slots 与 orphan subprocess
  records：
  `scripts/graphrag/batch-epub-workflow.mjs:4178` 至
  `scripts/graphrag/batch-epub-workflow.mjs:4255`。
- provider/book/subprocess lease 列表过滤 sidecars：
  `scripts/graphrag/batch-epub-workflow.mjs:2422` 至
  `scripts/graphrag/batch-epub-workflow.mjs:2431`、
  `scripts/graphrag/batch-epub-workflow.mjs:2494` 至
  `scripts/graphrag/batch-epub-workflow.mjs:2503`、
  `scripts/graphrag/batch-epub-workflow.mjs:2520` 至
  `scripts/graphrag/batch-epub-workflow.mjs:2525`。

缺口：

没有 beforeClaim 与 beforeResumeBook preflight。`markItemRunning()` 直接 claim：
`scripts/graphrag/batch-epub-workflow.mjs:8240` 至
`scripts/graphrag/batch-epub-workflow.mjs:8310`；`runGraphResume()` 直接进入
resume-book loop：
`scripts/graphrag/batch-epub-workflow.mjs:7636` 至
`scripts/graphrag/batch-epub-workflow.mjs:7698`。startup reconcile 对 fresh/
unknown temp 的处理是 preserve 并继续，而不是 stop_until_fixed：
`scripts/graphrag/batch-epub-workflow.mjs:3519` 至
`scripts/graphrag/batch-epub-workflow.mjs:3525`。因此在发现 unknown/live temp、
不可判定 lock owner 或不可收敛 checksum/generation 前不能证明阻断新 claim 或
resume-book 子进程。

### I10_regression_tests_and_observability

判定：FAIL。

证据：

- 已有同毫秒 temp 测试：
  `test/book-job-state.test.ts:419`。
- 已有 durable JSON checksum recovery/quarantine 测试：
  `test/book-job-state.test.ts:458`。
- 已有 auxiliary JSON target reject 测试：
  `test/book-job-state.test.ts:502`。
- 已有 batch stale/fresh temp cleanup 测试：
  `test/cli.test.ts:2608`。
- 已有 lease/registry sidecar filter 测试：
  `test/cli.test.ts:2689`。
- 已有 coordinator expired-live-owner lock 测试：
  `test/cli.test.ts:2508`。
- 已有 full qmd command matrix qmd index lock 测试：
  `test/cli.test.ts:3942`。
- contracts 与 runner schema 已加入 local durable evidence 字段：
  `src/contracts/batch-run.ts:134` 至
  `src/contracts/batch-run.ts:165`、
  `src/contracts/batch-run.ts:314` 至
  `src/contracts/batch-run.ts:348`、
  `src/contracts/batch-run.ts:350` 至
  `src/contracts/batch-run.ts:390`、
  `scripts/graphrag/batch-epub-workflow.mjs:614` 至
  `scripts/graphrag/batch-epub-workflow.mjs:653`、
  `scripts/graphrag/batch-epub-workflow.mjs:790` 至
  `scripts/graphrag/batch-epub-workflow.mjs:830`。

缺口：

固定基准要求的 fault injection 未完整覆盖。缺少 forced temp id collision、
durable file lock stale live owner、实际 rename ENOENT 写入路径、directory
fsync failure/unsupported injection、partial checksum sidecar、generation crash
window、resume-book orphan temp preflight stop_until_fixed 等测试。现有
`test/book-job-state.test.ts` 聚焦测试还出现 2 个相关失败，说明 durable checksum
回归套件当前不一致。

## 验证命令

已执行：

```bash
node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/book-job-state.test.ts \
  -t "durable|lease fencing|graph capability catalog commits"
```

结果：FAIL。7 passed，2 failed，55 skipped。

失败用例：

- `validates LanceDB row-count sidecars through durable checksums`
- `recovers and quarantines graph capability catalog durable checksum state`

已执行：

```bash
node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli.test.ts \
  -t "durable reconcile ignores auxiliary JSON in lease and registry dirs|all batch qmd commands acquire the qmd index file lock"
```

结果：PASS。2 passed，236 skipped。

未修改固定基准文件：

- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-criteria.yaml`
