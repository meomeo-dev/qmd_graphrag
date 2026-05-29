# GraphRAG 多书并行 Runner 生产实现复审 reaudit_5

## 结论

status: fail

固定基准文件为 `dev-agent-c/criteria.md`，SHA-256 为
`44829b40c6d6373b6bed0b93051a776627b4020b70070dcde1cd39f46fa04b0c`。
本轮只读复核当前 worktree，确认 reaudit_5 点名的 durable sidecar
修复大部分已经落到生产读路径：book-state YAML、GraphRAG identity
sidecar、producer manifest、LanceDB row-count sidecar 均有
checksum/reconcile/quarantine 证据。新增行为测试也覆盖了 duplicate
canonical book 排他、stale terminal checkpoint/event 拒绝、same-host
live orphan termination、parallel fail-fast quiesce，以及 sidecar recovery。

但按固定 10 条生产基准（fixed production baseline）逐条判定，仍存在
阻塞项：`.qmd/index.sqlite` 不是所有写入路径都受 qmd index lock 保护；
GraphRAG Python bridge 子进程没有 durable registry/process-group 边界；
subprocess registry 未记录 provider slot generation/fencing token；部分
GraphRAG catalog 写入不满足 durable write contract；status-json 缺少
固定要求的 worker 与真实 provider wait 观测；相应黑盒测试仍未证明这些
生产不变量。

## 固定基准逐条判定

| # | 基准 | 判定 | 复审结论 |
|---|---|---|---|
| 1 | coordinator exclusivity | pass | `coordinator-lock.json` 含 session/pid/heartbeat/expiry/generation/fencing，并在 acquire/heartbeat/release 中经文件锁 CAS 校验；第二 live coordinator 拒绝路径发生在写事件之前。 |
| 2 | item/book lease fencing | partial | book lease、item checkpoint、terminal event、repository YAML、producer manifest、qmd corpus registration 已有 fencing；但 qmd index 与 GraphRAG catalog 的全写入路径仍未全部 fenced/durable。 |
| 3 | provider durable semaphore | fail | provider slot lease 有容量门、stale recovery、release fencing；但 subprocess record 只保存 `providerSlotId`，没有 provider/generation/fencing token，未满足“子进程记录完整 provider slot fence”。 |
| 4 | qmd index writer lane/file lock | fail | runner 只包裹 `qmd-pull/update/embed/cleanup`；多数 qmd CLI 命令启动 `createStore()`/`syncConfigToDb()` 时仍会写 `.qmd/index.sqlite`，没有统一 file lock。 |
| 5 | subprocess process-group recovery | fail | batch 顶层 `spawnCommand()` 有 durable registry 和 process-group kill；但 GraphRAG Python bridge 内部 child 未登记 durable registry，也没有独立 process group。 |
| 6 | durable write contract | fail | batch JSON/YAML/sidecar 主路径已改进；但 GraphRAG provider request artifact 和 cost-accounting catalog 仍用普通 write/append，缺 temp/fsync/rename 或 fsync JSONL/tail recovery。 |
| 7 | terminal commit order | partial | completed checkpoint、`item_completed`、`item_worker_completed` 共享 finalization fence，且 release book lease 在 manifest/status 派生之后；仍未形成显式的 book checkpoint -> item checkpoint -> event 单一临界区。 |
| 8 | manifest/status-json projection | fail | manifest/status 主要从 durable checkpoints 派生；但 status item schema/输出没有 `workerId` 字段，`providerWaitMs` 对 active lease 固定为 0，未满足 worker/wait time 观测要求。 |
| 9 | bounded worker pool | pass | 单 coordinator 内 `bookConcurrency` worker pool、同 book defer、duplicate canonical book 测试、fail-fast sibling quiesce 测试均存在。此项仍受 #4/#5/#8 未闭合影响。 |
| 10 | behavioral evidence | fail | 新增测试覆盖本轮点名的部分场景；仍缺 qmd index 隐式写入竞争、GraphRAG bridge/grandchild process-group kill、provider slot registry 完整 fence、durable catalog crash recovery 等黑盒证据。 |

## Blocking Findings

### R5-B01: qmd index file lock 未覆盖所有 `.qmd/index.sqlite` 写入路径

- 违反基准：criteria 2、4、10
- 位置：
  - `scripts/graphrag/batch-epub-workflow.mjs:258`
  - `scripts/graphrag/batch-epub-workflow.mjs:6689`
  - `scripts/graphrag/batch-epub-workflow.mjs:6690`
  - `src/cli/qmd.ts:198`
  - `src/cli/qmd.ts:200`
  - `src/cli/qmd.ts:205`
  - `src/store.ts:855`
  - `src/store.ts:867`
  - `src/store.ts:1001`
  - `src/store.ts:2097`

