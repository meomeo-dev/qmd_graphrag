Status: FAIL

# Implementation Audit R8 - Agent A

审计基准：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-a/implementation-criteria.yaml`
中的 10 条固定 criteria。

结论：9 PASS，1 FAIL。R7 agent-a 的 targetMapping fallback、未映射生产目标、
`qmd_output_manifest.json` 迁移绕过 durable read/reconcile 与 per-target lock
两类 blocker 已有实质闭合；但 beforeClaim / beforeResumeBook preflight 仍不是
targetMapping 注册表驱动，无法覆盖嵌套生产 durable target，preflight 目标覆盖
与观测闭环未完全闭合。

本轮为只读审计。未修改 criteria 或生产代码，未读取 `.env`，未启动真实 EPUB
runner。`reports/status.json` 在仓库根不存在，本轮读取的是本审计目录下的
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json`。

## Blocking Findings

### BF-01: beforeClaim / beforeResumeBook preflight 未覆盖嵌套生产 durable target

固定 criteria I09 要求 batch runner 在 claim 新 item 与 resume-book 子进程前
扫描 durable lock、temp、checksum/generation、subprocess registry、provider slot
与 book lease；发现 unknown/live temp、不可收敛 checksum、不可判定 lock owner
或 local state integrity 失败时，必须 `stop_until_fixed`，不能继续 claim 或发布
completed。

