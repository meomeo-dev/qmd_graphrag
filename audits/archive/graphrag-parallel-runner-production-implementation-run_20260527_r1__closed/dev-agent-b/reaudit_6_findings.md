# GraphRAG 多书并行 Runner 生产实现 reaudit_6 发现

## 结论

复审状态：**fail**。

本轮使用同一 run id 下当前实际存在的
`dev-agent-b/criteria.md` 固定 10 条基准。文件系统中用户指定的
`...r1__open/dev-agent-b/` 目录已不存在，当前只存在同一审计 run 的
`...r1__closed/dev-agent-b/` 目录；本轮未新建目录，未修改 `criteria.md`，
未读取或输出 `.env`、密钥或凭据，未修改生产源码或测试。

第 5 轮两个显式实现阻塞已有实质修复：batch runner terminal evidence 的
producer manifest、LanceDB row-count、book checkpoint/artifact YAML 读路径
已接入 durable checksum/reconcile/quarantine；`graph-capabilities.yaml` 已
改为 durable YAML 写入，并在 repository publish 路径中增加 current book lease
前后 fence。按固定基准继续复核后，仍有阻塞项：共享 capability catalog 的
read-modify-write 不是 cross-process locked/CAS commit，batch runner 启动时
`catalog/books.yaml` 仍有 direct YAML 读路径，且黑盒负向测试未覆盖这些行为。

## 第 5 轮阻塞项闭合状态

- R5-B01 terminal evidence durable read bypass：**实现已闭合，测试仍部分**。
  `readYamlFileIfExists()`、`readGraphOutputProducerManifest()`、
  `readLanceRowCount()` 均先执行 durable reconcile；checksum mismatch 会
  quarantine 并 fail closed。缺口见 R6-B03。
- R5-B02 graph capability catalog durable/fenced commit：**部分闭合**。
  单次写入已 durable，且 publish 前后校验 current book lease；但共享 catalog
  本身没有跨进程 file lock 或 CAS，仍可能丢失并行 book 的 capability commit。
- R5-B03 行为测试覆盖：**部分闭合**。新增 JSON sidecar、stale lease、commit
  hook 测试有效，但缺少共享 catalog 并发负向测试和 terminal YAML corrupt
  black-box 测试。

## 固定基准逐条判定

| 基准 | 判定 | 结论 |
| --- | --- | --- |
| 1. Durable single coordinator ownership | pass | coordinator lock 含 session、pid/host、heartbeat、expiry、generation/fence；live coordinator 拒绝路径 fail closed。 |
| 2. Item and book ownership use lease fencing | fail | checkpoint、event、qmd index、producer manifest 有 fence；但共享 `graph-capabilities.yaml` catalog commit 缺少跨进程 locked/CAS read-modify-write。 |
| 3. Provider concurrency at child boundary | pass | provider-using subprocess 在 durable slot lease 后启动；slot generation/fence/recovery 可观测。 |
| 4. Durable writes are crash recoverable | fail | terminal evidence reader 已 durable；但 `catalog/books.yaml` 启动读路径绕过 checksum/reconcile，graph capability catalog 缺少并发 commit serialization。 |
| 5. Event logs authoritative audit trails | pass | event id/sequence、append fsync、partial tail 和 duplicate id normalization 已实现并有测试。 |
| 6. Manifest and status derived caches | pass | manifest/status 从 checkpoints 与 event evidence 重算，mismatch rebuild 有行为测试。 |
| 7. Terminal completion evidence gated | pass | completed checkpoint 与 terminal events 共享 finalization fence，terminal evidence 读路径已 fail closed。 |
| 8. Stable terminal or retry states | pass | non-transient stop_until_fixed、transient retry budget、exhaustion/quiesce 已覆盖。 |
| 9. Crash/restart live subprocess recovery | pass | subprocess registry、same-host orphan termination、remote quarantine 与 stale worker fence 已覆盖。 |
| 10. Behavioral recovery tests | fail | 仍缺共享 capability catalog 并发 no-lost-update、`books.yaml` durable startup、terminal YAML checksum corrupt 的黑盒负向测试。 |

## Blocking Findings

### R6-B01: `graph-capabilities.yaml` 缺少跨进程 locked/CAS catalog commit

违反基准：2、4、10。

证据：

- `src/graphrag/capability-catalog.ts:820` 先读取现有 explicit capability
  catalog，`src/graphrag/capability-catalog.ts:821` 到 `831` 在内存中合并，
  `src/graphrag/capability-catalog.ts:832` 到 `835` 再执行 hook 与 durable
  YAML write。该 read-modify-write 周围没有同文件 lock、generation CAS 或
  写前重读验证。
- `src/job-state/repository.ts:3190` 到 `3247` 在 query_ready succeeded 后循环
  发布多个 capability，并只校验当前 book lease。book lease 能阻止 stale worker
  写本 book，但不能保护共享 `catalog/graph-capabilities.yaml` 免受另一个 book
  的并发 read-modify-write 覆盖。
- `scripts/graphrag/batch-epub-workflow.mjs:8209` 到 `8290` 支持多 book worker
  pool；`scripts/graphrag/resume-book-workspace.mjs:984` 到 `1000` 和
  `scripts/graphrag/resume-book-workspace.mjs:1375` 到 `1391` 会在子进程内通过
  repository 完成 query_ready stage，从而触发 shared catalog publication。