当前 runner 只把 `qmd-pull`、`qmd-update`、`qmd-embed`、`qmd-cleanup`
放入 `qmdWriterCommandNames`，并据此进入 `withQmdIndexFileLock()`。
但是 qmd CLI 的 `getStore()` 会在首次使用时执行 `createStore()`，随后
`syncConfigToDb()`；`createStore()` 调用 `initializeDatabase()`，其中包含
`PRAGMA journal_mode = WAL`、DDL、trigger 重建、FTS normalization 版本写入等
SQLite 写操作。`qmd search`、`qmd query`、`qmd vsearch`、`qmd status`、
`qmd doctor`、`qmd get`、`qmd multi-get` 等命令均可能打开 store，因此即使
命令表面是 read path，也会写 `.qmd/index.sqlite`。

这违反第 4 条“qmd index writer lane 与文件锁必须覆盖 `.qmd/index.sqlite`
所有写入路径”。现有测试 `qmd writer commands acquire the qmd index file lock`
只验证四个显式 writer command 的事件，不覆盖这些隐式 DB 初始化/配置同步写入。

建议修复方向：

- 将 qmd index lock 下沉到 qmd store/openDatabase 边界，或通过环境变量让
  runner 子进程在任何可能写 index 的 `createStore()` 前必须获取同一 lock。
- 重新分类所有 batch 调用的 qmd 命令：只要会打开 `INDEX_PATH` 且可能触发
  PRAGMA/DDL/config sync/cache/FTS/vector 写入，就必须在锁内执行。
- 增加黑盒竞争测试：并发执行 `qmd search/query/status/get` 等看似只读命令，
  断言 lock acquire/release、bounded retry、无 SQLite busy/locked 泄漏。

### R5-B02: GraphRAG Python bridge 子进程不在 durable subprocess registry 中

- 违反基准：criteria 5、10
- 位置：
  - `src/integrations/python-bridge.ts:193`
  - `src/integrations/python-bridge.ts:194`
  - `src/integrations/python-bridge.ts:195`
  - `src/integrations/python-bridge.ts:196`
  - `src/integrations/python-bridge.ts:197`
  - `src/integrations/python-bridge.ts:229`
  - `src/integrations/python-bridge.ts:231`
  - `src/integrations/python-bridge.ts:234`
  - `scripts/graphrag/batch-epub-workflow.mjs:3360`
  - `scripts/graphrag/batch-epub-workflow.mjs:3365`
  - `scripts/graphrag/batch-epub-workflow.mjs:3367`
  - `scripts/graphrag/batch-epub-workflow.mjs:3397`

batch 顶层 `spawnCommand()` 使用 detached process group 并写 durable
subprocess record，这是进展。但 `callPythonBridge()` 仍直接 `spawn()` Python
bridge，未设置独立 process group，未写 batch subprocess registry，timeout/early
stop 只对 direct child 发 `SIGTERM`/`SIGKILL`。如果 resume/qmd 父进程异常退出，
内部 Python/grandchild 仍可能遗留；当前 takeover 恢复只基于登记的顶层 pid 判定，
当 process-group leader 已退出但组内子进程仍存活时，记录可能被标记 recovered，
而不会主动 kill 旧 process group。

这不满足第 5 条“每个 qmd/GraphRAG 命令必须登记 durable subprocess registry，
使用独立 process group，timeout 后先 terminate 再 kill 整个 process group”。

建议修复方向：

- 为 GraphRAG bridge 调用提供 runner-aware subprocess adapter：写入同一
  `subprocesses/*.json` registry，记录 pid/pgid、command、book/item/worker、
  provider slot fence，并在 close 后清理状态。
- 对 Python bridge 使用独立 process group，或至少把内部 child pid/pgid
  持久化，使 coordinator takeover 能终止 same-host orphan/grandchild。
- 增加测试：让 bridge 子进程继续存活而父 resume 进程退出，restart 必须 kill
  旧 process group 并记录恢复事件。

### R5-B03: subprocess registry 未记录 provider slot generation/fencing token

- 违反基准：criteria 3、5、8、10
- 位置：
  - `scripts/graphrag/batch-epub-workflow.mjs:352`
  - `scripts/graphrag/batch-epub-workflow.mjs:364`
  - `scripts/graphrag/batch-epub-workflow.mjs:6371`
  - `scripts/graphrag/batch-epub-workflow.mjs:6383`
  - `scripts/graphrag/batch-epub-workflow.mjs:6512`
  - `scripts/graphrag/batch-epub-workflow.mjs:6513`
  - `scripts/graphrag/batch-epub-workflow.mjs:6517`

