# GraphRAG 多书并行 Runner 实施复审 reaudit_5

## 结论

状态：fail。

固定基准文件：
`/Users/jin/projects/qmd_graphrag/audits/graphrag-parallel-runner-production-implementation-run_20260527_r1__open/dev-agent-a/criteria.md`

基准版本：
`sha256:e763182a90d9aeeeafa11f21379473a3a8e2218dc5d81bbbe9fef6625d9281ca`

本轮未新建审计目录，未修改 `criteria.md`，未读取或输出 `.env`、
密钥或凭据，未修改生产源码或测试。复审对象为当前工作树。

## 前序阻塞项闭合状态

RA4-B1 部分闭合但仍阻塞。`src/job-state/durable-json.ts` 新增 durable
JSON helper，`src/job-state/repository.ts` 的 repository YAML helper 已具备
checksum、temp reconciliation、missing checksum backfill 与 corrupt quarantine。
`getBookJob`、GraphRAG identity sidecar、producer manifest helper、LanceDB
row-count sidecar 在 TypeScript job-state 层已有 durable read/write 证据。

阻塞未完全闭合的原因是 batch runner 的生产 GraphRAG evidence 读路径仍绕过
这些 helper。终端完成 gate 仍会直接读取 `books.yaml`、`checkpoints.yaml`、
`artifacts.yaml` 与 `qmd_output_manifest.json`，未先校验 `.sha256`，也未做
temp reconciliation 或 corrupt quarantine。

RA4-B2 主要覆盖缺口已闭合。当前测试已覆盖 duplicate canonical book 排他、
stale item checkpoint/event fencing 负向拒绝、same-host live orphan
subprocess termination、parallel non-transient fail-fast quiesce/sibling
subprocess kill，以及 book YAML、identity sidecar、producer manifest、
LanceDB row-count sidecar 的 durable recovery。剩余测试缺口与 RA5-B1 相同：
缺少针对 batch runner 生产 evidence 读路径 checksum mismatch 的黑盒拒绝用例。

## Blocking Findings

### RA5-B1: batch runner 的生产 evidence 读路径仍绕过 durable checksum/reconcile

涉及基准：5、9、10。

精确位置：

- `scripts/graphrag/batch-epub-workflow.mjs:4305`
  `readYamlFileIfExists` 对 YAML 直接 `YAML.parse(readFileSync(...))`。
- `scripts/graphrag/batch-epub-workflow.mjs:4310`
  `readYamlSchemaIfExists` 直接调用上述非 durable YAML reader。
- `scripts/graphrag/batch-epub-workflow.mjs:4321`
  `readGraphOutputProducerManifest` 对 producer manifest 直接 `readJson(path)`。
- `scripts/graphrag/batch-epub-workflow.mjs:4710`
  `readGraphJob` 从 `catalog/books.yaml` 读取 GraphRAG job identity。
- `scripts/graphrag/batch-epub-workflow.mjs:4973`
  `graphBuildEvidence` 从 `books/<bookId>/checkpoints.yaml` 与
  `books/<bookId>/artifacts.yaml` 读取 GraphRAG stage/artifact evidence。
- `scripts/graphrag/batch-epub-workflow.mjs:4992`
  `graphBuildEvidence` 读取 `qmd_output_manifest.json` 作为 producer evidence。
- `scripts/graphrag/batch-epub-workflow.mjs:5090`
  `migrateGraphOutputProducerManifests` 迁移 producer manifest 前直接
  `JSON.parse(readFileSync(...))`。
- `scripts/graphrag/batch-epub-workflow.mjs:3088`
  `reconcileDurableRunFiles` 仅覆盖 batch manifest、recovery summary、
  coordinator lock、items、provider slots、subprocesses、book leases 等 run
  JSON 文件，不覆盖 `stateRoot/books/**` YAML 或 GraphRAG producer sidecar。

为什么仍阻塞：

基准 5 要求 manifest/status 由 durable checkpoint 与有效 event 派生，恢复
必须处理 temp file、manifest drift 与 durable evidence 边界。基准 9 要求
completed item 必须具备真实 qmd build evidence、GraphRAG producer lineage、
book-scoped artifact、qmd corpus registration 与 query-ready validation。当前
job-state 层虽然已实现 durable JSON/YAML helper，但 batch runner 最终判定
`graphBuildEvidence` 与 `readGraphJob` 时直接读取生产证据文件。

