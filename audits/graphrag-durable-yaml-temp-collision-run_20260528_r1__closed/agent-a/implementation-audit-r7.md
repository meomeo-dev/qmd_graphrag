Status: FAIL

# Implementation Audit R7 - Agent A

审计对象：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-criteria.yaml`
中的 10 条固定 criteria。

结论：7 PASS，3 FAIL。R6 的 checksum crash-window recovery、
rename ENOENT 证据、temp owner cleanup、JSON/YAML reconcile lock 与
resume/claim preflight 调用点已有实质修复；但 single durable boundary
（单一持久状态边界）、target mapping/lane（目标映射/写入通道）与
preflight 覆盖仍未完全闭合。

未修改 criteria 或生产代码，未启动真实 EPUB runner。本审计以当前代码与
测试证据为准。

## Blocking Findings

### BF-01: target mapping 仍允许 fallback，且存在未显式映射生产目标

设计契约要求每个生产 durable YAML/JSON/SQLite 目标都必须能从
targetMapping 追溯到唯一 lane、owner、timeout 与 releaseOn；未列入
targetMapping 的目标不得由并行 runner 写入：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:224-228`。

当前实现仍允许 fallback：

- Runner adapter 在未命中显式表时返回 `targetMappingRule: "fallback"`，
  并用路径推断 lane/owner：
  `scripts/graphrag/batch-epub-workflow.mjs:2428-2447`,
  `scripts/graphrag/batch-epub-workflow.mjs:2450-2480`。
- Shared durable store 同样允许 fallback：
  `src/job-state/durable-state-store.ts:1741-1767`,
  `src/job-state/durable-state-store.ts:1772-1798`。

至少以下生产目标未被显式、正确映射：

- `events.jsonl` 设计上受 eventWriterLane 保护：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:202-205`。
  但 runner mapping table 没有 `events.jsonl` 规则：
  `scripts/graphrag/batch-epub-workflow.mjs:238-347`。
  `event()` 写入 `eventsPath` 时通过 fallback 进入
  `manifestWriterLane`：
  `scripts/graphrag/batch-epub-workflow.mjs:3713-3743`,
  `scripts/graphrag/batch-epub-workflow.mjs:2462`。
- `qmd_row_count.json` 设计上显式属于 artifactValidation owner：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:344-349`。
  shared store 表中有该规则：
  `src/job-state/durable-state-store.ts:155-160`；
  runner adapter 表中没有对应规则：
  `scripts/graphrag/batch-epub-workflow.mjs:238-347`。
  runner 读取/reconcile row-count sidecar 时因此走 `/books/`
  fallback：
  `scripts/graphrag/batch-epub-workflow.mjs:6445-6449`,
  `scripts/graphrag/batch-epub-workflow.mjs:2460`,
  `scripts/graphrag/batch-epub-workflow.mjs:2480`。
- `qmd_output_manifest.json` 被 durable JSON 写入：
  `src/job-state/graphrag-book.ts:1688-1693`；
  runner 迁移也会写入：
  `scripts/graphrag/batch-epub-workflow.mjs:7105-7134`。
  该目标不在 Type DD targetMapping 列表中：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241-355`。
- `catalog/provider-requests/{artifactId}.json` 被 durable JSON 写入：
  `src/integrations/graphrag.ts:147-165`。
  该目标同样不在 Type DD targetMapping 列表中：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241-355`。

影响 criteria：I01、I02。

### BF-02: qmd output manifest 迁移绕过 read-before-reconcile 与 per-target lock

`migrateGraphOutputProducerManifests()` 对
`qmd_output_manifest.json` 直接执行 `JSON.parse(readFileSync(...))`，
随后直接调用 `writeJsonAtomic()`：
`scripts/graphrag/batch-epub-workflow.mjs:7105-7134`。

该路径没有先调用已存在的 durable read/reconcile 路径
`readGraphOutputProducerManifest()`：
`scripts/graphrag/batch-epub-workflow.mjs:6323-6326`，
也没有通过 `writeTypedJson()`/`withJsonFileLock()` wrapper：
`scripts/graphrag/batch-epub-workflow.mjs:5276-5284`。
`writeJsonAtomic()` 本身执行 temp/checksum/fsync，但不是 lock wrapper：
`scripts/graphrag/batch-epub-workflow.mjs:4036-4088`。

因此该迁移路径可能在未 reconcile checksum/generation 和未持有
per-target lock 的情况下提交 durable JSON，违反单一 durable boundary
与 lane 执行要求。

