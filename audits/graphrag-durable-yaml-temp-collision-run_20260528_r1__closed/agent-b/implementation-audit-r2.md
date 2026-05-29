# GraphRAG Durable YAML Temp Collision 实施审计 R2

## 结论

整体结论：FAIL。

固定基准判定：1 PASS，9 FAIL。R2 实现已修复 durable temp 唯一性
（temp identity）与独占创建（exclusive create）的核心碰撞风险，并补充了
provider slot、worker pool、qmd index lock 与测试钩子 gate。但实现仍未满足
固定 criteria 对统一 durable 边界、targetMapping 执行、checksum crash window、
in-flight cleanup、rename ENOENT 分类矩阵和故障注入测试的完整要求。

固定基准文件未修改：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-b/implementation-criteria.yaml`

审计方式：静态实现审计（static implementation audit）。未执行测试套件。

## 逐项判定

### I01_single_durable_boundary：FAIL

生产 YAML/JSON 写入边界未统一到单一 durableStateStore 或声明等价 adapter。

- `src/job-state/durable-state-store.ts:220` 实现共享 YAML/JSON durable 写入。
- `scripts/graphrag/batch-epub-workflow.mjs:3401` 仍保留私有
  `writeJsonAtomic`。
- `scripts/graphrag/batch-epub-workflow.mjs:3449` 仍保留私有
  `writeJsonlAtomic`。
- `scripts/graphrag/batch-epub-workflow.mjs:3668` 与 `:3758` 仍保留私有
  JSON/YAML reconcile。
- `scripts/graphrag/batch-epub-workflow.mjs:3895` 与 `:3957` 仍保留私有
  JSON lock。

这些 helper 与 `src/job-state/durable-state-store.ts` 的 owner evidence、
cleanup、checksum backfill、lock recovery、failure evidence 字段不完全一致。
代码中也没有显式声明该 runner 内私有实现是共享 store 的等价 adapter。因此
catalog、book-scoped YAML、item checkpoint、manifest/status、provider slot 与
subprocess registry 在同一批次中仍可能产生不同语义的 durable evidence。

### I02_target_mapping_enforcement：FAIL

设计文件要求每个生产目标可追溯到唯一 lane、owner、durableKind、
laneTimeoutMs 与 releaseOn。实现没有把 `targetMapping` 固化成运行时约束。

- 设计 targetMapping 位于
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:226` 之后。
- provider slot 使用 registry lock 与 durable lease：
  `scripts/graphrag/batch-epub-workflow.mjs:2882`。
- book lease 使用 per-book JSON lock：
  `scripts/graphrag/batch-epub-workflow.mjs:2535`。
- qmd index 使用 `qmdIndexWriterLane`：
  `scripts/graphrag/batch-epub-workflow.mjs:2988`。
- qmd index file lock 的等待阈值为 `qmdIndexFileLockWaitMs`：
  `scripts/graphrag/batch-epub-workflow.mjs:177`。
- `AsyncSemaphore.acquire` 无 lane timeout：
  `scripts/graphrag/batch-epub-workflow.mjs:2345`。

实现有 provider slot capacity gate、book worker pool 和 qmd index 串行化，
但没有对 catalog、book-scoped YAML、item checkpoint、manifest、status、
run lock、provider slot、subprocess registry、book lease、settings 与 qmd index
逐目标校验 lane/owner/durableKind/laneTimeout/releaseOn。事件 schema 中也缺少
一等 `lane` 字段，无法证明每次写入进入了设计 lane。

### I03_temp_identity_exclusive_create：PASS

durable temp 名称包含 UUID 等价熵源，并使用 exclusive create。

- 共享 store 的 `tempId` 包含 `randomUUID()`：
  `src/job-state/durable-state-store.ts:971`。
- 共享 store 主 temp 与 checksum temp 使用该 `tempId`：
  `src/job-state/durable-state-store.ts:225`、`:228`。
- 共享 store 写 temp 使用 `wx`：
  `src/job-state/durable-state-store.ts:233`、`:242`。
- runner 私有 durable helper 的 `operationId` 使用 `randomUUID()`：
  `scripts/graphrag/batch-epub-workflow.mjs:2093`。
