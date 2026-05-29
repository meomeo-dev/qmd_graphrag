Status: FAIL

# GraphRAG Durable YAML Temp Collision 实施审计 R7

## 总体结论

固定基准判定：3 PASS，7 FAIL。

R7 实现继续保留多项有效修复：temp identity 已包含随机 UUID 或等价熵源，
exclusive create 已覆盖主写入路径，checksum crash window 已有 durable meta
与恢复测试，CLI fault-injection 覆盖面也明显扩大。

但固定 10 条 criteria 尚未闭合。当前生产路径仍存在非强制 targetMapping、
runner 私有 durable helper 与 shared store 语义不完全一致、部分 raw
`writeJsonAtomic()` 调用缺少目标值 owner evidence、shared store stale temp
cleanup 删除未事件化、rename ENOENT cause matrix 不完整，以及
manifest/status-json 观测面不足。因此本轮 implementation audit 判定 FAIL。

本轮为只读审计。未修改 criteria，未修改生产代码，未启动真实 EPUB runner。
用户提供的本地验证结果作为背景输入；本报告仍以代码与测试覆盖证据为准。

## Blocking Findings

### 1. targetMapping 仍允许 fallback，且 events.jsonl 未按 eventWriterLane 映射

固定 criteria I02 要求每个生产目标匹配唯一 lane、owner、durableKind、
laneTimeoutMs 和 releaseOn。设计也明确禁止未列入 targetMapping 的 durable
YAML/JSON/SQLite 目标由并行 runner 写入。

证据：

- 设计禁止未列入 targetMapping 的 durable 目标写入：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`。
- 设计声明 `eventWriterLane` 保护 `events.jsonl`：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:202`。
- runner targetMapping 表未列出 `events.jsonl`：
  `scripts/graphrag/batch-epub-workflow.mjs:238`。
- event 写入使用 `eventsPath`，并经 `withJsonFileLock()` append：
  `scripts/graphrag/batch-epub-workflow.mjs:390`、
  `scripts/graphrag/batch-epub-workflow.mjs:3736`。
- runner `durableTargetMapping()` 允许 `targetMappingRule: "fallback"`：
  `scripts/graphrag/batch-epub-workflow.mjs:2428`。
- fallback 中 `/catalog/batch-runs/` 会推断为 `manifestWriterLane`，不是
  `eventWriterLane`：
  `scripts/graphrag/batch-epub-workflow.mjs:2450`。
- shared store 同样允许 fallback，并允许环境变量覆盖 owner/lane：
  `src/job-state/durable-state-store.ts:1741`、
  `src/job-state/durable-state-store.ts:1750`。

阻塞影响：未映射或误映射的生产 durable target 仍可写入，不能证明所有目标
满足唯一 targetMapping 与 release-on-error 诊断要求。

### 2. runner 私有 durable adapter 与 shared store 仍非完全等价边界

I01 要求生产路径的 durable replace、checksum backfill、temp cleanup、
quarantine 和 lock recovery 通过共享 `durableStateStore` 或声明等价 adapter，
且每个写入点能追溯到相同语义。

证据：

- runner 声明等价 adapter：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。
- shared store 有独立 durable replace、lock、cleanup 和 ENOENT 分类：
  `src/job-state/durable-state-store.ts:385`、
  `src/job-state/durable-state-store.ts:650`、
  `src/job-state/durable-state-store.ts:889`、
  `src/job-state/durable-state-store.ts:1194`。
- runner 保留私有 JSON replace、JSONL replace、lock、cleanup 与 ENOENT 分类：
  `scripts/graphrag/batch-epub-workflow.mjs:4036`、
  `scripts/graphrag/batch-epub-workflow.mjs:4101`、
  `scripts/graphrag/batch-epub-workflow.mjs:5090`、
  `scripts/graphrag/batch-epub-workflow.mjs:4638`、
  `scripts/graphrag/batch-epub-workflow.mjs:3956`。
- shared store cleanup 删除没有 runner event/status/recovery projection：
  `src/job-state/durable-state-store.ts:918`。
- shared store 与 runner ENOENT cause matrix 都是粗粒度分支：
  `src/job-state/durable-state-store.ts:1250`、
  `scripts/graphrag/batch-epub-workflow.mjs:3985`。

阻塞影响：adapter 虽声明等价，但在 targetMapping、cleanup observability 和
rename cause 分类上仍不可证明等价。

### 3. 部分 raw writeJsonAtomic 调用缺目标值 owner evidence

I04 要求 temp owner evidence 可恢复读取，并包含适用的 worker/coordinator、
item/book scope、leaseGeneration、fencingTokenHash 等字段。

