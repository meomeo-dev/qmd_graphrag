Status: FAIL

# Implementation Audit R6 - agent-c

## 总体结论

固定基准判定：7 PASS，3 FAIL。

R6 相比 R5 已实质修复 durable temp identity、exclusive create、shared durable
store 复用、checksum crash-window recovery、directory fsync classification、
failure classifier、observability schema、qmd index file lock，以及主要 fault
injection tests。受审模块中 repository、capability catalog、settings
projection、python bridge、DSPy policy store 和 durable-json 已基本收敛到
`src/job-state/durable-state-store.ts`。

但最新实现仍未满足固定 10 条基准。阻塞点集中在三类：

- batch runner 仍存在未声明的裸 durable YAML parse 与 durable target bare
  rename 旁路，且 `discoverItems()` 在 runner_start preflight 前读取
  `graph_vault/catalog/books.yaml`。
- shared durable store 删除 stale lock 后没有持久记录
  `durable_lock_recovered` 或等价 recovery evidence。
- batch runner 的直接 durable 调用链仍未完全覆盖 catalog YAML crash-window /
  temp 状态，无法证明所有受审 durable YAML/JSON 读写路径都进入同一 durable
  契约或等价 adapter。

本轮未读取或打印 `.env` 内容，未启动真实 EPUB runner，未修改固定 criteria，
未修改代码。

## Criteria Checklist

| ID | 判定 | 依据 |
| --- | --- | --- |
| I01_temp_identity_exclusive_create | PASS | runner temp id 包含 pid、timestamp、operationId UUID，并以 `wx` 写 temp/checksum：`scripts/graphrag/batch-epub-workflow.mjs:2319`, `scripts/graphrag/batch-epub-workflow.mjs:4023`, `scripts/graphrag/batch-epub-workflow.mjs:4058`。shared store 同样使用 random UUID operationId、pid、timestamp 与 exclusive create：`src/job-state/durable-state-store.ts:1530`, `src/job-state/durable-state-store.ts:393`, `src/job-state/durable-state-store.ts:410`。EEXIST 分类为 `durable_temp_create_collision`：`scripts/graphrag/batch-epub-workflow.mjs:4003`, `src/job-state/durable-state-store.ts:1327`。 |
| I02_single_durable_boundary | FAIL | 受审模块多数已复用 shared store，但 batch runner 仍有未声明 bare YAML parse 和 bare rename 旁路：`scripts/graphrag/batch-epub-workflow.mjs:5464`, `scripts/graphrag/batch-epub-workflow.mjs:5585`。这些路径未先进入 durable reconcile/lock/checksum/classification 契约。 |
| I03_lock_owner_fencing | FAIL | lock owner 字段已满足 pid、host、session、generation、fencing、target、operationId、heartbeatAt、expiresAt：`src/job-state/durable-state-store.ts:1568`, `scripts/graphrag/batch-epub-workflow.mjs:4928`, `scripts/graphrag/batch-epub-workflow.mjs:3180`。runner stale lock recovery 会写 `durable_lock_recovered`：`scripts/graphrag/batch-epub-workflow.mjs:4842`。但 shared store stale lock recovery 删除 lock 后仅 fsync directory，不持久记录 `durable_lock_recovered` 或等价 evidence：`src/job-state/durable-state-store.ts:751`, `src/job-state/durable-state-store.ts:779`。 |
| I04_live_temp_cleanup_safety | PASS | runner cleanup 持有 per-target lock，并校验 owner evidence、TTL、owner alive / lease expiry、target checksum generation：`scripts/graphrag/batch-epub-workflow.mjs:4163`, `scripts/graphrag/batch-epub-workflow.mjs:4550`, `scripts/graphrag/batch-epub-workflow.mjs:4671`。shared store cleanup 也要求 owner target、createdAt、cleanup fence、target checksum 未推进、stale TTL、lease expired 或 local owner dead：`src/job-state/durable-state-store.ts:807`, `src/job-state/durable-state-store.ts:855`。 |
| I05_checksum_commit_recovery | PASS | target-new/checksum-old、target-new/checksum-missing、pending meta committed、checksum mismatch quarantine 均实现：`src/job-state/durable-state-store.ts:485`, `src/job-state/durable-state-store.ts:549`, `scripts/graphrag/batch-epub-workflow.mjs:4550`, `scripts/graphrag/batch-epub-workflow.mjs:4671`。partial checksum sidecar 有 preflight blocking 测试：`test/cli.test.ts:3244`。残余风险：commit provenance 主要依赖 checksum/meta locator，generation/fencing proof 仍偏弱。 |
| I06_fsync_platform_failure | PASS | file fsync 与 directory fsync failure 被投射为 local durable failure，包含 fsyncTarget、fsyncErrno、fsyncPlatform、durableMode、completedPublishRule forbidden：`scripts/graphrag/batch-epub-workflow.mjs:2710`, `scripts/graphrag/batch-epub-workflow.mjs:2758`, `src/job-state/durable-state-store.ts:1253`, `src/job-state/durable-state-store.ts:1307`。directory fsync fault injection 测试存在：`test/cli.test.ts:2789`。 |
| I07_batch_observability_schema | PASS | checkpoint、event、recovery summary schemas 均承载 failureKind、localFailureClass、recoveryDecision、failedStage、redactedEvidenceLocator 及 durable metadata：`src/contracts/batch-run.ts:134`, `src/contracts/batch-run.ts:188`, `src/contracts/batch-run.ts:347`, `src/contracts/batch-run.ts:399`。runner projection 保留这些字段：`scripts/graphrag/batch-epub-workflow.mjs:2482`, `scripts/graphrag/batch-epub-workflow.mjs:2556`。 |
| I08_failure_classifier_mapping | PASS | classifier 在 provider transient 规则前识别 local durable state failures：`scripts/graphrag/batch-failure-classifier.mjs:1`, `scripts/graphrag/batch-failure-classifier.mjs:83`。映射覆盖 rename ENOENT、temp collision、live temp deletion、checksum mismatch/window、fsync failure、directory fsync、lock timeout：`scripts/graphrag/batch-failure-classifier.mjs:102`, `scripts/graphrag/batch-failure-classifier.mjs:347`。 |
| I09_direct_call_chain_coverage | FAIL | repository、capability catalog、settings projection、durable-json、python bridge、DSPy policy store 已接入 shared durable store：`src/job-state/repository.ts:70`, `src/graphrag/capability-catalog.ts:31`, `src/graphrag/settings-projection.ts:6`, `src/job-state/durable-json.ts:1`, `src/integrations/python-bridge.ts:11`, `src/dspy/policy-store.ts:55`。但 batch runner 的 catalog discovery 在 `main()` 早于 preflight 执行，并裸读 YAML：`scripts/graphrag/batch-epub-workflow.mjs:10119`, `scripts/graphrag/batch-epub-workflow.mjs:5464`。invalid manifest recovery 也裸 `renameSync` durable target：`scripts/graphrag/batch-epub-workflow.mjs:5593`。 |
| I10_fault_injection_tests | PASS | 测试覆盖 same-ms temp、forced temp collision、fresh/stale temp reconcile、target generation advanced、pending meta committed、partial checksum sidecar、lock timeout、rename ENOENT、directory fsync failure、qmd index lock：`test/book-job-state.test.ts:420`, `test/cli.test.ts:2609`, `test/cli.test.ts:2720`, `test/cli.test.ts:2789`, `test/cli.test.ts:2851`, `test/cli.test.ts:3175`, `test/cli.test.ts:3244`, `test/cli.test.ts:3350`, `test/cli.test.ts:3428`, `test/cli.test.ts:3565`, `test/cli.test.ts:4869`。 |

