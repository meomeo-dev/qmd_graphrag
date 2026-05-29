Status: FAIL

# Durable YAML/JSON Temp Collision 实施审计 R6

## 总体结论

固定 criteria 共 10 条：6 条 PASS，4 条 FAIL。

R6 相比 R5 有明确推进：runner 侧补上 forced temp id collision、directory
fsync failure、partial checksum sidecar、before-resume orphan temp 等测试；qmd
index 普通 batch qmd 命令已进入 `withQmdIndexFileLock`；shared store 的 stale
temp cleanup 已不再删除未证明失效的 remote owner temp；runner 的 JSON lock
timeout 与 qmd index lock timeout 已投射为 `local_state_lock_timeout`。

但固定基准仍未闭合。阻塞项集中在四处：runner 与 shared store 仍存在语义不等价
的 durable 实现；checksum backfill/reconcile 未统一处于 per-target lock 内；
checksum crash-window recovery 仍可在缺少 owner/generation/fencing proof 时
backfill；before-claim/before-resume preflight 只扫描 batch-run JSON 目录，未覆盖
book-scoped YAML、qmd index lock、settings、graph capability、LanceDB sidecar 等
生产 durable target。另一个关键残余是 `resume-book` 子进程内部的 qmd index lock
仍是独立弱锁，缺少 generation、fencing hash、operationId、heartbeat/expiry 与
guarded release。

本轮为只读静态审计。未读取或打印 `.env` 内容，未启动真实 EPUB runner，未修改
固定 criteria，也未修改实现代码。

## Criteria Checklist

