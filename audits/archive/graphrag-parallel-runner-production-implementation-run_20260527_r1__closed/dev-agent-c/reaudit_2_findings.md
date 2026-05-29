# GraphRAG 多书并行 Runner 实施 reaudit_2 复审

## 结论

status: fail

当前工作树相对 `reaudit_1` 已闭合一批明确缺口：同 runId
coordinator lock 已含 live pid 拒绝；repository 的 stage checkpoint、
artifact manifest 与 run catalog 写入已有 book lease fencing；provider slot
lease 已有 durable capacity gate 与 release token 校验；qmd writer commands
已有 qmd index file lock 事件证据；event tail 与 duplicate/sequence
normalization 已有迁移测试；YAML writer 与 GraphRAG output producer manifest
主写入路径已改为 temp/fsync/rename/fsync parent。

按本目录 `criteria.md` 的 10 条固定基准逐条复审后，仍不能判定为
production ready。阻塞项集中在：item/book fencing 仍未覆盖所有持久写入；
provider slot lease 没有贯穿到子进程/adapter 的可恢复 fencing 边界；qmd
index file lock 未覆盖所有 `.qmd/index.sqlite` 写入；GraphRAG 内部 Python
bridge 与 takeover orphan recovery 仍不满足 durable process boundary；部分
manifest 迁移写入不满足 durable contract；terminal commit 顺序仍不是固定
fenced critical section；status-json 缺少 worker 与真实 provider wait 派生；
行为测试仍缺少关键竞态与崩溃恢复证明。

复审未读取或输出 `.env`、密钥或凭据。未修改生产代码。未新建审计目录。

## 固定基准逐条判定

| # | 基准 | 判定 | 复审结论 |
|---|---|---|---|
| 1 | coordinator exclusivity | pass | `coordinator-lock.json` 有 session、pid、heartbeat、expiry、generation、fencing token，并通过 JSON file lock 下的 CAS acquire/heartbeat/release。`coordinatorLockLive()` 对同 host live pid 优先拒绝，即使 lock 已过期。 |
| 2 | item/book lease fencing | fail | book lease 已持久化，但没有独立 durable item lease；event、manifest、qmd build manifest、GraphRAG producer manifest、部分 qmd index 写入仍未在写入前验证当前 item/book fencing。 |
| 3 | provider semaphore durable lease | fail | durable provider slot capacity gate 与 release token 校验已存在，但 subprocess registry 只记录 `providerSlotId`，不记录 provider/generation/fencing token；子进程或 provider adapter 未验证 slot fencing；terminal commit 也不验证 provider slot。 |
| 4 | qmd index writer lane/file lock | fail | 父进程 qmd writer commands 已加 file lock，但 `.qmd/index.sqlite` 写入不限于这些命令。`createStore()` 初始化、query/rerank cache、GraphRAG/direct store 与 restore 类路径没有统一 lock/busy retry 证明。 |
| 5 | subprocess process-group recovery | fail | top-level `spawnCommand()` 有 durable record、detached process group 和 timeout terminate/kill；但 GraphRAG Python bridge 内部 child 未登记 durable registry，takeover 也不会终止同 host 仍存活的旧 child process group。 |
| 6 | durable write contract | fail | batch JSON/YAML 与主要 producer manifest 写入已改进；但 `migrateGraphOutputProducerManifests()` 仍直接覆盖 `qmd_output_manifest.json`，不满足 manifest temp/fsync/rename/fsync parent contract。 |
| 7 | terminal commit order | fail | completed item 路径验证 evidence 后写 item checkpoint、event，再由 worker 更新 manifest 并释放 book lease；没有 fixed book checkpoint -> item checkpoint -> event -> manifest/status -> release critical section，也没有 provider slot verification。 |
| 8 | manifest/status-json projection | fail | manifest/status 主要由当前 checkpoints 数组派生，不以 durable events 作为恢复权威；status item schema/输出缺 workerId；providerWaitMs 对 active slots 固定为 0，未从 slot lease/events 重建真实 wait time。 |
| 9 | worker pool bounded parallelism | partial pass | 单 coordinator 内 worker pool 有 `bookConcurrency` 上界、同 book active checkpoint 检查和 book lease，且已有重叠/顺序测试。但 fail-fast sibling cancellation 与 provider wait/starvation 的生产不变量仍缺完整行为证据，并受未闭合 fencing 问题影响。 |
| 10 | behavioral evidence | fail | 已覆盖若干新增行为，但仍缺 provider release rejection、qmd index 真实竞争与 SQLite busy/retry、GraphRAG bridge/grandchild kill、manifest crash recovery、event/manifest/qmd build stale fencing 等证明。 |