证据：

- runner `durableOperationEvidence()` 可生成完整 owner evidence：
  `scripts/graphrag/batch-epub-workflow.mjs:2320`。
- typed helper 会从写入值投影 durable context：
  `scripts/graphrag/batch-epub-workflow.mjs:5264`、
  `scripts/graphrag/batch-epub-workflow.mjs:5276`。
- book lease acquire/refresh 直接调用 raw `writeJsonAtomic()`：
  `scripts/graphrag/batch-epub-workflow.mjs:2995`、
  `scripts/graphrag/batch-epub-workflow.mjs:3023`、
  `scripts/graphrag/batch-epub-workflow.mjs:3040`、
  `scripts/graphrag/batch-epub-workflow.mjs:3057`。
- provider slot acquire 直接调用 raw `writeJsonAtomic()`：
  `scripts/graphrag/batch-epub-workflow.mjs:3440`、
  `scripts/graphrag/batch-epub-workflow.mjs:3458`。
- coordinator lock acquire/heartbeat 直接调用 raw `writeJsonAtomic()`：
  `scripts/graphrag/batch-epub-workflow.mjs:5548`、
  `scripts/graphrag/batch-epub-workflow.mjs:5560`、
  `scripts/graphrag/batch-epub-workflow.mjs:5579`、
  `scripts/graphrag/batch-epub-workflow.mjs:5596`。
- item checkpoint heartbeat/clear heartbeat 也绕过 typed helper：
  `scripts/graphrag/batch-epub-workflow.mjs:6220`、
  `scripts/graphrag/batch-epub-workflow.mjs:6241`、
  `scripts/graphrag/batch-epub-workflow.mjs:6268`、
  `scripts/graphrag/batch-epub-workflow.mjs:6295`。

阻塞影响：这些 temp owner sidecar 依赖 ambient context 或 coordinator state，
不能证明均从目标值写入 item/book/worker/generation/fencing evidence。

### 4. shared store stale temp cleanup 删除未事件化

I05 要求 cleanup 同时检查 stale age、owner 存活或 lease 失效、target
generation 未推进、持有 per-target lock；删除时必须事件化，并包含 tempId、
operationId、owner、staleAgeMs 和 cleanupReason。

证据：

- shared store reconcile 在持锁路径调用 cleanup：
  `src/job-state/durable-state-store.ts:495`。
- cleanup 检查 owner target、createdAt、cleanup fence、target generation、
  stale TTL、owner alive 和 lease/local owner dead：
  `src/job-state/durable-state-store.ts:901`、
  `src/job-state/durable-state-store.ts:906`、
  `src/job-state/durable-state-store.ts:907`、
  `src/job-state/durable-state-store.ts:909`、
  `src/job-state/durable-state-store.ts:912`、
  `src/job-state/durable-state-store.ts:917`。
- 删除只 `rm` temp 与 owner sidecar，然后 fsync 目录：
  `src/job-state/durable-state-store.ts:918`。
- fsync evidence 含 `cleanupReason`，但未持久化 event/recovery record，
  且未包含 `staleAgeMs`：
  `src/job-state/durable-state-store.ts:920`。
- lock recovery 有 `.durable-recovery.jsonl` 记录，temp cleanup 没有同等记录：
  `src/job-state/durable-state-store.ts:789`、
  `src/job-state/durable-state-store.ts:826`。
- runner cleanup 会写事件并包含 staleAgeMs：
  `scripts/graphrag/batch-epub-workflow.mjs:4654`、
  `scripts/graphrag/batch-epub-workflow.mjs:4665`。

阻塞影响：shared store 删除 stale temp 后，status/recovery summary 无法引用
同等 cleanup evidence。

### 5. rename ENOENT cause matrix 未满足固定细分要求

I07 要求 rename ENOENT 分类为 local_state_integrity、retryable=false、
recoveryDecision=stop_until_fixed，并区分 temp 碰撞、调和误删、并发接管、
generation 更新和底层文件系统或外部修改。

证据：

- shared store ENOENT 会进入 `durable_temp_rename_enoent`：
  `src/job-state/durable-state-store.ts:1194`。
- shared store cause 只返回 `target_generation_advanced`、
  `temp_missing_before_rename`、`temp_reconciled_or_external_removed`、
  `target_parent_missing`、`filesystem_or_external_mutation`：
  `src/job-state/durable-state-store.ts:1250`。
- runner ENOENT 分类使用同样粗粒度原因：
  `scripts/graphrag/batch-epub-workflow.mjs:3956`、
  `scripts/graphrag/batch-epub-workflow.mjs:3985`。
