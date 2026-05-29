# GraphRAG Durable YAML Temp Collision 实施审计 R3

## 总体结论

整体结论：FAIL。

固定基准判定：1 PASS，9 FAIL。R3 当前实现相较 R2 已补强
durable JSON lock owner/fencing/expiry、runner schema 的 lane 观测字段、
temp owner sidecar、rename ENOENT 故障注入测试、provider slot durable
capacity gate、book worker pool 与 qmd index file lock 测试证据。但固定
criteria 要求的是生产持久化边界（durable boundary）完整收敛、targetMapping
运行时约束、checksum crash window 全窗口恢复、rename ENOENT 原因矩阵
和故障注入闭环。当前实现仍未满足这些阻塞条件。

固定基准文件：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-criteria.yaml`

本轮审计方式：静态实现审计（static implementation audit），并对照用户提供
的已通过验证结果。未修改 criteria，未修改源代码。

是否允许恢复真实 EPUB runner：不允许恢复真实 EPUB runner 的生产并行执行。
在阻塞项修复前，只应允许只读 `--status-json`、受控 `--migrate-only`/恢复检查、
以及隔离测试钩子（test hook）验证，不应恢复真实 EPUB 批处理写入路径。

## 逐项判定

### I01_single_durable_boundary：FAIL

生产 YAML/JSON durable replace 仍存在两套边界，未统一到共享
`durableStateStore` 或显式声明等价 adapter。

证据：

- 共享 store 提供 YAML/JSON 写入、checksum、lock、temp cleanup 与 quarantine：
  `src/job-state/durable-state-store.ts:136`、
  `src/job-state/durable-state-store.ts:188`、
  `src/job-state/durable-state-store.ts:253`。
- runner 仍保留私有 `writeJsonAtomicSidecar`、`writeJsonAtomic`、
  `writeJsonlAtomic`：
  `scripts/graphrag/batch-epub-workflow.mjs:3458`、
  `scripts/graphrag/batch-epub-workflow.mjs:3561`、
  `scripts/graphrag/batch-epub-workflow.mjs:3622`。
- runner 仍保留私有 JSON/YAML reconcile 与 JSON lock：
  `scripts/graphrag/batch-epub-workflow.mjs:3902`、
  `scripts/graphrag/batch-epub-workflow.mjs:3999`、
  `scripts/graphrag/batch-epub-workflow.mjs:4184`、
  `scripts/graphrag/batch-epub-workflow.mjs:4258`。
- event append 使用 runner 私有 `writeFileDurable`，不是共享 store：
  `scripts/graphrag/batch-epub-workflow.mjs:3280`、
  `scripts/graphrag/batch-epub-workflow.mjs:3303`。

影响：runner 私有边界与共享 store 的 owner evidence、lease/fencing、
cleanup、checksum recovery 和事件化语义仍不完全一致。固定基准要求
每个生产写入点追溯到同一语义；当前只能证明局部相似，不能证明统一边界。

建议修复：

- 将 runner 的 JSON/JSONL durable replace、reconcile、lock timeout、
  checksum recovery 和 temp cleanup 改为调用共享 durable store，或抽出
  runner adapter 并在代码中显式声明与共享 store 的等价 contract。
- 为 event JSONL append 定义同一 durable boundary：append fsync、tail
  recovery、owner evidence、failure classification 与 targetMapping 证据
  必须与共享 store 同源。

### I02_target_mapping_enforcement：FAIL

实现新增了 target mapping 推断字段，但未把设计 targetMapping 固化为完整
运行时 contract（runtime contract）。

证据：

- 设计 targetMapping 要求唯一 lane、owner、durableKind、laneTimeoutMs 与
  releaseOn：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`、
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241`。
- 设计默认 `laneTimeoutMs` 为 120000：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:229`。
- runner 通过路径推断 lane/owner，而不是校验固定 targetMapping 表：
  `scripts/graphrag/batch-epub-workflow.mjs:2160`、
  `scripts/graphrag/batch-epub-workflow.mjs:2171`、
  `scripts/graphrag/batch-epub-workflow.mjs:2189`。