- runner 主 temp 与 checksum temp 使用该 `tempId`：
  `scripts/graphrag/batch-epub-workflow.mjs:3406`、`:3409`。
- runner 写 temp 使用 `wx`：
  `scripts/graphrag/batch-epub-workflow.mjs:3413`、`:3422`。
- EEXIST 被分类为 `durable_temp_create_collision`：
  `src/job-state/durable-state-store.ts:913`、
  `scripts/graphrag/batch-epub-workflow.mjs:3381`。

测试覆盖同毫秒并发 YAML 写入：
`test/book-job-state.test.ts:419`。

### I04_temp_owner_evidence：FAIL

owner evidence 有进展，但不满足固定基准要求的可恢复字段集合。

- 共享 store owner evidence 包含 `tempId`、`operationId`、`targetLocator`、
  `runnerSessionId`、`ownerPid`、`ownerHost`、`createdAt`：
  `src/job-state/durable-state-store.ts:967`。
- 共享 store 只从环境变量读取 lease/fencing：
  `src/job-state/durable-state-store.ts:982`。
- runner durable operation evidence 不包含 `workerId`、`itemId`、`bookId`、
  `leaseGeneration`、`fencingTokenHash`：
  `scripts/graphrag/batch-epub-workflow.mjs:2093`。
- runner cleanup projection 会尝试输出这些字段，但普通 durable operation 没有
  写入对应字段：
  `scripts/graphrag/batch-epub-workflow.mjs:3480`。

runner 明确知道 item/book/worker/provider slot 与 lease context，例如子进程
环境在 `scripts/graphrag/batch-epub-workflow.mjs:7265` 之后设置，但 direct
durable writes 的 owner sidecar 没有绑定这些作用域字段。恢复、cleanup 与
rename ENOENT 后续只能得到部分 evidence，不能满足可诊断 owner evidence
（owner evidence）要求。

### I05_inflight_cleanup_safety：FAIL

temp cleanup 未同时满足 stale age、owner 存活或 lease 失效、target generation
未推进、cleaner 持有 per-target lock 四个条件。

- 共享 store cleanup 检查 stale age 与 owner pid：
  `src/job-state/durable-state-store.ts:541`。
- 共享 store cleanup 不检查 lease 失效、target generation 未推进，也不事件化
  删除：
  `src/job-state/durable-state-store.ts:553`。
- runner cleanup 检查 stale age、owner alive 与 lease expiry：
  `scripts/graphrag/batch-epub-workflow.mjs:3510`。
- runner cleanup 事件包含 cleanupReason 与 staleAgeMs：
  `scripts/graphrag/batch-epub-workflow.mjs:3686`、`:3776`。
- `loadManifest` 可直接调用 reconcile，未显示持有 per-target lock：
  `scripts/graphrag/batch-epub-workflow.mjs:4521`。

runner 版本优于共享 store，但仍未验证 target generation 未推进，且并非所有
cleanup 入口都证明 cleaner 持有目标 lock。共享 store 删除 stale temp 时没有
事件、tempId、operationId、owner、staleAgeMs 与 cleanupReason 持久诊断。

### I06_atomic_commit_and_checksum_recovery：FAIL

实现覆盖了 temp fsync、rename、checksum sidecar 与 parent fsync 的部分顺序，
但 crash window 收敛仍不足。

- 共享 store 写入顺序为 owner sidecar、target temp、target rename、checksum
  temp、checksum rename、metadata、parent fsync：
  `src/job-state/durable-state-store.ts:231`。
- 共享 store 对 checksum missing 直接 backfill：
  `src/job-state/durable-state-store.ts:332`。
- 共享 store 对 checksum old 仅在 metadata checksum 等于 actual 时 backfill：
  `src/job-state/durable-state-store.ts:343`。
- metadata 缺失或 partial 且 checksum old 时会进入 mismatch quarantine：
  `src/job-state/durable-state-store.ts:347`。
- runner 具有相同的 target-first、checksum-after 写入顺序：
  `scripts/graphrag/batch-epub-workflow.mjs:3412`。
- runner checksum recovery 逻辑同样依赖 checksum meta：
  `scripts/graphrag/batch-epub-workflow.mjs:3713`、`:3803`。