- 现有测试只覆盖 `temp_missing_before_rename`：
  `test/cli.test.ts:3601`、
  `test/cli.test.ts:3697`、
  `test/cli.test.ts:3732`。

阻塞影响：实现可以持久化 ENOENT failure，但不能区分 criteria 明确要求的
temp collision、reconciler mistaken deletion、concurrent takeover 等原因。

### 6. manifest/status-json durable failure 观测面仍不完整

I08 要求 contracts、runner event、item checkpoint、manifest/status-json 与
recovery summary 均能表达 durable write failure 诊断字段。

证据：

- command check、checkpoint、event 与 recovery summary item schema 已包含
  多数 durable 字段：
  `src/contracts/batch-run.ts:134`、
  `src/contracts/batch-run.ts:188`、
  `src/contracts/batch-run.ts:347`、
  `src/contracts/batch-run.ts:399`。
- manifest schema 缺少 `localFailureClass`、`targetLocator`、`tempId`、
  `operationId`、`lockOwnerEvidence`、`checksumRecoveryDecision` 等字段：
  `src/contracts/batch-run.ts:311`。
- runner 内部 manifest schema 同样只有 run counts、locator、policy 与时间字段：
  `scripts/graphrag/batch-epub-workflow.mjs:885`。
- recovery summary item 会投影 durable fields：
  `scripts/graphrag/batch-epub-workflow.mjs:7891`、
  `scripts/graphrag/batch-epub-workflow.mjs:7951`。
- 设计 targetMapping 包含 `status.json`：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:314`。
- runner `--status-json` 只打印 recovery summary；未发现 durable
  `status.json` 写入路径：
  `scripts/graphrag/batch-epub-workflow.mjs:8068`、
  `scripts/graphrag/batch-epub-workflow.mjs:10385`。

阻塞影响：event/checkpoint/recovery summary 的观测面已增强，但 manifest 与
设计中的 status target 仍不能满足固定 criteria 的“均能表达”要求。

### 7. 直接调用链覆盖被 runner 私有路径缺口阻塞

I09 要求 repository、capability catalog、durable-json、batch runner、settings
projection、python bridge 和 dspy policy store 的直接 durable 写入链满足同一
修复语义，或被明确排除在生产 runner 路径之外。

证据：

- repository 通过 shared durable store：
  `src/job-state/repository.ts:70`、
  `src/job-state/repository.ts:400`。
- capability catalog 通过 shared durable store：
  `src/graphrag/capability-catalog.ts:31`、
  `src/graphrag/capability-catalog.ts:745`。
- durable-json 是 shared store thin wrapper：
  `src/job-state/durable-json.ts:1`。
- settings projection 通过 shared durable store：
  `src/graphrag/settings-projection.ts:7`、
  `src/graphrag/settings-projection.ts:263`。
- python bridge subprocess registry 通过 shared durable JSON：
  `src/integrations/python-bridge.ts:151`。
- dspy policy store 通过 shared durable store：
  `src/dspy/policy-store.ts:55`、
  `src/dspy/policy-store.ts:194`。
- batch runner 仍保留私有 durable write/lock/cleanup 路径：
  `scripts/graphrag/batch-epub-workflow.mjs:4036`、
  `scripts/graphrag/batch-epub-workflow.mjs:5090`。

阻塞影响：多数模块已迁移到 shared store，但 batch runner 仍因 I01、I02、
I04、I05、I07、I08 的缺口，不能证明直接调用链统一闭合。

## Criteria 判定矩阵

### I01_single_durable_boundary: FAIL

证据：

- runner 声明等价 adapter：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。
- runner 保留私有 `writeJsonAtomic()`、`writeJsonlAtomic()`、JSON lock、
  cleanup、rename ENOENT 分类：
  `scripts/graphrag/batch-epub-workflow.mjs:4036`、
  `scripts/graphrag/batch-epub-workflow.mjs:4101`、
  `scripts/graphrag/batch-epub-workflow.mjs:5090`、
  `scripts/graphrag/batch-epub-workflow.mjs:4638`、
  `scripts/graphrag/batch-epub-workflow.mjs:3985`。
- shared store 独立实现 durable replace、lock、cleanup、ENOENT 分类：
  `src/job-state/durable-state-store.ts:385`、
  `src/job-state/durable-state-store.ts:650`、
  `src/job-state/durable-state-store.ts:889`、
  `src/job-state/durable-state-store.ts:1250`。

结论：声明等价不足以覆盖观测面与 cause matrix 差异，FAIL。

### I02_target_mapping_enforcement: FAIL

证据：

- 设计要求未列入 targetMapping 的 durable target 不得写入：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224`。
- runner targetMapping 表：
  `scripts/graphrag/batch-epub-workflow.mjs:238`。
