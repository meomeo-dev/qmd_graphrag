# GraphRAG 多书并行 Runner 实施复审 reaudit_6

## 结论

状态：pass。

固定基准文件：
`/Users/jin/projects/qmd_graphrag/audits/graphrag-parallel-runner-production-implementation-run_20260527_r1__open/dev-agent-a/criteria.md`

基准版本：
`sha256:e763182a90d9aeeeafa11f21379473a3a8e2218dc5d81bbbe9fef6625d9281ca`

本轮未新建审计目录，未修改 `criteria.md`，未读取或输出 `.env`、
密钥或凭据。复审对象为当前工作树。

## 第 5 轮阻塞项闭合状态

RA5-B1 已闭合。

batch runner 的生产 evidence 读取路径已改为先执行 durable
checksum/reconcile：

- `readYamlFileIfExists()` 调用 `reconcileDurableYamlTarget()` 后再解析 YAML。
- `readJsonSchemaIfExists()` 调用 `reconcileDurableJsonTarget()` 后再解析 JSON。
- `readGraphOutputProducerManifest()` 调用 `reconcileDurableJsonTarget()` 后再读取
  producer manifest。
- `readLanceRowCount()` 调用 `reconcileDurableJsonTarget()` 后再读取 row-count。
- `validateLanceDbDirectory()` 与 `validateArtifactContent()` 对 durable target
  错误执行 fail-closed，不再吞掉 checksum mismatch。

checksum mismatch、invalid target 或 unreconciled temp state 会触发 quarantine
事件并抛出 `invalid durable JSON target` 或 `invalid durable YAML target`，
因此 normal run 与 migrate-only 不会继续写 terminal completion 或迁移
producer manifest。

新增黑盒测试已覆盖 RA5-B1 的两个生产闭环：

- `migrate-only reopens completed item when terminal evidence checksum is corrupt`
- `migrate-only rejects corrupt LanceDB row-count durable checksum`

这些测试验证了保留旧 `.sha256` 并篡改有效 YAML/JSON target 时，batch runner
会 fail closed、quarantine corrupt target，并避免写入 completed 终态。

## 固定 10 条基准逐条判定

1. 同 `runId` 单协调器：pass。
   coordinator lock、heartbeat、过期接管检查、same-host live pid 拒绝与
   subprocess registry reconciliation 均存在，并有 CLI 行为测试覆盖。

2. Item claim 与 fencing：pass。
   item/book claim 持久包含 runner session、worker identity、lease generation、
   expiresAt 与 fencing token；terminal checkpoint/event/catalog 写入前后均有
   fence 校验。

3. Book 级互斥：pass。
   每个 `bookId` 使用持久 book lease；worker pool 对 duplicate canonical book
   执行 defer，避免同一本书并发 qmd、GraphRAG、checkpoint 或 artifact 写入。

4. 顺序兼容：pass。
   `--book-concurrency 1` 保持顺序执行语义；并行 worker 通过同一
   coordinator 调度，不改变单 worker 的 retry 与 completion 行为。

5. Manifest 与 event 一致性：pass。
   manifest/status 从 durable checkpoints 与 reconciled events 派生。event
   partial tail、duplicate id、manifest drift 与 durable target mismatch 均有
   恢复或 fail-closed 路径。

6. Provider slot 治理：pass。
   OpenAI/Jina/local CPU/qmd writer lane 均通过 coordinator-granted durable
   provider slot lease 管理，slot generation、wait metric、release event、
   leak recovery 与 status-json projection 均可观测。

7. qmd index 写入安全：pass。
   batch required command set 统一纳入 qmd index file lock；GraphRAG resume 的
   qmd index mutation stage 也通过 qmd index writer lane 串行执行。

8. 失败与等待语义：pass。
   fail-fast、transient retry、provider recovery wait、provider auth 与
   non-transient stop 保持区分；不可恢复失败会在新 claim 前 quiesce scheduler。

9. GraphRAG 闭环 gate：pass。
   completed item 需要 qmd build evidence、GraphRAG stage producer lineage、
   book-scoped artifacts、qmd corpus registration、query-ready checkpoint
   validation 与 GraphRAG query check；这些 terminal evidence 读取已纳入
   durable checksum/reconcile。

10. 生产级测试覆盖：pass。
    focused tests 覆盖 parallel/sequential worker、duplicate book 排他、
    coordinator recovery、stale claim fencing、provider slot contention 与 leak
    recovery、qmd index lock、event/manifest reconciliation、durable terminal
    evidence mismatch、subprocess registry 与 provider cost/catalog recovery。

## 本轮证据

关键代码证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3050`
  `reconcileDurableJsonTarget()` 实现 temp cleanup、checksum backfill、
  checksum mismatch quarantine 与 fail-closed。
- `scripts/graphrag/batch-epub-workflow.mjs:3107`
  `reconcileDurableYamlTarget()` 实现 YAML target durable reconcile。
- `scripts/graphrag/batch-epub-workflow.mjs:4381`
  `readYamlFileIfExists()` 使用 durable YAML reader。
- `scripts/graphrag/batch-epub-workflow.mjs:4392`
  `readJsonSchemaIfExists()` 使用 durable JSON reader。
- `scripts/graphrag/batch-epub-workflow.mjs:4399`
  `readGraphOutputProducerManifest()` 使用 durable JSON reader。
- `scripts/graphrag/batch-epub-workflow.mjs:4521`
  `readLanceRowCount()` 使用 durable JSON reader。
- `scripts/graphrag/batch-epub-workflow.mjs:5953`
  status/recovery summary 派生 `workerId`、provider wait、slot generation。
- `scripts/graphrag/batch-epub-workflow.mjs:6429`
  subprocess registry 记录 provider slot fence 字段。
- `src/graphrag/capability-catalog.ts:421`
  `graph-capabilities.yaml` 通过 durable YAML writer 写入。
- `src/job-state/repository.ts:3241`
  graph capability catalog commit 前后验证 current batch book lease。

通过的验证命令：

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `node --check scripts/graphrag/resume-book-workspace.mjs`
- `node --check scripts/graphrag/batch-failure-classifier.mjs`
- `npm run test:types -- --pretty false`
- focused `test/cli.test.ts` 8 个并行、fencing、provider slot、durable evidence
  关键用例。
- focused `test/integrations/python-bridge-early-stop.test.ts` provider slot
  fencing registry 用例。
- focused `test/integrations/graphrag-cost.test.ts` request artifact 与 corrupt
  cost ledger recovery 用例。
- focused `test/book-job-state.test.ts` graph capability durable/fenced commit
  用例。

## 非阻塞风险

未执行完整仓库测试套件。当前结论基于固定审计基准、源码证据、类型检查和
覆盖第 5 轮阻塞项的 focused behavior tests。完整套件仍可作为提交前的额外
回归验证，但不是本轮固定基准的阻塞项。