为什么仍阻塞：

固定基准 2 要求 catalog commits 验证当前 fencing token，基准 4 要求 catalog
writes 具备 crash-recoverable durable protocol。在多书并行生产语义下，catalog
commit 还必须保护 read-modify-write 的完整临界区。当前实现保证单次 rename
durable，但不能保证两个合法 book worker 同时发布时不发生 lost update；后写者
可能基于旧 snapshot 覆盖先写者已发布的 capability。

建议修复方向：

- 为 `graph-capabilities.yaml` 增加同目录 durable file lock，锁内执行
  reconcile、read、merge、write、checksum、parent fsync。
- 或将 capability 改为 per-book/per-capability 文件，再由 loader 派生聚合视图。
- 增加并发行为测试：两个不同 book 同时 query_ready publication 后，catalog
  必须同时包含两本书的全部 capability，且 checksum 有效。

### R6-B02: batch runner 启动时 `catalog/books.yaml` 绕过 durable reconcile

违反基准：4、6、10。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3650` 到 `3654` 的
  `loadCatalogBySourceHash()` 直接 `YAML.parse(readFileSync(catalogPath))`，
  不校验 `.sha256`，不 backfill checksum，也不 quarantine invalid/corrupt
  target。
- `scripts/graphrag/batch-epub-workflow.mjs:3701` 到 `3710` 的
  `discoverItems()` 用该 catalog 映射 source 到 `bookId` 和 normalized path。
- `scripts/graphrag/batch-epub-workflow.mjs:8353` 到 `8365` 中，`main()` 在
  `acquireCoordinatorLock()` 与 run-file reconcile 前调用 `discoverItems()`；
  因此 corrupt or checksum-mismatched `catalog/books.yaml` 可在 runner 启动阶段
  被信任或导致非 quarantine abort。

为什么仍阻塞：

`catalog/books.yaml` 是 book identity 与 status derivation 的生产 catalog。
固定基准 4 要求 catalog/book state writes 的 invalid targets 在 restart 上
reconcile；基准 6 要求 manifest/status 不信任 mismatched cache。虽然 terminal
evidence 中的 `readGraphJob()` 已走 durable YAML reader，但启动路径仍存在不等价
reader，会让同一生产证据面出现 durable 与 non-durable 两套语义。

建议修复方向：

- 将 `loadCatalogBySourceHash()` 改为复用 runner durable YAML helper，并用
  `BookJobCatalogSchema` 解析。
- 在 checksum mismatch 或 invalid YAML 时 quarantine target 并 fail closed；
  checksum 缺失时 backfill。
- 增加 CLI 负向测试：篡改 `catalog/books.yaml.sha256` 或写入 invalid YAML 后，
  runner 不得继续按该 catalog 派生 book identity，并应产生 quarantine 证据。

### R6-B03: 黑盒负向测试仍未覆盖剩余生产可靠性边界

违反基准：10。

证据：

- `test/cli.test.ts:12123` 覆盖 corrupt `qmd_output_manifest.json.sha256`，
  `test/cli.test.ts:12181` 覆盖 corrupt `qmd_row_count.json.sha256`，但未覆盖
  terminal gate 对 `books/{bookId}/checkpoints.yaml.sha256` 或
  `books/{bookId}/artifacts.yaml.sha256` mismatch 的 CLI fail-closed/quarantine。
- `test/book-job-state.test.ts:3023` 到 `3062` 覆盖 graph capability checksum
  recovery，`test/book-job-state.test.ts:3064` 到 `3144` 覆盖 stale book lease，
  `test/book-job-state.test.ts:3146` 到 `3183` 覆盖 commit hook；这些均未构造
  两个不同 book 并发发布同一个 `graph-capabilities.yaml` 的 no-lost-update
  行为。
- 当前未发现 batch runner 对 `catalog/books.yaml` checksum mismatch 的
  production black-box test。

为什么仍阻塞：

固定基准 10 要求测试覆盖 state/recovery behavior，而不是只验证 helper token。
当前测试已证明新增 helper 的若干单路径行为，但没有证明共享 catalog 并发 commit、
startup catalog durable recovery、terminal YAML evidence corrupt 三个生产边界。

建议修复方向：

- 增加 CLI/migrate-only 测试：corrupt `checkpoints.yaml.sha256` 与
  `artifacts.yaml.sha256` 时，不写新的 completed checkpoint 或 `item_completed`
  event，并 quarantine target。
- 增加 batch runner startup 测试：corrupt `catalog/books.yaml` 或其 checksum 后
  fail closed。
- 增加 graph capability 并发测试：两个 book 的 query_ready completion 并行后，
  explicit catalog 包含双方全部 capabilities。

## 残余非阻塞风险

- 本轮由 dev-agent-b 实际执行了三个 `node --check` 静态验证；`npm run
  test:types` 与 focused Vitest 命令按主控报告为已通过，未在本轮重复执行完整
  suite。

## 本轮验证命令

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：pass。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：pass。
- `node --check scripts/graphrag/batch-failure-classifier.mjs`：pass。

主控报告已通过的证据命令包括 type tests、focused CLI tests、book job state tests
和 GraphRAG book state tests；本轮复审结论以源码与测试只读审计为准。