- runner JSON lock timeout 使用 `jsonFileLockWaitMs`，生产值至少 300000，
  不匹配设计默认 120000：
  `scripts/graphrag/batch-epub-workflow.mjs:181`。
- qmd index file lock timeout 同样至少 300000：
  `scripts/graphrag/batch-epub-workflow.mjs:193`。
- `AsyncSemaphore.acquire` 没有 lane timeout，也没有 `writer_lane_timeout`
  durable failure：
  `scripts/graphrag/batch-epub-workflow.mjs:2462`、
  `scripts/graphrag/batch-epub-workflow.mjs:2470`。
- qmd index 写入有 semaphore 与 file lock，但 lock owner 不含 lane、
  durableKind、laneTimeoutMs、releaseOn 或 fencing：
  `scripts/graphrag/batch-epub-workflow.mjs:2810`、
  `scripts/graphrag/batch-epub-workflow.mjs:2819`。

影响：provider slot、book lease、manifest/checkpoint、subprocess registry
和 qmd index 的局部锁存在，但不能证明每个生产 target 都匹配固定设计
targetMapping，也不能证明 timeout/releaseOn 按同一规则执行。

建议修复：

- 将设计 targetMapping 落为代码中的显式表或生成常量，所有写入入口必须按
  target locator 查表并拒绝未映射的 durable YAML/JSON/SQLite 目标。
- 对 catalog、checkpoint、event、manifest、provider slot、subprocess、
  book lease、settings 与 qmd index 逐目标记录 lane、owner、durableKind、
  laneTimeoutMs、releaseOn，并在 lock/semaphore timeout 时输出
  `writer_lane_timeout` 或等价 durable failure。
- 将生产 timeout 与设计 contract 对齐，或更新设计后重新建立固定基准。

### I03_temp_identity_exclusive_create：PASS

durable temp 名称包含 UUID 等价熵源，并使用 exclusive create。

证据：

- 共享 store `tempId` 包含 `randomUUID()`：
  `src/job-state/durable-state-store.ts:1221`。
- 共享 store 主 temp、checksum temp 使用该 `tempId`：
  `src/job-state/durable-state-store.ts:263`、
  `src/job-state/durable-state-store.ts:266`。
- 共享 store temp 写入使用 `wx`：
  `src/job-state/durable-state-store.ts:272`、
  `src/job-state/durable-state-store.ts:288`。
- runner `operationId` 使用 `randomUUID()`，`tempId` 包含 pid、时间和 UUID：
  `scripts/graphrag/batch-epub-workflow.mjs:2134`。
- runner 主 temp、checksum temp 使用该 `tempId` 并以 `wx` 创建：
  `scripts/graphrag/batch-epub-workflow.mjs:3567`、
  `scripts/graphrag/batch-epub-workflow.mjs:3574`、
  `scripts/graphrag/batch-epub-workflow.mjs:3594`。
- EEXIST 被分类为 `durable_temp_create_collision`：
  `src/job-state/durable-state-store.ts:1084`、
  `scripts/graphrag/batch-epub-workflow.mjs:3541`。
- 同毫秒并发 YAML 写入测试覆盖：
  `test/book-job-state.test.ts:420`。

结论：固定基准对 temp identity 与 exclusive create 的要求已满足。

### I04_temp_owner_evidence：FAIL

owner evidence 已持久化到 `.owner.json` sidecar，但 runner 私有 durable
operation 的证据字段仍不完整。

证据：

- 共享 store owner evidence 包含 tempId、operationId、targetLocator、
  runnerSessionId、runId、workerId、itemId、bookId、ownerPid、ownerHost、
  createdAt、leaseGeneration 与 fencingTokenHash：
  `src/job-state/durable-state-store.ts:1221`。
- runner owner evidence 包含 tempId、operationId、targetLocator、
  runnerSessionId、workerId、itemId、bookId、ownerPid、ownerHost、createdAt：
  `scripts/graphrag/batch-epub-workflow.mjs:2134`。
