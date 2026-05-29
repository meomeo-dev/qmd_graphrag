Status: FAIL

# GraphRAG Durable YAML Temp Collision 实施审计 R6

## 总体结论

固定基准判定：3 PASS，7 FAIL。

R6 相比 R5 已关闭多项实质缺口：runner 和 shared store 均有显式
targetMapping 表，`.qmd/index.sqlite` owner 已对齐为 `qmd`，forced temp
collision、directory fsync failure、partial checksum sidecar、before-resume
orphan temp 等测试已补入，shared store cleanup 也已避免删除无法证明失效的
remote owner temp。

但固定基准仍未闭合。当前最新实现仍保留 fallback targetMapping、未列入设计
表的生产 durable target 写入、部分 raw `writeJsonAtomic()` 路径未投影目标值
owner evidence、shared store stale temp cleanup 删除未事件化，且 rename ENOENT
cause 仍未区分 criteria 要求的全部原因类别。因此本轮 implementation audit
不能判定 PASS。

本轮为只读静态审计。未读取或打印 `.env`，未启动真实 EPUB runner，未修改
固定 criteria。用户提供的最近验证结果已作为背景输入，本轮未重新执行真实
runner 或慢测。

## 阻塞项

### 1. targetMapping 仍不是固定表强制执行

固定 criteria I02 要求每个生产目标必须匹配设计 targetMapping 的唯一 lane、
owner、durableKind、laneTimeoutMs 和 releaseOn，未列入 targetMapping 的
durable YAML/JSON/SQLite 目标不得由并行 runner 写入。

证据：

