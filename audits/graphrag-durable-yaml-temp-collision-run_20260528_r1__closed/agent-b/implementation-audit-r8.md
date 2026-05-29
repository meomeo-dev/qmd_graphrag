Status: FAIL

# GraphRAG Durable YAML Temp Collision 实施审计 R8

## 总体结论

固定基准判定：9 PASS，1 FAIL。

R8 复核显示，R7 的多数 blocker 已闭合：生产 durable targetMapping 已
fail-closed，runner 私有 adapter 与 shared durable store 的 cleanup、lock、
checksum、owner evidence 与 observability 已基本对齐；raw `writeJsonAtomic()`
调用已改为 value-derived owner context；shared stale temp cleanup 已写入
`.durable-recovery.jsonl`；manifest、`status.json` 与 recovery summary 已具备
durable failure projection；provider request artifact 已走 durable JSON 写入。

剩余 blocker 是 `rename ENOENT` cause matrix 未满足固定 I07。当前实现仍只
返回粗粒度 `renameCause`，不能区分固定 criteria 明确要求的 temp 碰撞
（temp collision）、调和误删（reconciler mistaken deletion）、并发接管
（concurrent takeover）、generation 更新与底层文件系统/外部修改。测试也只
覆盖 `temp_missing_before_rename` 一个原因。因此本轮 implementation audit
判定 FAIL。

本轮为只读审计。未修改 criteria，未修改生产代码，未启动真实 EPUB runner。
仅写入本报告。

## Blocking Finding

### 1. Rename ENOENT cause matrix 仍未满足固定细分要求

固定 I07 要求 temp rename ENOENT 分类为 `local_state_integrity`、
`retryable=false`、`recoveryDecision=stop_until_fixed`，并区分 temp 碰撞、
调和误删、并发接管、generation 更新和底层文件系统或外部修改。

证据：