因此，在 `books.yaml`、`checkpoints.yaml`、`artifacts.yaml` 或
`qmd_output_manifest.json` 被部分写入、被有效 YAML/JSON 形式篡改、或与
`.sha256` 不一致时，batch runner 不会 fail-closed，也不会 quarantine 目标。
终端 completion gate 可能基于未经 checksum 验证的 GraphRAG producer lineage
与 artifact catalog 继续完成或迁移状态。该行为仍违反 durable recovery 与
GraphRAG 闭环 gate 的生产审计要求。

第 10 条测试覆盖也因此未完全通过。现有新增测试证明 repository/helper 层的
durable recovery 能工作，但未覆盖 batch runner 在 normal run 或 migrate-only
路径中遇到 checksum mismatch 的 book-state YAML、producer manifest 时必须
拒绝完成、拒绝迁移并 quarantine 的黑盒行为。

必须修复方向：

- 将 `scripts/graphrag/batch-epub-workflow.mjs` 中读取
  `catalog/books.yaml`、`books/<bookId>/checkpoints.yaml`、
  `books/<bookId>/artifacts.yaml` 的路径改为 durable YAML reconcile/read。
- 将 batch runner 的 `qmd_output_manifest.json` 读取与 migrate-only 迁移路径
  改为 durable JSON reconcile/read，checksum mismatch 或 invalid target 必须
  fail-closed 并 quarantine。
- normal run 与 migrate-only 在上述 evidence 文件 checksum mismatch 时不得
  写 terminal completion event，不得补 checksum 后继续接受未知内容。
- 增加生产级黑盒测试：篡改有效 YAML/JSON 内容并保留旧 `.sha256`，验证
  batch runner 阻断 completed item、记录 quarantine/stop_until_fixed 证据，
  且不会写 `item_completed`、`item_worker_completed` 或迁移后的 producer
  manifest。

## 固定 10 条基准逐条判定

1. 同 `runId` 单协调器：pass。
   `acquireCoordinatorLock`、`coordinatorLockLive`、heartbeat、
   expired takeover check 与 subprocess registry reconciliation 已存在。
   同 runId live coordinator 拒绝与 expired-but-live PID 拒绝有 focused
   CLI 测试覆盖。

2. Item claim 与 fencing：pass。
   `markItemRunning` 写入 runner session、worker identity、lease generation、
   expiresAt、fencing token、book lease generation 与 book fencing token。
   checkpoint/event terminal write 通过 `assertItemCheckpointFence`、
   `assertEventItemFence` 与 terminal finalization fence 校验。stale item
   checkpoint ownership 负向拒绝测试已覆盖不写 `item_completed`。

3. Book 级互斥：pass。
   `acquireBookLease`、`refreshBookLease`、`releaseBookLease` 使用持久 book
   lease 与 generation/fencing token。worker pool 通过
   `activeRunningBookCheckpoint` 推迟同 canonical book 的重复 item。新增
   duplicate canonical book 测试证明两个同书 item 不会并发 resume。

4. 顺序兼容：pass。
   `--book-concurrency 1` 保留顺序执行路径与 completed behavior。focused CLI
   测试覆盖 sequential book execution。

5. Manifest 与 event 一致性：fail。
   batch run JSON、event tail、duplicate event 与 manifest rebuild 有 durable
   与测试证据；但 GraphRAG evidence 所需的 book-state YAML 与 producer
   manifest 生产读路径仍绕过 durable checksum/reconcile。见 RA5-B1。

6. Provider slot 治理：pass。
   provider slot 使用 durable lease、generation、fencing token、capacity gate、
   wait metric、release event 与 stale recovery。focused CLI 测试覆盖 stale
   recovery、capacity gate 与 stale release fencing。

7. qmd index 写入安全：pass。
   batch qmd writer 命令使用 qmd index file lock；GraphRAG qmd corpus mutation
   使用 book lease 校验、file lock 与 SQLite busy/locked bounded retry，并写
   retry metric。focused 测试覆盖 qmd writer lock、stale lease 拒绝和 SQLite
   contention retry metric。