- 设计明确禁止未列入 targetMapping 的 durable 目标写入：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`。
- 设计列出 `.qmd/index.sqlite` owner 为 `qmd`：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:344`。
- 设计还把 `events.jsonl` 放入 `eventWriterLane`：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:202`。
- runner 虽新增固定表，但 `durableTargetMapping()` 仍允许 fallback：
  `scripts/graphrag/batch-epub-workflow.mjs:2427`。
- fallback 继续通过路径推断 lane/owner：
  `scripts/graphrag/batch-epub-workflow.mjs:2449`、
  `scripts/graphrag/batch-epub-workflow.mjs:2470`。
- shared store 同样允许 fallback，并允许生产环境变量覆盖 owner/lane：
  `src/job-state/durable-state-store.ts:1655`、
  `src/job-state/durable-state-store.ts:1664`。
- runner 的 `events.jsonl` 是生产 durable append target：
  `scripts/graphrag/batch-epub-workflow.mjs:389`、
  `scripts/graphrag/batch-epub-workflow.mjs:3708`。
  但 runner targetMapping 表没有 events.jsonl 项：
  `scripts/graphrag/batch-epub-workflow.mjs:237`。
  因此 events 写入只能走 fallback，且会落入
  `manifestWriterLane` 推断，而不是设计的 `eventWriterLane`。
- `resume-book-*` 路径只在 parent runner 外层进入
  `qmdIndexWriterLane` semaphore，没有调用 runner 的
  `withQmdIndexFileLock()`：
  `scripts/graphrag/batch-epub-workflow.mjs:8712`、
  `scripts/graphrag/batch-epub-workflow.mjs:8752`。
- 子路径实际 qmd index 写入使用 `src/job-state/graphrag-book.ts` 的本地
  `withQmdIndexFileLock()`，该 lock owner 只写 pid/session/runId/acquiredAt，
  超时抛普通 `Error`，没有 targetMappingOwner、lane、operationId、
  generation、fencingTokenHash 或 durable failure projection：
  `src/job-state/graphrag-book.ts:1024`、
  `src/job-state/graphrag-book.ts:1217`、
  `src/job-state/graphrag-book.ts:1227`、
  `src/job-state/graphrag-book.ts:1243`。

建议修复：

- 对 runner 与 shared store 使用同一个 generated/static target registry。
- `durableTargetMapping()` 遇到未列入表的 production YAML/JSON/SQLite target
  应直接拒绝写入，不应 fallback 推断。
- 将 events.jsonl、recovery-summary/status 输出的设计归属补齐，或明确排除
  其 durable targetMapping 要求。
- `resume-book-*` 的 qmd index 写入必须使用与 runner 相同的 qmd index lock
  adapter，或把 `src/job-state/graphrag-book.ts` 的 lock 升级为等价 durable
  lock，并输出相同诊断字段。

### 2. 部分 production temp owner evidence 仍缺目标值 scope

固定 criteria I04 要求每个 temp 创建后都有可恢复 owner evidence，至少包含
tempId、targetLocator、operationId、runnerSessionId、worker/coordinator、
item/book scope、leaseGeneration、fencingTokenHash、ownerPid、ownerHost、
createdAt 中适用字段。

证据：

- runner 的通用 `durableOperationEvidence()` 支持完整字段：
  `scripts/graphrag/batch-epub-workflow.mjs:2319`。
- `writeTypedJson()` 与 `lockedReadWriteTypedJson()` 会通过写入值投影 context：
  `scripts/graphrag/batch-epub-workflow.mjs:5080`、
  `scripts/graphrag/batch-epub-workflow.mjs:5092`。
- 但 book lease acquire/refresh 仍直接调用 raw `writeJsonAtomic()`：
  `scripts/graphrag/batch-epub-workflow.mjs:2990`、
  `scripts/graphrag/batch-epub-workflow.mjs:3018`、
  `scripts/graphrag/batch-epub-workflow.mjs:3035`、
  `scripts/graphrag/batch-epub-workflow.mjs:3052`。
  这些 temp owner sidecar 不会从 lease value 投影 itemId、bookId、workerId
  和 book lease generation/fencing token。
- provider slot acquire 也直接 `writeJsonAtomic()`：
  `scripts/graphrag/batch-epub-workflow.mjs:3435`、
  `scripts/graphrag/batch-epub-workflow.mjs:3453`。
- coordinator lock acquire/heartbeat 直接 `writeJsonAtomic()`，初始 acquire
  在 `coordinatorLease` 赋值之前发生：
  `scripts/graphrag/batch-epub-workflow.mjs:5350`、
  `scripts/graphrag/batch-epub-workflow.mjs:5362`、
  `scripts/graphrag/batch-epub-workflow.mjs:5363`、
  `scripts/graphrag/batch-epub-workflow.mjs:5381`、
  `scripts/graphrag/batch-epub-workflow.mjs:5398`。
- item checkpoint heartbeat 和 clear heartbeat 也绕过 `writeTypedJson()`：
  `scripts/graphrag/batch-epub-workflow.mjs:6012`、
  `scripts/graphrag/batch-epub-workflow.mjs:6030`、
  `scripts/graphrag/batch-epub-workflow.mjs:6060`、
  `scripts/graphrag/batch-epub-workflow.mjs:6084`。

建议修复：

- 禁止 production path 直接调用 raw `writeJsonAtomic()`，除非调用点显式传入
  `withDurableOperationContext(durableContextFromValue(value))`。
- 将 book lease、provider slot、coordinator lock、checkpoint heartbeat 写入
  改为 typed durable write helper，或为 raw helper 增加 required context 参数。
- 增加测试读取 temp owner sidecar，断言上述目标的 item/book/worker/generation
  和 fencing evidence 存在。

### 3. shared store stale temp cleanup 删除仍未事件化

固定 criteria I05 要求 cleanup 删除时必须事件化，并包含 tempId、
operationId、owner、staleAgeMs 和 cleanupReason。

证据：

- shared store 已检查 owner evidence、cleanup fence、target generation、
  stale age、owner alive、lease expired 和 local owner dead：
  `src/job-state/durable-state-store.ts:807`、
  `src/job-state/durable-state-store.ts:829`。
- 但实际删除只 `rm` temp 和 owner sidecar，然后 fsync 目录：
  `src/job-state/durable-state-store.ts:836`、
  `src/job-state/durable-state-store.ts:838`。
- 传给 fsync 的 evidence 有 operationId、tempId、lockOwnerEvidence 和
  cleanupReason，但没有 staleAgeMs，也没有写 runner event、status-json 或
  recovery summary：
  `src/job-state/durable-state-store.ts:838`。
- 同步路径同样只删除和 fsync：
  `src/job-state/durable-state-store.ts:884`、
  `src/job-state/durable-state-store.ts:886`。

建议修复：

- 为 shared store cleanup 增加可注入 recovery/event sink。无 runner sink 时，
  至少持久化 cleanup summary sidecar。
- cleanup evidence 必须包含 staleAgeMs，并将 owner evidence 作为 redacted
  lockOwnerEvidence 输出。
- shared store 与 runner cleanup 应共用同一个 projection helper。

### 4. rename ENOENT cause 仍未区分 criteria 要求的全部原因

固定 criteria I07 要求 temp rename ENOENT 区分 temp 碰撞、调和误删、并发
接管、generation 更新、底层文件系统或外部修改。

证据：

- runner `inferRenameEnoentCause()` 只返回
  `target_generation_advanced`、`temp_missing_before_rename`、
  `temp_reconciled_or_external_removed`、`target_parent_missing` 和
  `filesystem_or_external_mutation`：
  `scripts/graphrag/batch-epub-workflow.mjs:3972`。
- shared store 使用等价的粗粒度原因：
  `src/job-state/durable-state-store.ts:1168`。
- 现有 ENOENT 测试只断言 `temp_missing_before_rename`：
  `test/cli.test.ts:3565`、
  `test/cli.test.ts:3652`、
  `test/cli.test.ts:3668`。

阻塞结论：实现可持久化 ENOENT failure，但不能区分 temp collision、
reconciler 删除、concurrent takeover 等 criteria 指定原因类别。

建议修复：

- 在 rename ENOENT 分类时读取 temp owner sidecar、target checksum/meta、
  current lock owner 和 cleanup/recovery evidence，输出更具体的 renameCause。
- 增加覆盖 concurrent takeover、reconciler deletion 和 temp collision 相关
  ENOENT 分支的 fault injection 测试。

### 5. manifest/status 观测面仍不能完整表达 durable failure

固定 criteria I08 要求 contracts、runner event、item checkpoint、
manifest/status-json 与 recovery summary 均能表达 durable write failure 诊断字段。

证据：

- command check、item checkpoint、event、recovery summary item schema 已包含
  durable 诊断字段：
  `src/contracts/batch-run.ts:134`、
  `src/contracts/batch-run.ts:226`、
  `src/contracts/batch-run.ts:350`、
  `src/contracts/batch-run.ts:399`。
- runner event 会 redaction metadata：
  `scripts/graphrag/batch-epub-workflow.mjs:3708`。
- recovery summary item 从 failed command 或 checkpoint 投影 durable fields：
  `scripts/graphrag/batch-epub-workflow.mjs:7710`、
  `scripts/graphrag/batch-epub-workflow.mjs:7740`。
- 但 BatchRunManifestSchema 仍只有 run counts、locator、policy 和 timing 等
  字段，没有 localFailureClass、targetLocator、operationId、lockOwnerEvidence、
  checksumRecoveryDecision 等 durable failure 字段：
  `src/contracts/batch-run.ts:311`、
  `scripts/graphrag/batch-epub-workflow.mjs:884`。
- 设计 targetMapping 列出 `status.json`，但 runner 当前没有持久化
  `status.json` target；`--status-json` 只是打印 recovery summary：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:314`、
  `scripts/graphrag/batch-epub-workflow.mjs:7857`。