| ID | 判定 | 依据 |
| --- | --- | --- |
| I01_single_durable_state_boundary | FAIL | runner 仍保留私有 durable adapter：`scripts/graphrag/batch-epub-workflow.mjs:206-220`、`scripts/graphrag/batch-epub-workflow.mjs:4023-4086`、`scripts/graphrag/batch-epub-workflow.mjs:4550-4789`；shared store 独立实现：`src/job-state/durable-state-store.ts:36-49`、`src/job-state/durable-state-store.ts:375-547`、`src/job-state/durable-state-store.ts:612-805`。两者在 checksum reconcile/backfill lock 边界上不等价，见 I02/I07。 |
| I02_target_mapping_and_lane_enforcement | FAIL | runner 的 `reconcileDurableJsonTarget()` / `reconcileDurableYamlTarget()` 只在 temp cleanup 子步骤中持有 `withJsonFileLock()`，checksum read/backfill/quarantine 分支未整体处于 per-target lock：`scripts/graphrag/batch-epub-workflow.mjs:4550-4668`、`scripts/graphrag/batch-epub-workflow.mjs:4671-4789`。`resume-book` 父进程只用 in-process `qmdIndexWriterLane` 包裹 qmd-index write stage，没有使用父级 `withQmdIndexFileLock()`：`scripts/graphrag/batch-epub-workflow.mjs:8752-8767`。子进程内部 qmd index lock 是弱独立实现，缺 generation/fencing/operationId/expiry：`src/job-state/graphrag-book.ts:1217-1263`。 |
| I03_collision_resistant_temp_creation | PASS | runner tempId 包含 pid、timestamp 与 randomUUID/operationId：`scripts/graphrag/batch-epub-workflow.mjs:2319-2322`；temp 与 checksum temp 使用 `wx`：`scripts/graphrag/batch-epub-workflow.mjs:4037-4065`；EEXIST 分类为 `durable_temp_create_collision`：`scripts/graphrag/batch-epub-workflow.mjs:4003-4019`。shared store 同样使用 randomUUID tempId 与 exclusive create：`src/job-state/durable-state-store.ts:1530-1539`、`src/job-state/durable-state-store.ts:393-410`、`src/job-state/durable-state-store.ts:1050-1064`。forced collision 测试存在：`test/cli.test.ts:2720-2787`。 |
| I04_owner_evidence_and_cleanup_safety | PASS | runner owner evidence 写入 tempId、operationId、target、runner/session、lease/generation、checksum-before、fencing hash、createdAt/expiresAt：`scripts/graphrag/batch-epub-workflow.mjs:2319-2368`。runner cleanup 要求 stale TTL、owner evidence、target match、generation/fencing、target checksum、owner alive/remote/lease-expired 判断：`scripts/graphrag/batch-epub-workflow.mjs:4163-4256`。shared store cleanup 同样要求 target match、createdAt、cleanup fence、target generation 未推进、TTL、owner-dead 或 lease-expired：`src/job-state/durable-state-store.ts:807-848`、`src/job-state/durable-state-store.ts:855-896`。shared store remote owner 保留与 expired lease 删除测试存在：`test/book-job-state.test.ts:569-653`。 |
| I05_lock_freshness_fencing_and_takeover | PASS | runner JSON lock owner 包含 generation、fencingTokenHash、operationId、heartbeatAt、expiresAt，并在 callback 前后验证 owner：`scripts/graphrag/batch-epub-workflow.mjs:4928-4999`、`scripts/graphrag/batch-epub-workflow.mjs:5004-5077`。stale removal 要求 expired/dead/recovery fence：`scripts/graphrag/batch-epub-workflow.mjs:4825-4870`。shared store lock owner 与 stale writer rejection 也具备 generation/fencing/operationId：`src/job-state/durable-state-store.ts:612-667`、`src/job-state/durable-state-store.ts:751-805`、`src/job-state/durable-state-store.ts:1485-1528`。qmd index 子进程弱锁作为 I02 阻塞项处理。 |
| I06_atomic_replace_and_fsync_boundary | PASS | runner durable JSON replace 顺序为 owner sidecar、temp write/fsync、pending meta、target rename、checksum temp write/fsync、checksum rename、committed meta、parent directory fsync：`scripts/graphrag/batch-epub-workflow.mjs:4023-4074`。directory fsync failure 分类为 `durable_directory_fsync_uncertain` 并禁止 completed publish：`scripts/graphrag/batch-epub-workflow.mjs:2710-2731`。shared store 同步/异步 durable replace 与 fsync 分类也存在：`src/job-state/durable-state-store.ts:375-425`、`src/job-state/durable-state-store.ts:429-480`、`src/job-state/durable-state-store.ts:1253-1325`。directory fsync fault test 存在：`test/cli.test.ts:2789-2849`。 |
| I07_checksum_generation_crash_window_recovery | FAIL | runner `checksumCommitEvidenceMatches()` 只验证 checksum 与 target locator/basename，不验证 owner/generation/fencing：`scripts/graphrag/batch-epub-workflow.mjs:3917-3922`。missing checksum 与 target-new/checksum-old 会直接 backfill：`scripts/graphrag/batch-epub-workflow.mjs:4598-4619`、`scripts/graphrag/batch-epub-workflow.mjs:4719-4740`。shared store 同样在缺少 checksum 时自动 backfill：`src/job-state/durable-state-store.ts:505-540`，其 commit evidence match 也只看 checksum/locator：`src/job-state/durable-state-store.ts:1385-1393`。测试还明确接受缺 owner/generation/fencing 的 checksum recovery：`test/book-job-state.test.ts:459-483`。 |
| I08_rename_enoent_failure_classification | PASS | runner `renameWithDurableEvidence()` 将 ENOENT 分类为 `durable_temp_rename_enoent`，携带 failedSyscall、errno、renameCause、target/temp/operation/owner/lease evidence 并禁止 completed publish：`scripts/graphrag/batch-epub-workflow.mjs:3943-3967`。shared store 同类分类路径存在：`src/job-state/durable-state-store.ts:1112-1166`。checkpoint/event/recovery summary 测试覆盖 stop-until-fixed：`test/cli.test.ts:3565-3701`。 |
| I09_resume_preflight_and_runner_recovery | FAIL | preflight 目标仅为当前 batch-run 目录、items、provider-slots、subprocesses、book-leases：`scripts/graphrag/batch-epub-workflow.mjs:4404-4411`。它未扫描 qmd index SQLite lock、book-scoped YAML、settings.yaml、graph-capabilities.yaml、GraphRAG output producer manifests、LanceDB row-count sidecars 或 DSpy durable targets。`before_claim` 与 `before_resume_book` 调用存在：`scripts/graphrag/batch-epub-workflow.mjs:9310`、`scripts/graphrag/batch-epub-workflow.mjs:8712`，但 before-resume 实际仍复用上述 batch-run 目录扫描，未执行 book-scoped durable state preflight。runner-start 还以 `{ includeTemps: false }` 跳过 temp：`scripts/graphrag/batch-epub-workflow.mjs:10124-10129`。 |
| I10_regression_tests_and_observability | PASS | 固定矩阵已有测试：same-ms temp collision：`test/book-job-state.test.ts:420-457`；forced temp id collision：`test/cli.test.ts:2720-2787`；active/stale temp reconcile：`test/cli.test.ts:2851-3087`；stale live lock owner：`test/cli.test.ts:2609-2718`；rename ENOENT：`test/cli.test.ts:3565-3701`；directory fsync boundary：`test/cli.test.ts:2789-2849`；partial checksum sidecar crash window：`test/cli.test.ts:3244-3348`；resume-book orphan temp：`test/cli.test.ts:3428-3563`。observability schema 暴露 durable evidence fields：`src/contracts/batch-run.ts:134-186`、`src/contracts/batch-run.ts:350-397`、`src/contracts/batch-run.ts:399-440`。残余风险：测试尚未捕获 I02/I09 的 child qmd index weak lock 与 preflight target 覆盖缺口。 |