8. 失败与等待语义：pass。
   fail-fast、transient retry、provider recovery wait limit、provider auth 与
   non-transient stop 被区分。parallel non-transient failure 会 request stop、
   quiesce scheduler 并终止 sibling subprocess；provider recovery wait limit
   不再保持 runnable pending。focused CLI 测试覆盖这些路径。

9. GraphRAG 闭环 gate：fail。
   completion 前会校验 qmd build、GraphRAG build 与 GraphRAG query evidence，
   qmd corpus registration 与 query-ready producer artifact 也有代码和测试证据。
   但该 gate 仍从 batch runner 直接读取未经 checksum/reconcile 验证的
   book-state YAML 与 producer manifest。见 RA5-B1。

10. 生产级测试覆盖：fail。
    新增测试覆盖了前序明确列出的并行、顺序、duplicate book、stale claim、
    orphan subprocess、fail-fast quiesce、provider slot、qmd contention、
    event/manifest recovery 与 durable sidecar recovery 的多数路径。但缺少
    batch runner 生产 GraphRAG evidence 读路径在 checksum mismatch 下必须
    fail-closed/quarantine 的黑盒测试。见 RA5-B1。

## 已验证的正向覆盖

- single coordinator lock、heartbeat、expired takeover 与 subprocess registry
  recovery 已有实现与 focused CLI 测试证据。
- durable provider slot semaphore 已有 capacity gate、stale recovery、
  release fencing 与 status evidence。
- item/book fencing 覆盖 checkpoint、terminal event、repository stage/artifact
  写入、qmd corpus mutation 与 producer manifest write。
- `src/job-state/durable-json.ts` 与 repository YAML helper 支持 checksum、
  temp cleanup、missing checksum backfill 与 corrupt quarantine。
- GraphRAG identity sidecar、producer manifest helper、LanceDB row-count sidecar
  在 job-state 层已使用 durable JSON helper，并有 focused tests。
- qmd index writer lock 与 SQLite busy/locked bounded retry 已有可观测 metric
  与 contention 测试。
- failure/quiesce 覆盖 transient provider wait exhaustion、same-host live
  orphan termination、remote orphan quarantine 与 parallel sibling kill。

## 非阻塞风险

- 本轮审计以只读源码/测试检查和主控报告的 focused test pass 为证据，未由
  本代理重新执行完整测试套件。
- LanceDB row-count checksum mismatch 在 artifact validation 中以
  `lancedb_table_missing_positive_row_count` 形式阻断 gate，并完成 quarantine；
  该错误边界可接受，但可进一步增加 status-json 级别的可观测断言。

## 证据文件

- `criteria.md`
- `reaudit_4_summary.yaml`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `scripts/graphrag/resume-book-workspace.mjs`
- `scripts/graphrag/batch-failure-classifier.mjs`
- `src/job-state/durable-json.ts`
- `src/job-state/repository.ts`
- `src/job-state/graphrag-book.ts`
- `src/job-state/artifact-validation.ts`
- `src/db.ts`
- `test/cli.test.ts`
- `test/book-job-state.test.ts`
- `test/graphrag-book-state.test.ts`
- `test/integrations/contracts.test.ts`

## 证据命令

- `shasum -a 256 audits/graphrag-parallel-runner-production-implementation-run_20260527_r1__open/dev-agent-a/criteria.md`
- `git status --short`
- `rg -n "readYamlFileIfExists|readGraphOutputProducerManifest|graphBuildEvidence|migrateGraphOutputProducerManifests" scripts/graphrag/batch-epub-workflow.mjs`
- `rg -n "qmd_graph_text_unit_identity|qmd_output_manifest|qmd_row_count|readJsonFileDurable|writeJsonFileDurable" src/job-state test/book-job-state.test.ts test/graphrag-book-state.test.ts`
- `rg -n "book worker pool defers duplicate canonical books|stale item checkpoint ownership rejects terminal event writes|parallel non-transient failure quiesces sibling workers|restart terminates same-host live orphan subprocess records" test/cli.test.ts`
- 主控报告通过：
  `node --check scripts/graphrag/batch-epub-workflow.mjs &&
  node --check scripts/graphrag/resume-book-workspace.mjs &&
  node --check scripts/graphrag/batch-failure-classifier.mjs`
- 主控报告通过：`npm run test:types -- --pretty false`
- 主控报告通过：本轮任务列出的 focused CLI、book-state 与
  graphrag-book-state vitest patterns。