- shared store cleanup 删除也没有进入 event/status/recovery summary，见阻塞项 3。

建议修复：

- 明确 manifest、status-json、recovery-summary 的职责边界。若 manifest 不承载
  durable failure fields，应在固定 criteria/设计中明确排除；否则补 schema。
- 若设计保留 `status.json` target，应实现 durable `status.json` 写入并复用
  recovery summary 的 durable diagnostics projection。
- shared store cleanup/recovery 应接入同一 observability projection。

## Criteria Checklist

### I01_single_durable_boundary：FAIL

runner 仍保留私有 durable helpers，并以 metadata contract 声明等价；shared
store 也有独立实现。R6 已让两边语义更接近，但 targetMapping fallback、
shared cleanup observability、qmd index lock 子路径和 raw write context 仍不等价。

关键证据：

- runner contract 仍是声明性对象：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。
- runner private durable replace/helper 仍存在：
  `scripts/graphrag/batch-epub-workflow.mjs:3888`、
  `scripts/graphrag/batch-epub-workflow.mjs:4023`、
  `scripts/graphrag/batch-epub-workflow.mjs:4088`。
- shared store 独立实现 durable replace/reconcile/lock：
  `src/job-state/durable-state-store.ts:375`、
  `src/job-state/durable-state-store.ts:485`、
  `src/job-state/durable-state-store.ts:612`。