影响 criteria：I01、I02。

### BF-03: resume/claim preflight 调用存在，但扫描不是目标注册表驱动

runner 已在 claim 与 resume-book 前调用 preflight：
`scripts/graphrag/batch-epub-workflow.mjs:9520-9522`,
`scripts/graphrag/batch-epub-workflow.mjs:8915-8924`。
但 preflight 只扫描固定目录的一层 entry：
`scripts/graphrag/batch-epub-workflow.mjs:4440-4472`；
目标目录列表只包含 book output root 与 `output/artifacts`：
`scripts/graphrag/batch-epub-workflow.mjs:4475-4491`。

该范围不会在 beforeClaim/beforeResumeBook 阶段扫描嵌套目标，例如
`graph_vault/books/{bookId}/output/lancedb/*.lance/qmd_row_count.json`
及其 lock/temp/checksum sidecar。该目标在设计中是生产 durable JSON：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:344-349`，
并由实现写入/读取：
`src/job-state/graphrag-book.ts:1389-1406`,
`scripts/graphrag/batch-epub-workflow.mjs:6445-6449`。

runner_start preflight 还显式跳过 temp 扫描：
`scripts/graphrag/batch-epub-workflow.mjs:10335-10340`。
虽然 named tests 覆盖了 manifest orphan temp，但目标注册表级扫描缺口仍会让
部分 local state integrity 在 claim/resume 前未被阻断。

影响 criteria：I09。

## Criteria Checklist

### I01_single_durable_state_boundary: FAIL

证据：

- shared durable API 覆盖 YAML/JSON read/write/update：
  `src/job-state/durable-state-store.ts:209-327`。
- shared replace/reconcile/backfill/quarantine/cleanup/lock recovery 存在：
  `src/job-state/durable-state-store.ts:385-571`,
  `src/job-state/durable-state-store.ts:650-705`,
  `src/job-state/durable-state-store.ts:811-983`。
- runner adapter 对 JSON/YAML reconcile 已进入 per-target lock：
  `scripts/graphrag/batch-epub-workflow.mjs:4632-4636`,
  `scripts/graphrag/batch-epub-workflow.mjs:4767-4770`。
- `books.yaml` read-before-reconcile 已存在：
  `scripts/graphrag/batch-epub-workflow.mjs:5662-5667`。
- FAIL：`migrateGraphOutputProducerManifests()` 对
  `qmd_output_manifest.json` 直接 read/parse/write，绕过
  read-before-reconcile 与 per-target lock：
  `scripts/graphrag/batch-epub-workflow.mjs:7105-7134`。
- FAIL：runner/shared store target mapping 仍允许 fallback：
  `scripts/graphrag/batch-epub-workflow.mjs:2428-2447`,
  `src/job-state/durable-state-store.ts:1741-1767`。

### I02_target_mapping_and_lane_enforcement: FAIL

证据：

- 设计契约禁止并行 runner 写入未列入 targetMapping 的生产目标：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:224-228`。
- runner mapping table 缺少 `events.jsonl`、`qmd_row_count.json`、
  `qmd_output_manifest.json` 与 provider request artifact 规则：
  `scripts/graphrag/batch-epub-workflow.mjs:238-347`。
- `events.jsonl` 设计 lane 为 eventWriterLane：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:202-205`；
  实现通过 fallback 将 batch-run 路径推断到 manifestWriterLane：
  `scripts/graphrag/batch-epub-workflow.mjs:3713-3743`,
  `scripts/graphrag/batch-epub-workflow.mjs:2462`。
- row-count sidecar 设计 owner 为 artifactValidation：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:344-349`；
  runner 读取路径通过未显式映射的 fallback 执行：
  `scripts/graphrag/batch-epub-workflow.mjs:6445-6449`,
  `scripts/graphrag/batch-epub-workflow.mjs:2460`,
  `scripts/graphrag/batch-epub-workflow.mjs:2480`。