## 阻塞项

### 1. Durable boundary 仍不是可执行的单一边界

证据：

- runner 使用声明性 adapter contract，但仍实现自己的 temp、checksum、fsync、
  lock、failure projection：
  `scripts/graphrag/batch-epub-workflow.mjs:206-220`,
  `scripts/graphrag/batch-epub-workflow.mjs:4023-4086`,
  `scripts/graphrag/batch-epub-workflow.mjs:4550-4789`,
  `scripts/graphrag/batch-epub-workflow.mjs:4928-5077`。
- shared store 是另一套实现：
  `src/job-state/durable-state-store.ts:36-49`,
  `src/job-state/durable-state-store.ts:375-547`,
  `src/job-state/durable-state-store.ts:612-805`。
- 两套实现的 reconcile 语义不等价：shared store 的 public reconcile 进入
  `withDurableFileLock()`，runner 的 checksum backfill/quarantine 分支没有整体
  包在 per-target lock 内：
  `src/job-state/durable-state-store.ts:358-364`,
  `scripts/graphrag/batch-epub-workflow.mjs:4550-4668`。

建议修复：

- 抽出真实 shared durable adapter，让 runner 通过同一模块执行 YAML/JSON
  replace、reconcile、checksum backfill、quarantine、cleanup 与 lock recovery。
- 若保留 runner adapter，增加 executable conformance tests（可执行等价测试），
  覆盖 lock 边界、checksum crash windows、temp cleanup、ENOENT、fsync 与
  failure projection，并禁止未经 adapter 的生产 durable 写入。

### 2. Checksum reconcile/backfill 未满足 lane/per-target lock 约束

证据：

- `reconcileDurableJsonTarget()` 只在 temp cleanup 中进入 `withJsonFileLock()`；
  checksum mismatch、missing checksum、pending meta、metadata backfill 与
  quarantine 分支在锁外执行：
  `scripts/graphrag/batch-epub-workflow.mjs:4550-4668`。
- YAML 分支同样如此：
  `scripts/graphrag/batch-epub-workflow.mjs:4671-4789`。
- `durablePreflightDecisionForPrimaryJson()` 在 preflight 中直接调用上述 reconcile，
  因此 preflight checksum recovery 也继承锁边界缺口：
  `scripts/graphrag/batch-epub-workflow.mjs:4348-4371`。

建议修复：

- 将 JSON/YAML reconcile 的完整读 target、读 checksum/meta、backfill、
  quarantine 与 meta commit 放入同一个 per-target lock critical section。
- 避免在锁内再次递归获取同一 target lock；可拆分 `reconcileUnlocked()`，由外层
  public/preflight 路径统一持锁调用。

### 3. `resume-book` qmd index lock 不满足固定 lock/fencing contract

证据：

- 普通 batch qmd 命令已使用父进程 qmd index file lock：
  `scripts/graphrag/batch-epub-workflow.mjs:8520-8559`。
- `resume-book` 路径在检测 qmd index write stage 时只进入 in-process
  `qmdIndexWriterLane`，没有使用父进程 `withQmdIndexFileLock()`：
  `scripts/graphrag/batch-epub-workflow.mjs:8712-8767`。
- 子进程 `syncGraphRagBookWorkspace()` 会调用 `registerQmdCorpusDocument()` 写
  qmd index：
  `scripts/graphrag/resume-book-workspace.mjs:541-550`,
  `src/job-state/graphrag-book.ts:2010-2017`。
- 子进程内部 `withQmdIndexFileLock()` 只写 pid、runnerSessionId、runId、
  acquiredAt；没有 lane、owner、generation、fencingTokenHash、operationId、
  heartbeatAt、expiresAt，也没有 guarded release：
  `src/job-state/graphrag-book.ts:1217-1263`。

建议修复：

- 让 `resume-book` 的所有 qmd index writes 使用与父 runner 相同的 qmd index
  durable file lock，或把强 lock owner schema 下沉到 shared runtime。
- 子进程 lock owner 必须包含 target mapping、generation、fencing hash、
  operationId、heartbeat/expiry；release 必须验证当前 owner 仍匹配。
- lock wait timeout 应记录 lockOwnerEvidence 并投射为
  `local_state_lock_timeout` / `durable_state_lock_timeout`。

### 4. Checksum/generation crash-window recovery 缺 owner/generation proof

证据：

