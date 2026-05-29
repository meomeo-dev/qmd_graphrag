# Durable YAML Temp Collision 实施审计 R2

审计日期：2026-05-28

固定基准：
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-c/implementation-criteria.yaml`

## 结论

FAIL。

10 条固定基准中，I01 判定 PASS；I02 至 I10 判定 FAIL。R2 实现已经
引入统一 durable state store（持久状态存储）、唯一 temp 名、checksum
sidecar、部分 strict fsync、batch 观测字段和 classifier 优先级修复，但仍未
满足 lock fencing（锁栅栏）、live temp cleanup safety（活动临时文件清理
安全）、target-new/checksum-old crash window（崩溃窗口）、file fsync 分类、
直接调用链覆盖和 fault injection（故障注入）测试要求。

## 关键发现

1. per-target lock owner（单目标锁所有者）仍未满足固定字段和恢复校验。
   共享 durable store 的 lock owner 已写入 pid、host、runnerSessionId、
   generation、fencingTokenHash、targetLocator、operationId、heartbeatAt
   和 expiresAt，但 stale lock 删除只检查 mtime、host 和 pid liveness，未校验
   expiresAt、generation 或 fencing。batch runner 的 JSON file lock 还缺少
   generation、fencingTokenHash、heartbeatAt 和 expiresAt。

2. checksum recovery（校验和恢复）仍无法证明 target-new/checksum-old 可恢复。
   当前实现只有在 checksum meta 的 checksum 等于 target 实际 hash 时才回填
   checksum。真实写入顺序是先 rename target，再写 checksum，再写 meta；若在
   target rename 后、checksum/meta 更新前崩溃，旧 checksum 与旧 meta 均不匹配
   新 target，下一次 reconcile 会 quarantine 有效 target。

3. fsync failure（同步失败）分类不完整。parent directory fsync 已分类为
   `durable_directory_fsync_uncertain`，但 file fsync 失败仍会作为原始 I/O
   错误抛出，缺少 fsyncTarget、fsyncErrno、fsyncPlatform、durableMode 和
   completedPublishRule=forbidden。

4. batch observability（批处理观测）字段虽然已进入 schema，但不是所有本地
   durable 失败都会稳定投影到 item checkpoint、event、status-json 和 recovery
   summary。尤其是通过 subprocess stderr 进入 classifier 的 durable 失败只得到
   localFailureClass，通常缺少 redactedEvidenceLocator、tempId、operationId 等
   证据字段。

5. fault injection 测试仍不足，并且当前相关测试存在失败信号。已有测试覆盖
   same-ms temp、部分 checksum、temp reconcile、classifier 和 parallel runner，
   但没有直接注入 rename ENOENT、file/directory fsync failure、真实 lock
   timeout、target-new/checksum-old 崩溃窗口，且未证明所有本地 durable state
   失败不会发布错误 completed。

## 固定基准逐项判定

| ID | 判定 | 摘要 |
| --- | --- | --- |
| I01_temp_identity_exclusive_create | PASS | temp 名和 `wx` 独占创建已覆盖主要受审 durable YAML/JSON replace 写入。 |
| I02_single_durable_boundary | FAIL | 仍有 raw YAML/JSON read/parse 和 DSPy artifact write 旁路未纳入等价 durable 契约。 |
| I03_lock_owner_fencing | FAIL | lock owner 字段和 stale lock 删除校验不满足 fencing 要求。 |
| I04_live_temp_cleanup_safety | FAIL | temp cleanup 缺 target generation 校验，异常删除未 fail closed。 |
| I05_checksum_commit_recovery | FAIL | target-new/checksum-old 仍可能误隔离新 target，缺 generation 级收敛证据。 |
| I06_fsync_platform_failure | FAIL | directory fsync 有分类，file fsync 失败未分类为本地 durable state failure。 |
| I07_batch_observability_schema | FAIL | schema 字段存在，但 classifier-only 和 temp cleanup 路径不能稳定输出全部必需字段。 |
| I08_failure_classifier_mapping | FAIL | 本地 durable 分类优先级正确，但 classifier 输出缺 recoveryDecision=stop_until_fixed。 |
| I09_direct_call_chain_coverage | FAIL | settings projection、batch catalog reader、DSPy artifact paths 等仍未完全纳入修复边界。 |
| I10_fault_injection_tests | FAIL | 缺少关键故障注入测试，且当前定向测试有失败和超时。 |

## 证据

### I01 PASS：temp 身份与独占创建

共享 durable store 使用 `${path}.tmp-${operation.tempId}`，其中 tempId 包含
pid、Date.now 和 randomUUID；temp 与 checksum temp 写入均使用 `wx`：

- `src/job-state/durable-state-store.ts:224`
- `src/job-state/durable-state-store.ts:225`
- `src/job-state/durable-state-store.ts:232`
- `src/job-state/durable-state-store.ts:233`
- `src/job-state/durable-state-store.ts:971`
- `src/job-state/durable-state-store.ts:972`

batch runner 内部 durable JSON adapter 也使用同类 tempId 和 `wx`：

- `scripts/graphrag/batch-epub-workflow.mjs:2093`
- `scripts/graphrag/batch-epub-workflow.mjs:2095`
- `scripts/graphrag/batch-epub-workflow.mjs:3405`
- `scripts/graphrag/batch-epub-workflow.mjs:3406`
- `scripts/graphrag/batch-epub-workflow.mjs:3413`
- `scripts/graphrag/batch-epub-workflow.mjs:3422`

同 pid 同毫秒场景已有测试覆盖：

- `test/book-job-state.test.ts:419`
- `test/book-job-state.test.ts:424`
- `test/book-job-state.test.ts:449`
- `test/book-job-state.test.ts:451`
- `test/book-job-state.test.ts:3397`
- `test/book-job-state.test.ts:3402`

### I02 FAIL：单一 durable 边界

repository、capability catalog、settings projection 写入、python bridge 和
durable-json 已接入共享 durable store：

- `src/job-state/repository.ts:70`
- `src/job-state/repository.ts:400`
- `src/graphrag/capability-catalog.ts:31`
- `src/graphrag/capability-catalog.ts:350`
- `src/graphrag/settings-projection.ts:8`
- `src/graphrag/settings-projection.ts:263`
- `src/integrations/python-bridge.ts:11`
- `src/integrations/python-bridge.ts:155`
- `src/job-state/durable-json.ts:1`

但仍存在未纳入同等 reconcile/checksum/failure 分类的 durable YAML/JSON 旁路：

- `src/graphrag/settings-projection.ts:326` 直接读取 settings.yaml。
- `src/graphrag/settings-projection.ts:373` 同步路径直接读取 settings.yaml。
- `src/graphrag/settings-projection.ts:416` assert 路径直接读取 settings.yaml。
- `scripts/graphrag/batch-epub-workflow.mjs:4402` 直接读取并解析
  `graph_vault/catalog/books.yaml`。
- `src/dspy/policy-store.ts:189` 直接 `YAML.parse(readFileSync(...))` 读取 DSPy
  YAML registry。
- `src/dspy/policy-store.ts:632`、`:1212`、`:1329` 直接写入 policy artifact
  文件，其中 JSONL artifact 未使用 durable temp/checksum/lock 契约。

这些旁路不满足“无未声明裸 rename/writeFile/YAML parse 旁路”的固定要求。

### I03 FAIL：lock owner 与 fencing

共享 durable store 的 lock owner 字段已经接近要求：

- `src/job-state/durable-state-store.ts:990`
- `src/job-state/durable-state-store.ts:1004`

但 stale lock 删除只检查 mtime、host 和 pid liveness，未校验 expiresAt、
generation 或 fencingTokenHash，也未记录 `durable_lock_recovered`：

- `src/job-state/durable-state-store.ts:495`
- `src/job-state/durable-state-store.ts:506`
- `src/job-state/durable-state-store.ts:518`
- `src/job-state/durable-state-store.ts:530`

batch runner 的 JSON file lock owner 字段更少，缺 generation、fencingTokenHash、
heartbeatAt 和 expiresAt：

- `scripts/graphrag/batch-epub-workflow.mjs:3895`
- `scripts/graphrag/batch-epub-workflow.mjs:3900`
- `scripts/graphrag/batch-epub-workflow.mjs:3909`
- `scripts/graphrag/batch-epub-workflow.mjs:3957`
- `scripts/graphrag/batch-epub-workflow.mjs:3962`
- `scripts/graphrag/batch-epub-workflow.mjs:3970`

对应 stale lock 删除仅依据 mtime 和 pid：

- `scripts/graphrag/batch-epub-workflow.mjs:3881`
- `scripts/graphrag/batch-epub-workflow.mjs:3888`

### I04 FAIL：live temp 清理安全性

共享 durable store 的 temp cleanup 会跳过 fresh temp 和 owner-alive temp，但没有
target generation 未推进校验，也不对 owner evidence 缺失或异常删除 fail
closed：

- `src/job-state/durable-state-store.ts:541`
- `src/job-state/durable-state-store.ts:554`
- `src/job-state/durable-state-store.ts:555`
- `src/job-state/durable-state-store.ts:558`
- `src/job-state/durable-state-store.ts:560`
- `src/job-state/durable-state-store.ts:562`

batch runner 的 cleanup 有更完整 owner evidence 和 lease-expired 判断，但同样
没有 target generation 校验；删除后只发 `durable_json_temp_reconciled` 或
`durable_yaml_temp_reconciled` pending event，不会进入 local_state_integrity
fail closed：

- `scripts/graphrag/batch-epub-workflow.mjs:3510`
- `scripts/graphrag/batch-epub-workflow.mjs:3519`
- `scripts/graphrag/batch-epub-workflow.mjs:3527`
- `scripts/graphrag/batch-epub-workflow.mjs:3535`
- `scripts/graphrag/batch-epub-workflow.mjs:3543`
- `scripts/graphrag/batch-epub-workflow.mjs:3683`
- `scripts/graphrag/batch-epub-workflow.mjs:3686`
- `scripts/graphrag/batch-epub-workflow.mjs:3773`
- `scripts/graphrag/batch-epub-workflow.mjs:3776`

测试只证明 fresh temp 被保留、stale temp 被删除，未证明 target generation 或
异常删除的 fail closed 语义：

- `test/cli.test.ts:2608`
- `test/cli.test.ts:2677`
- `test/cli.test.ts:2684`

### I05 FAIL：checksum 提交与恢复

实现支持 checksum missing、meta-matches-target 时的 checksum old 回填，以及无法
收敛时 quarantine：

- `src/job-state/durable-state-store.ts:332`
- `src/job-state/durable-state-store.ts:343`
- `src/job-state/durable-state-store.ts:347`
- `scripts/graphrag/batch-epub-workflow.mjs:3715`
- `scripts/graphrag/batch-epub-workflow.mjs:3729`
- `scripts/graphrag/batch-epub-workflow.mjs:3746`
- `scripts/graphrag/batch-epub-workflow.mjs:3805`
- `scripts/graphrag/batch-epub-workflow.mjs:3819`

但是写入顺序仍是先发布 target，再发布 checksum，再写 checksum meta：

- `src/job-state/durable-state-store.ts:232`
- `src/job-state/durable-state-store.ts:234`
- `src/job-state/durable-state-store.ts:241`
- `src/job-state/durable-state-store.ts:243`
- `src/job-state/durable-state-store.ts:248`
- `scripts/graphrag/batch-epub-workflow.mjs:3412`
- `scripts/graphrag/batch-epub-workflow.mjs:3414`
- `scripts/graphrag/batch-epub-workflow.mjs:3421`
- `scripts/graphrag/batch-epub-workflow.mjs:3426`
- `scripts/graphrag/batch-epub-workflow.mjs:3432`

若进程在 target rename 后、checksum/meta 发布前崩溃，旧 checksum 和旧 meta
都不会等于新 target hash。当前逻辑会进入 checksum_mismatch quarantine，而不是
用 generation 或 operation evidence 收敛。因此“新 target 不因旧 checksum 被
误隔离”的 passCondition 未满足。

### I06 FAIL：fsync 平台失败处理

parent directory fsync 已分类为 local durable state failure，并带有观测字段：

- `src/job-state/durable-state-store.ts:859`
- `src/job-state/durable-state-store.ts:868`
- `src/job-state/durable-state-store.ts:873`
- `src/job-state/durable-state-store.ts:877`
- `scripts/graphrag/batch-epub-workflow.mjs:2293`
- `scripts/graphrag/batch-epub-workflow.mjs:2300`
- `scripts/graphrag/batch-epub-workflow.mjs:2304`
- `scripts/graphrag/batch-epub-workflow.mjs:2308`

file fsync 失败未被包装为 DurableStateError，也不会带 fsyncTarget/fsyncErrno：

- `src/job-state/durable-state-store.ts:711`
- `src/job-state/durable-state-store.ts:714`
- `src/job-state/durable-state-store.ts:718`
- `src/job-state/durable-state-store.ts:720`
- `scripts/graphrag/batch-epub-workflow.mjs:2328`
- `scripts/graphrag/batch-epub-workflow.mjs:2330`

固定要求同时覆盖 file fsync 和 parent directory fsync，因此本项 FAIL。

### I07 FAIL：batch 观测 schema

contract schema 和 runner 内联 schema 已加入 failureKind、localFailureClass、
recoveryDecision、failedStage、redactedEvidenceLocator、tempId、operationId、
checksumRecoveryDecision、fsyncTarget 等字段：

- `src/contracts/batch-run.ts:134`
- `src/contracts/batch-run.ts:164`
- `src/contracts/batch-run.ts:205`
- `src/contracts/batch-run.ts:222`
- `src/contracts/batch-run.ts:325`
- `src/contracts/batch-run.ts:344`
- `scripts/graphrag/batch-epub-workflow.mjs:780`
- `scripts/graphrag/batch-epub-workflow.mjs:797`

recovery summary 也投影 durable fields：

- `scripts/graphrag/batch-epub-workflow.mjs:6642`
- `scripts/graphrag/batch-epub-workflow.mjs:6672`
- `scripts/graphrag/batch-epub-workflow.mjs:6773`

但字段存在不等于所有路径稳定填充。通过 subprocess stderr 进入
`classifyFailure()` 的 durable failure 只得到 localFailureClass；`runCommand()`
只从 `result.error` 提取 durable evidence，子进程 stderr 场景通常没有
redactedEvidenceLocator、tempId 或 operationId：

- `scripts/graphrag/batch-epub-workflow.mjs:7303`
- `scripts/graphrag/batch-epub-workflow.mjs:7305`
- `scripts/graphrag/batch-epub-workflow.mjs:7329`
- `scripts/graphrag/batch-epub-workflow.mjs:7341`
- `scripts/graphrag/batch-epub-workflow.mjs:7367`

temp reconcile 事件也不是 local_state_integrity failure 事件，缺 failureKind、
recoveryDecision 和 failedStage 的强制语义：

- `scripts/graphrag/batch-epub-workflow.mjs:3686`
- `scripts/graphrag/batch-epub-workflow.mjs:3699`
- `scripts/graphrag/batch-epub-workflow.mjs:3776`
- `scripts/graphrag/batch-epub-workflow.mjs:3789`

### I08 FAIL：failure classifier 映射

classifier 已把本地 durable state 分类放在 provider transient 之前：

- `scripts/graphrag/batch-failure-classifier.mjs:7`
- `scripts/graphrag/batch-failure-classifier.mjs:14`
- `scripts/graphrag/batch-failure-classifier.mjs:47`

映射覆盖 rename ENOENT、live temp deletion、checksum old/missing/mismatch、fsync
failure 和 lock timeout：

- `scripts/graphrag/batch-failure-classifier.mjs:100`
- `scripts/graphrag/batch-failure-classifier.mjs:126`
- `scripts/graphrag/batch-failure-classifier.mjs:135`
- `scripts/graphrag/batch-failure-classifier.mjs:144`
- `scripts/graphrag/batch-failure-classifier.mjs:154`
- `scripts/graphrag/batch-failure-classifier.mjs:164`
- `scripts/graphrag/batch-failure-classifier.mjs:170`
- `scripts/graphrag/batch-failure-classifier.mjs:176`
- `scripts/graphrag/batch-failure-classifier.mjs:345`

但 classifier 输出本身只返回 failureKind、retryable 和 localFailureClass，未返回
`recoveryDecision: "stop_until_fixed"`，不满足 passCondition：

- `scripts/graphrag/batch-failure-classifier.mjs:83`
- `scripts/graphrag/batch-failure-classifier.mjs:97`

已有测试仅覆盖部分字符串，不覆盖 live temp deletion、checksum missing、file
fsync failure 和 stop_until_fixed 输出：

- `test/cli.test.ts:2574`
- `test/cli.test.ts:2605`

### I09 FAIL：直接调用链覆盖

主链路已有明显改善：repository、capability catalog、settings projection 写入、
python bridge 和 durable-json 已使用共享 durable store；batch runner 也实现了
内部 adapter。

仍未覆盖的受审路径包括：

- settings projection 对 `settings.yaml` 的 raw read/parse：
  `src/graphrag/settings-projection.ts:326`、`:373`、`:416`。
- batch runner 对 `catalog/books.yaml` 的 raw read/parse：
  `scripts/graphrag/batch-epub-workflow.mjs:4402`。
- DSPy policy store raw YAML read 和 JSONL artifact write：
  `src/dspy/policy-store.ts:189`、`:632`、`:1212`、`:1329`。

此外，shared durable store 的 live temp cleanup、file fsync 和
target-new/checksum-old 仍未满足 I04/I05/I06，因此无法证明任一受审 durable
YAML/JSON 写入路径都不会复现 live temp deletion 或未分类 local state integrity
失败。

### I10 FAIL：fault injection 测试

已有测试覆盖：

- 同 pid 同毫秒 durable YAML temp：
  `test/book-job-state.test.ts:419`。
- durable JSON checksum backfill/quarantine：
  `test/book-job-state.test.ts:458`。
- graph capability same-ms temp：
  `test/book-job-state.test.ts:3397`。
- batch temp reconcile：
  `test/cli.test.ts:2608`。
- parallel runner：
  `test/cli.test.ts:2775`。
- classifier priority 片段：
  `test/cli.test.ts:2574`。

仍缺少：

- rename ENOENT 的真实 fault injection。
- file fsync 与 directory fsync failure/unsupported injection。
- target-new/checksum-old crash window 注入。
- lock timeout 的真实等待/owner evidence 验证。
- 多 worker 同目标 durable write 的失败注入。
- 所有本地 durable state 失败都写出 checkpoint、event、status-json 和 recovery
  summary 字段的端到端断言。

## 专项核对：test-only command matrix narrowing

本项未发现削弱生产闭环（production closed loop）的证据。生产默认仍使用完整
command matrix：

- `scripts/graphrag/batch-epub-workflow.mjs:239`
- `scripts/graphrag/batch-epub-workflow.mjs:267`
- `scripts/graphrag/batch-epub-workflow.mjs:272`
- `scripts/graphrag/batch-epub-workflow.mjs:300`

测试缩窄只在 `QMD_GRAPHRAG_ENABLE_TEST_HOOKS=1` 时启用，且必须保留两个
GraphRAG query check；未知项、重复项或缺少 graph query check 会抛错：

- `scripts/graphrag/batch-epub-workflow.mjs:273`
- `scripts/graphrag/batch-epub-workflow.mjs:276`
- `scripts/graphrag/batch-epub-workflow.mjs:281`
- `scripts/graphrag/batch-epub-workflow.mjs:282`
- `scripts/graphrag/batch-epub-workflow.mjs:285`
- `scripts/graphrag/batch-epub-workflow.mjs:292`

test runner hooks 还要求相关环境变量在 process 初始环境中存在，避免 dotenv
后注入直接启用测试 runner：

- `scripts/graphrag/batch-epub-workflow.mjs:7056`
- `scripts/graphrag/batch-epub-workflow.mjs:7065`
- `scripts/graphrag/batch-epub-workflow.mjs:7070`
- `scripts/graphrag/batch-epub-workflow.mjs:7079`

## 验证结果

已运行定向测试。测试结果不能支持 R2 通过。

1. `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/book-job-state.test.ts -t "durable|same-ms|checksum|collision-resistant"`

   结果：FAIL。5 passed，3 failed，56 skipped。

   失败项：

   - `recovers book job YAML checksums and quarantines corrupt targets`：
     期望 reject，但当前实现 resolve 了 book job。
   - `validates LanceDB row-count sidecars through durable checksums`：
     期望 `{ valid: false }`，实际 `{ valid: true }`。
   - `recovers and quarantines graph capability catalog durable checksum state`：
     60s timeout。

2. `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 120000 test/cli.test.ts -t "durable state classifier|durable reconcile|book-concurrency 2 runs multiple books|updates batch checkpoint heartbeat|terminal evidence checksum|row-count durable checksum"`

   结果：FAIL。5 passed，2 failed，231 skipped。

   失败项：

   - `migrate-only reopens completed item when terminal evidence checksum is corrupt`：
     exitCode 为 1，但 stderr 为 `durable json checksum_mismatch`，不包含测试期望的
     `invalid durable JSON target`。
   - `migrate-only rejects corrupt LanceDB row-count durable checksum`：
     期望 exitCode 1，实际 exitCode 0。

这些失败说明当前测试与 checksum recovery 语义仍未收敛。若 checksum 文件损坏但
checksum meta 仍能证明 target hash，当前实现会恢复 checksum；这是 I05 中
checksum partial write recovery 的合理方向。但现有测试没有改成同时破坏 meta 或
注入真实 target-new/checksum-old crash window，因此既不能证明 fail closed，也不能
证明 crash-window recovery。

## 审计结论

R2 实现尚不能关闭
`durable YAML temp rename ENOENT` 生产失败项。当前代码已经降低同 pid/同毫秒
temp collision 风险，并改进了部分 batch observability 和 classifier 优先级；
但 fixed-10 基准要求的是完整 durable state contract（持久状态契约）和可测试的
fail closed 语义。剩余缺口集中在 lock fencing、temp cleanup generation 保护、
checksum generation/recovery matrix、file fsync 分类、直接调用链旁路和故障注入
测试。
