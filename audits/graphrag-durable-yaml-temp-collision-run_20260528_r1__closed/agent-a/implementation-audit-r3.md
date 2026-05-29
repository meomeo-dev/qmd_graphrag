# Durable YAML/JSON Temp Collision 实施审计 R3

## 总体结论

总体结论：FAIL。

固定基准共 10 条：2 条 PASS，8 条 FAIL。

R3 相比 R2 有实质修复：辅助 JSON 过滤（auxiliary JSON filtering）、
test-only command check narrowing、file/directory fsync 分类、owner sidecar
保留策略、JSON lock timeout evidence、rename ENOENT checkpoint evidence、
LanceDB row-count checksum quarantine、provider/book/subprocess sidecar 过滤、
以及生产命令矩阵保持均有当前实现或测试证据。

仍不允许恢复真实 EPUB runner（real EPUB runner）。阻塞项是 durable state
边界仍有 runner 内联重复实现，owner cleanup 缺少 generation/fencing 完整证据，
checksum/generation crash-window 没有 generation sidecar 与完整矩阵，
beforeClaim/beforeResumeBook preflight 缺失，且 fault injection 覆盖仍不完整。

## 逐项结论

| ID | 基准 | 判定 |
| --- | --- | --- |
| I01 | 单一 durable state 边界 | FAIL |
| I02 | target mapping 与 lane 执行 | FAIL |
| I03 | temp 身份与独占创建 | PASS |
| I04 | owner evidence 与 temp 清理安全 | FAIL |
| I05 | lock freshness、fencing 与 takeover | FAIL |
| I06 | 原子替换与 fsync 平台边界 | PASS |
| I07 | checksum/generation crash window 恢复 | FAIL |
| I08 | rename ENOENT 分类与证据 | FAIL |
| I09 | resume preflight 与 runner 恢复阻断 | FAIL |
| I10 | 回归测试与可观测性 | FAIL |

## R2 失败项复核摘要

- 辅助 JSON 过滤：通过。runner 的 `isDurableAuxiliaryPath()`、
  `isDurablePrimaryJsonEntry()` 排除 `.owner.json`、`.sha256`、
  `.sha256.meta.json`、`.lock`、`.tmp-*`、`.corrupt-*`；
  provider slots、subprocess records、book leases 列表读取均过滤 primary JSON。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:2354`、
  `scripts/graphrag/batch-epub-workflow.mjs:2364`、
  `scripts/graphrag/batch-epub-workflow.mjs:2547`、
  `scripts/graphrag/batch-epub-workflow.mjs:2619`、
  `scripts/graphrag/batch-epub-workflow.mjs:2645`；
  测试：`test/cli.test.ts:2875`。
- owner sidecar cleanup：部分修复但未过固定基准。实现已保留 fresh temp、
  ownerless temp、missing-createdAt temp，并清理 stale dead-owner temp；但清理
  stale temp 不要求 generation/fencing 完整证据。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:3695`、
  `scripts/graphrag/batch-epub-workflow.mjs:3722`、
  `scripts/graphrag/batch-epub-workflow.mjs:3730`、
  `scripts/graphrag/batch-epub-workflow.mjs:3754`；
  测试：`test/cli.test.ts:2718`、`test/cli.test.ts:2803`。
- heartbeat fencing merge：部分修复但未过固定基准。runner item checkpoint
  保留较新 heartbeat/expiry，JSON file lock owner 也写入 generation、
  fencingTokenHash、heartbeatAt、expiresAt；但 durable file lock 无持续 heartbeat
  refresh，释放时也未先确认当前 lock 仍归本 owner。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:4151`、
  `scripts/graphrag/batch-epub-workflow.mjs:4184`、
  `scripts/graphrag/batch-epub-workflow.mjs:4248`、
  `scripts/graphrag/batch-epub-workflow.mjs:5191`。
- test-only command check narrowing：通过。测试命令集合只在
  `QMD_GRAPHRAG_ENABLE_TEST_HOOKS=1` 时读取，并拒绝 unknown、duplicate、
  缺少 graph query checks 的集合。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:288`。
- 生产完整命令矩阵：通过。非 test hooks 使用
  `defaultRequiredCommandCheckNames`，`runCliChecks()` 仍枚举完整生产命令矩阵。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:255`、
  `scripts/graphrag/batch-epub-workflow.mjs:8273`。
- provider/book/subprocess lease sidecar 过滤：通过。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2547`、
  `scripts/graphrag/batch-epub-workflow.mjs:2619`、
  `scripts/graphrag/batch-epub-workflow.mjs:2645`；
  测试：`test/cli.test.ts:2875`。