## Blocking Findings

### 1. Batch runner 在 preflight 前裸读 durable catalog YAML

证据：

- `main()` 在 acquire coordinator lock、runner_start preflight 与
  `reconcileDurableRunFiles()` 前调用 `discoverItems()`：
  `scripts/graphrag/batch-epub-workflow.mjs:10114`,
  `scripts/graphrag/batch-epub-workflow.mjs:10119`,
  `scripts/graphrag/batch-epub-workflow.mjs:10125`.
- `discoverItems()` 调用 `loadCatalogBySourceHash()`：
  `scripts/graphrag/batch-epub-workflow.mjs:5515`.
- `loadCatalogBySourceHash()` 直接执行
  `YAML.parse(readFileSync(catalogPath, "utf8"))` 读取
  `graph_vault/catalog/books.yaml`：
  `scripts/graphrag/batch-epub-workflow.mjs:5464`.

影响：

该路径绕过 durable YAML lock、checksum reconcile、stale/live temp 判定、
checksum crash-window recovery 与 local durable failure classification。若
`books.yaml` 处于 target-new/checksum-old、checksum missing、partial checksum
sidecar、live temp 或 corrupt target 状态，runner 可能在 preflight 前以普通
YAML/IO/schema 行为失败或使用未验证内容，违反 I02 与 I09。

建议修复：

- 将 `loadCatalogBySourceHash()` 改为使用 durable YAML reader，例如复用
  `readYamlFileIfExists(catalogPath)` 或一个 runner/shared durable YAML adapter。
- 或在 `discoverItems()` 前执行覆盖 catalog YAML 的 durable preflight/reconcile。
- 增加测试：构造 `graph_vault/catalog/books.yaml` 的 checksum mismatch、
  checksum missing、pending meta 和 unresolved temp，断言 runner_start 前不会裸读，
  而是写出 `durable_preflight_blocked` 或 checksum recovery evidence。

### 2. Invalid manifest recovery 使用裸 `renameSync`

证据：

- `loadManifest()` 在 schema parse failure 时直接
  `renameSync(manifestPath, quarantinePath)`，随后 fsync directory：
  `scripts/graphrag/batch-epub-workflow.mjs:5585`,
  `scripts/graphrag/batch-epub-workflow.mjs:5593`.