设计也要求 beforeClaim / beforeResumeBook 扫描 durable lock owner、temp、
target/checksum 或 target/generation、一组 registry/lease，并在异常时阻断 claim
或 resume：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:903-916`。

当前实现确实在 claim 与 resume-book 前调用 preflight：
`scripts/graphrag/batch-epub-workflow.mjs:9673-9675`,
`scripts/graphrag/batch-epub-workflow.mjs:9068-9077`。

但 preflight 扫描函数只对传入目录执行一层 `readdirSync()`，未递归展开子目录：
`scripts/graphrag/batch-epub-workflow.mjs:4560-4592`。
目标目录集合仍是固定目录列表，只包含 batch run registry、book 根目录、
book `runs`、book `output` 和 `output/artifacts`：
`scripts/graphrag/batch-epub-workflow.mjs:4595-4611`。

因此它不会在 beforeClaim / beforeResumeBook 阶段扫描嵌套目标，例如：
`graph_vault/books/{bookId}/output/lancedb/*.lance/qmd_row_count.json`。
该目标是设计中明确列入 targetMapping 的生产 durable JSON：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:398-408`，
实现的 runner targetMapping 也将其列为生产 target：
`scripts/graphrag/batch-epub-workflow.mjs:384-395`。

该目标确有生产 durable 写入与读取路径：book runtime 写入 row-count sidecar
使用 durable JSON：
`src/job-state/graphrag-book.ts:1389-1406`；runner artifact gate 读取时对该
sidecar 执行 durable JSON reconcile 后读取：
`scripts/graphrag/batch-epub-workflow.mjs:6576-6580`；共享 artifact validation
也通过 durable JSON reader 读取：
`src/job-state/artifact-validation.ts:190-204`。

影响：如果 `qmd_row_count.json` 或其 `.sha256`、`.sha256.meta.json`、`.lock`、
`.tmp-*` sidecar 在嵌套 LanceDB table 目录中出现 unresolved temp、partial
checksum sidecar 或不可判定 lock owner，当前 beforeClaim / beforeResumeBook
preflight 不会提前阻断。runner 可继续 claim 或启动 resume-book，直到后续
artifact validation 才可能发现问题；这不满足 I09 的“claim/resume 前扫描并阻断”
要求。

## R7 Blocker 复核

- targetMapping fallback / 未映射生产目标：已闭合。runner 显式映射
  `events.jsonl`、`provider-requests/*.json`、`qmd_output_manifest.json` 与
  `qmd_row_count.json`：
  `scripts/graphrag/batch-epub-workflow.mjs:300-346`,
  `scripts/graphrag/batch-epub-workflow.mjs:366-395`。生产 durable target 未命中
  显式表时抛 `durable_target_mapping_missing`，不再用路径 fallback 写入：
  `scripts/graphrag/batch-epub-workflow.mjs:2515-2534`。shared store 有同等阻断：
  `src/job-state/durable-state-store.ts:1852-1872`。

- `qmd_output_manifest.json` 迁移：已闭合主缺口。迁移路径改为先调用
  `readGraphOutputProducerManifest()`：
  `scripts/graphrag/batch-epub-workflow.mjs:7236-7249`；该 reader 执行 durable
  JSON reconcile：
  `scripts/graphrag/batch-epub-workflow.mjs:6454-6457`；迁移提交改用
  `writeTypedJson()`：
  `scripts/graphrag/batch-epub-workflow.mjs:7263-7271`，而 `writeTypedJson()` 在
  per-target lock 内写入：
  `scripts/graphrag/batch-epub-workflow.mjs:5394-5399`。

- preflight 目标覆盖与观测闭环：未闭合。见 BF-01。

## Criteria 判定矩阵

### I01_single_durable_state_boundary: PASS

共享 durable store 覆盖 YAML/JSON durable read/write/update、replace、
reconcile、checksum backfill、quarantine、lock recovery 与 temp cleanup：
`src/job-state/durable-state-store.ts:264-352`,
`src/job-state/durable-state-store.ts:447-452`,
`src/job-state/durable-state-store.ts:464-516`,
`src/job-state/durable-state-store.ts:574-650`,
`src/job-state/durable-state-store.ts:729-840`,
`src/job-state/durable-state-store.ts:968-1094`,
`src/job-state/durable-state-store.ts:1096-1219`,
`src/job-state/durable-state-store.ts:1382-1444`。
runner 保留同步 adapter，但声明等价契约并集中实现 target mapping、
exclusive temp、owner evidence、checksum 与 failure projection：
`scripts/graphrag/batch-epub-workflow.mjs:206-220`,
`scripts/graphrag/batch-epub-workflow.mjs:4156-4219`,
`scripts/graphrag/batch-epub-workflow.mjs:4752-5020`,
`scripts/graphrag/batch-epub-workflow.mjs:5210-5382`。
R7 中 `qmd_output_manifest.json` 迁移绕过 durable boundary 的主问题已闭合。

剩余风险：runner JSON reader 仍是 lock 内 reconcile 后再读取目标内容；当前未作为
blocking finding，因为提交路径与 reconcile/backfill/cleanup/lock recovery 已受锁。

### I02_target_mapping_and_lane_enforcement: PASS

设计要求未列入 targetMapping 的生产 durable target 不得由并行 runner 写入：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:224-228`。runner 与 shared
store 已显式映射 R7 指出的生产目标：
`scripts/graphrag/batch-epub-workflow.mjs:238-409`,
`src/job-state/durable-state-store.ts:57-216`。runner 与 shared store 对未映射生产
target 均抛 `durable_target_mapping_missing`：
`scripts/graphrag/batch-epub-workflow.mjs:2515-2534`,
`src/job-state/durable-state-store.ts:1852-1872`。写入 helper 使用 per-target lock
和 finally release：
`scripts/graphrag/batch-epub-workflow.mjs:5210-5292`,
`scripts/graphrag/batch-epub-workflow.mjs:5394-5399`,
`src/job-state/durable-state-store.ts:729-840`。

剩余风险：preflight 尚未从该 mapping 注册表派生扫描范围，见 I09。

### I03_collision_resistant_temp_creation: PASS

runner tempId 包含 pid、timestamp 与 UUID operationId：
`scripts/graphrag/batch-epub-workflow.mjs:2407-2456`；shared store 同样生成
UUID-backed operation evidence：
`src/job-state/durable-state-store.ts:1727-1762`。runner 与 shared store temp
创建使用 `wx` exclusive create：
`scripts/graphrag/batch-epub-workflow.mjs:4170-4175`,
`scripts/graphrag/batch-epub-workflow.mjs:4191-4196`,
`src/job-state/durable-state-store.ts:481-499`。EEXIST 被分类为
`durable_temp_create_collision`：
`scripts/graphrag/batch-epub-workflow.mjs:4136-4152`,
`src/job-state/durable-state-store.ts:1520-1541`。测试覆盖同毫秒写入和 forced
collision：
`test/book-job-state.test.ts:420-457`,
`test/book-job-state.test.ts:3556-3585`,
`test/cli.test.ts:2752-2817`。

剩余风险：无新增 blocking risk。

### I04_owner_evidence_and_cleanup_safety: PASS

runner owner evidence 包含 tempId、operationId、target、owner、generation、
fencing、createdAt 与 lease 信息：
`scripts/graphrag/batch-epub-workflow.mjs:2407-2456`；shared store owner evidence
字段同等：
`src/job-state/durable-state-store.ts:1727-1762`。runner cleanup decision 检查
owner、target、generation/fencing、target checksum、stale TTL、owner live 与
lease expiry：
`scripts/graphrag/batch-epub-workflow.mjs:4296-4389`。shared cleanup 检查 owner
target、createdAt、cleanup fence、target generation、TTL、owner alive 与 lease
expiry，并写 `.durable-recovery.jsonl`：
`src/job-state/durable-state-store.ts:968-1025`,
`src/job-state/durable-state-store.ts:1032-1094`。测试覆盖缺失 owner evidence、
stale temp 保留/清理与 recovery record：
`test/book-job-state.test.ts:569-670`,
`test/cli.test.ts:2883-3047`。

剩余风险：无新增 blocking risk。

### I05_lock_freshness_fencing_and_takeover: PASS

shared lock owner 记录 owner、generation、fencing hash、heartbeat/expiry 与
operationId：
`src/job-state/durable-state-store.ts:1765-1788`。shared lock acquire 在提交前后
验证 fencing，并 finally release：
`src/job-state/durable-state-store.ts:729-840`；stale lock recovery 需要 expired、
recovery fence 与 dead local owner，并写 recovery record：
`src/job-state/durable-state-store.ts:890-966`。runner JSON lock 记录同类 owner
evidence，提交前后验证并 finally release：
`scripts/graphrag/batch-epub-workflow.mjs:5141-5292`。qmd index lock 也带
generation/fencing/operationId：
`src/job-state/graphrag-book.ts:1293-1387`。

剩余风险：长 critical section heartbeat 仍主要依赖短区间约束，未发现本轮
blocking evidence。

### I06_atomic_replace_and_fsync_boundary: PASS

runner durable JSON replace 顺序为 owner evidence、temp write/fsync、pending
checksum meta、rename target、checksum temp、rename checksum、committed meta、
parent fsync：
`scripts/graphrag/batch-epub-workflow.mjs:4156-4219`。shared store 同等执行：
`src/job-state/durable-state-store.ts:464-516`,
`src/job-state/durable-state-store.ts:518-571`。file fsync 与 directory fsync
失败分类为 local state integrity，并带 completedPublishRule：
`src/job-state/durable-state-store.ts:1446-1517`,
`scripts/graphrag/batch-epub-workflow.mjs:2715-2795`。测试覆盖 directory fsync
failure 阻断 completed：
`test/cli.test.ts:2821-2881`。

剩余风险：无新增 blocking risk。

### I07_checksum_generation_crash_window_recovery: PASS

shared store 区分 missing checksum、target-new/checksum-old、pending meta、
invalid meta 与 checksum mismatch quarantine：
`src/job-state/durable-state-store.ts:594-650`,
`src/job-state/durable-state-store.ts:671-727`。commit evidence 要求 operationId、
runnerSessionId、fencingTokenHash 与 targetGeneration：
`src/job-state/durable-state-store.ts:1578-1590`。runner adapter 也处理
checksum missing/old/pending/mismatch 分支并 backfill/quarantine：
`scripts/graphrag/batch-epub-workflow.mjs:4793-4884`,
`scripts/graphrag/batch-epub-workflow.mjs:4928-5020`。测试覆盖 checksum recovery、
partial sidecar 与 quarantine：
`test/book-job-state.test.ts:459-526`,
`test/book-job-state.test.ts:1755-1785`,
`test/cli.test.ts:3207-3375`,
`test/cli.test.ts:13611-13733`。

剩余风险：preflight 对嵌套 row-count sidecar 的提前覆盖不足，归入 I09。

### I08_rename_enoent_failure_classification: PASS

shared store `renameWithEvidence()` / sync variant 将 ENOENT 分类为
`durable_temp_rename_enoent`，记录 failedSyscall、errno、renameCause 与 evidence：
`src/job-state/durable-state-store.ts:1305-1359`。runner adapter 同类分类在
rename wrapper 与 durable projection 中保留：
`scripts/graphrag/batch-epub-workflow.mjs:4080-4128`,
`scripts/graphrag/batch-epub-workflow.mjs:2606-2648`。failure classifier 在 provider
transient 前识别 durable rename ENOENT：
`scripts/graphrag/batch-failure-classifier.mjs:1-14`,
`scripts/graphrag/batch-failure-classifier.mjs:83-117`。测试覆盖 rename ENOENT
stop-until-fixed：
`test/cli.test.ts:3601-3738`。

剩余风险：cause matrix 仍偏粗粒度，但已满足“不降级为 provider transient /
unknown”的固定分类要求。

### I09_resume_preflight_and_runner_recovery: FAIL

见 BF-01。调用点存在：
`scripts/graphrag/batch-epub-workflow.mjs:9068-9077`,
`scripts/graphrag/batch-epub-workflow.mjs:9673-9675`；但扫描范围固定且非递归：
`scripts/graphrag/batch-epub-workflow.mjs:4560-4611`，无法覆盖嵌套生产 durable
target `qmd_row_count.json`：
`docs/architecture/graphrag-parallel-runner.type-dd.yaml:398-408`,
`scripts/graphrag/batch-epub-workflow.mjs:384-395`。

### I10_regression_tests_and_observability: PASS

状态文件记录预审验证已通过相关 test filters：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json:58-101`。
测试覆盖 same-ms temp、forced collision、directory fsync、active/stale temp、
partial checksum、stale lock、resume-book orphan temp、rename ENOENT 与 qmd index
lock：
`test/book-job-state.test.ts:420-457`,
`test/book-job-state.test.ts:569-670`,
`test/book-job-state.test.ts:1755-1785`,
`test/book-job-state.test.ts:3556-3585`,
`test/cli.test.ts:2752-2817`,
`test/cli.test.ts:2821-2881`,
`test/cli.test.ts:3207-3375`,
`test/cli.test.ts:3386-3462`,
`test/cli.test.ts:3464-3595`,
`test/cli.test.ts:3601-3738`,
`test/cli.test.ts:4905-4950`。
contract schema 与 runner recovery summary 暴露 durable diagnostics：
`src/contracts/batch-run.ts:134-186`,
`src/contracts/batch-run.ts:311-369`,
`src/contracts/batch-run.ts:371-421`,
`src/contracts/batch-run.ts:423-520`,
`scripts/graphrag/batch-epub-workflow.mjs:7912-8218`。

剩余风险：缺少针对 targetMapping 注册表驱动 preflight 覆盖嵌套 durable targets
的回归测试；该风险已由 I09 blocking finding 承载。