## Blocking Findings

### R2-C01: item/book fencing 未覆盖所有持久写入

严重性：blocking

对应基准：2、7、8、10

已闭合部分：

- `src/job-state/repository.ts:1106-1142` 增加 batch book lease 校验。
- `src/job-state/repository.ts:2131-2215` 的 artifact 写入已调用
  `assertBatchBookLease()`。
- `src/job-state/repository.ts:2222-2253` 的 run record/catalog 写入已调用
  `assertBatchBookLease()`。
- `src/job-state/repository.ts:2958-3088` 的 stage checkpoint 写入已调用
  `assertBatchBookLease()`。
- `test/book-job-state.test.ts:1059-1150` 与 `:1152-1188` 覆盖了 stage、
  artifact 和 run catalog stale book lease 拒绝。

仍未闭合证据：

- `scripts/graphrag/batch-epub-workflow.mjs:345-351` 只有 `BookLeaseSchema`；
  item fencing 存在于 item checkpoint 字段中，但没有独立 durable item
  lease/CAS 资源。
- `scripts/graphrag/batch-epub-workflow.mjs:2804-2829` 的 `event()` 不接收
  item/book lease 参数，追加 event 前不验证 fencing。
- `scripts/graphrag/batch-epub-workflow.mjs:5366-5427` 的 `updateManifest()`
  根据传入 checkpoints 写 manifest 和 recovery summary，写入前不验证
  item/book fencing。
- `scripts/graphrag/batch-epub-workflow.mjs:4804-4883` 的
  `writeQmdBuildManifest()` 直接写 qmd build manifest，不校验当前 book
  lease 或 item fencing。
- `src/job-state/graphrag-book.ts:1015-1040` 在 qmd index SQLite 写入后才调用
  repository 记录 qmd corpus registration；SQLite 写入本身没有先验证 batch
  book lease fencing。
- `src/job-state/graphrag-book.ts:1384-1426` 的
  `writeGraphRagOutputProducerManifest()` 走 durable write，但没有
  `assertBatchBookLease()` 或等效 fencing 校验。
- `scripts/graphrag/batch-epub-workflow.mjs:6926-6930` completed item commit
  只通过 `saveCheckpoint(... requireBookLease: true)` 保护 item checkpoint；
  随后的 event 与 worker manifest update 不在同一个 fenced write boundary。

影响：

旧 worker 在 book lease 过期、coordinator takeover、或 checkpoint 被新
generation 接管后，仍可能追加 event、改 manifest/status、写 qmd build
manifest、写 producer manifest 或写 qmd index。当前 stale fencing 测试只证明
repository 的部分 book-state 写入拒绝 stale token，不能证明 criteria.md 要求的
所有 checkpoint、event、manifest、catalog、qmd index、book artifact 写入都被
fencing 保护。

必须修复：

建立独立 durable item lease 与 book lease fencing 协议，并将 event、manifest、
status/recovery summary、qmd build manifest、producer manifest、qmd index、
catalog、artifact、checkpoint 所有写入统一接入 current generation/token 校验。

### R2-C02: provider slot lease 未成为端到端 fenced provider boundary

严重性：blocking

