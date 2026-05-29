Status: FAIL

# GraphRAG Durable YAML Temp Collision 实施审计 R5

## Overall

固定基准判定：2 PASS，8 FAIL。

R5 相比 R4 已关闭若干关键局部问题（localized issues）：runner/shared
边界新增 `durableAdapterContract` 声明，pending checksum meta 在 checksum
匹配时会收敛为 `commitState: "committed"`，runner temp cleanup 已加入
target checksum/generation fence，stale lock recovery 要求 generation、
fencingTokenHash 与 operationId，`before_claim` 与 `before_resume_book`
preflight 已进入生产路径，并新增了 pending-meta、target-generation cleanup、
preflight live-lock 等测试。

但固定 criteria 要求的是全目标、全调用链的运行时一致性（runtime
coherence），而不是字段或局部 hook 存在。当前实现仍未满足：
targetMapping 仍由路径推断且 timeout/owner 与设计表不一致；部分 runner
生产写入没有把目标 lease 值投影到 temp owner evidence；shared store
cleanup 缺事件化删除与远端 owner 保守判定；rename ENOENT 仍只有单一
通用原因；manifest/status 观测面未完整表达 durable failure；故障注入
矩阵仍不完整。因此本轮不能通过 R5 implementation audit。

本审计为只读静态审计（static audit）。未读取或打印 `.env` 内容，未启动
真实 EPUB runner，未处理真实 runId `epub-batch-20260527-real-resume-1`。
用户提供的验证结果纳入证据，但本轮未重新运行这些测试。

## Criteria Checklist

### I01_single_durable_boundary：FAIL

生产路径仍同时存在 shared durable state store 与 runner 私有 durable
adapter。R5 增加了 `durableAdapterContract`，但该对象是声明性 metadata，
没有把 runner 私有 helper 收敛到共享实现，也没有消除语义差异。

证据：

- runner 声明 `boundary: "runner-equivalent-durable-state-store"` 与 shared
  module：
  `scripts/graphrag/batch-epub-workflow.mjs:194`。
- runner 仍保留私有 `writeFileDurable`、`writeJsonAtomicSidecar`、
  `writeJsonAtomic`、`writeJsonlAtomic`、`renameWithDurableEvidence`：
  `scripts/graphrag/batch-epub-workflow.mjs:2610`、
  `scripts/graphrag/batch-epub-workflow.mjs:3703`、
  `scripts/graphrag/batch-epub-workflow.mjs:3758`、
  `scripts/graphrag/batch-epub-workflow.mjs:3821`、
  `scripts/graphrag/batch-epub-workflow.mjs:3882`。
- shared store 使用独立实现：
  `src/job-state/durable-state-store.ts:266`、
  `src/job-state/durable-state-store.ts:512`、
  `src/job-state/durable-state-store.ts:695`、
  `src/job-state/durable-state-store.ts:986`。
- shared store lock timeout evidence 只写 target/lock/wait/redacted locator，
  未带 lane、targetMappingOwner、releaseOn 或 lockOwnerEvidence：
  `src/job-state/durable-state-store.ts:529`。
- shared store stale temp cleanup 直接删除并 fsync，未写 runner event 或
  recovery summary：
  `src/job-state/durable-state-store.ts:720`。

阻塞结论：当前只能证明两套实现尝试共享语义，不能证明所有 YAML/JSON
durable replace、checksum backfill、cleanup、quarantine 与 lock recovery
均通过同一可测试边界（testable boundary）。

建议修复：抽出真实 shared adapter，runner 私有写入通过 adapter 调用；或为
runner adapter 建立 contract tests，逐项断言 temp identity、owner evidence、
checksum recovery、cleanup、lock timeout、ENOENT classification、fsync 与
redaction 与 shared store 等价。

### I02_target_mapping_enforcement：FAIL

targetMapping 未按设计固定表执行。实现仍通过路径推断 lane/owner，且生产
timeout 与设计默认值不一致；qmd index owner 也与设计表冲突。