- runner sidecar 投影支持 `leaseGeneration` 和 `fencingTokenHash`，但
  `durableOperationEvidence` 没有写入这些字段：
  `scripts/graphrag/batch-epub-workflow.mjs:3658`、
  `scripts/graphrag/batch-epub-workflow.mjs:3686`。
- 子进程环境已经携带 book/item lease 与 fencing token，说明这些字段在
  runner 上下文中适用：
  `scripts/graphrag/batch-epub-workflow.mjs:7581`、
  `scripts/graphrag/batch-epub-workflow.mjs:7589`。

影响：runner checkpoint、manifest、provider slot、book lease 等生产写入的
temp owner sidecar 不能完整证明 leaseGeneration 与 fencingTokenHash。恢复、
cleanup、rename ENOENT 分类和 recovery summary 因此缺少关键 owner evidence。

建议修复：

- 在 runner `durableOperationEvidence` 中写入适用的 book/item
  `leaseGeneration`、`fencingTokenHash`、lease expiry 与 worker/coordinator
  scope。
- 对 coordinator、manifest、provider slot 和 subprocess registry 明确使用
  coordinator generation/fencing；对 item checkpoint 使用 item/book lease
  generation/fencing。

### I05_inflight_cleanup_safety：FAIL

temp cleanup 有 owner sidecar 与 stale age 检查，但未同时满足 stale age、
owner 存活或 lease 失效、target generation 未推进、cleaner 持有 per-target
lock 四个条件。

证据：

- runner cleanup 检查 stale age、owner target、owner alive 和 owner expiry：
  `scripts/graphrag/batch-epub-workflow.mjs:3695`。
- runner cleanup 在 reconcile 中持有 per-target JSON lock 并事件化删除：
  `scripts/graphrag/batch-epub-workflow.mjs:3902`、
  `scripts/graphrag/batch-epub-workflow.mjs:3913`、
  `scripts/graphrag/batch-epub-workflow.mjs:3921`。
- runner cleanup 未检查 target generation 未推进：
  `scripts/graphrag/batch-epub-workflow.mjs:3695`。
- 共享 store stale temp cleanup 不事件化删除，也不检查 target generation：
  `src/job-state/durable-state-store.ts:619`、
  `src/job-state/durable-state-store.ts:650`。
- 共享 store 对 remote owner 没有 runner 侧 `remote_owner_unproven` 保护：
  `src/job-state/durable-state-store.ts:638`、
  `src/job-state/durable-state-store.ts:640`。
- 测试覆盖 fresh temp 保留、owner-dead stale temp 删除、owner evidence 缺失
  时保留：
  `test/cli.test.ts:2718`、
  `test/cli.test.ts:2803`、
  `test/book-job-state.test.ts:551`。

影响：当前实现降低了活跃 temp 被误删概率，但仍不能证明 cleanup 不会删除
generation 已变化或 remote owner 未证明死亡的 temp。共享 store 删除也缺少
事件化证据。

建议修复：

- owner sidecar 写入 target generation、lease generation、fencingTokenHash；
  cleanup 必须在 per-target lock 下比较 target 当前 generation/checksum 与
  owner 记录。
- 共享 store cleanup 删除时必须持久化事件或 recovery summary 证据，包含
  tempId、operationId、owner、staleAgeMs、cleanupReason。
- remote owner 未过期且不能证明死亡时必须保留 temp。

### I06_atomic_commit_and_checksum_recovery：FAIL

实现新增了 `target_rename_pending`、`committed`、checksum backfill 与 strict
fsync 分类，但 checksum crash window 仍存在错误隔离有效 target 的窗口。

证据：

- 共享 store 在 target rename 之前写入 checksum meta
  `target_rename_pending`：
  `src/job-state/durable-state-store.ts:271`、
  `src/job-state/durable-state-store.ts:273`、
  `src/job-state/durable-state-store.ts:278`。
- runner 私有 helper 也在 target rename 前写入
  `target_rename_pending`：
  `scripts/graphrag/batch-epub-workflow.mjs:3579`、
  `scripts/graphrag/batch-epub-workflow.mjs:3584`。
