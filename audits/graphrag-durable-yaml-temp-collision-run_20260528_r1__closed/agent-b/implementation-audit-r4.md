# GraphRAG Durable YAML Temp Collision 实施审计 R4

## Overall

Overall: FAIL。

固定基准判定：2 PASS，8 FAIL。R4 当前实现相较 R3 已实质补强
runner owner evidence 的 generation/fencing 字段、guarded lock release、
`before_claim`/`before_resume_book` preflight、event/recovery schema 的
`workerId`，并修复了 pending checksum meta 指向新 checksum、旧 target
仍有效时被错误 quarantine 的主要窗口。但固定 criteria 要求完整 durable
boundary 收敛、显式 targetMapping runtime contract、全目标 owner evidence、
cleanup target-generation fence、rename ENOENT cause matrix、manifest/status
观测闭环和完整 fault injection 矩阵。当前实现仍未满足这些条件。

审计方式：静态实现审计（static implementation audit），并纳入用户提供的
本轮已通过验证结果。未启动真实 EPUB runner，未处理真实 runId
`epub-batch-20260527-real-resume-1`，未读取或打印 `.env`，未修改 criteria。

## Criteria Checklist

### I01_single_durable_boundary：FAIL

生产 durable 写入仍存在共享 store 与 runner 私有 helper 两套边界，未统一
到同一 `durableStateStore`，也没有显式等价 adapter contract。

证据：

- 共享 store 提供 YAML/JSON durable 读写、reconcile、lock 与 checksum：
  `src/job-state/durable-state-store.ts:136`、
  `src/job-state/durable-state-store.ts:188`、
  `src/job-state/durable-state-store.ts:236`。
- runner 仍保留私有 `writeFileDurable`、`writeJsonAtomicSidecar`、
  `writeJsonAtomic`、`writeJsonlAtomic`：
  `scripts/graphrag/batch-epub-workflow.mjs:2570`、
  `scripts/graphrag/batch-epub-workflow.mjs:3586`、
  `scripts/graphrag/batch-epub-workflow.mjs:3694`、
  `scripts/graphrag/batch-epub-workflow.mjs:3755`。
- runner 私有 event append、JSON/YAML reconcile 与 JSON lock 仍独立实现：
  `scripts/graphrag/batch-epub-workflow.mjs:3429`、
  `scripts/graphrag/batch-epub-workflow.mjs:4163`、
  `scripts/graphrag/batch-epub-workflow.mjs:4267`、
  `scripts/graphrag/batch-epub-workflow.mjs:4496`。

### I02_target_mapping_enforcement：FAIL

实现仍通过路径推断 lane/owner，而不是执行设计文档中的唯一 targetMapping
表；生产 timeout 也不匹配设计默认值。

证据：