`ProviderSlotLeaseSchema` 自身包含 provider、slot、generation、fencing token，
acquire/release event 也带这些字段。但 durable subprocess record schema 只保存
`providerSlotId`，没有 provider、providerSlotGeneration、
providerSlotFencingToken。`runCommand()` 确实把 generation/token 注入子进程
环境变量，但 registry 没有持久记录这些 fence 字段。

当 coordinator crash/restart 时，单靠 subprocess record 无法完整恢复“这个
provider-consuming child 属于哪个 provider slot generation/fence”，也无法用
registry 证明 child start 前获得的 slot lease 与 release/recovery 的 slot fence
一致。这不满足第 3 条对子进程记录 provider/slot/generation/fencing token 的要求。

建议修复方向：

- 扩展 `SubprocessRecordSchema` 和 `BatchSubprocessRecordSchema`，加入
  `providerSlotProvider`、`providerSlotGeneration`、
  `providerSlotFencingToken`。
- `spawnCommand()` 在成功和 spawn error 两条路径都持久化完整 provider slot
  fence；close/recovery event 同步输出这些字段。
- 增加负向测试：伪造同 slotId 但不同 generation/token 的 running subprocess
  与 provider slot lease，restart/release 必须拒绝错误 fence。

### R5-B04: GraphRAG catalog 写入仍不满足 durable write contract

- 违反基准：criteria 6、10
- 位置：
  - `src/integrations/graphrag.ts:162`
  - `src/integrations/graphrag.ts:163`
  - `src/provider/cost-accounting.ts:29`
  - `src/provider/cost-accounting.ts:30`
  - `src/provider/cost-accounting.ts:31`

本轮已修复的 durable JSON/YAML/sidecar 路径包括 book-state YAML、producer
manifest、GraphRAG identity sidecar、LanceDB row-count sidecar。但 GraphRAG
provider request artifact 仍直接 `writeFile()` 到
`catalog/provider-requests/*.json`；provider cost accounting 仍直接
`appendFile()` 到 `catalog/cost-accounting.jsonl`。这些路径属于 GraphRAG
catalog 状态，却没有 temp file、fsync file、atomic rename、fsync parent，也
没有 JSONL 单行 fsync、sequence/eventId 或尾部损坏恢复。

这违反第 6 条中 catalog durable write contract。崩溃时可能留下半写 catalog
artifact 或丢失 cost accounting 行，且没有 checksum/reconcile/quarantine 证据。

建议修复方向：

- provider request artifact 改用 durable JSON helper，写入 checksum 并在读路径
  reconcile/quarantine。
- cost-accounting JSONL 改为 append+fsync，增加 line-level schema 校验、
  sequence/eventId 或 checksum/tail recovery。
- 增加 crash recovery 测试：截断 provider request/cost catalog 后，resume/status
  必须 quarantine 或恢复，而不是静默接受损坏状态。

### R5-B05: status-json 缺少 worker 字段，provider wait time 不是真实派生值

- 违反基准：criteria 8、10
- 位置：
  - `src/contracts/batch-run.ts:299`
  - `src/contracts/batch-run.ts:331`
  - `src/contracts/batch-run.ts:332`
  - `src/contracts/batch-run.ts:333`
  - `scripts/graphrag/batch-epub-workflow.mjs:5865`
  - `scripts/graphrag/batch-epub-workflow.mjs:5871`
  - `scripts/graphrag/batch-epub-workflow.mjs:5872`
  - `scripts/graphrag/batch-epub-workflow.mjs:5942`
  - `scripts/graphrag/batch-epub-workflow.mjs:5943`
  - `scripts/graphrag/batch-epub-workflow.mjs:5944`

第 8 条要求 status-json 展示 provider slots、wait time、slot generation、
worker、running command 和 recovery decision。当前 recovery summary schema
与 projection 有 active provider slots、providerSlotGeneration、
active/current command、recoveryDecision，但没有 `workerId` 字段。workerId 只存在
于 checkpoint metadata 或 subprocess/provider lease metadata 中，未投影为
status-json 的稳定字段。

同时 `buildRecoverySummary()` 对 active provider lease 初始化
`providerWaitMs: 0`，未从 provider slot acquire event、lease acquiredAt、
队列等待或 durable events 重建真实 wait time。这个字段存在但语义不满足
“wait time” 观测要求。

建议修复方向：

- 在 `BatchRecoverySummaryItemSchema` 中加入稳定 `workerId` 字段，并从 running
  checkpoint metadata、book lease 或 subprocess record 派生。
- 将 provider wait time 从 durable provider slot events/lease metadata 派生；
  对无法重建的历史状态明确输出 unknown/null，不要固定为 0。