对应基准：3、7、8、10

已闭合部分：

- `scripts/graphrag/batch-epub-workflow.mjs:2534-2583` 在 provider registry
  lock 下回收 stale slot、统计 active slot 并写 slot lease，具备 durable
  capacity gate。
- `scripts/graphrag/batch-epub-workflow.mjs:2585-2618` release 时读回当前
  slot lease 并校验 session/generation/fencing token。
- `test/cli.test.ts:2609-2649` 覆盖 openai provider durable capacity 上界。
- `test/cli.test.ts:2514-2607` 覆盖 stale provider slot lease recovery。

仍未闭合证据：

- `scripts/graphrag/batch-epub-workflow.mjs:352-372` 的 subprocess record
  schema 只有 `providerSlotId`，没有 provider、slot generation、provider
  fencing token。
- `scripts/graphrag/batch-epub-workflow.mjs:6034-6065` 仅把 provider slot
  id/generation/fencing token 放入 child env；全仓检索只发现这三项在该处
  写入，没有 provider adapter 或 child runtime 读取并验证它们。
- `scripts/graphrag/batch-epub-workflow.mjs:6216-6255` 与 `:6400-6462` 在
  qmd/resume wrapper 外层持有 slot，但 GraphRAG Python bridge 内部 provider
  调用没有独立 durable slot record 或 child-side fencing check。
- `scripts/graphrag/batch-epub-workflow.mjs:6926-6930` terminal item commit
  只验证 book/item checkpoint fencing；provider slot 已在各 command 返回时
  release，终态提交无法验证当前 provider slot 仍有效。
- 行为测试未覆盖 release token mismatch 被拒绝、child-side slot fencing 拒绝、
  或旧 provider child 在 takeover 后不能继续调用 provider 的场景。

影响：

当前 provider slot 已能证明单 runner 内的 durable capacity gate，但还不是完整
durable semaphore（durable semaphore）。如果旧 child 或内部 GraphRAG provider
调用越过 wrapper，生产不变量不能证明“每次 OpenAI/Jina 调用前 slot fencing
仍有效”。终态提交也不能证明 provider slot 与已生成 evidence 属于同一 fenced
generation。

必须修复：

subprocess registry 与 provider adapter 必须记录并校验 provider、slot id、
generation、fencing token。每次 OpenAI/Jina 调用前验证当前 slot lease，release
与 recovery 事件必须可由 durable slot lease 和 subprocess record 重放验证。

### R2-C03: qmd index file lock 未覆盖所有 `.qmd/index.sqlite` 写入

严重性：blocking

对应基准：4、6、10

已闭合部分：

- `scripts/graphrag/batch-epub-workflow.mjs:2319-2429` 已有 qmd index lock，
  包含 owner、timeout、stale pid 检查和 bounded wait。
- `scripts/graphrag/batch-epub-workflow.mjs:6228-6245` 对 qmd writer commands
  包裹 `withQmdIndexFileLock()`。
- `src/job-state/graphrag-book.ts:1089-1135` direct GraphRAG qmd corpus
  registration 使用同类 `.lock` 文件。
- `test/cli.test.ts:2651-2686` 覆盖 qmd writer commands 会产生 lock acquire/
  release 事件。

仍未闭合证据：

- `scripts/graphrag/batch-epub-workflow.mjs:258-263` 的 writer 集合只包含
  `qmd-pull`、`qmd-update`、`qmd-embed`、`qmd-cleanup`。
- `src/store.ts:855-1002` 的 `initializeDatabase()` 会执行 schema、WAL、
  trigger、FTS rebuild、`store_config` 等 SQLite 写入；所有 qmd CLI 命令只要
  `createStore()` 就可能触发这些写入。
- `src/store.ts:2539-2549` 的 `setCachedResult()` 写 `llm_cache`；query/
  rerank 路径在 `src/store.ts:4099-4130` 与 `:4151-4185` 调用它。
  `qmd-query-json`、`qmd-query-auto-json`、`qmd-query-graphrag-json` 不在
  qmd writer lock 集合中。