证据：

- 设计 contract 要求每个生产持久化目标可追溯到唯一 lane、owner、
  durableKind、laneTimeoutMs 与 releaseOn；默认 timeout 为 120000 ms：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`、
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:229`。
- 设计表将 `.qmd/index.sqlite` owner 定义为 `qmd`：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:344`。
- runner 用 `inferDurableLane` 与 `inferDurableOwner` 推断映射：
  `scripts/graphrag/batch-epub-workflow.mjs:2290`、
  `scripts/graphrag/batch-epub-workflow.mjs:2301`、
  `scripts/graphrag/batch-epub-workflow.mjs:2322`。
- shared store 也通过 `inferTargetMappingLane` 与
  `inferTargetMappingOwner` 推断，且允许环境变量覆盖 owner/lane：
  `src/job-state/durable-state-store.ts:1498`、
  `src/job-state/durable-state-store.ts:1519`、
  `src/job-state/durable-state-store.ts:1533`。
- runner `jsonFileLockWaitMs`、provider slot wait 与 qmd index lock wait
  生产值至少为 300000 ms：
  `scripts/graphrag/batch-epub-workflow.mjs:183`、
  `scripts/graphrag/batch-epub-workflow.mjs:209`、
  `scripts/graphrag/batch-epub-workflow.mjs:210`。
- shared store `DurableLockWaitMs` 为 300000 ms：
  `src/job-state/durable-state-store.ts:32`。
- qmd index lock 实现从 runner mapping 得到 owner `batchCoordinator`，测试
  也断言该 owner，而设计表为 `qmd`：
  `scripts/graphrag/batch-epub-workflow.mjs:3025`、
  `test/cli.test.ts:4527`。

阻塞结论：固定 criteria 要求“未列入 targetMapping 的目标不得写入”和唯一
映射执行约束；当前实现没有固定表校验（table enforcement），也没有拒绝
未知目标的 runtime guard。

建议修复：从设计 targetMapping 生成代码常量或手写固定表。所有 catalog、
book YAML、checkpoint、manifest、status、run lock、provider slot、
subprocess registry、book lease、settings 与 qmd index 写入必须查表；
未知目标拒绝写入。将 timeout 与 owner 对齐设计，或先更新设计并重新固定
criteria。

### I03_temp_identity_exclusive_create：PASS

durable temp identity 已包含 UUID 等价熵源，并以 exclusive create 写入。
EEXIST 会分类为 local state integrity，不会覆盖 target。

证据：

- runner tempId 包含 pid、Date.now 与 randomUUID：
  `scripts/graphrag/batch-epub-workflow.mjs:2196`。
- runner JSON/YAML/JSONL temp 与 checksum temp 使用 `flag: "wx"`：
  `scripts/graphrag/batch-epub-workflow.mjs:3709`、
  `scripts/graphrag/batch-epub-workflow.mjs:3834`、
  `scripts/graphrag/batch-epub-workflow.mjs:3854`、
  `scripts/graphrag/batch-epub-workflow.mjs:3891`。
- shared store tempId 同样包含 randomUUID，temp 写入使用 `wx`：
  `src/job-state/durable-state-store.ts:1374`、
  `src/job-state/durable-state-store.ts:294`、
  `src/job-state/durable-state-store.ts:310`、
  `src/job-state/durable-state-store.ts:862`。
- runner 与 shared store 将 EEXIST 分类为 `durable_temp_create_collision`：
  `scripts/graphrag/batch-epub-workflow.mjs:3801`、
  `src/job-state/durable-state-store.ts:1180`。
- 同毫秒并发 YAML 写入测试覆盖 temp path 抗碰撞：
  `test/book-job-state.test.ts:420`。

残余风险：forced EEXIST 注入测试尚未发现，计入 I10。

### I04_temp_owner_evidence：FAIL

R5 的通用 owner evidence 字段明显增强，但并非所有生产 temp 都携带适用的
item/book/worker scope、目标 lease generation 与目标 fencing evidence。

证据：

- runner `durableOperationEvidence` 可写入 tempId、operationId、
  targetLocator、runnerSessionId、workerId、itemId、bookId、leaseGeneration、
  bookLeaseGeneration、targetGeneration、targetChecksumBefore 与
  fencingTokenHash：
  `scripts/graphrag/batch-epub-workflow.mjs:2196`。
- `writeTypedJson` 与 `lockedReadWriteTypedJson` 会通过
  `durableContextFromValue` 从写入值投影 context：
  `scripts/graphrag/batch-epub-workflow.mjs:4872`、
  `scripts/graphrag/batch-epub-workflow.mjs:4884`。
- 但 book lease acquire 直接 `writeJsonAtomic`，没有从 lease 值建立
  durable context：
  `scripts/graphrag/batch-epub-workflow.mjs:2826`、
  `scripts/graphrag/batch-epub-workflow.mjs:2854`。
- provider slot acquire 也直接 `writeJsonAtomic`，未投影 provider slot 的
  item/book/worker/generation/fencingToken：
  `scripts/graphrag/batch-epub-workflow.mjs:3223`、
  `scripts/graphrag/batch-epub-workflow.mjs:3268`。
- coordinator lock acquire 与 heartbeat 直接 `writeJsonAtomic`；初始 acquire
  发生在 `coordinatorLease` 赋值前，owner sidecar 只能落到 fallback fence：
  `scripts/graphrag/batch-epub-workflow.mjs:5142`、
  `scripts/graphrag/batch-epub-workflow.mjs:5154`、
  `scripts/graphrag/batch-epub-workflow.mjs:5173`、
  `scripts/graphrag/batch-epub-workflow.mjs:5190`。
- shared store owner evidence 主要从环境变量读取 book/item lease，不适用于
  所有直接调用目标：
  `src/job-state/durable-state-store.ts:1374`。

阻塞结论：owner evidence 的字段集合已接近要求，但固定基准要求“每个 temp
创建后”都有可恢复 owner evidence。当前 raw `writeJsonAtomic` 调用仍会产生
缺少目标值 scope 的 temp owner sidecar。

建议修复：book lease、provider slot、coordinator lock、heartbeat、manifest
migration、event migration 等直接写入统一包裹
`withDurableOperationContext(durableContextFromValue(value))`，或改用
`writeTypedJson`/shared adapter。

### I05_inflight_cleanup_safety：FAIL

runner cleanup 已补上 target checksum/generation fence 并事件化删除；shared
store cleanup 仍不满足固定 criteria 的全局通过条件。

证据：

- runner cleanup 会检查 stale age、owner target、generation/fencing、
  targetChecksumBefore、owner alive、remote owner 与 lease expiry：
  `scripts/graphrag/batch-epub-workflow.mjs:3957`。
- runner 删除 stale temp 时在 per-target lock 内执行，并发出
  `durable_json_temp_reconciled` 或 `durable_yaml_temp_reconciled`：
  `scripts/graphrag/batch-epub-workflow.mjs:4342`、
  `scripts/graphrag/batch-epub-workflow.mjs:4463`。
- runner 删除事件 metadata 包含 lockOwnerEvidence、recoveryDecision、
  cleanupReason 与 staleAgeMs：
  `scripts/graphrag/batch-epub-workflow.mjs:4361`、
  `scripts/graphrag/batch-epub-workflow.mjs:4482`。
- shared store cleanup 已检查 target checksum 是否推进：
  `src/job-state/durable-state-store.ts:1313`、
  `src/job-state/durable-state-store.ts:1322`。
- 但 shared store 对远端 owner 没有 runner 的 `remote_owner_unproven` 保守
  分支；非本机 owner 在 stale 后可被删除：
  `src/job-state/durable-state-store.ts:716`。
- shared store 删除 temp 与 owner sidecar 后只 fsync 目录，不写 event 或
  recovery summary，也不记录 staleAgeMs/cleanupReason：
  `src/job-state/durable-state-store.ts:720`、
  `src/job-state/durable-state-store.ts:761`。

阻塞结论：criteria 要求 temp cleanup 删除“必须事件化”并包含 tempId、
operationId、owner、staleAgeMs 与 cleanupReason。shared store cleanup
不满足该条件，且远端 owner 判定不够保守。

建议修复：为 shared store cleanup 增加可注入 reporter/recovery sink；无
reporter 时至少持久化 cleanup summary sidecar。对 remote owner 在 lease
未过期或无法证明失效时保持不删除。

### I06_atomic_commit_and_checksum_recovery：PASS

R5 已补齐 R4 的核心 checksum pending-meta 窗口。实现覆盖 temp fsync、
atomic rename、checksum sidecar durable replace、parent directory fsync，
并处理主要 crash window。

证据：

- shared store 写入顺序：owner sidecar、temp `wx` 写入/fsync、pending meta、
  target rename、checksum temp `wx` 写入/fsync、checksum rename、committed
  meta、父目录 fsync：
  `src/job-state/durable-state-store.ts:275`。
- runner JSON 写入顺序等价：
  `scripts/graphrag/batch-epub-workflow.mjs:3821`。
- target-new/checksum-old 通过 commit evidence 回填：
  `src/job-state/durable-state-store.ts:438`、
  `scripts/graphrag/batch-epub-workflow.mjs:4390`、
  `scripts/graphrag/batch-epub-workflow.mjs:4511`。
- target-new/checksum-missing 通过 checksum backfill 回填：
  `src/job-state/durable-state-store.ts:408`、
  `scripts/graphrag/batch-epub-workflow.mjs:4405`、
  `scripts/graphrag/batch-epub-workflow.mjs:4526`。
- target 与 checksum 已匹配但 meta 仍 pending 时，R5 会写入 committed meta：
  `src/job-state/durable-state-store.ts:418`、
  `scripts/graphrag/batch-epub-workflow.mjs:4412`、
  `scripts/graphrag/batch-epub-workflow.mjs:4533`。
- parent directory fsync 不确定会分类为
  `durable_directory_fsync_uncertain`，`completedPublishRule: "forbidden"`：
  `src/job-state/durable-state-store.ts:1106`、
  `scripts/graphrag/batch-epub-workflow.mjs:2562`。
- pending meta committed 的 shared store 与 runner 测试覆盖：
  `test/book-job-state.test.ts:459`、
  `test/cli.test.ts:3043`。

残余风险：partial checksum/meta 与 parent fsync uncertainty 的故障注入覆盖
仍不足，计入 I10；shared store backfill meta 未统一写 `commitState:
"committed"`，建议后续收敛为显式 committed schema。

### I07_rename_enoent_classification：FAIL

rename ENOENT 已稳定分类为 local state integrity、retryable=false 与
stop-until-fixed，但没有区分 criteria 要求的原因矩阵（cause matrix）。

证据：

- runner ENOENT evidence 固定为
  `renameCause: "filesystem_or_external_mutation"`：
  `scripts/graphrag/batch-epub-workflow.mjs:3758`。
- shared store async/sync rename ENOENT 同样固定为该通用值：
  `src/job-state/durable-state-store.ts:986`、
  `src/job-state/durable-state-store.ts:1014`。
- 测试断言 checkpoint/event/recovery summary 中的 ENOENT 与
  stop-until-fixed，但未断言 temp collision、cleanup deletion、concurrent
  takeover、generation advanced、filesystem/external mutation 的枚举原因：
  `test/cli.test.ts:3190`、
  `test/cli.test.ts:3275`。

阻塞结论：固定基准要求区分 temp 碰撞、调和误删、并发接管、generation
更新、底层文件系统或外部修改。当前只有最后一类通用原因。

建议修复：rename ENOENT 时读取 temp owner sidecar、target checksum/generation、
cleanup history、current lock owner 与 checksum/meta 状态，输出枚举化
`renameCause`；补齐原因矩阵测试。

### I08_status_event_schema_observability：FAIL

event、checkpoint、command check 与 recovery summary schema 已大幅增强，但
manifest/status 观测面仍未完整表达 durable write failure 诊断字段。

证据：

- command check schema 包含 lane、targetLocator、tempId、operationId、
  renameCause、lockOwnerEvidence、checksumRecoveryDecision、runner/worker/
  lease/fence 字段：
  `src/contracts/batch-run.ts:134`。
- item checkpoint schema 包含同类 durable failure 字段：
  `src/contracts/batch-run.ts:188`。
- event log schema 包含同类 durable failure 字段：
  `src/contracts/batch-run.ts:347`。
- recovery summary item schema 包含同类 durable failure 字段：
  `src/contracts/batch-run.ts:399`。
- runner event 写入前会 redact message/metadata：
  `scripts/graphrag/batch-epub-workflow.mjs:3523`。
- `BatchRunManifestSchema` 仍主要是 counts、locators、active slot/subprocess/
  book lease 计数和 metadata；没有 durable failure summary、lock owner
  evidence 或 checksum recovery decision 的结构化字段：
  `src/contracts/batch-run.ts:311`。
- status-json 输出构造的是 recovery summary；manifest 子对象仍只投影 counts
  与时间戳：
  `src/contracts/batch-run.ts:519`、
  `scripts/graphrag/batch-epub-workflow.mjs:7602`。

阻塞结论：criteria 明确要求 contracts、runner event、item checkpoint、
manifest/status-json 与 recovery summary 均能表达 durable write failure
诊断字段。manifest/status 层尚未闭环。

建议修复：明确 manifest 是否仅派生缓存。若仍在 criteria 范围内，则为
manifest/status-json 增加 durableFailureSummary、lastDurableFailure、
checksumRecoveryDecision 与 redacted evidence locator；否则更新设计并重新
固定 criteria。

### I09_direct_call_chain_coverage：FAIL

repository、capability catalog、durable-json、settings projection、python
bridge 与 DSPy policy store 已基本收敛到 shared store；runner 生产 JSON/
JSONL 写入链仍保留私有实现，且部分 direct call 未携带目标 context。

证据：

- repository 通过 shared durable YAML writer：
  `src/job-state/repository.ts:400`。
- capability catalog 读取/更新走 durable YAML helper：
  `src/graphrag/capability-catalog.ts:342`、
  `src/graphrag/capability-catalog.ts:745`。
- settings projection 使用 shared durable YAML writer：
  `src/graphrag/settings-projection.ts:259`。
- python bridge 使用 shared durable JSON writer：
  `src/integrations/python-bridge.ts:151`。
- DSPy policy store 使用 shared durable YAML/JSON/opaque writers：
  `src/dspy/policy-store.ts:194`。
- runner event append、book lease、provider slot、coordinator lock、heartbeat、
  event log migration、manifest migration 等仍直接调用私有 writer：
  `scripts/graphrag/batch-epub-workflow.mjs:2854`、
  `scripts/graphrag/batch-epub-workflow.mjs:3268`、
  `scripts/graphrag/batch-epub-workflow.mjs:3548`、
  `scripts/graphrag/batch-epub-workflow.mjs:5002`、
  `scripts/graphrag/batch-epub-workflow.mjs:5154`、
  `scripts/graphrag/batch-epub-workflow.mjs:5190`、
  `scripts/graphrag/batch-epub-workflow.mjs:5822`、
  `scripts/graphrag/batch-epub-workflow.mjs:5876`、
  `scripts/graphrag/batch-epub-workflow.mjs:6714`。

阻塞结论：当前不能证明所有被 targetMapping 或 runner 恢复路径覆盖的写入链
都满足同一 owner evidence、checksum recovery、ENOENT classification 与
parent fsync 语义。

建议修复：runner 私有 durable writer 要么下沉到 shared adapter，要么建立
逐调用点 context contract；所有 raw `writeJsonAtomic` 调用必须投影目标值
中的 lease/fence/scope。

### I10_fault_injection_tests：FAIL

R5 新增测试显著提高覆盖面，但仍未满足固定故障注入矩阵。

已覆盖证据：

- 同毫秒 temp 抗碰撞：
  `test/book-job-state.test.ts:420`。
- checksum target-new/checksum-old、matching pending meta committed、checksum
  mismatch quarantine：
  `test/book-job-state.test.ts:459`、
  `test/cli.test.ts:3043`。
- fresh temp 保留、owner-dead stale temp 删除、owner evidence 缺失保留、
  target generation advanced 保留：
  `test/cli.test.ts:2719`、
  `test/cli.test.ts:2813`、
  `test/cli.test.ts:2885`。
- lock timeout owner evidence 与 preflight live-lock blocker：
  `test/cli.test.ts:2609`、
  `test/cli.test.ts:3112`。
- rename ENOENT durable checkpoint stop-until-fixed：
  `test/cli.test.ts:3190`。
- provider slot capacity gate、stale release fencing、qmd index file lock：
  `test/cli.test.ts:3968`、
  `test/cli.test.ts:4010`、
  `test/cli.test.ts:4491`。

缺口：

- 未发现 forced temp EEXIST 注入测试；`durable_temp_create_collision` 仍主要是
  分类代码证据。
- 未发现 `before_resume_book` preflight blocker 的定向断言。
- 未覆盖 active writer temp 被 cleanup 误删的负向注入。
- 未覆盖 target-old/checksum-old/pending-meta、partial checksum、partial meta、
  parent fsync uncertainty 的完整 crash-window 矩阵。
- rename ENOENT 未覆盖 temp collision、cleanup deletion、concurrent takeover、
  generation advanced、filesystem/external mutation 的 cause matrix。
- durable write failure 后的 restart recovery 闭环仍不足。

阻塞结论：测试证明了 R5 的若干局部修复，但不足以证明“不丢失已提交状态、
不把未提交状态标记为完成”的全矩阵不变量。

建议修复：增加 deterministic hooks：forced EEXIST、fsync failure、partial
checksum/meta、live temp cleanup race、renameCause matrix、before_resume_book
preflight、durable write failure 后重启恢复；测试需同时断言 event、
status-json/recovery summary、checkpoint 与目标文件状态。

## Blocking Findings

### Critical：targetMapping runtime contract 未落地

实现仍以路径推断替代设计表，且 timeout/owner 与设计不一致。该问题直接影响
I02，也削弱 I01/I08/I09 的证据链。

建议：将设计 targetMapping 固化为 runtime table；所有 durable 目标写入前
必须查表，未知目标拒绝写入。将 qmd index owner 与 lane timeout 对齐设计或
重新走设计变更流程。

### Critical：runner direct durable writes 未统一 context

book lease、provider slot、coordinator lock 等 direct write 未从目标值投影
lease/fence/scope，导致 temp owner evidence 不满足“每个 temp”的固定要求。

建议：用 `withDurableOperationContext(durableContextFromValue(value))` 包裹
所有 raw writes；长期应删除 runner 私有 durable writer，统一到 shared
adapter。

### High：shared store cleanup 不满足事件化与 remote owner 安全

shared store cleanup 已有 checksum fence，但删除没有事件/summary，也没有
runner 的 remote-owner 保守分支。

建议：为 shared store cleanup 增加 reporter/recovery sink；remote owner
未证明 lease 失效时不得删除。

### High：rename ENOENT cause matrix 缺失

ENOENT 诊断仍固定为 `filesystem_or_external_mutation`，无法支持固定 criteria
要求的原因区分。

建议：实现原因判定矩阵并补齐 fault injection tests。

### Medium：manifest/status 观测面未闭环

checkpoint/event/recovery summary 字段已增强，但 manifest/status 层仍缺
durable failure summary 与 lock/checksum evidence。

建议：为 manifest/status-json 增加 durable failure summary；或明确 manifest
仅为派生缓存并重新固定 criteria。

## R4 失败点复核

- runner/shared durable boundary：部分改善但未关闭。新增 adapter contract
  声明，私有 helper 和语义差异仍存在。
- targetMapping runtime contract：未关闭。仍路径推断，timeout/owner 与设计
  不一致。
- owner evidence：部分改善但未关闭。typed JSON 写入可投影 context，raw
  writeJsonAtomic 调用仍缺目标值 scope。
- cleanup target-generation fence：runner 关闭，shared store 仍因事件化与
  remote owner 判定不足而未通过。
- pending checksum meta：主要实现缺口已关闭。matching pending meta 会收敛
  为 committed。
- stale lock recovery fencing/session/operationId：主要实现点已改善，但
  shared store lock timeout evidence 仍不完整。
- startup/claim/resume preflight：实现已加入；claim/live-lock 有测试，
  before_resume_book 定向 blocker 测试仍缺。
- fault/path tests：覆盖面增加，但固定矩阵仍未关闭。

## Reviewed Files

- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-criteria.yaml`
- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-audit-r4.md`
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/job-state/durable-state-store.ts`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `test/book-job-state.test.ts`
- `src/job-state/repository.ts`
- `src/graphrag/capability-catalog.ts`
- `src/job-state/durable-json.ts`
- `src/graphrag/settings-projection.ts`
- `src/integrations/python-bridge.ts`
- `src/dspy/policy-store.ts`