- 增加 status-json 测试，断言 running item 含 workerId、active command、
  provider slot generation、真实 waitMs/recovery decision。

### R5-B06: 行为测试仍未覆盖未闭合的生产不变量

- 违反基准：criteria 10
- 位置：
  - `test/cli.test.ts:3013`
  - `test/cli.test.ts:3026`
  - `test/cli.test.ts:3383`
  - `test/cli.test.ts:3388`
  - `test/cli.test.ts:3411`
  - `test/graphrag-book-state.test.ts:2875`
  - `test/graphrag-book-state.test.ts:2935`
  - `test/graphrag-book-state.test.ts:3051`
  - `test/book-job-state.test.ts:1316`
  - `test/book-job-state.test.ts:1351`

本轮新增测试覆盖了多项前序 blocking：duplicate canonical book defer、
stale terminal checkpoint/event 拒绝、same-host orphan termination、
parallel fail-fast quiesce、book-state YAML/sidecar recovery。仍不足以满足第
10 条固定测试基准：

- qmd index lock 测试只断言四个显式 writer command；没有覆盖 `qmd search`、
  `qmd query`、`qmd status` 等隐式 `createStore()`/`syncConfigToDb()` 写入。
- GraphRAG Python bridge 没有 durable registry/process-group/grandchild kill
  故障注入。
- provider slot stale release 测试当前没有注入 stale release；它只断言正常
  fixture 中没有 release rejection，不能证明错误 generation/token 无法删除当前
  slot。
- GraphRAG provider request artifact 与 cost-accounting catalog 没有 durable
  crash recovery 测试。
- status-json 缺 workerId 与真实 providerWaitMs 的行为断言。

建议修复方向：

- 将第 4、5、6、8 条的修复分别配套黑盒竞态/崩溃测试。
- 测试应验证负向拒绝和持久状态未变化，而不仅是事件字符串存在。

## 已确认闭合或改善的前序问题

- `coordinator-lock.json` live pid takeover 拒绝为 fail-closed；主流程先获取
  coordinator lock，随后才 reconcile/write event。
- book lease 与 item checkpoint fencing 覆盖 running/terminal checkpoint；
  terminal `item_completed` 与 `item_worker_completed` 共享
  `terminalFinalization` token。
- producer manifest 写入前后调用 `assertCurrentBatchBookLease()`，生产 resume
  调用传入 repo。
- qmd corpus registration 在 book lease 校验后进入 qmd index lock，并在 SQLite
  mutation 前后再次校验 book lease。
- durable sidecar 修复覆盖：
  - book-state YAML: `src/job-state/repository.ts`
  - GraphRAG identity sidecar: `src/job-state/graphrag-book.ts`
  - producer manifest: `src/job-state/graphrag-book.ts`
  - LanceDB row-count sidecar: `src/job-state/artifact-validation.ts`
- event log 具备 eventId/sequence normalization 与 tail recovery。
- provider transient recovery exhaustion 会转为 failed/stop_until_fixed，不再保持
  runnable pending。
- same-host live orphan subprocess record 已有 termination 测试；remote orphan
  已有 quarantine 策略。

## Residual Risks

- terminal commit 已有 finalization fence，但缺少一个显式、可审计的
  book checkpoint -> item checkpoint -> event -> manifest/status -> release
  单一事务边界。当前实现依赖 resume child 已完成 book-stage checkpoint。
- qmd index lock 与 SQLite busy retry 有两套实现：runner 脚本与
  `src/job-state/graphrag-book.ts`。如果不下沉到统一 SQLite/store 边界，后续新增
  qmd 命令仍容易绕过锁。
- status-json 不读取或重放 events 来派生 wait time/worker 观测，后续恢复语义需
  明确哪些字段来自 checkpoint、lease、subprocess registry 或 event log。

## Evidence Commands

本轮执行的是只读审计命令，未重新跑完整测试套件；以下命令由主控报告已通过并
作为辅助证据，最终判定仍以源码与测试审计为准。

- `shasum -a 256 audits/.../dev-agent-c/criteria.md`
- `git status --short --untracked-files=no`
- `rg -n "checksum|reconcile|quarantine|sidecar" src/job-state test`
- `rg -n "duplicate canonical|stale item checkpoint|same-host live orphan|parallel non-transient" test`
- `rg -n "SubprocessRecord|providerSlot|spawnCommand|detached|orphan" scripts/graphrag src test`
- `rg -n "qmdWriterCommandNames|withQmdIndexFileLock|createStore|initializeDatabase|syncConfigToDb" scripts/graphrag src test`
- 主控报告通过的命令包括 `node --check`、`npm run test:types`，以及本轮点名的
  focused Vitest tests。