- `src/store.ts` 检索未发现 `PRAGMA busy_timeout` 或 `SQLITE_BUSY` bounded
  retry；SQLite 层没有统一 writer lock adapter。
- 当前 qmd index test 只验证 lock 事件和 lock 文件清理，不构造真实跨进程
  SQLite writer 竞争、busy retry、或 live-owner stale lock 不可删除场景。

影响：

多 worker 下多个 qmd query/status/search 类命令仍可能同时初始化或写入同一个
`.qmd/index.sqlite`。即使高成本 writer commands 被外层 lock 包裹，SQLite 写入
面仍有未锁路径，无法满足“所有 `.qmd/index.sqlite` 写入路径”这一固定基准。

必须修复：

把 qmd index lock 下沉到 `createStore()` 或 SQLite write adapter 层，覆盖 schema
init、cache、FTS rebuild、direct store、restore/resync、qmd CLI、GraphRAG/resume
全部写路径，并加入 SQLite busy timeout 与 bounded retry 行为测试。

### R2-C04: subprocess recovery 与 process-group 边界仍不完整

严重性：blocking

对应基准：1、3、5、10

已闭合部分：

- `scripts/graphrag/batch-epub-workflow.mjs:5880-6011` 的 top-level
  `spawnCommand()` 登记 durable subprocess record，Unix 下 `detached: true`，
  timeout 后先 `SIGTERM` 再 `SIGKILL` process group。
- `test/cli.test.ts:2444-2512` 验证正常 worker pool 后 subprocess records 进入
  terminal status。

仍未闭合证据：

- `src/integrations/python-bridge.ts:181-245` 的 GraphRAG Python bridge 内部
  child 没有 durable subprocess registry，没有 `detached` process group，也不
  记录 provider slot generation/fencing token。
- `src/integrations/python-bridge.ts:229-237` early-stop 只 kill direct child；
  没有 process-group terminate/kill 语义。
- `scripts/graphrag/batch-epub-workflow.mjs:3058-3088` takeover/recovery
  对 active subprocess record 的处理只在 `record.runnerHost !== runnerHost` 或
  `!processAlive(record.pid)` 时标记 recovered/killed；如果旧 coordinator 已死、
  但同 host 旧 child pid 仍存活，新 coordinator 不会 terminate 该旧 process
  group。
- 行为测试没有覆盖 timeout 后 grandchild/process group 被杀，也没有覆盖
  takeover 时 live orphan child group 被终止或进入 `stop_until_fixed`。

影响：

旧 GraphRAG/Python provider child 可能在新 coordinator 接管后继续运行、调用
provider 或写 artifact。当前 durable subprocess registry 能覆盖 runner 直接
spawn 的 wrapper，但不能证明每个 qmd/GraphRAG command boundary 都可恢复。

必须修复：

GraphRAG Python bridge 和内部 provider child 必须进入 durable subprocess
registry，记录 pid/pgid、provider slot、generation、fencing token。coordinator
takeover 必须 terminate 同 host live orphan process group，无法 quiesce 时必须
进入 `stop_until_fixed`。

### R2-C05: manifest durable write contract 仍有迁移路径缺口

严重性：blocking

对应基准：6

已闭合部分：

- `scripts/graphrag/batch-epub-workflow.mjs:2009-2021` 与 `:2842-2848`
  提供 JSON temp/fsync/rename/fsync parent 写入。
- `scripts/graphrag/batch-epub-workflow.mjs:2804-2829` 的 events 使用单行
  append、file fsync 与 eventId/sequence。
- `scripts/graphrag/batch-epub-workflow.mjs:3030-3047` 与 `:5653-5768`
  使用 atomic rewrite 恢复 partial tail、duplicate eventId 和 sequence。
- `src/job-state/repository.ts:388-409` 的 YAML writer 已 fsync temp file 并
  rename 后 fsync parent。