- runner `checksumCommitEvidenceMatches()` 只看 checksum 与 locator/basename：
  `scripts/graphrag/batch-epub-workflow.mjs:3917-3922`。
- target-new/checksum-old 与 checksum-missing 直接 backfill：
  `scripts/graphrag/batch-epub-workflow.mjs:4598-4619`,
  `scripts/graphrag/batch-epub-workflow.mjs:4719-4740`。
- shared store 同样只用 checksum/meta locator 判定：
  `src/job-state/durable-state-store.ts:1385-1393`，
  并在 missing checksum 时自动 backfill：
  `src/job-state/durable-state-store.ts:505-540`。
- 测试仍允许缺少 owner/generation/fencing evidence 的 backfill：
  `test/book-job-state.test.ts:459-483`。

建议修复：

- checksum meta 应作为 commit record，包含 operationId、owner/session、
  leaseGeneration、targetGeneration、fencingTokenHash、targetChecksumBefore/after。
- `target_new_checksum_old` 与 `target_new_checksum_missing` 只有在 commit record
  与当前 target 内容、owner/generation/fencing proof 匹配时才能 backfill。
- 缺 proof、partial sidecar 或 ambiguous window 应 quarantine 或
  stop_until_fixed，不应自动 backfill。

### 5. Preflight 未覆盖全部生产 durable state

证据：

- preflight target 固定为当前 batch-run 的五个目录：
  `scripts/graphrag/batch-epub-workflow.mjs:4404-4411`。
- before-claim 与 before-resume 调用存在，但使用同一有限扫描：
  `scripts/graphrag/batch-epub-workflow.mjs:9310`,
  `scripts/graphrag/batch-epub-workflow.mjs:8712`。
- `runner_start` 使用 `{ includeTemps: false }`，启动时不扫描 temp：
  `scripts/graphrag/batch-epub-workflow.mjs:10124-10129`。
- book-scoped YAML 由 shared store 管理：
  `src/job-state/repository.ts:70-78`,
  `src/job-state/repository.ts:400-417`；
  graph capabilities 与 settings 也走 durable YAML：
  `src/graphrag/capability-catalog.ts:730-770`,
  `src/graphrag/settings-projection.ts:259-270`；
  GraphRAG output/row-count JSON sidecars 走 durable JSON：
  `src/job-state/graphrag-book.ts:1265-1283`,
  `src/job-state/graphrag-book.ts:1960-2025`。
  这些目标不在 runner preflight scan 中。

建议修复：

- 用 target registry（目标注册表）生成 preflight targets，覆盖 batch-run JSON、
  book-scoped YAML、settings、graph capability catalog、GraphRAG output sidecars、
  LanceDB row-count sidecars、qmd index lock 和必要 SQLite health checks。
- `before_resume_book` 必须执行 bookId-scoped preflight，发现同 bookId 旧
  generation temp、run record 半写、checkpoint checksum mismatch 或 qmd index
  lock owner 不可判定时写 `durable_preflight_blocked` 并 stop_until_fixed。
- runner-start 是否跳过 temp 需要改为只跳过已证明安全的旧格式/非生产 temp，
  不能全局 `includeTemps: false`。

## 已通过项与残余风险

- I03：temp identity 与 exclusive create 已满足；forced temp collision 已有测试。
- I04：temp owner evidence 与 cleanup safety 已明显改进；shared store remote owner
  保留测试已经覆盖。
- I05：YAML/JSON lock freshness、fencing 与 stale writer rejection 基本满足；qmd
  index 子进程弱锁不计入此项，但阻塞 I02。
- I06：durable replace 与 strict fsync boundary 已满足；directory fsync fault
  injection 已覆盖。
- I08：rename ENOENT 分类、evidence、checkpoint/event/recovery summary 覆盖完整。
- I10：固定回归矩阵大部分已补齐；仍建议新增测试专门覆盖 child qmd index lock
  owner schema、preflight all-target registry 与 checksum proof 缺失时的
  stop_until_fixed。

## 审计输入

采用用户提供的最近本地验证结果作为执行验证输入，本轮未重新运行测试：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `node --check scripts/graphrag/batch-failure-classifier.mjs`
- `node --check scripts/graphrag/resume-book-workspace.mjs`
- `npm run test:types`
- durable CLI 聚焦组：11 passed
- book-state durable 聚焦组：7 passed
- qmd index lock 慢测：1 passed

本轮实际查看的主要文件：

- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-criteria.yaml`
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/resume-book-workspace.mjs`
- `src/job-state/durable-state-store.ts`
- `src/job-state/graphrag-book.ts`
- `src/job-state/repository.ts`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `test/book-job-state.test.ts`
- `test/graphrag-book-state.test.ts`