## I01 单一 durable state 边界

判定：FAIL。

证据：

- 共享 durable store 已覆盖 TypeScript 侧 YAML/JSON durable read/write、
  reconcile、checksum、temp cleanup、lock。证据：
  `src/job-state/durable-state-store.ts:77`、
  `src/job-state/durable-state-store.ts:136`、
  `src/job-state/durable-state-store.ts:182`、
  `src/job-state/durable-state-store.ts:236`。
- `src/job-state/durable-json.ts` 已是 adapter/re-export。证据：
  `src/job-state/durable-json.ts:1`。
- batch runner 仍保留内联 durable JSON/YAML/temp/checksum/lock/failure
  实现，而不是调用共享 store 或等价 adapter。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2134`、
  `scripts/graphrag/batch-epub-workflow.mjs:3561`、
  `scripts/graphrag/batch-epub-workflow.mjs:3902`、
  `scripts/graphrag/batch-epub-workflow.mjs:4184`。

缺口：

runner 内联实现与共享 store 仍不完全等价：runner temp operation evidence
不写 `leaseGeneration`/`fencingTokenHash`；runner `removeStaleJsonLock()` 删除
lock 后不 fsync 父目录；runner lock release 在 finally 中无条件 unlink lock。
因此固定基准要求的单一 durable state boundary 未成立。

建议修复：

- 将 runner JSON/YAML durable replace、checksum、reconcile、lock、cleanup
  收敛为共享 `durable-state-store` adapter，或抽出一个共享 runner-compatible
  durable module，保证 temp owner、lock release、checksum recovery 语义一致。
- 删除或薄化 runner 内联 durable 实现，只保留 event/status 投影层。

## I02 target mapping 与 lane 执行

判定：FAIL。

证据：

- runner 已写入 lane、targetMappingOwner、laneTimeoutMs、releaseOn evidence。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:2160`。
- shared store 也推断 lane/owner/releaseOn。证据：
  `src/job-state/durable-state-store.ts:1331`。
- qmd index writer lane 和 file lock 存在。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:3113`、
  `scripts/graphrag/batch-epub-workflow.mjs:7780`。
- provider slots、book leases 有 durable lease/fencing。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2660`、
  `scripts/graphrag/batch-epub-workflow.mjs:3007`。

缺口：

实现仍是路径推断式 mapping，未形成可审计的生产 target mapping 矩阵，不能证明
每个 durable YAML/JSON/SQLite target 都唯一映射到 writer lane、owner、timeout、
releaseOn。`reconcileDurableRunFiles()` 只遍历固定 runner 目录；SQLite 侧还有
独立 qmd index lock 实现，未共享同一 target mapping 证据。证据：
`scripts/graphrag/batch-epub-workflow.mjs:4096`、
`src/job-state/graphrag-book.ts:1217`。

建议修复：

- 建立显式 target mapping 表，覆盖 batch manifest、checkpoint、events、
  recovery summary、provider slots、subprocess registry、book leases、
  catalog YAML、settings YAML、DSPy state、LanceDB sidecars、qmd index SQLite。
- 所有 write/reconcile/backfill/quarantine/lock recovery 入口必须通过该 mapping
  获取 lane、owner、timeout、releaseOn，并在 evidence 中记录 target id。

## I03 temp 身份与独占创建

判定：PASS。

证据：

- shared tempId 包含 pid、Date.now、UUID operationId，并以 `wx` 创建。
  证据：`src/job-state/durable-state-store.ts:1221`、
  `src/job-state/durable-state-store.ts:828`。