## Commands

实际执行的只读/报告写入相关命令：

- `sed -n '1,240p' audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-criteria.yaml`
- `sed -n '1,260p' audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-audit-r4.md`
- `sed -n '260,420p' audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-audit-r4.md`
- `git status --short`
- `rg --files -g '!**/.env*' audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b scripts/graphrag src/job-state src/contracts test`
- `rg -n ... scripts/graphrag/batch-epub-workflow.mjs`
- `rg -n ... src/job-state/durable-state-store.ts`
- `rg -n ... src/contracts/batch-run.ts`
- `rg -n ... test/cli.test.ts test/book-job-state.test.ts`
- `nl -ba scripts/graphrag/batch-epub-workflow.mjs | sed -n ...`
- `nl -ba src/job-state/durable-state-store.ts | sed -n ...`
- `nl -ba src/contracts/batch-run.ts | sed -n ...`
- `nl -ba test/cli.test.ts | sed -n ...`
- `nl -ba test/book-job-state.test.ts | sed -n ...`
- `nl -ba docs/architecture/graphrag-parallel-runner.type-dd.yaml | sed -n ...`
- `nl -ba src/graphrag/capability-catalog.ts | sed -n ...`
- `nl -ba src/job-state/repository.ts | sed -n ...`
- `nl -ba src/graphrag/settings-projection.ts | sed -n ...`
- `nl -ba src/integrations/python-bridge.ts | sed -n ...`
- `nl -ba src/dspy/policy-store.ts | sed -n ...`
- `find audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open -maxdepth 3 -type f | sort`
- `mkdir -p audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b && touch audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-audit-r5.md`

用户提供但本轮未重新执行的验证结果：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `node --check scripts/graphrag/batch-failure-classifier.mjs`
- `npm run test:types`
- CLI durable 聚焦组：9 passed
- book-state durable 聚焦组：4 passed，graph capability pattern still skipped
- `book-concurrency 2 runs multiple books through the worker pool`
- `durable provider slots gate capacity across concurrent workers`
- `all batch qmd commands acquire the qmd index file lock`
- `terminal completion events share the checkpoint finalization fence`
- `parallel non-transient failure quiesces sibling workers`
- `provider slot stale release cannot delete the current durable slot`
- 进程检查：仅匹配检查命令本身，无旧 runner/vitest 残留