- 固定 criteria 明确要求上述 cause matrix：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-criteria.yaml:84`。
- shared store 捕获 ENOENT 并持久化 `durable_temp_rename_enoent`：
  `src/job-state/durable-state-store.ts:1305`。
- shared store 的 `inferRenameEnoentCause()` 只返回
  `target_generation_advanced`、`temp_missing_before_rename`、
  `temp_reconciled_or_external_removed`、`target_parent_missing`、
  `filesystem_or_external_mutation`，没有 temp collision、reconciler mistaken
  deletion、concurrent takeover 的可判定分支：
  `src/job-state/durable-state-store.ts:1361`。
- runner adapter 同样捕获 ENOENT：
  `scripts/graphrag/batch-epub-workflow.mjs:4076`。
- runner adapter 的 `inferRenameEnoentCause()` 与 shared store 同样只返回
  粗粒度原因：
  `scripts/graphrag/batch-epub-workflow.mjs:4105`。
- 当前 rename ENOENT 测试只断言 `temp_missing_before_rename`：
  `test/cli.test.ts:3601`、`test/cli.test.ts:3697`、
  `test/cli.test.ts:3711`、`test/cli.test.ts:3732`。

阻塞影响：实现可以把 ENOENT fail closed，但无法给 status/event/checkpoint/
recovery summary 提供固定 I07 要求的具体根因。事故恢复时仍不能区分 temp
碰撞、误删、并发接管与外部修改。

## R7 Blocker 复核

- targetMapping 唯一映射与非生产默认：已闭合。runner 表列出 batch items、
  manifest、events、status、recovery summary、coordinator lock、provider
  slots、subprocesses、book leases、provider requests、cost accounting、
  DSPy、qmd manifests、LanceDB row-count 与 qmd index：
  `scripts/graphrag/batch-epub-workflow.mjs:238`。生产未映射 target 会抛出
  `durable_target_mapping_missing`，`nonProductionDefault` 只在非生产 target
  后备：
  `scripts/graphrag/batch-epub-workflow.mjs:2515`、
  `scripts/graphrag/batch-epub-workflow.mjs:2553`。shared store 也对
  `/graph_vault/`、`.qmd/index.sqlite`、`index.sqlite` 与 sqlite lock 生产
  target fail-closed：
  `src/job-state/durable-state-store.ts:1852`、
  `src/job-state/durable-state-store.ts:1902`。
- runner/shared durable boundary 等价性：部分闭合但受 I07 阻塞。runner 声明
  equivalent adapter：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。shared store 与 runner 都
  覆盖 owner sidecar、exclusive create、checksum pending/committed meta、
  atomic rename、parent fsync、lock timeout、stale temp cleanup 与 event/
  recovery projection：
  `src/job-state/durable-state-store.ts:464`、
  `scripts/graphrag/batch-epub-workflow.mjs:4156`、
  `src/job-state/durable-state-store.ts:968`、
  `scripts/graphrag/batch-epub-workflow.mjs:4752`。剩余差距为 I07 cause matrix。
- raw `writeJsonAtomic()` owner evidence：已闭合。raw writer 只由
  `writeJsonAtomicWithValue()` 调用，该 helper 从目标值投影 item/book/worker/
  generation/fencing context：
  `scripts/graphrag/batch-epub-workflow.mjs:5384`、
  `scripts/graphrag/batch-epub-workflow.mjs:5403`、
  `scripts/graphrag/batch-epub-workflow.mjs:2486`。book lease、provider slot 与
  coordinator lock 已改为 `writeJsonAtomicWithValue()`：
  `scripts/graphrag/batch-epub-workflow.mjs:3146`、
  `scripts/graphrag/batch-epub-workflow.mjs:3581`、
  `scripts/graphrag/batch-epub-workflow.mjs:5683`。
- shared stale temp cleanup 事件化：已闭合。async 与 sync cleanup 删除 stale
  temp 后均写 `.durable-recovery.jsonl`，包含 `tempId`、`operationId`、
  `cleanupReason`、`staleAgeMs` 与 owner evidence：
  `src/job-state/durable-state-store.ts:997`、
  `src/job-state/durable-state-store.ts:1013`、
  `src/job-state/durable-state-store.ts:1061`、
  `src/job-state/durable-state-store.ts:1077`。
- rename ENOENT cause matrix：未闭合。见 blocking finding。
- manifest/status/recovery observability：已闭合。contracts 的 manifest
  `durableFailureSummary`、event、checkpoint 与 recovery summary item 均包含
  durable diagnostics：
  `src/contracts/batch-run.ts:344`、
  `src/contracts/batch-run.ts:371`、
  `src/contracts/batch-run.ts:188`、
  `src/contracts/batch-run.ts:423`。runner 从 checkpoint 投影
  `durableFailureSummary`，并同时写 `recovery-summary.json` 与 `status.json`：
  `scripts/graphrag/batch-epub-workflow.mjs:7951`、
  `scripts/graphrag/batch-epub-workflow.mjs:8214`。
- provider request artifact durable：已闭合。GraphRAG provider request
  artifact 经 `writeJsonFileDurable()` 写入
  `catalog/provider-requests/*.json`：
  `src/integrations/graphrag.ts:129`、
  `src/integrations/graphrag.ts:162`。LLM provider request artifact 同样经
  durable JSON 写入：
  `src/llm.ts:2035`、`src/llm.ts:2046`。

## Criteria 判定矩阵

### I01_single_durable_boundary: PASS

证据：

- repository、capability catalog、settings projection、python bridge、DSPy
  policy store 与 durable-json 均进入 shared durable store：
  `src/job-state/repository.ts:70`、
  `src/graphrag/capability-catalog.ts:31`、
  `src/graphrag/settings-projection.ts:7`、
  `src/integrations/python-bridge.ts:151`、
  `src/dspy/policy-store.ts:55`、
  `src/job-state/durable-json.ts:1`。
- runner adapter 覆盖 equivalent durable contract：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。
- shared store 与 runner 都实现 temp owner evidence、exclusive create、
  checksum/generation、atomic rename、parent fsync、lock timeout、cleanup 与
  failure projection：
  `src/job-state/durable-state-store.ts:464`、
  `src/job-state/durable-state-store.ts:729`、
  `scripts/graphrag/batch-epub-workflow.mjs:4156`、
  `scripts/graphrag/batch-epub-workflow.mjs:5210`。

剩余风险：I07 的 cause submatrix 未闭合；该风险不改变单一 durable boundary
入口判定，但影响 ENOENT 根因精度。

### I02_target_mapping_enforcement: PASS

证据：

- 设计 targetMapping 覆盖 catalog、book-scoped YAML、item checkpoint、
  manifest、events、status、recovery summary、lock、provider slot、
  subprocess、book lease、provider request、cost accounting、DSPy、qmd
  manifests、LanceDB row-count 与 `.qmd/index.sqlite`：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241`。
- runner targetMapping 表对应上述生产目标，并补充 explicit qmd index lock：
  `scripts/graphrag/batch-epub-workflow.mjs:238`、
  `scripts/graphrag/batch-epub-workflow.mjs:397`。
- runner 对生产未映射 target fail-closed：
  `scripts/graphrag/batch-epub-workflow.mjs:2515`。
- shared store 对生产未映射 target fail-closed：
  `src/job-state/durable-state-store.ts:1852`。
- qmd index lane 有 file lock、event evidence、timeout 与 release evidence：
  `scripts/graphrag/batch-epub-workflow.mjs:3308`、
  `scripts/graphrag/batch-epub-workflow.mjs:3352`、
  `scripts/graphrag/batch-epub-workflow.mjs:3382`、
  `scripts/graphrag/batch-epub-workflow.mjs:3413`。

剩余风险：`index.sqlite` 的 generic mapping 与 `.qmd/index.sqlite` mapping
语义相同；当前未发现冲突 lane/owner，但缺少独立 duplicate-pattern test。

### I03_temp_identity_exclusive_create: PASS

证据：

- shared store tempId 使用 `randomUUID()`：
  `src/job-state/durable-state-store.ts:1727`。
- runner tempId 使用 `randomUUID()`，test hook 仅在测试启用时覆盖：
  `scripts/graphrag/batch-epub-workflow.mjs:2407`。
- shared store 与 runner primary/checksum temp 均使用 `wx` exclusive create：
  `src/job-state/durable-state-store.ts:483`、
  `src/job-state/durable-state-store.ts:499`、
  `scripts/graphrag/batch-epub-workflow.mjs:4171`、
  `scripts/graphrag/batch-epub-workflow.mjs:4192`。
- EEXIST 分类为 `durable_temp_create_collision`：
  `src/job-state/durable-state-store.ts:1520`、
  `scripts/graphrag/batch-epub-workflow.mjs:4136`。
- 同毫秒与 forced collision 测试覆盖：
  `test/book-job-state.test.ts:420`、
  `test/book-job-state.test.ts:3556`、
  `test/cli.test.ts:2752`。

剩余风险：无阻塞风险。

### I04_temp_owner_evidence: PASS

证据：

- shared store owner evidence 包含 tempId、operationId、targetLocator、
  runnerSessionId、workerId、itemId、bookId、ownerPid、ownerHost、createdAt、
  leaseGeneration、targetGeneration 与 fencingTokenHash：
  `src/job-state/durable-state-store.ts:1727`。
- runner owner evidence 包含同类字段：
  `scripts/graphrag/batch-epub-workflow.mjs:2407`。
- runner typed JSON 写入从目标值派生 durable context：
  `scripts/graphrag/batch-epub-workflow.mjs:2486`、
  `scripts/graphrag/batch-epub-workflow.mjs:5403`。
- book lease、provider slot、coordinator lock、manifest/status/recovery summary
  写入均通过 typed/value-derived path：
  `scripts/graphrag/batch-epub-workflow.mjs:3146`、
  `scripts/graphrag/batch-epub-workflow.mjs:3581`、
  `scripts/graphrag/batch-epub-workflow.mjs:5683`、
  `scripts/graphrag/batch-epub-workflow.mjs:8216`。

剩余风险：owner evidence 完整性依赖目标值 schema 与 ambient runner context。

### I05_inflight_cleanup_safety: PASS

证据：

- shared store cleanup 要求 owner target 匹配、createdAt、cleanup fence、
  target generation 未推进、stale TTL、owner dead 或 lease expired：
  `src/job-state/durable-state-store.ts:980`、
  `src/job-state/durable-state-store.ts:982`、
  `src/job-state/durable-state-store.ts:985`、
  `src/job-state/durable-state-store.ts:986`、
  `src/job-state/durable-state-store.ts:988`、
  `src/job-state/durable-state-store.ts:991`、
  `src/job-state/durable-state-store.ts:996`。
- shared cleanup 删除后记录 durable recovery：
  `src/job-state/durable-state-store.ts:1013`、
  `src/job-state/durable-state-store.ts:1077`。
- runner cleanup 同样事件化并包含 cleanup reason 与 stale age：
  `scripts/graphrag/batch-epub-workflow.mjs:4752`、
  `scripts/graphrag/batch-epub-workflow.mjs:4774`、
  `scripts/graphrag/batch-epub-workflow.mjs:4887`、
  `scripts/graphrag/batch-epub-workflow.mjs:4909`。
- fresh temp、不完整 owner evidence、owner-dead stale temp 与 target generation
  advanced 测试覆盖：
  `test/cli.test.ts:2883`、
  `test/cli.test.ts:2977`、
  `test/cli.test.ts:3049`、
  `test/book-job-state.test.ts:569`。

剩余风险：shared store recovery log 不是 batch `events.jsonl`，但已是 durable
事件记录，可供恢复审计读取。

### I06_atomic_commit_and_checksum_recovery: PASS

证据：

- shared store 写入顺序覆盖 owner sidecar、temp fsync、pending checksum meta、
  target rename、checksum temp、checksum rename、committed meta 与 parent fsync：
  `src/job-state/durable-state-store.ts:481`、
  `src/job-state/durable-state-store.ts:489`、
  `src/job-state/durable-state-store.ts:498`、
  `src/job-state/durable-state-store.ts:505`、
  `src/job-state/durable-state-store.ts:508`。
- shared recovery 处理 checksum missing、pending、old 与 mismatch/quarantine：
  `src/job-state/durable-state-store.ts:597`、
  `src/job-state/durable-state-store.ts:614`、
  `src/job-state/durable-state-store.ts:641`、
  `src/job-state/durable-state-store.ts:645`。
- runner JSON durable path 有相同 pending/committed checksum sequence：
  `scripts/graphrag/batch-epub-workflow.mjs:4156`。
- checksum crash-window 测试覆盖：
  `test/book-job-state.test.ts:459`、
  `test/cli.test.ts:3207`、
  `test/cli.test.ts:3280`。

剩余风险：无阻塞风险。

### I07_rename_enoent_classification: FAIL

证据与影响见 Blocking Finding。

### I08_status_event_schema_observability: PASS

证据：

- contracts 支持 command check、checkpoint、manifest durableFailureSummary、
  event 与 recovery summary item durable diagnostics：
  `src/contracts/batch-run.ts:134`、
  `src/contracts/batch-run.ts:188`、
  `src/contracts/batch-run.ts:344`、
  `src/contracts/batch-run.ts:371`、
  `src/contracts/batch-run.ts:423`。
- runner schema 同步支持 manifest durableFailureSummary 与 event diagnostics：
  `scripts/graphrag/batch-epub-workflow.mjs:948`、
  `scripts/graphrag/batch-epub-workflow.mjs:1007`。
- runner event 写入 redaction 后进入 durable append：
  `scripts/graphrag/batch-epub-workflow.mjs:3833`。
- manifest 从 checkpoint 反推 durable failure summary：
  `scripts/graphrag/batch-epub-workflow.mjs:7951`。
- recovery summary 与 status target 都 durable 写入：
  `scripts/graphrag/batch-epub-workflow.mjs:8214`。

剩余风险：I07 未闭合导致 `renameCause` 的字段值粒度不足。

### I09_direct_call_chain_coverage: PASS

证据：

- repository 通过 shared durable YAML：
  `src/job-state/repository.ts:400`、
  `src/job-state/repository.ts:411`。
- capability catalog 通过 shared durable unknown YAML wrapper：
  `src/graphrag/capability-catalog.ts:350`、
  `src/graphrag/capability-catalog.ts:745`。
- durable-json 是 shared store thin wrapper：
  `src/job-state/durable-json.ts:1`。
- settings projection 通过 shared durable store：
  `src/graphrag/settings-projection.ts:7`、
  `src/graphrag/settings-projection.ts:263`。
- python bridge subprocess registry 通过 shared durable JSON sync：
  `src/integrations/python-bridge.ts:151`。
- dspy policy store 通过 shared durable YAML/JSON/opaque write：
  `src/dspy/policy-store.ts:55`、
  `src/dspy/policy-store.ts:194`、
  `src/dspy/policy-store.ts:198`。
- batch runner 私有 adapter 已补齐 targetMapping、owner evidence、checksum、
  cleanup、lock 与 observability；剩余 ENOENT cause 粒度由 I07 单独阻塞：
  `scripts/graphrag/batch-epub-workflow.mjs:206`。

剩余风险：`src/job-state/graphrag-book.ts` 的 qmd index lock 是 sqlite adapter，
非 YAML/JSON durable replace；它记录 lane/owner/fencing/timeout，但 parent
fsync 使用 best-effort。该项不阻塞本 YAML/JSON temp collision 基准。

### I10_fault_injection_tests: PASS

证据：

- 同毫秒 temp 碰撞：
  `test/book-job-state.test.ts:420`、
  `test/book-job-state.test.ts:3556`。
- forced temp collision：
  `test/cli.test.ts:2752`。
- fresh temp、stale temp、owner evidence 缺失、target generation advanced：
  `test/cli.test.ts:2883`、
  `test/cli.test.ts:2977`、
  `test/cli.test.ts:3049`。
- shared store owner-dead/lease-expired stale temp recovery log：
  `test/book-job-state.test.ts:569`。
- checksum pending/missing/partial/mismatch windows：
  `test/book-job-state.test.ts:459`、
  `test/cli.test.ts:3207`、
  `test/cli.test.ts:3280`。
- lock timeout：
  `test/cli.test.ts:2641`。
- before-resume unresolved temp blocks worker start：
  `test/cli.test.ts:3464`。
- rename ENOENT event/checkpoint/recovery summary projection：
  `test/cli.test.ts:3601`。
- qmd index lane lock coverage：
  `test/cli.test.ts:4905`。

剩余风险：rename ENOENT cause submatrix 未覆盖 temp collision、reconciler
mistaken deletion 与 concurrent takeover；该缺口已在 I07 计为 blocker。

## 审计输入

- 固定 criteria：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-criteria.yaml`
- 设计参考：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- 状态文件：
  `audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json`

根目录 `reports/status.json` 不存在；本轮使用审计目录下的 status 文件。