- 同文件已有 `quarantineDurableTarget()` / `renameWithDurableEvidence()` 可提供
  durable rename ENOENT classification、operationId、temp/evidence locator 与
  `completedPublishRule=forbidden`：
  `scripts/graphrag/batch-epub-workflow.mjs:3943`,
  `scripts/graphrag/batch-epub-workflow.mjs:4497`.

影响：

这是 durable JSON target 的未声明 mutation bypass。若 quarantine rename 期间发生
ENOENT、external mutation 或 parent fsync uncertainty，错误不会稳定投射为固定
local durable state 语义，违反 I02 与 I09。

建议修复：

- 将 invalid manifest quarantine 改为调用 `quarantineDurableTarget()` 或等价
  durable adapter。
- 保留 `renameCause`、operationId、targetLocator、redactedEvidenceLocator、
  `completedPublishRule=forbidden`。
- 增加 invalid manifest quarantine rename ENOENT / fsync fault injection 测试。

### 3. Shared durable store stale lock recovery 未持久记录 recovery evidence

证据：

- shared store stale lock recovery 校验 mtime/TTL、owner expiry、generation、
  fencingTokenHash、runnerSessionId、operationId、host 与 pid liveness：
  `src/job-state/durable-state-store.ts:751`,
  `src/job-state/durable-state-store.ts:779`,
  `src/job-state/durable-state-store.ts:1422`,
  `src/job-state/durable-state-store.ts:1433`.
- 但删除 lock 后只调用 `fsyncDirectoryStrict()`，未写 `durable_lock_recovered`
  event、summary sidecar 或其他持久 recovery record：
  `src/job-state/durable-state-store.ts:764`,
  `src/job-state/durable-state-store.ts:792`.
- 对比 runner adapter，JSON lock recovery 会写 `durable_lock_recovered` event：
  `scripts/graphrag/batch-epub-workflow.mjs:4842`,
  `scripts/graphrag/batch-epub-workflow.mjs:4853`.

影响：

固定 I03 要求 stale lock 删除前校验 TTL、owner liveness、generation/fencing，并
记录 `durable_lock_recovered` 或 `local_state_lock_timeout` evidence。shared store
删除成功路径没有持久证据；repository、capability catalog、settings projection、
python bridge 与 DSPy policy store 通过 shared store 时无法证明 lock takeover
发生过。

建议修复：

- 为 `src/job-state/durable-state-store.ts` 增加可注入 recovery recorder，或在
  lock 旁写入同目录 durable recovery sidecar / JSONL。
- recovery record 至少包含 targetLocator、lockPath、pid、host、runnerSessionId、
  generation、fencingTokenHash、operationId、heartbeatAt、expiresAt、
  recoveredAt、recoveryDecision。
- 增加 shared store stale lock recovery 测试，断言删除 lock 后存在持久
  `durable_lock_recovered` 或等价 evidence。

## Non-Blocking Residual Risks

- Runner 与 shared store 仍是两套实现。R6 已接近等价，但仍需要 conformance
  tests（契约一致性测试）证明 runner adapter 与 shared store 在 lock recovery、
  cleanup、checksum recovery、fsync failure、rename ENOENT 上完全一致。
- shared store checksum recovery 的 `checksumCommitEvidenceMatches()` 仍主要验证
  checksum 与 locator：`src/job-state/durable-state-store.ts:1385`。目前满足固定
  I05 的收敛要求，但 commit provenance（提交来源证明）仍弱于 generation/fencing
  级别证明。
- `durableTargetMapping()` 仍允许 fallback mapping：
  `src/job-state/durable-state-store.ts:1655`,
  `scripts/graphrag/batch-epub-workflow.mjs:2427`。固定 R6 criteria 未直接要求
  targetMapping hard reject，但后续生产安全仍应收敛到显式 target registry。
- 本轮本地聚焦 CLI 测试并行执行时，11 passed、3 timed out；用户提供的最近本地
  验证记录显示 durable CLI 聚焦组与 qmd index lock 慢测已通过。该超时未作为
  本报告阻塞项，但说明这些 fixture 对运行环境时延敏感。

## Verification

已执行：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：通过。
- `node --check scripts/graphrag/batch-failure-classifier.mjs`：通过。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：通过。
- `npm run test:types`：通过。
- `node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/book-job-state.test.ts -t "durable|checksum|LanceDB row-count|graph capability catalog"`：
  13 passed，52 skipped。
- `node ./node_modules/vitest/vitest.mjs run --reporter=dot --testTimeout 60000 test/cli.test.ts -t "durable state classifier|durable JSON lock timeout|forced durable temp collision|directory fsync failure|durable reconcile|durable preflight|before-resume preflight|rename ENOENT|all batch qmd commands acquire the qmd index file lock"`：
  11 passed，3 timed out，234 skipped。

未执行：

- 未启动真实 EPUB runner。
- 未读取或打印 `.env`。
- 未修改代码或固定 criteria。