- `src/job-state/graphrag-book.ts:1429-1440` 的主 producer manifest writer 已
  temp/fsync/rename/fsync parent。

仍未闭合证据：

- `scripts/graphrag/batch-epub-workflow.mjs:4708-4746` 的
  `migrateGraphOutputProducerManifests()` 仍用 `writeFileSync()` 直接覆盖
  `qmd_output_manifest.json`。这是 manifest 写入，未走 temp/fsync/rename/fsync
  parent。
- `test/cli.test.ts:3823-3946` 覆盖 absolute output manifest 被迁移为 locator，
  但没有断言该 migration 遵守 durable write contract 或 crash recovery。

影响：

主写入路径的 durable contract 已明显改进，但迁移路径仍可能在 crash/power loss
后留下 torn manifest 或不可解析 manifest，与 criteria.md 对 manifest 写入的
统一 durable contract 不一致。

必须修复：

所有 manifest migration/rewrite 必须复用同一 durable writer，并增加迁移中断、
partial manifest、atomic rename 后恢复的行为测试。

### R2-C06: terminal commit 不是固定 fenced finalization

严重性：blocking

对应基准：7

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:6849-6903` 验证 qmd build、
  GraphRAG build 和 GraphRAG query evidence。
- `scripts/graphrag/batch-epub-workflow.mjs:6926-6930` 随后写 completed item
  checkpoint 并追加 `item_completed` event。
- `scripts/graphrag/batch-epub-workflow.mjs:7553-7562` worker 返回后才
  `updateManifestState()`、追加 `item_worker_completed`，然后 release book
  lease。
- book stage checkpoint 由 resume child 在更早阶段写入，不在 terminal commit
  critical section 中。
- provider slot 在各 command wrapper 的 `finally` 中释放，terminal commit 没有
  provider slot fencing 可校验。

影响：

如果 crash 或 takeover 发生在 item checkpoint、event、manifest/status、release
之间，恢复逻辑不能证明固定顺序已完成到哪一步。旧 worker 也可能在 provider
slot 已释放或失效后提交 completed item。

必须修复：

实现显式 finalization critical section：验证 item/book/provider slot，验证 qmd、
GraphRAG、query_ready evidence，写 book checkpoint，写 item checkpoint，追加
event，派生 manifest/status，最后 release lease。每一步恢复语义必须可由 durable
checkpoint/events 重建。

### R2-C07: manifest/status-json 未完全由 durable checkpoint/events 派生

严重性：blocking

对应基准：8

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5366-5427` 的 manifest counts 从
  传入 checkpoints 数组计算并直接写 manifest；运行中该数组来自内存 Map。
- `scripts/graphrag/batch-epub-workflow.mjs:5454-5614` 的 recovery summary 主要
  从 checkpoints、active provider slot files、active subprocess files 派生，
  没有以 durable events 作为 wait time、worker timeline 或 recovery decision 的
  重建来源。
- `scripts/graphrag/batch-epub-workflow.mjs:5458-5468` active slot summary 将
  `providerWaitMs` 初始化为 0；provider slot lease schema 不保存 waitMs，summary
  也未从 `provider_slot_lease_acquired` event 重建真实 wait time。
- `scripts/graphrag/batch-epub-workflow.mjs:678-761` 与
  `src/contracts/batch-run.ts:300-390` 的 recovery summary item schema 没有
  `workerId` 字段；status-json 不能直接展示 worker。
- `scripts/graphrag/batch-epub-workflow.mjs:5536-5540` 只在 running item 上展示
  currentCommand/currentCommandStartedAt；已释放 slot 的 generation/wait 观测会丢失。

影响：

status-json 可以读 durable checkpoint，但仍不能满足“manifest 与 status-json 从
durable checkpoint 和 durable events 派生”的固定基准。provider wait、slot
generation、worker、running command 与 recovery decision 的可观测性不完整。