- `events.jsonl` 写入路径：
  `scripts/graphrag/batch-epub-workflow.mjs:3736`。
- runner fallback：
  `scripts/graphrag/batch-epub-workflow.mjs:2439`、
  `scripts/graphrag/batch-epub-workflow.mjs:2450`。
- shared store fallback 与 env override：
  `src/job-state/durable-state-store.ts:1750`、
  `src/job-state/durable-state-store.ts:1760`。

结论：targetMapping 未被强制执行，且 `events.jsonl` 未按设计映射，FAIL。

### I03_temp_identity_exclusive_create: PASS

证据：

- shared store tempId 包含 `randomUUID()`：
  `src/job-state/durable-state-store.ts:1616`。
- runner tempId 包含 `randomUUID()`：
  `scripts/graphrag/batch-epub-workflow.mjs:2320`。
- shared store primary/checksum temp 使用 `wx`：
  `src/job-state/durable-state-store.ts:404`、
  `src/job-state/durable-state-store.ts:420`。
- runner primary/checksum temp 使用 `wx`：
  `scripts/graphrag/batch-epub-workflow.mjs:4051`、
  `scripts/graphrag/batch-epub-workflow.mjs:4072`。
- EEXIST 被分类为 `durable_temp_create_collision`：
  `src/job-state/durable-state-store.ts:1409`、
  `scripts/graphrag/batch-epub-workflow.mjs:4016`。
- 同毫秒与 forced collision 测试：
  `test/book-job-state.test.ts:420`、
  `test/book-job-state.test.ts:3538`、
  `test/cli.test.ts:2752`。

结论：满足 temp 唯一性与 exclusive create 基准，PASS。

### I04_temp_owner_evidence: FAIL

证据：

- shared store owner evidence 字段：
  `src/job-state/durable-state-store.ts:1616`。
- runner owner evidence 字段：
  `scripts/graphrag/batch-epub-workflow.mjs:2320`。
- typed helper 会投影写入值 context：
  `scripts/graphrag/batch-epub-workflow.mjs:5264`。
- raw book lease/provider slot/coordinator lock/checkpoint heartbeat 写入绕过
  typed context：
  `scripts/graphrag/batch-epub-workflow.mjs:3023`、
  `scripts/graphrag/batch-epub-workflow.mjs:3458`、
  `scripts/graphrag/batch-epub-workflow.mjs:5560`、
  `scripts/graphrag/batch-epub-workflow.mjs:6241`。

结论：并非所有适用生产 temp 均可证明有完整 owner evidence，FAIL。

### I05_inflight_cleanup_safety: FAIL

证据：

- shared store cleanup 检查 stale、owner、generation、lease：
  `src/job-state/durable-state-store.ts:901`、
  `src/job-state/durable-state-store.ts:909`、
  `src/job-state/durable-state-store.ts:912`、
  `src/job-state/durable-state-store.ts:917`。
- shared store 删除无事件记录，fsync evidence 缺 `staleAgeMs`：
  `src/job-state/durable-state-store.ts:918`、
  `src/job-state/durable-state-store.ts:920`。
- runner cleanup 事件包含 staleAgeMs：
  `scripts/graphrag/batch-epub-workflow.mjs:4654`、
  `scripts/graphrag/batch-epub-workflow.mjs:4665`。
- cleanup 安全测试覆盖 fresh/stale/incomplete owner/generation：
  `test/cli.test.ts:2883`、
  `test/cli.test.ts:2977`、
  `test/cli.test.ts:3049`、
  `test/book-job-state.test.ts:569`。

结论：删除安全检查大体存在，但 shared store 删除未事件化，FAIL。

### I06_atomic_commit_and_checksum_recovery: PASS

证据：

- shared store 顺序覆盖 owner sidecar、temp fsync、pending meta、target rename、
  checksum temp、checksum rename、committed meta、parent fsync：
  `src/job-state/durable-state-store.ts:403`、
  `src/job-state/durable-state-store.ts:404`、
  `src/job-state/durable-state-store.ts:405`、
  `src/job-state/durable-state-store.ts:410`、
  `src/job-state/durable-state-store.ts:419`、
  `src/job-state/durable-state-store.ts:421`、
  `src/job-state/durable-state-store.ts:426`、
  `src/job-state/durable-state-store.ts:429`。