- 设计要求每个生产目标追溯到唯一 lane、owner、durableKind、
  laneTimeoutMs、releaseOn：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`、
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241`。
- 设计 targetMapping 默认 `laneTimeoutMs: 120000`：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:246`。
- runner 和共享 store 均使用推断函数，而非固定表校验：
  `scripts/graphrag/batch-epub-workflow.mjs:2257`、
  `scripts/graphrag/batch-epub-workflow.mjs:2268`、
  `src/job-state/durable-state-store.ts:1389`、
  `src/job-state/durable-state-store.ts:1410`。
- runner JSON lock、provider slot、qmd index lock 使用至少 300000 ms：
  `scripts/graphrag/batch-epub-workflow.mjs:181`、
  `scripts/graphrag/batch-epub-workflow.mjs:192`、
  `scripts/graphrag/batch-epub-workflow.mjs:194`。
- qmd index lock owner/event 未写入 lane、durableKind、laneTimeoutMs、
  releaseOn、fencingTokenHash：
  `scripts/graphrag/batch-epub-workflow.mjs:2936`、
  `scripts/graphrag/batch-epub-workflow.mjs:2945`、
  `scripts/graphrag/batch-epub-workflow.mjs:2957`。

### I03_temp_identity_exclusive_create：PASS

durable temp 名称包含 UUID 等价熵源，并以 exclusive create 写入；EEXIST
会被分类为 local state integrity。

证据：

- 共享 store tempId 包含 `randomUUID()`，主 temp 和 checksum temp 使用该
  tempId：
  `src/job-state/durable-state-store.ts:1279`、
  `src/job-state/durable-state-store.ts:263`、
  `src/job-state/durable-state-store.ts:266`。
- 共享 store 和 runner temp 写入均使用 `wx`：
  `src/job-state/durable-state-store.ts:272`、
  `src/job-state/durable-state-store.ts:288`、
  `scripts/graphrag/batch-epub-workflow.mjs:3707`、
  `scripts/graphrag/batch-epub-workflow.mjs:3727`。
- runner tempId 包含 pid、Date.now 与 UUID：
  `scripts/graphrag/batch-epub-workflow.mjs:2171`。
- EEXIST 分类为 `durable_temp_create_collision`：
  `src/job-state/durable-state-store.ts:1123`、
  `scripts/graphrag/batch-epub-workflow.mjs:3676`。
- 同毫秒并发 YAML 写入测试覆盖：
  `test/book-job-state.test.ts:420`。

### I04_temp_owner_evidence：FAIL

R4 已补强 `durableOperationEvidence` 的 generation/fencing 字段，但并非每个
runner 生产 temp owner sidecar 都携带适用的 item/book/worker scope 与目标
lease/fencing evidence。

证据：

- runner `durableOperationEvidence` 可写入 leaseGeneration、bookLeaseGeneration、
  targetGeneration、fencingTokenHash：
  `scripts/graphrag/batch-epub-workflow.mjs:2171`、
  `scripts/graphrag/batch-epub-workflow.mjs:2176`、
  `scripts/graphrag/batch-epub-workflow.mjs:2206`。
- 子进程环境携带 book/item lease 与 fencing token：
  `scripts/graphrag/batch-epub-workflow.mjs:7897`、
  `scripts/graphrag/batch-epub-workflow.mjs:7900`。
- item checkpoint、typed JSON 写入通过 `withDurableOperationContext` 从值投影
  owner scope：
  `scripts/graphrag/batch-epub-workflow.mjs:4648`、
  `scripts/graphrag/batch-epub-workflow.mjs:4652`。
- 但 book lease、provider slot、coordinator lock 初始写入直接调用
  `writeJsonAtomic`，没有从即将写入的 lease 值建立 durable operation context：
  `scripts/graphrag/batch-epub-workflow.mjs:2814`、
  `scripts/graphrag/batch-epub-workflow.mjs:3151`、
  `scripts/graphrag/batch-epub-workflow.mjs:4918`。
- 共享 store owner evidence 依赖环境变量获取 book lease/fencing；没有
  targetGeneration，也没有可事件化的 cleaner summary：
  `src/job-state/durable-state-store.ts:1279`、
  `src/job-state/durable-state-store.ts:1300`。

### I05_inflight_cleanup_safety：FAIL

cleanup 已检查 stale age、owner evidence、owner alive 与 remote owner，但没有
同时检查 target generation 未推进；共享 store cleanup 也不事件化删除。

证据：

- runner cleanup decision 检查 stale age、target match、owner generation/fence、
  owner alive 与 remote owner：
  `scripts/graphrag/batch-epub-workflow.mjs:3828`、
  `scripts/graphrag/batch-epub-workflow.mjs:3847`、
  `scripts/graphrag/batch-epub-workflow.mjs:3871`、
  `scripts/graphrag/batch-epub-workflow.mjs:3883`、
  `scripts/graphrag/batch-epub-workflow.mjs:3891`。
- runner reconcile 在 per-target JSON lock 下删除并事件化 stale temp：
  `scripts/graphrag/batch-epub-workflow.mjs:4163`、
  `scripts/graphrag/batch-epub-workflow.mjs:4174`、
  `scripts/graphrag/batch-epub-workflow.mjs:4182`。
- cleanup decision 未比较 target 当前 generation/checksum 是否已推进：
  `scripts/graphrag/batch-epub-workflow.mjs:3828`。
- 共享 store cleanup 只检查 owner target、createdAt、cleanup fence、stale age、
  owner alive；删除时无 event/recovery summary：
  `src/job-state/durable-state-store.ts:651`、
  `src/job-state/durable-state-store.ts:668`、
  `src/job-state/durable-state-store.ts:675`、
  `src/job-state/durable-state-store.ts:683`、
  `src/job-state/durable-state-store.ts:707`。

### I06_atomic_commit_and_checksum_recovery：FAIL

R4 修复了 R3 指出的 target-old/checksum-old/pending-meta 误 quarantine
主窗口，但 checksum commit protocol 仍未完整收敛到 committed/generation
状态，也缺少全窗口测试证据。

证据：

- 写入仍在 target rename 前发布 `target_rename_pending` meta：
  `src/job-state/durable-state-store.ts:273`、
  `scripts/graphrag/batch-epub-workflow.mjs:3712`。
- R4 新增 pending meta 与当前 target checksum 不一致时回填旧有效 checksum，
  避免 R3 的误 quarantine：
  `src/job-state/durable-state-store.ts:391`、
  `src/job-state/durable-state-store.ts:396`、
  `scripts/graphrag/batch-epub-workflow.mjs:4233`、
  `scripts/graphrag/batch-epub-workflow.mjs:4337`。
- target-new/checksum-old 由 commit evidence 回填：
  `src/job-state/durable-state-store.ts:409`、
  `scripts/graphrag/batch-epub-workflow.mjs:4211`。
- target-new/checksum-missing 由 backfill 处理：
  `src/job-state/durable-state-store.ts:386`、
  `scripts/graphrag/batch-epub-workflow.mjs:4226`。
- 但当 target 与 checksum 均为新值、meta 仍为 pending 且 checksum 相同，
  reconcile 不会把 meta 收敛为 committed；逻辑直接返回：
  `src/job-state/durable-state-store.ts:391`、
  `src/job-state/durable-state-store.ts:396`、
  `src/job-state/durable-state-store.ts:400`、
  `scripts/graphrag/batch-epub-workflow.mjs:4233`、
  `scripts/graphrag/batch-epub-workflow.mjs:4240`。
- parent directory fsync uncertain 只分类为 stop-until-fixed，缺少 crash-window
  recovery 闭环测试：
  `src/job-state/durable-state-store.ts:1044`、
  `scripts/graphrag/batch-epub-workflow.mjs:2522`。

### I07_rename_enoent_classification：FAIL

rename ENOENT 已稳定分类为 `local_state_integrity`、retryable=false、
`stop_until_fixed`，但 `renameCause` 仍是单一通用值，未区分固定原因矩阵。

证据：

- 共享 store ENOENT 分类固定为
  `renameCause: "filesystem_or_external_mutation"`：
  `src/job-state/durable-state-store.ts:924`、
  `src/job-state/durable-state-store.ts:942`、
  `src/job-state/durable-state-store.ts:952`、
  `src/job-state/durable-state-store.ts:970`。
- runner ENOENT 分类同样固定为该通用原因：
  `scripts/graphrag/batch-epub-workflow.mjs:3631`、
  `scripts/graphrag/batch-epub-workflow.mjs:3649`。
- 测试覆盖 stop-until-fixed 字段投影，但未断言 cause matrix：
  `test/cli.test.ts:2963`、
  `test/cli.test.ts:3050`、
  `test/cli.test.ts:3065`。

### I08_status_event_schema_observability：FAIL

event、checkpoint、command check 和 recovery summary schema 已显著增强，但
manifest/status 仍不能完整表达 durable write failure 所需诊断字段；固定
criteria 要求的观测面尚未全部对齐。

证据：

- contract command check、checkpoint、event、recovery summary item 已包含
  lane、targetLocator、tempId、operationId、workerId、leaseGeneration、
  targetGeneration、fencingTokenHash 等字段：
  `src/contracts/batch-run.ts:134`、
  `src/contracts/batch-run.ts:214`、
  `src/contracts/batch-run.ts:347`、
  `src/contracts/batch-run.ts:399`。
- runner event schema 也包含 top-level `workerId` 与 durable fields：
  `scripts/graphrag/batch-epub-workflow.mjs:779`、
  `scripts/graphrag/batch-epub-workflow.mjs:815`。
- runner recovery summary 从 checkpoint/failed command 投影 durable fields：
  `scripts/graphrag/batch-epub-workflow.mjs:7266`、
  `scripts/graphrag/batch-epub-workflow.mjs:7296`。
- manifest schema 仍仅包含 counts、locators、active slot/subprocess/book lease
  统计和 metadata，没有 durable failure 诊断字段：
  `src/contracts/batch-run.ts:311`、
  `src/contracts/batch-run.ts:336`、
  `src/contracts/batch-run.ts:344`。
- runner 没有单独 durable `status.json` 目标；status-json 输出 recovery
  summary：
  `scripts/graphrag/batch-epub-workflow.mjs:249`、
  `scripts/graphrag/batch-epub-workflow.mjs:7413`。
- event 写入前对 message/metadata 做 redaction：
  `scripts/graphrag/batch-epub-workflow.mjs:2102`、
  `scripts/graphrag/batch-epub-workflow.mjs:3406`。

### I09_direct_call_chain_coverage：FAIL

repository、catalog、settings、python bridge、DSPy 等链路已收敛到共享 store，
但 batch runner 生产 JSON/JSONL durable 写入仍保留私有语义。

证据：

- repository、capability catalog、durable-json、settings projection、python
  bridge、DSPy 已调用共享 durable store：
  `src/job-state/repository.ts:400`、
  `src/graphrag/capability-catalog.ts:342`、
  `src/job-state/durable-json.ts:1`、
  `src/graphrag/settings-projection.ts:263`、
  `src/integrations/python-bridge.ts:155`、
  `src/dspy/policy-store.ts:195`。
- runner book lease、provider slot、event log、coordinator lock、heartbeat、
  manifest migration、event migration 等仍调用私有 writer：
  `scripts/graphrag/batch-epub-workflow.mjs:2814`、
  `scripts/graphrag/batch-epub-workflow.mjs:3151`、
  `scripts/graphrag/batch-epub-workflow.mjs:3431`、
  `scripts/graphrag/batch-epub-workflow.mjs:4918`、
  `scripts/graphrag/batch-epub-workflow.mjs:5586`、
  `scripts/graphrag/batch-epub-workflow.mjs:6478`、
  `scripts/graphrag/batch-epub-workflow.mjs:7598`。

### I10_fault_injection_tests：FAIL

测试覆盖比 R3 更强，但未覆盖固定基准要求的完整故障注入矩阵。

已覆盖证据：

- 同毫秒 temp 抗碰撞：
  `test/book-job-state.test.ts:420`。
- target-new/checksum-old 与 checksum mismatch quarantine：
  `test/book-job-state.test.ts:459`。
- stale temp cleanup、fresh temp 保留、owner evidence 缺失时保留：
  `test/cli.test.ts:2718`、
  `test/cli.test.ts:2805`、
  `test/book-job-state.test.ts:551`。
- JSON lock timeout owner evidence：
  `test/cli.test.ts:2609`。
- rename ENOENT stop-until-fixed：
  `test/cli.test.ts:2963`。
- provider slot durable gate 与 release fencing：
  `test/cli.test.ts:3741`、
  `test/cli.test.ts:3783`。
- qmd index file lock：
  `test/cli.test.ts:4264`。

缺口：

- 未发现 forced temp EEXIST 注入测试；`durable_temp_create_collision` 仅有分类
  代码证据。
- 未发现 `before_claim` 或 `before_resume_book` preflight blocker 的测试断言。
- 未覆盖 target-old/checksum-old/pending-meta、
  target-new/checksum-new/meta-pending、partial checksum、partial meta、
  parent fsync uncertainty。
- rename ENOENT 测试未覆盖 temp collision、cleanup deletion、concurrent
  takeover、generation advanced、filesystem/external mutation 的原因矩阵。
- restart recovery 主要覆盖 subprocess/orphan，未覆盖 durable write failure
  后重启闭环。

## Findings

### Critical：生产 durable boundary 未统一

可执行问题：将 runner 的 JSON/JSONL replace、event append、reconcile、lock、
checksum recovery 和 temp cleanup 移到共享 durable store adapter；或抽出
显式等价 adapter，并用 contract tests 锁定 temp identity、owner evidence、
checksum recovery、quarantine、fsync、lock timeout 和 ENOENT classification。

### Critical：targetMapping runtime contract 未落地

可执行问题：从设计 targetMapping 生成代码常量或手写固定表。所有 catalog、
book-scoped YAML、item checkpoint、manifest、status、run lock、provider slot、
subprocess registry、book lease、settings、qmd index 写入必须查表；未映射
目标拒绝写入。生产 timeout 需与设计 120000 ms 对齐，或先更新设计并重新固定
criteria。

### High：部分 runner temp owner evidence 仍缺目标 lease scope

可执行问题：book lease、provider slot、coordinator lock 等直接 `writeJsonAtomic`
调用必须包裹 `withDurableOperationContext(durableContextFromValue(value))` 或等价
上下文，确保 owner sidecar 持久化 worker/coordinator id、item/book scope、
leaseGeneration、bookLeaseGeneration、targetGeneration、fencingTokenHash、
expiresAt。

### High：cleanup 缺 target-generation fence

可执行问题：owner sidecar 写入 target generation/checksum snapshot；cleanup
在 per-target lock 下比较当前 target generation/checksum 与 owner snapshot。
共享 store stale temp 删除必须事件化或写入 recovery summary，包含 tempId、
operationId、owner、staleAgeMs、cleanupReason。

### High：checksum commit protocol 仍不完整

可执行问题：引入明确 generation/commit token。reconcile 必须把
target-new/checksum-new/meta-pending 收敛为 committed meta，并覆盖 partial
checksum、partial meta、parent fsync uncertain 的 stop-until-fixed 或 repair
路径，避免 pending 状态永久残留。

### Medium：rename ENOENT cause matrix 缺失

可执行问题：rename ENOENT 处理需要读取 temp owner sidecar、target current
generation、cleanup history、lock owner、checksum/meta 状态，输出枚举化
renameCause：temp_collision、cleanup_deleted_live_temp、concurrent_takeover、
generation_advanced、filesystem_or_external_mutation。

### Medium：manifest/status 观测面未完整对齐

可执行问题：明确 `manifest.json` 是否允许只做派生缓存。若固定 criteria 保持
manifest/status 观测要求，则 manifest 或 status-json contract 需包含 durable
failure summary、lock owner evidence、checksum recovery decision 和 redacted
evidence locator。

### Medium：fault injection 矩阵不完整

可执行问题：增加 deterministic hooks 和测试：forced EEXIST、preflight live
temp/live lock、active writer temp 被 cleanup 删除、pending-meta crash windows、
partial checksum/meta、parent fsync failure、renameCause matrix、durable write
failure 后重启恢复。

## R3 FAIL 点复核

- runner 与 shared durable store 统一性：未关闭。runner 私有边界仍在。
- owner generation/fencing 证据：部分关闭。通用 operation evidence 已补强，
  但 book lease/provider slot/coordinator 初始写入未从目标 lease 值投影。
- guarded lock release：已关闭主要实现点。JSON lock、provider slot、
  book lease、coordinator release 均检查 generation/fencing 后释放。
- pending checksum meta crash window：部分关闭。旧 target/旧 checksum/pending
  meta 不再误 quarantine；meta-pending-same-checksum 与全窗口测试仍缺。
- `before_claim`/`before_resume_book` preflight：实现已加入，但缺测试覆盖。
- observability/schema 对齐：部分关闭。workerId 和多数 durable fields 已加入；
  manifest/status 观测面仍不足。
- fault injection 覆盖：未关闭。覆盖面仍未达到固定矩阵。

## Evidence

读取的关键文件：

- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-criteria.yaml`
- `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-audit-r3.md`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `src/job-state/durable-state-store.ts`
- `test/cli.test.ts`
- `test/book-job-state.test.ts`
- `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- `src/job-state/repository.ts`
- `src/graphrag/capability-catalog.ts`
- `src/job-state/durable-json.ts`
- `src/graphrag/settings-projection.ts`
- `src/integrations/python-bridge.ts`
- `src/dspy/policy-store.ts`

验证依据：

- 用户提供本轮已通过：`node --check scripts/graphrag/batch-epub-workflow.mjs`
- 用户提供本轮已通过：`node --check scripts/graphrag/batch-failure-classifier.mjs`
- 用户提供本轮已通过：`npm run test:types`
- 用户提供本轮已通过：CLI durable 聚焦组 6 passed
- 用户提供本轮已通过：book-state durable 聚焦组 4 passed
- 用户提供本轮已通过：book-concurrency 2、durable provider slots、
  all batch qmd commands lock、terminal completion fence、parallel
  non-transient failure/provider slot stale release 慢测 passed

审计结论不否定上述验证结果；这些结果证明 R4 修复了多个 R3 局部缺口，但
不足以证明 10 条固定 criteria 全部满足。