- 共享 store 在 `expected === actual` 但 meta checksum 不等于 actual 时
  quarantine target：
  `src/job-state/durable-state-store.ts:391`、
  `src/job-state/durable-state-store.ts:396`。
- runner reconcile 在 `expected === actual` 但 meta invalid 时同样 quarantine：
  `scripts/graphrag/batch-epub-workflow.mjs:3972`、
  `scripts/graphrag/batch-epub-workflow.mjs:3987`。
- parent directory fsync 失败被分类为
  `durable_directory_fsync_uncertain`，但不是 crash-window recovery 证明：
  `src/job-state/durable-state-store.ts:1010`、
  `scripts/graphrag/batch-epub-workflow.mjs:2397`。
- 现有 checksum 测试覆盖 target-new/checksum-old 部分路径和 corrupt
  quarantine，但未覆盖 target-old/checksum-old/pending-meta、partial meta、
  partial checksum 与 parent fsync uncertainty 的恢复闭环：
  `test/book-job-state.test.ts:459`。

阻塞 crash window：若进程在写入 `target_rename_pending` meta 后、target rename
前崩溃，磁盘上仍可能是旧 target 与旧 checksum，二者一致且代表上一次有效
提交；但 meta 指向新 checksum。恢复时当前逻辑把这个有效旧 target 当作
checksum mismatch quarantine，而不是识别为 abandoned pending commit 并回滚
meta 或 `stop_until_fixed` 而不隔离有效 target。

建议修复：

- 将 checksum meta 建模为 generation/commit protocol：`pending` meta 不得使
  旧 target/旧 checksum 被隔离。
- 恢复逻辑必须区分 target-old/checksum-old/pending-meta、
  target-new/checksum-old、target-new/checksum-missing、checksum partial、
  meta partial 与 parent fsync uncertain。
- 对无法证明同一提交的窗口输出 `stop_until_fixed` 诊断，但不得移动或删除仍
  与 checksum 一致的有效 target。
- 补充对应 fault injection tests。

### I07_rename_enoent_classification：FAIL

rename ENOENT 已稳定分类为 local state integrity 和 stop-until-fixed，但
renameCause 仍是单一通用原因，未满足固定原因矩阵。

证据：

- 共享 store ENOENT 分类为 `durable_temp_rename_enoent`，但固定
  `renameCause: "filesystem_or_external_mutation"`：
  `src/job-state/durable-state-store.ts:890`、
  `src/job-state/durable-state-store.ts:908`、
  `src/job-state/durable-state-store.ts:918`、
  `src/job-state/durable-state-store.ts:936`。
- runner ENOENT 分类同样固定为
  `filesystem_or_external_mutation`：
  `scripts/graphrag/batch-epub-workflow.mjs:3498`、
  `scripts/graphrag/batch-epub-workflow.mjs:3516`。
- failure classifier 只能从文本识别 durable rename ENOENT：
  `scripts/graphrag/batch-failure-classifier.mjs:83`。
- rename ENOENT checkpoint/event/recovery summary 测试已覆盖 stop-until-fixed
  与字段投影，但未覆盖 renameCause 分类矩阵：
  `test/cli.test.ts:2961`。

影响：item checkpoint、event、status-json/recovery summary 能表达
`localFailureClass`、`tempId`、`operationId`、`failedSyscall`、`errno`，但不能
区分 temp collision、cleanup 误删、并发接管、generation 更新、底层文件系统
或外部修改。

建议修复：

- 在 rename ENOENT 处理处读取 temp owner sidecar、target current generation、
  per-target lock owner、cleanup event 与 checksum/meta 状态，生成可枚举
  `renameCause`。
- 对每个原因补充 checkpoint、event、recovery summary 断言。

### I08_status_event_schema_observability：FAIL

状态与事件观测字段明显增强，但 contracts、runner event、checkpoint、
manifest/status-json 和 recovery summary 仍未完整表达固定基准要求的诊断字段。

证据：