- `qmd_output_manifest.json` 与 provider request artifact 被 durable JSON 写入，
  但不在 Type DD targetMapping 中：
  `src/job-state/graphrag-book.ts:1688-1693`,
  `src/integrations/graphrag.ts:147-165`,
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:241-355`。

### I03_collision_resistant_temp_creation: PASS

证据：

- runner tempId 包含 operationId/randomUUID：
  `scripts/graphrag/batch-epub-workflow.mjs:2320-2323`。
- shared store tempId 包含 operationId/randomUUID：
  `src/job-state/durable-state-store.ts:1616-1622`。
- durable temp 与 checksum temp 使用 exclusive create (`wx`)：
  `scripts/graphrag/batch-epub-workflow.mjs:4050-4055`,
  `scripts/graphrag/batch-epub-workflow.mjs:4071-4076`,
  `src/job-state/durable-state-store.ts:403-405`,
  `src/job-state/durable-state-store.ts:419-421`。
- EEXIST 被分类为 `durable_temp_create_collision`：
  `scripts/graphrag/batch-epub-workflow.mjs:4016-4032`,
  `src/job-state/durable-state-store.ts:1409-1429`。
- 测试覆盖 same-ms 与 forced collision：
  `test/book-job-state.test.ts:420-457`,
  `test/book-job-state.test.ts:3538-3575`,
  `test/cli.test.ts:2752-2817`。

### I04_owner_evidence_and_cleanup_safety: PASS

证据：

- runner operation/owner evidence 包含 tempId、operationId、runnerSessionId、
  owner、generation、fencing hash 等字段：
  `scripts/graphrag/batch-epub-workflow.mjs:2320-2369`。
- shared store operation/owner evidence 包含对应字段：
  `src/job-state/durable-state-store.ts:1616-1651`。
- runner cleanup decision 校验 owner、target、generation/fencing、TTL、
  target checksum、owner alive/lease expired：
  `scripts/graphrag/batch-epub-workflow.mjs:4176-4269`。
- shared cleanup 只在 owner/target/fence/stale/owner-dead 或 lease-expired
  证据满足时删除：
  `src/job-state/durable-state-store.ts:889-930`,
  `src/job-state/durable-state-store.ts:1528-1569`。
- 测试覆盖 fresh/stale temp、缺失 owner evidence 与 cleanup 诊断：
  `test/cli.test.ts:2883-3047`,
  `test/book-job-state.test.ts:569-657`。

### I05_lock_freshness_fencing_and_takeover: PASS

证据：

- shared lock owner schema 记录 owner、generation、fencing hash、
  heartbeat/expires 与 operationId：
  `src/job-state/durable-state-store.ts:1654-1677`。
- shared lock acquire、fencing assert、finally release 与 timeout 证据：
  `src/job-state/durable-state-store.ts:650-705`,
  `src/job-state/durable-state-store.ts:1571-1595`。
- shared stale lock recovery 要求 expired、recovery fence、local dead owner：
  `src/job-state/durable-state-store.ts:811-887`。
- runner JSON lock 记录 owner/fence/expiry，commit 前后校验，finally release：
  `scripts/graphrag/batch-epub-workflow.mjs:5090-5172`,
  `scripts/graphrag/batch-epub-workflow.mjs:5021-5067`。
- qmd index lock 在 parent runner 与 book runtime 中记录 generation/fence/
  operationId，并进行 guarded release：
  `scripts/graphrag/batch-epub-workflow.mjs:3185-3317`,
  `src/job-state/graphrag-book.ts:1240-1255`,
  `src/job-state/graphrag-book.ts:1293-1380`。
- 测试覆盖 lock timeout、stale lock preflight、qmd index lock acquire/release
  与 stale book lease fencing：
  `test/cli.test.ts:2641-2747`,
  `test/cli.test.ts:3386-3462`,
  `test/cli.test.ts:4905-4950`,
  `test/book-job-state.test.ts:3382-3441`。

### I06_atomic_replace_and_fsync_boundary: PASS

证据：

- runner durable replace 顺序为 owner evidence、temp write/fsync、
  pending checksum meta、rename target、checksum temp、rename checksum、
  committed meta、parent fsync：
  `scripts/graphrag/batch-epub-workflow.mjs:4036-4088`。
- shared durable replace 实现同等顺序：
  `src/job-state/durable-state-store.ts:385-437`。
- file fsync 与 directory fsync failure 分类为 local state integrity，
  completedPublishRule 为 forbidden：
  `scripts/graphrag/batch-epub-workflow.mjs:2715-2795`,
  `src/job-state/durable-state-store.ts:1335-1407`。
- 测试覆盖 directory fsync failure 阻断 completed：
  `test/cli.test.ts:2821-2881`。

### I07_checksum_generation_crash_window_recovery: PASS

证据：

- runner checksum commit evidence 要求 operationId、runnerSessionId、
  fencingTokenHash、targetGeneration 与 pending state：
  `scripts/graphrag/batch-epub-workflow.mjs:3922-3935`。
- runner reconcile 区分 old checksum、missing checksum、pending meta、
  metadata backfill、quarantine/stop_until_fixed：
  `scripts/graphrag/batch-epub-workflow.mjs:4673-4764`,
  `scripts/graphrag/batch-epub-workflow.mjs:4808-4900`。
- shared store reconcile/backfill/quarantine 具有同类分支：
  `src/job-state/durable-state-store.ts:495-571`,
  `src/job-state/durable-state-store.ts:575-648`,
  `src/job-state/durable-state-store.ts:1467-1478`。
- 测试覆盖 JSON checksum recovery/quarantine、partial sidecar preflight 与
  row-count durable checksum：
  `test/book-job-state.test.ts:459-536`,
  `test/cli.test.ts:3280-3384`,
  `test/book-job-state.test.ts:1777-1816`。

### I08_rename_enoent_failure_classification: PASS

证据：

- runner rename ENOENT 分类为 `local_state_integrity` /
  `durable_temp_rename_enoent`，记录 tempId、operationId、target、
  failedSyscall、errno、renameCause 与 completedPublishRule：
  `scripts/graphrag/batch-epub-workflow.mjs:3956-3979`,
  `scripts/graphrag/batch-epub-workflow.mjs:3985-3999`。
- shared store rename ENOENT 使用同类 DurableStateError：
  `src/job-state/durable-state-store.ts:1194-1248`。
- failure classifier 保留 durable local failure，不降级为 provider transient：
  `scripts/graphrag/batch-failure-classifier.mjs:83-117`。
- 测试覆盖 checkpoint、event 与 recovery summary 证据字段：
  `test/cli.test.ts:3601-3734`。

### I09_resume_preflight_and_runner_recovery: FAIL

证据：

- beforeResumeBook preflight 已存在：
  `scripts/graphrag/batch-epub-workflow.mjs:8915-8924`。
- beforeClaim preflight 已存在：
  `scripts/graphrag/batch-epub-workflow.mjs:9520-9522`。
- preflight blocker 会写 `durable_preflight_blocked` 并抛出
  stop_until_fixed：
  `scripts/graphrag/batch-epub-workflow.mjs:4494-4534`。
- FAIL：preflight 扫描只读取固定目录一层 entry：
  `scripts/graphrag/batch-epub-workflow.mjs:4440-4472`；
  目标列表不包含 nested LanceDB table dirs：
  `scripts/graphrag/batch-epub-workflow.mjs:4475-4491`。
- FAIL：`qmd_row_count.json` 是设计中的生产 durable JSON，但
  beforeClaim/beforeResumeBook 不会递归扫描其 lock/temp/checksum sidecar：
  `docs/architecture/graphrag-parallel-runner.type-dd.yaml:344-349`,
  `src/job-state/graphrag-book.ts:1389-1406`,
  `scripts/graphrag/batch-epub-workflow.mjs:6445-6449`。
- runner_start preflight 还跳过 temp 扫描：
  `scripts/graphrag/batch-epub-workflow.mjs:10335-10340`。
- 测试覆盖 manifest orphan temp 阻断，但不覆盖 nested durable target
  preflight：
  `test/cli.test.ts:3464-3599`。

### I10_regression_tests_and_observability: PASS

证据：

- local durable failure classifier 测试：
  `test/cli.test.ts:2606-2639`。
- lock timeout、forced temp collision、directory fsync、temp reconcile、
  partial checksum、stale lock、resume orphan temp、rename ENOENT 测试：
  `test/cli.test.ts:2641-2819`,
  `test/cli.test.ts:2821-3047`,
  `test/cli.test.ts:3280-3599`,
  `test/cli.test.ts:3601-3734`。
- qmd index lock acquire/release 测试：
  `test/cli.test.ts:4905-4950`。
- durable JSON/YAML checksum、same-ms temp、row-count sidecar、
  graph capability fencing 测试：
  `test/book-job-state.test.ts:420-536`,
  `test/book-job-state.test.ts:1777-1816`,
  `test/book-job-state.test.ts:3336-3575`。
- checkpoint/event/recovery summary 暴露 local state evidence：
  `test/cli.test.ts:3686-3734`。
- recovery summary/status 输出路径存在：
  `scripts/graphrag/batch-epub-workflow.mjs:8062-8070`。