必须修复：

将 manifest/status projection 改为从 checkpoint + event log + lease/subprocess
registry 重建，并在 schema 中输出 workerId、真实 provider waitMs、slot
generation、running command、recovery decision 和 event-derived timeline。

### R2-C08: 行为测试仍缺关键生产竞态与崩溃恢复证明

严重性：blocking

对应基准：9、10

已覆盖证据：

- 同 runId live coordinator 拒绝、过期 lock 但 live pid 拒绝。
- stale provider slot recovery 与 durable provider slot capacity。
- `book-concurrency 2` 真实 worker overlap 与 `book-concurrency 1` 顺序执行。
- partial event tail recovery 与 duplicate eventId/non-monotonic sequence
  normalization。
- stage checkpoint、artifact、run catalog stale book lease fencing。
- batch execution bus contract。
- qmd writer commands acquire qmd index file lock。

仍缺测试：

- provider slot release token mismatch、child-side provider slot fencing 拒绝、
  live pid but expired provider slot 不被误回收。
- qmd index file lock 真实跨进程竞争、SQLite busy timeout/bounded retry、
  live-owner stale lock 不可删除。
- GraphRAG Python bridge/grandchild timeout 后 process-group kill。
- coordinator takeover 时 live orphan child group quiesce 或 stop_until_fixed。
- event、manifest、qmd build manifest、producer manifest、qmd index stale
  item/book fencing 写入拒绝。
- manifest/status crash recovery：crash between item checkpoint/event/
  manifest/release 后由 durable checkpoints/events 正确重建。
- fail-fast 多 worker sibling cancellation：一个 worker 失败时 sibling command 被
  终止、leases 被释放或可恢复、不会重复 claim 或 starvation。

影响：

新增测试证明了部分修复有效，但还不能覆盖 criteria.md 第 10 条要求的生产级竞态、
crash recovery 和 fencing 不变量。

必须修复：

补齐上述行为级测试，并避免只断言事件存在；测试应断言 durable files、process
liveness、SQLite lock/busy 行为、lease fencing rejection、manifest/status 重建
结果和 worker pool quiesce。

## 残余风险

- qmd CLI 的 provider 调用路径依赖外层 runner wrapper；非 batch 调用或内部
  GraphRAG bridge 不会自动获得 provider slot fencing。
- JSON file lock stale cleanup 不记录 owner pid；虽然 coordinator lock 自身有
  live pid 语义，通用 JSON lock 在极端 pause/slow FS 场景下仍缺 owner 观测。
- status-json 的 provider auth redaction 测试较多，但 runner 恢复状态的 worker/
  slot timeline 仍不完整。

## Evidence Commands

本次复审执行静态读取与检索，不运行生产修改命令：

- `sed -n '1,220p' audits/.../dev-agent-c/criteria.md`
- `rg -n "coordinatorLock|providerSlot|qmdIndex|recoverEventLogTail|spawnCommand|failFast" scripts/graphrag/batch-epub-workflow.mjs`
- `rg -n "assertBatchBookLease|writeYamlFile|recordArtifacts|appendRunRecord" src/job-state/repository.ts src/job-state/graphrag-book.ts`
- `rg -n "withQmdIndexFileLock|QMD_GRAPHRAG_PROVIDER_SLOT|python-bridge|createStore|setCachedResult" src scripts test`
- `rg -n "rejects coordinator takeover|durable provider slots|qmd writer commands acquire|migrate-only normalizes|rejects stage checkpoint" test`

主控已报告通过的命令与 focused tests 作为行为证据输入，包括：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `npm run test:types -- --pretty false`
- focused CLI tests covering coordinator exclusivity, provider slots,
  worker pool overlap/sequential mode, event tail recovery, duplicate event
  normalization, and qmd writer lock events.
- book-state stale fencing tests for stage checkpoint, artifact and run catalog.
- contract test `accepts batch execution bus envelopes`.