- contract 的 command check、checkpoint、event、recovery summary 已包含
  lane、targetLocator、tempId、operationId、localFailureClass、retryable、
  recoveryDecision、renameCause、lockOwnerEvidence、checksumRecoveryDecision：
  `src/contracts/batch-run.ts:134`、
  `src/contracts/batch-run.ts:174`、
  `src/contracts/batch-run.ts:327`、
  `src/contracts/batch-run.ts:369`。
- runner schema 也包含这些 durable 字段：
  `scripts/graphrag/batch-epub-workflow.mjs:441`、
  `scripts/graphrag/batch-epub-workflow.mjs:607`、
  `scripts/graphrag/batch-epub-workflow.mjs:758`、
  `scripts/graphrag/batch-epub-workflow.mjs:805`。
- `durableProjection` 会投影 lane、owner、timeout、releaseOn、tempId、
  operationId、renameCause 与 checksumRecoveryDecision：
  `scripts/graphrag/batch-epub-workflow.mjs:2257`。
- event schema 没有 top-level `workerId`；部分事件仅在 metadata 中携带：
  `scripts/graphrag/batch-epub-workflow.mjs:758`。
- `src/contracts` 的 `BatchRecoverySummaryItemSchema` 没有 `workerId` 字段，
  而 runner 内部 schema 有 `workerId`，contract 与实现不一致：
  `src/contracts/batch-run.ts:369`、
  `scripts/graphrag/batch-epub-workflow.mjs:805`。
- manifest schema 不携带 durable write failure 诊断字段：
  `src/contracts/batch-run.ts:291`。
- redaction 已用于 messages/metadata：
  `scripts/graphrag/batch-epub-workflow.mjs:3280`、
  `scripts/graphrag/batch-epub-workflow.mjs:3287`。

影响：status-json/recovery summary 和 event 对多数 durable fields 可观测，
但 workerId、manifest/status 表达、contract 一致性和 qmd index lock 的完整
targetMapping evidence 仍不足。

建议修复：

- 统一 runner schema 与 `src/contracts/batch-run.ts`，将 `workerId` 和必要
  durable owner/lease fields 加入 recovery summary contract。
- event schema 增加 top-level `workerId` 或明确将 metadata workerId 纳入
  contract，并在所有 durable failure event 中稳定输出。
- manifest 或 status-json 必须能表达 durable write failure 的 lane、owner、
  lock owner evidence、checksum recovery decision 和 redacted evidence。

### I09_direct_call_chain_coverage：FAIL

直接调用链已有明显收敛，但 batch runner 仍保留私有 durable write chain，且
部分路径未明确排除在生产 runner durable target 之外。

证据：

- repository YAML 写入调用共享 durable store：
  `src/job-state/repository.ts:400`。
- capability catalog 调用共享 durable YAML update：
  `src/graphrag/capability-catalog.ts:342`、
  `src/graphrag/capability-catalog.ts:350`。
- durable-json 委托共享 durable store：
  `src/job-state/durable-json.ts:1`。
- settings projection 调用共享 durable store：
  `src/graphrag/settings-projection.ts:263`。
- python bridge subprocess registry 调用共享 durable JSON：
  `src/integrations/python-bridge.ts:155`。
- DSPy policy store 已使用共享 durable YAML/JSON/opaque 写入：
  `src/dspy/policy-store.ts:195`、
  `src/dspy/policy-store.ts:200`、
  `src/dspy/policy-store.ts:632`、
  `src/dspy/policy-store.ts:1211`、
  `src/dspy/policy-store.ts:1327`。
- batch runner 仍保留私有 JSON/JSONL durable replace、lock 与 reconcile：
  `scripts/graphrag/batch-epub-workflow.mjs:3561`、
  `scripts/graphrag/batch-epub-workflow.mjs:3622`、
  `scripts/graphrag/batch-epub-workflow.mjs:3902`、
  `scripts/graphrag/batch-epub-workflow.mjs:4184`。
- manifest invalid quarantine 使用直接 rename/fsync，不通过共享 durable
  quarantine 语义：
  `scripts/graphrag/batch-epub-workflow.mjs:4833`、
  `scripts/graphrag/batch-epub-workflow.mjs:4841`。