- shared store recovery 处理 checksum missing/old/pending/mismatch：
  `src/job-state/durable-state-store.ts:515`、
  `src/job-state/durable-state-store.ts:526`、
  `src/job-state/durable-state-store.ts:535`、
  `src/job-state/durable-state-store.ts:562`、
  `src/job-state/durable-state-store.ts:566`。
- runner 同等 JSON 顺序和 recovery：
  `scripts/graphrag/batch-epub-workflow.mjs:4036`、
  `scripts/graphrag/batch-epub-workflow.mjs:4638`。
- checksum crash window 测试：
  `test/book-job-state.test.ts:459`、
  `test/cli.test.ts:3207`、
  `test/cli.test.ts:3280`。

结论：checksum window 与 atomic commit recovery 基准可通过，PASS。

### I07_rename_enoent_classification: FAIL

证据：

- shared store 和 runner 均分类 ENOENT 为 durable local failure：
  `src/job-state/durable-state-store.ts:1194`、
  `scripts/graphrag/batch-epub-workflow.mjs:3956`。
- cause matrix 分支不足：
  `src/job-state/durable-state-store.ts:1250`、
  `scripts/graphrag/batch-epub-workflow.mjs:3985`。
- 测试只覆盖 `temp_missing_before_rename`：
  `test/cli.test.ts:3601`、
  `test/cli.test.ts:3697`。

结论：未区分固定 criteria 要求的全部 ENOENT 原因，FAIL。

### I08_status_event_schema_observability: FAIL

证据：

- checkpoint/event/recovery summary item schema 有 durable fields：
  `src/contracts/batch-run.ts:188`、
  `src/contracts/batch-run.ts:347`、
  `src/contracts/batch-run.ts:399`。
- manifest schema 缺 durable failure diagnostics：
  `src/contracts/batch-run.ts:311`、
  `scripts/graphrag/batch-epub-workflow.mjs:885`。
- event redaction：
  `scripts/graphrag/batch-epub-workflow.mjs:3713`。
- recovery summary projection：
  `scripts/graphrag/batch-epub-workflow.mjs:7891`、
  `scripts/graphrag/batch-epub-workflow.mjs:7951`。
- `--status-json` 打印 summary，但无 durable `status.json` 写入：
  `scripts/graphrag/batch-epub-workflow.mjs:8068`、
  `scripts/graphrag/batch-epub-workflow.mjs:10385`。

结论：status/event schema 观测面未满足 manifest/status-json 全量要求，FAIL。

### I09_direct_call_chain_coverage: FAIL

证据：

- repository、capability catalog、durable-json、settings projection、python bridge、
  dspy policy store 使用 shared durable store：
  `src/job-state/repository.ts:70`、
  `src/graphrag/capability-catalog.ts:31`、
  `src/job-state/durable-json.ts:1`、
  `src/graphrag/settings-projection.ts:7`、
  `src/integrations/python-bridge.ts:151`、
  `src/dspy/policy-store.ts:55`。
- batch runner 仍有私有 durable replace/lock/cleanup：
  `scripts/graphrag/batch-epub-workflow.mjs:4036`、
  `scripts/graphrag/batch-epub-workflow.mjs:5090`、
  `scripts/graphrag/batch-epub-workflow.mjs:4638`。

结论：非 runner 模块大多已统一，但 runner 私有路径仍未满足同一修复语义，
FAIL。

### I10_fault_injection_tests: PASS

证据：

- 同毫秒 temp 碰撞：
  `test/book-job-state.test.ts:420`、
  `test/book-job-state.test.ts:3538`。
- forced temp collision：
  `test/cli.test.ts:2752`。
- 活跃 temp 调和、owner-dead stale temp、owner evidence 不完整、generation
  advanced：
  `test/cli.test.ts:2883`、
  `test/cli.test.ts:2977`、
  `test/cli.test.ts:3049`、
  `test/book-job-state.test.ts:569`。
- checksum crash windows：
  `test/book-job-state.test.ts:459`、
  `test/cli.test.ts:3207`、
  `test/cli.test.ts:3280`。
- lock timeout：
  `test/cli.test.ts:2641`。
- rename ENOENT：
  `test/cli.test.ts:3601`。
- before-resume orphan temp、provider/subprocess recovery：
  `test/cli.test.ts:3464`、
  `test/cli.test.ts:4174`、
  `test/cli.test.ts:4598`、
  `test/cli.test.ts:4682`。

结论：固定 fault-injection 类别已有覆盖。rename cause submatrix 的不足已在
I07 计为实现与测试阻塞；I10 按高层类别判定 PASS。