- runner tempId 包含 pid、Date.now、UUID operationId，并以 `wx` 创建。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:2134`、
  `scripts/graphrag/batch-epub-workflow.mjs:2444`、
  `scripts/graphrag/batch-epub-workflow.mjs:3561`。
- EEXIST 被分类为 `durable_temp_create_collision`。证据：
  `src/job-state/durable-state-store.ts:1084`、
  `scripts/graphrag/batch-epub-workflow.mjs:3541`。
- 同毫秒 temp collision 场景已有回归测试。证据：
  `test/book-job-state.test.ts:420`。

剩余风险：

forced temp id collision fault injection 测试仍缺失，计入 I10，不影响 I03 的
实现判定。

## I04 owner evidence 与 temp 清理安全

判定：FAIL。

证据：

- shared cleanup 会读取 owner sidecar，并保留 owner 缺失、target mismatch、
  createdAt 缺失、fresh、owner alive 的 temp。证据：
  `src/job-state/durable-state-store.ts:619`、
  `src/job-state/durable-state-store.ts:1170`。
- runner cleanup 会读取 owner sidecar，并保留 fresh、owner 缺失/invalid、
  target mismatch、owner alive、remote unproven 的 temp。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:3695`。
- stale temp without complete owner evidence 的 shared 与 runner 测试存在。
  证据：`test/book-job-state.test.ts:551`、`test/cli.test.ts:2803`。

缺口：

runner 写 temp owner evidence 时未写 generation/fencing；cleanup 删除 stale
dead-owner temp 时也不要求 generation/fencing 完整。测试中的 stale owner
evidence 只有 tempId、operationId、target、ownerPid、ownerHost、createdAt，
没有 generation，仍预期被删除。证据：`test/cli.test.ts:2767`、
`test/cli.test.ts:2794`。这不满足固定基准要求的 owner、target、generation、
createdAt、stale TTL、owner-dead 或 lease-expired 全量验证。

建议修复：

- temp owner sidecar 必须写入 owner generation、fencingTokenHash 或等价 lease
  generation，并在 cleanup 前校验。
- 删除 stale temp 前必须记录 cleanup decision，包括完整 owner evidence、
  target match、generation/fencing match、createdAt、stale age、owner-dead 或
  lease-expired 依据。
- 缺少 generation/fencing 的 stale temp 应 preserve 或 stop_until_fixed，不能删除。

## I05 lock freshness、fencing 与 takeover

判定：FAIL。

证据：

- shared lock owner 已包含 generation、fencingTokenHash、heartbeatAt、expiresAt、
  operationId，并在 callback 前后校验 owner/fencing。证据：
  `src/job-state/durable-state-store.ts:1250`、
  `src/job-state/durable-state-store.ts:1188`。
- runner JSON lock owner 已包含 generation、fencingTokenHash、heartbeatAt、
  expiresAt、operationId，并在 callback 前后校验 owner/fencing。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:4151`、
  `scripts/graphrag/batch-epub-workflow.mjs:4184`。
- durable JSON lock timeout 测试断言 owner evidence。证据：
  `test/cli.test.ts:2609`。

缺口：

durable YAML/JSON file lock 仍没有持续 heartbeat refresh；超过 stale window 的
长 callback 可能被 takeover。更关键的是 lock release 在 finally 中无条件
unlink lock path，若当前 lock 已被新 owner 接管，旧 writer 失败退出时仍可能删除
新 lock。证据：`src/job-state/durable-state-store.ts:509`、
`scripts/graphrag/batch-epub-workflow.mjs:4248`。
runner `removeStaleJsonLock()` 删除 lock 后未 fsync 父目录，也未记录 recovery
event。证据：`scripts/graphrag/batch-epub-workflow.mjs:4136`。

建议修复：

- 为 durable file lock 增加 heartbeat refresh，或证明 callback bounded 小于
  stale window 并以测试覆盖。
- release lock 前必须重新读取并确认 operationId、runnerSessionId、generation、
  fencingTokenHash 仍匹配；不匹配不得 unlink。
- stale lock break 应 fsync 父目录并写入 recovery event/status evidence。

## I06 原子替换与 fsync 平台边界

判定：PASS。

证据：

- shared durable replace 顺序包含 temp owner、temp write/fsync、target rename、
  checksum meta pending、checksum temp write/fsync、checksum rename、checksum meta
  committed、parent directory fsync。证据：
  `src/job-state/durable-state-store.ts:253`。
- runner durable replace 顺序等价。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:3561`。
- file fsync failure 被分类为 `durable_fsync_failed`，directory fsync failure
  被分类为 `durable_directory_fsync_uncertain`，并带 `completedPublishRule:
  "forbidden"`。证据：`src/job-state/durable-state-store.ts:1064`、
  `src/job-state/durable-state-store.ts:1010`、
  `scripts/graphrag/batch-epub-workflow.mjs:2428`、
  `scripts/graphrag/batch-epub-workflow.mjs:2396`。