若 crash 发生在 target rename 之后、checksum/meta publish 之前，恢复逻辑缺少
target generation 与 commit owner evidence 来证明 `target-new/checksum-old` 或
`target-new/checksum-missing` 属于同一提交。checksum meta partial write 时，
有效 target 可能被隔离为 checksum mismatch，而不是收敛到 committed、
retryable repair 或有证据的 stop_until_fixed。

### I07_rename_enoent_classification：FAIL

rename ENOENT 已被识别为 local_state_integrity，但未满足原因分类矩阵。

- 共享 store 将 ENOENT 分类为 `durable_temp_rename_enoent`：
  `src/job-state/durable-state-store.ts:747`。
- 共享 store 固定写入 `renameCause: filesystem_or_external_mutation`：
  `src/job-state/durable-state-store.ts:765`。
- runner 私有 helper 同样固定写入
  `renameCause: filesystem_or_external_mutation`：
  `scripts/graphrag/batch-epub-workflow.mjs:3355`。
- failure classifier 只能从文本推断 durable rename ENOENT：
  `scripts/graphrag/batch-failure-classifier.mjs:100`。

固定基准要求区分 temp collision、调和误删、并发接管、generation 更新、
底层文件系统或外部修改。当前实现只有通用 cause，且 runner evidence 缺少
leaseGeneration、worker/item/book scope。item checkpoint、status-json 或
recovery summary 只能持久化部分字段，无法给出明确 renameCause。

### I08_status_event_schema_observability：FAIL

观测面已有大量 durable 字段，但缺少固定基准要求的完整诊断字段，尤其是
`lane`。

- command check schema 包含 localFailureClass、targetLocator、tempId、
  operationId、renameCause、lockOwnerEvidence、checksumRecoveryDecision：
  `src/contracts/batch-run.ts:140`。
- item checkpoint schema 包含相同 durable 字段：
  `src/contracts/batch-run.ts:209`。
- event schema 包含相同 durable 字段：
  `src/contracts/batch-run.ts:331`。
- recovery summary item schema 包含相同 durable 字段：
  `src/contracts/batch-run.ts:350`。
- runner recovery summary 投影 durable fields：
  `scripts/graphrag/batch-epub-workflow.mjs:6657`。

缺口是 schema 与 runner event/status/recovery summary 没有一等 `lane` 字段，
也没有稳定投影 targetMapping owner、laneTimeoutMs、releaseOn 与 checksum
recovery decision 的完整上下文。redaction 已存在，但观测字段仍不足以满足
固定基准。

### I09_direct_call_chain_coverage：FAIL

部分直接调用链已收敛到共享 durable store，但仍存在未覆盖或未排除的生产写入链。

- repository YAML 写入调用共享 store：
  `src/job-state/repository.ts:400`。
- capability catalog 调用共享 durable YAML update：
  `src/graphrag/capability-catalog.ts:350`。
- durable-json 已委托共享 store：
  `src/job-state/durable-json.ts:1`。
- settings projection 调用共享 store：
  `src/graphrag/settings-projection.ts:259`。
- python bridge subprocess registry 调用共享 store：
  `src/integrations/python-bridge.ts:151`。
- DSPy YAML/JSON helper 调用共享 store：
  `src/dspy/policy-store.ts:193`。
- batch runner 仍保留私有 durable JSON/JSONL helper：
  `scripts/graphrag/batch-epub-workflow.mjs:3401`。
- DSPy policy store 仍有 JSONL / artifact file direct writes，未声明排除：
  `src/dspy/policy-store.ts:632`、`:1212`、`:1329`。

当前 runner targetMapping 覆盖的 manifest/status/checkpoint/provider slot/
subprocess registry/book lease 写入没有统一进入共享 store，也没有声明等价语义。
因此直接调用链覆盖仍未满足固定基准。

### I10_fault_injection_tests：FAIL

测试覆盖显著增加，但未覆盖固定基准要求的完整故障注入矩阵。

已覆盖或部分覆盖：

- 同毫秒 durable YAML temp 抗碰撞：
  `test/book-job-state.test.ts:419`。