### I02_target_mapping_enforcement：FAIL

固定表已新增，但没有强制拒绝未知 target；events.jsonl 走 fallback，shared
store 允许 env 覆盖，resume-book qmd index 子锁不输出 targetMapping 证据。

证据见阻塞项 1。

### I03_temp_identity_exclusive_create：PASS

runner 和 shared store tempId 均包含 random UUID 等价熵源，写入使用 exclusive
create，EEXIST 会分类为 local state integrity。

证据：

- runner tempId 包含 randomUUID；test hook 仅在测试模式启用：
  `scripts/graphrag/batch-epub-workflow.mjs:2319`、
  `scripts/graphrag/batch-epub-workflow.mjs:2371`。
- runner temp/checksum temp 使用 `wx`：
  `scripts/graphrag/batch-epub-workflow.mjs:4037`、
  `scripts/graphrag/batch-epub-workflow.mjs:4058`。
- runner EEXIST 分类为 `durable_temp_create_collision`：
  `scripts/graphrag/batch-epub-workflow.mjs:4003`。
- shared store tempId 包含 randomUUID，temp 写入使用 `wx`：
  `src/job-state/durable-state-store.ts:1530`、
  `src/job-state/durable-state-store.ts:393`、
  `src/job-state/durable-state-store.ts:410`。
- same-ms 与 forced collision 测试覆盖：
  `test/book-job-state.test.ts:420`、
  `test/cli.test.ts:2720`。

### I04_temp_owner_evidence：FAIL

通用 owner evidence 能表达固定字段，但部分 production raw writes 未从目标值投影
适用 item/book/worker/generation/fencing scope。

证据见阻塞项 2。

### I05_inflight_cleanup_safety：FAIL

cleanup safety 判断已明显加强；runner 删除事件也包含 staleAgeMs 和 cleanup
reason。但 shared store cleanup 删除仍未事件化，且没有输出 staleAgeMs。

证据见阻塞项 3。

### I06_atomic_commit_and_checksum_recovery：PASS

主要 durable replace 顺序覆盖 temp fsync、atomic rename、checksum sidecar
durable replace 和父目录 fsync。target-new/checksum-old、
target-new/checksum-missing、pending meta 和 partial checksum sidecar 均有恢复或
stop-until-fixed 路径。

证据：

- runner JSON replace 顺序：
  `scripts/graphrag/batch-epub-workflow.mjs:4023`、
  `scripts/graphrag/batch-epub-workflow.mjs:4044`、
  `scripts/graphrag/batch-epub-workflow.mjs:4049`、
  `scripts/graphrag/batch-epub-workflow.mjs:4071`、
  `scripts/graphrag/batch-epub-workflow.mjs:4074`。