- failure classifier 优先识别 durable fsync 和 directory fsync。证据：
  `scripts/graphrag/batch-failure-classifier.mjs:138`、
  `scripts/graphrag/batch-failure-classifier.mjs:157`。

剩余风险：

当前实现没有 generation sidecar，相关 crash-window 风险计入 I07；directory fsync
fault injection 测试缺失计入 I10。

## I07 checksum/generation crash window 恢复

判定：FAIL。

证据：

- shared 与 runner 已处理 `target_new_checksum_missing`、
  `target_new_checksum_old`、metadata backfill、checksum mismatch quarantine。
  证据：`src/job-state/durable-state-store.ts:363`、
  `scripts/graphrag/batch-epub-workflow.mjs:3902`。
- durable JSON/YAML/LanceDB/capability catalog checksum 测试存在。证据：
  `test/book-job-state.test.ts:459`、
  `test/book-job-state.test.ts:1670`、
  `test/book-job-state.test.ts:1710`、
  `test/book-job-state.test.ts:3269`。

缺口：

没有 durable generation sidecar，也没有完整 generation rewind / partial sidecar /
old target / new target old checksum / missing checksum 的 crash-window matrix。当前
恢复主要依赖 target text checksum 与 `.sha256.meta.json` 的 `checksum` 和
`commitState`，不能证明 generation 一致性。证据：
`src/job-state/durable-state-store.ts:273`、
`scripts/graphrag/batch-epub-workflow.mjs:3579`。

建议修复：

- 为 durable target 增加 generation sidecar 或在 checksum meta 中持久化单调
  generation，并在 target/checksum/meta 三者不一致时按矩阵判定。
- 对 missing checksum、old checksum、partial meta、partial checksum temp、
  generation rewind、target invalid 分别收敛到 committed、repair 或
  stop_until_fixed。
- 禁止仅凭 event、manifest 或可解析 target 自动证明 completed。

## I08 rename ENOENT 分类与证据

判定：FAIL。

证据：

- shared 与 runner 捕获 temp rename ENOENT 并分类为
  `durable_temp_rename_enoent`。证据：
  `src/job-state/durable-state-store.ts:890`、
  `scripts/graphrag/batch-epub-workflow.mjs:3498`。
- runner evidence 已持久化 failedSyscall、errno、renameCause、
  completedPublishRule、target、tempId、operationId。证据：
  `scripts/graphrag/batch-epub-workflow.mjs:2197`、
  `scripts/graphrag/batch-epub-workflow.mjs:3511`。
- failure classifier 优先识别 rename/temp ENOENT。证据：
  `scripts/graphrag/batch-failure-classifier.mjs:102`。
- CLI 测试覆盖 checkpoint、event、recovery summary 字段。证据：
  `test/cli.test.ts:2961`。

缺口：

固定基准还要求 owner 与 generation。runner `localDurableEvidence()` 不投影
runnerSessionId、ownerPid/ownerHost、createdAt、leaseGeneration 或
fencingTokenHash；runner `durableOperationEvidence()` 本身也未写入
leaseGeneration/fencingTokenHash。证据：
`scripts/graphrag/batch-epub-workflow.mjs:2134`、
`scripts/graphrag/batch-epub-workflow.mjs:2197`。因此 rename ENOENT 不会在
checkpoint/event/status/recovery summary 中稳定记录 owner/generation。

建议修复：

- 将 ownerPid、ownerHost、runnerSessionId、createdAt、leaseGeneration、
  fencingTokenHash 或等价 generation 写入 durable operation evidence，并加入
  checkpoint/event/recovery summary schema 投影。
- rename ENOENT 测试需断言 owner 与 generation 字段。

## I09 resume preflight 与 runner 恢复阻断

判定：FAIL。

证据：

- runner 启动时 acquire coordinator lock、reconcile durable run files、恢复
  event tail。证据：`scripts/graphrag/batch-epub-workflow.mjs:9357`。
- coordinator runtime recovery 会处理 stale provider slot 与 orphan subprocess。
  证据：`scripts/graphrag/batch-epub-workflow.mjs:4491`。

缺口：