影响：repository、catalog、settings、python bridge、DSPy 的主链路已基本
进入共享 store，但当前生产并行 runner 覆盖的 manifest、checkpoint、event、
provider slot、subprocess registry 与 book lease 仍存在私有语义，I09 不能
通过。

建议修复：

- batch runner 生产 YAML/JSON/JSONL 写入统一接入共享 durable adapter。
- 对不属于本 runner targetMapping 的日志、raw report、artifact 写入建立
  明确排除清单，避免被误判为 durable state target。
- manifest invalid quarantine 纳入共享 quarantine/recovery 语义或声明为
  非 durable replace 并补充 recovery contract。

### I10_fault_injection_tests：FAIL

测试覆盖显著增强，但未覆盖固定基准要求的完整故障注入矩阵。

已覆盖证据：

- 同毫秒 temp 抗碰撞：
  `test/book-job-state.test.ts:420`。
- durable JSON checksum target-new/checksum-old 与 corrupt quarantine 部分路径：
  `test/book-job-state.test.ts:459`。
- stale temp with/without owner evidence：
  `test/cli.test.ts:2718`、
  `test/cli.test.ts:2803`、
  `test/book-job-state.test.ts:551`。
- auxiliary JSON sidecar filter：
  `test/cli.test.ts:2875`。
- durable JSON lock timeout with owner evidence：
  `test/cli.test.ts:2609`。
- rename ENOENT checkpoint/event/recovery summary：
  `test/cli.test.ts:2961`。
- book concurrency worker pool：
  `test/cli.test.ts:3096`。
- durable provider slot capacity gate 与 stale release fence：
  `test/cli.test.ts:3739`、
  `test/cli.test.ts:3781`。
- qmd index file lock：
  `test/cli.test.ts:4262`。
- parallel non-transient failure quiesce：
  `test/cli.test.ts:3803`。

缺口：

- 未发现 forced temp create collision 的 EEXIST 注入测试：
  `test/cli.test.ts`、`test/book-job-state.test.ts` 中无对应强制碰撞断言。
- 未覆盖 active writer temp 被 cleanup 误删后的
  `durable_live_temp_deleted` 或等价 stop-until-fixed 路径。
- 未覆盖 checksum crash window 全矩阵，尤其是
  target-old/checksum-old/pending-meta、partial meta、partial checksum 和
  parent fsync uncertainty。
- rename ENOENT 测试只覆盖通用 stop-until-fixed，不覆盖 renameCause 原因矩阵。
- restart recovery 主要覆盖 subprocess orphan，不覆盖 durable write failure
  后重启闭环：
  `test/cli.test.ts:3955`、
  `test/cli.test.ts:4150`。

建议修复：

- 增加 deterministic fault injection hooks：forced temp EEXIST、rename temp
  removal by cleanup、checksum/meta partial write、parent fsync failure、
  stale lock timeout 和 process restart。
- 每个测试必须断言 event、checkpoint、status-json/recovery summary 与目标
  文件状态，证明不会丢失已提交状态，也不会把未提交状态标记为 completed。

## R2 失败项复核

- durable state boundary：仍 FAIL。共享 store 增强，但 runner 私有边界仍在。
- target mapping/lane/owner/timeout/releaseOn：仍 FAIL。字段增加，但未形成
  固定 targetMapping runtime enforcement，timeout 也不匹配设计默认值。
- temp owner evidence：仍 FAIL。runner 缺 leaseGeneration/fencingTokenHash。
- cleanup safety：仍 FAIL。runner 优于 R2，但共享 store 仍缺事件化、
  generation 检查和 remote owner 保护。
- JSON lock owner/fencing/heartbeat/expiry：部分修复。runner lock 已有 owner、
  generation、fencingTokenHash、expiresAt 和 timeout evidence；但这不足以
  覆盖 I01/I02/I05。
- atomic replace/fsync/checksum crash window：仍 FAIL。`target_rename_pending`
  meta 可导致旧有效 target 被 quarantine。