- durable checksum old/missing 与 corrupt quarantine 的部分路径：
  `test/book-job-state.test.ts:458`、`:1611`、`:3200`。
- auxiliary sidecar recursion filter：
  `test/cli.test.ts:2689`。
- fresh temp 保留、owner-dead stale temp 删除与事件：
  `test/cli.test.ts:2608`。
- provider slot recovery 与 durable capacity gate：
  `test/cli.test.ts:3211`、`:3419`。
- book concurrency worker pool：
  `test/cli.test.ts:2775`。
- qmd index file lock：
  `test/cli.test.ts:3942`。
- classifier 字符串级 durable class：
  `test/cli.test.ts:2574`。

未充分覆盖：

- forced temp create collision 的 EEXIST 注入。
- 实际 `rename(temp, target)` ENOENT 注入与 checkpoint/status/recovery summary
  字段断言。
- active writer temp 被误删后的 `durable_live_temp_deleted` 路径。
- checksum partial write、target-new/checksum-old 且 metadata partial/missing。
- parent directory fsync uncertainty 的完成禁止规则。
- lock timeout 的持久 owner evidence。
- restart 后针对上述 durable failures 的完整恢复闭环。

因此测试不能证明不会丢失已提交状态，也不能证明未提交状态不会被标记为完成。

## 重点关注项状态

- durable temp collision：核心实现 PASS。共享 store 与 runner temp 均包含
  UUID，并使用 `wx`；同毫秒并发测试已覆盖。
- sidecar recursion：部分 PASS。共享 store 拒绝 auxiliary target，runner 过滤
  `.sha256`、`.meta.json`、`.owner.json`、`.tmp-*`；测试覆盖 provider slot、
  subprocess 与 book lease 目录。但这不消除 I01/I09 的双实现问题。
- checksum crash window：FAIL。缺少 generation/owner-based recovery，partial
  checksum/meta 仍可能错误隔离有效 target。
- provider slot durable capacity：部分 PASS。provider slot lease、registry
  lock、capacity gate 与 stale recovery 已实现并有测试；但没有完整
  targetMapping lane/timeout/releaseOn 证据。
- book concurrency worker pool：部分 PASS。worker pool、book lease 与 sibling
  quiesce 行为已有实现和测试；但 lane/targetMapping 证据不足。
- qmd index writer lane：部分 PASS。qmd command 会进入 qmd index semaphore 与
  file lock，并有测试；但 semaphore 无 lane timeout，event/status 无 `lane`。
- test-only env gates：PASS。`QMD_GRAPHRAG_ENABLE_TEST_HOOKS` 与
  `initialEnvNames` gate 保护 test runner override：
  `scripts/graphrag/batch-epub-workflow.mjs:7056`、`:7070`。测试用 lock/temp
  参数也受 enable flag gate：
  `scripts/graphrag/batch-epub-workflow.mjs:166`、`:171`。

## 阻塞发现

1. 双 durable 边界仍存在。runner 内私有 JSON/JSONL durable helper 未声明为共享
   store 的等价 adapter，且 owner evidence、cleanup 与 checksum recovery 语义
   不一致。
2. targetMapping 未成为运行时 contract。provider slot、book lease 与 qmd index
   有局部锁和 semaphore，但缺少逐目标 lane/owner/durableKind/laneTimeoutMs/
   releaseOn enforcement。
3. checksum crash window 仍缺少 generation 与 owner evidence 收敛。partial
   checksum/meta 或 target-new/checksum-old 可能导致有效 target 被错误 quarantine。
4. in-flight temp cleanup 不满足全部安全条件。共享 store cleanup 无事件和
   target generation 检查；runner cleanup 也不能证明所有入口持有 per-target lock。
5. rename ENOENT 只有通用 cause。当前 evidence 无法区分 temp collision、
   cleanup 误删、并发接管、generation 更新与外部文件系统修改。
6. observability 缺少 `lane` 与 targetMapping 诊断字段。status-json、
   recovery summary、event 与 checkpoint 无法完整表达固定基准要求的 durable
   write failure 诊断。
7. fault injection tests 未覆盖 forced collision、真实 rename ENOENT、checksum
   partial write、lock timeout owner evidence 与 restart recovery 闭环。