没有 `beforeClaim` 或 `beforeResumeBook` preflight 入口。代码中只存在 startup
reconcile；claim 新 item 时 `markItemRunning()` 直接获取 book lease 并写 running；
`runGraphResume()` 直接启动 resume-book 子进程。证据：
`scripts/graphrag/batch-epub-workflow.mjs:7952`、
`scripts/graphrag/batch-epub-workflow.mjs:8556`、
`scripts/graphrag/batch-epub-workflow.mjs:9256`、
`scripts/graphrag/batch-epub-workflow.mjs:9788`。
fresh/unknown temp 被 preserve 后 runner 仍可继续 claim，不会 stop_until_fixed。
证据：`scripts/graphrag/batch-epub-workflow.mjs:3714`。

建议修复：

- 增加 `durablePreflightBeforeClaim()` 和
  `durablePreflightBeforeResumeBook()`，扫描 durable locks、temps、
  checksum/generation、subprocess registry、provider slots、book leases。
- 发现 unknown/live temp、不可收敛 checksum/generation、不可判定 lock owner、
  local_state_integrity failure 时，必须写 checkpoint/event/recovery summary，
  设置 `recoveryDecision: "stop_until_fixed"`，并阻止 claim/resume-book。
- 为 preserved fresh/unknown temp 增加 stop event 或 explicit continue policy，
  不得静默继续。

## I10 回归测试与可观测性

判定：FAIL。

证据：

- 已覆盖同毫秒 temp collision：`test/book-job-state.test.ts:420`。
- 已覆盖 durable JSON/YAML checksum recovery/quarantine：
  `test/book-job-state.test.ts:459`、`test/book-job-state.test.ts:1670`。
- 已覆盖 LanceDB row-count checksum quarantine：
  `test/book-job-state.test.ts:1710`、`test/cli.test.ts:13013`。
- 已覆盖 stale temp owner evidence：
  `test/book-job-state.test.ts:551`、`test/cli.test.ts:2718`、
  `test/cli.test.ts:2803`。
- 已覆盖 auxiliary JSON filter：`test/book-job-state.test.ts:520`、
  `test/cli.test.ts:2875`。
- 已覆盖 rename ENOENT checkpoint failure：`test/cli.test.ts:2961`。
- checkpoint/event/recovery summary schema 已暴露 durable fields。证据：
  `src/contracts/batch-run.ts:134`、`src/contracts/batch-run.ts:327`、
  `src/contracts/batch-run.ts:369`。

缺口：

固定基准要求的 fault injection 未完整覆盖：forced temp id collision、
directory fsync failure/unsupported injection、durable file lock stale live owner
takeover/release fencing、partial checksum sidecar、generation crash window、
resume-book orphan temp preflight stop_until_fixed 均缺失或只覆盖 classifier 文本。
现有 observability 也缺少 owner/generation 在 rename ENOENT 与 temp cleanup
路径中的稳定投影。

建议修复：

- 增加 test-only hooks：forced tempId、file fsync failure、directory fsync
  failure/unsupported、partial sidecar、generation rewind、preflight orphan temp。
- 扩展 CLI focused tests，断言 checkpoint、event、status-json、recovery summary
  四处均含 owner/generation/fencing/cleanup/recoveryDecision 字段。

## 阻塞项

1. runner 内联 durable state 实现未收敛到共享边界，且语义仍不等价。
2. temp owner cleanup 不要求 generation/fencing 完整证据，仍可删除缺少 generation
   的 stale temp。
3. durable file lock 无持续 heartbeat refresh，release 未做 owner/fencing
   guarded unlink。
4. checksum/generation crash-window 缺少 generation sidecar 与完整恢复矩阵。
5. rename ENOENT 持久 evidence 缺少 owner/generation。
6. beforeClaim/beforeResumeBook durable preflight 缺失，无法阻止真实 runner 在
   preserved unknown/live temp 或不可判定 durable state 后继续 claim/resume。
7. fault injection 测试缺少 forced collision、fsync 边界、partial sidecar、
   generation rewind、resume-book orphan temp stop_until_fixed。

## 已复核验证

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：通过。
- `node --check scripts/graphrag/batch-failure-classifier.mjs`：通过。
- 用户提供的本轮验证结果记录为通过，包括 `npm run test:types`、focused
  `test/cli.test.ts`、focused `test/book-job-state.test.ts`、以及 slow CLI tests。
  本审计未重跑完整慢测试。

## 恢复真实 EPUB runner 判定

不允许恢复真实 EPUB runner。

允许条件是 I01、I04、I05、I07、I08、I09、I10 的阻塞项全部修复，并补齐对应
fault injection 与 observability 断言后，再执行下一轮 implementation audit。