- rename ENOENT 分类：仍 FAIL。stop-until-fixed 已覆盖，原因矩阵缺失。
- preflight/recovery stop_until_fixed：部分修复。durable errors 投影到
  checkpoint/event/recovery summary，但真实 runner 恢复仍受上述阻塞项约束。
- fault injection tests：仍 FAIL。新增测试有效，但矩阵不完整。
- event/checkpoint/status/recovery observability：仍 FAIL。字段增加，但
  contract/runner 不一致，workerId 与 manifest/status 表达仍不足。

## 剩余风险

1. 有效旧 target 可能因 pending checksum meta 被误 quarantine，导致已提交
   状态丢失或需要人工修复。
2. runner 私有 durable 边界与共享 store 漂移，后续修复可能只覆盖其中一侧。
3. remote owner 或 generation 已推进的 temp cleanup 仍有误删风险。
4. qmd index writer lane 无统一 targetMapping timeout/fencing 证据，真实并行
   runner 下仍可能出现不可诊断的 lock starvation 或 stale lock。
5. rename ENOENT 不能给出具体 cause，运维无法区分代码 bug、外部修改、
   cleanup 误删和并发接管。
6. fault injection 未覆盖所有 crash windows，当前已通过测试不能证明生产
   runner 可恢复。

## 阻塞项与建议修复

1. 统一 durable boundary。
   将 runner 私有 JSON/JSONL replace、reconcile、lock、checksum recovery
   和 temp cleanup 改为共享 store adapter，或抽出等价 adapter 并用测试锁定
   等价语义。

2. 固化 targetMapping runtime contract。
   所有生产 durable target 必须查表确认 lane、owner、durableKind、
   laneTimeoutMs、releaseOn；未映射目标拒绝写入。qmd index lane、provider
   slot、book lease、manifest/status、event 和 checkpoint 都要输出同一
   evidence。

3. 修复 checksum commit protocol。
   pending meta 不能污染旧有效提交；引入 generation/commit token，并覆盖
   target-old/checksum-old/pending-meta、target-new/checksum-old、
   target-new/checksum-missing、partial checksum、partial meta 和 parent fsync
   uncertain 的恢复路径。

4. 补齐 owner evidence 与 cleanup safety。
   runner owner sidecar 写入 leaseGeneration、fencingTokenHash、expiresAt 和
   target generation。cleanup 必须同时检查 stale age、owner/lease、target
   generation 与 per-target lock，并事件化所有删除。

5. 完成 rename ENOENT cause matrix。
   通过 owner sidecar、cleanup history、target generation、lock owner 和
   checksum/meta 状态区分 temp collision、cleanup deletion、concurrent takeover、
   generation advanced、filesystem/external mutation。

6. 补齐 observability contract。
   统一 `src/contracts/batch-run.ts` 与 runner 内部 schema，增加缺失 workerId
   和 durable owner/lease fields，确保 event/checkpoint/status-json/recovery
   summary 经过 redaction 后完整表达 durable failure。

7. 补齐 fault injection tests。
   增加 forced EEXIST、live temp deletion、checksum/meta partial、parent fsync
   uncertainty、renameCause matrix、lock timeout owner evidence 和 restart
   recovery 闭环断言。

## 验证记录

用户提供的本轮已通过验证结果已纳入审计判断，包括：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `node --check scripts/graphrag/batch-failure-classifier.mjs`
- `npm run test:types`
- focused `test/cli.test.ts` durable classifier、JSON lock timeout、temp
  reconcile、auxiliary JSON filter、rename ENOENT checkpoint failure。
- focused `test/book-job-state.test.ts` collision-resistant YAML temp、
  durable JSON checksum quarantine、stale temp owner evidence、LanceDB
  row-count durable checksums。
- slow CLI tests sequentially passed：book concurrency worker pool、
  durable provider slots gate、qmd index file lock、terminal finalization fence、
  provider slot stale release、parallel non-transient failure quiesce。

这些验证结果证明 R3 已修复多项 R2 局部缺口，但不足以满足 10 条固定基准的
完整通过条件。