- shared store replace 顺序：
  `src/job-state/durable-state-store.ts:392`、
  `src/job-state/durable-state-store.ts:395`、
  `src/job-state/durable-state-store.ts:400`、
  `src/job-state/durable-state-store.ts:416`、
  `src/job-state/durable-state-store.ts:419`。
- checksum recovery 分支：
  `scripts/graphrag/batch-epub-workflow.mjs:4598`、
  `scripts/graphrag/batch-epub-workflow.mjs:4613`、
  `scripts/graphrag/batch-epub-workflow.mjs:4620`、
  `src/job-state/durable-state-store.ts:508`、
  `src/job-state/durable-state-store.ts:518`、
  `src/job-state/durable-state-store.ts:538`。
- partial checksum sidecar 测试：
  `test/cli.test.ts:3244`。

残余风险：runner checksum reconcile/backfill 仍不是整体包在 per-target lock 内；
该问题已计入 I01/I02。

### I07_rename_enoent_classification：FAIL

ENOENT 会投射为 stop-until-fixed local state failure，但 renameCause 粒度未覆盖
固定 criteria 要求的全部原因类别。

证据见阻塞项 4。

### I08_status_event_schema_observability：FAIL

event、checkpoint、command check、recovery summary 的字段覆盖较完整，但
manifest/status target 与 shared cleanup observability 仍未满足固定 criteria。

证据见阻塞项 5。

### I09_direct_call_chain_coverage：FAIL

repository、capability catalog、durable-json、settings projection、python bridge
和 dspy policy store 已基本走 shared durable-state-store；但 batch runner 仍有
未等价的直接 durable 写入链。

证据：

- repository 使用 shared durable-state-store：
  `src/job-state/repository.ts:71`、
  `src/job-state/repository.ts:401`。
- capability catalog 使用 shared durable-state-store：
  `src/graphrag/capability-catalog.ts:31`、
  `src/graphrag/capability-catalog.ts:342`。
- settings projection 使用 shared durable-state-store：
  `src/graphrag/settings-projection.ts:9`。
- python bridge subprocess registry 使用 shared durable JSON：
  `src/integrations/python-bridge.ts:151`。
- dspy policy store YAML/JSON writes 使用 shared durable store：
  `src/dspy/policy-store.ts:190`。
- batch runner raw durable writes 仍绕过 typed/context helper，见阻塞项 2。
- resume-book qmd index 子路径使用旧 lock helper，见阻塞项 1。

### I10_fault_injection_tests：PASS

固定 fault injection 矩阵已覆盖主要场景，并断言事件、checkpoint、recovery
summary 或目标文件状态。

证据：

- same-ms temp collision：
  `test/book-job-state.test.ts:420`。
- forced temp collision：
  `test/cli.test.ts:2720`。
- active/fresh temp 与 owner-dead stale temp：
  `test/cli.test.ts:2851`、
  `test/book-job-state.test.ts:569`。
- target generation advanced temp 保留：
  `test/cli.test.ts:3017`。
- rename ENOENT：
  `test/cli.test.ts:3565`。
- checksum crash windows、pending meta、partial checksum sidecar：
  `test/book-job-state.test.ts:459`、
  `test/cli.test.ts:3175`、
  `test/cli.test.ts:3244`。
- lock timeout：
  `test/cli.test.ts:2609`。
- before-resume orphan temp preflight：
  `test/cli.test.ts:3428`。

## 本轮验证输入

采用用户提供的最近本地验证结果作为背景输入：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `node --check scripts/graphrag/batch-failure-classifier.mjs`
- `node --check scripts/graphrag/resume-book-workspace.mjs`
- `npm run test:types`
- durable CLI 聚焦组 11 passed
- book-state durable 聚焦组 7 passed
- qmd index lock 慢测 1 passed

本轮未重新运行上述命令，未启动真实 EPUB runner。

