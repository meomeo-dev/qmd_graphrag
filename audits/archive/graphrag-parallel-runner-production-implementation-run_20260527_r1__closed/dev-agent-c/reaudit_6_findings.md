# GraphRAG 多书并行 Runner 生产实现复审 reaudit_6

## 结论

status: pass

固定基准文件为 `dev-agent-c/criteria.md`，SHA-256 为
`44829b40c6d6373b6bed0b93051a776627b4020b70070dcde1cd39f46fa04b0c`。

本轮只读复核当前 worktree，未修改 `criteria.md`，未读取或输出 `.env`、
密钥或凭据。

## 第 5 轮阻塞项闭合状态

### R5-B01: qmd index file lock coverage

状态：closed。

`qmdIndexLockedCommandNames` 已由 `requiredCommandCheckNames` 派生，覆盖 batch
闭环中所有 qmd 子命令。`qmd()` 使用该集合判断是否进入 qmd index writer lane
与 file lock。新增测试断言所有 batch qmd commands 均 acquire/release qmd
index file lock。

### R5-B02: Python bridge subprocess registry

状态：closed。

`callPythonBridge()` 在 batch runner 环境变量存在时写入同一 durable
`subprocesses/*.json` registry，记录 runner/session/host/pid、item/book/worker
与 process group。registry 初始写入失败时会终止 child process group 并 reject；
close 后写 final record。

### R5-B03: subprocess registry provider slot fence

状态：closed。

`BatchSubprocessRecordSchema` 与 batch runner subprocess record 已包含
`providerSlotProvider`、`providerSlotGeneration`、
`providerSlotFencingToken`。`spawnCommand()` 的 running 与 spawn error 两条路径
均持久化这些字段；Python bridge 也从 batch env 中记录 provider slot fence。

### R5-B04: GraphRAG catalog durable write

状态：closed。

GraphRAG provider request artifact 使用 durable JSON writer 并写 `.sha256`
sidecar。cost accounting JSONL 追加前执行 schema prefix recovery，corrupt tail
会 quarantine 为 `.corrupt-<timestamp>-<pid>`，有效 prefix 会 durable rewrite，
每次 append 使用 `writeSync` 与 `fsyncSync`。

### R5-B05: status-json worker/wait observability

状态：closed。

`BatchRecoverySummaryItemSchema` 包含 `workerId`，recovery summary 从 item
checkpoint 或 metadata 派生 worker。provider wait 从 active durable provider
slot lease 的 `waitMs` 派生，并投影 `activeProviderSlots` 与
`providerSlotGeneration`。

### R5-B06: behavior coverage

状态：closed。

新增 focused tests 覆盖 qmd index lock 全命令、worker pool overlap、provider
slot durable fence、same-host live orphan termination、Python bridge registry、
provider request durable artifact、cost ledger corrupt-tail recovery、graph
capability durable/fenced commit、terminal evidence checksum mismatch 与 LanceDB
row-count checksum rejection。

## 固定基准逐条判定

| # | 基准 | 判定 | 复审结论 |
|---|---|---|---|
| 1 | coordinator exclusivity | pass | `coordinator-lock.json` 持久互斥、heartbeat、expiry、generation 与 live pid 检查保持有效。 |
| 2 | item/book lease fencing | pass | item/book checkpoint、terminal event、catalog、qmd corpus 与 graph capability commit 均有 fence 校验。 |
| 3 | provider durable semaphore | pass | provider slot lease 覆盖 batch runner 与 Python bridge subprocess boundary，并持久记录 generation/fencing token。 |
| 4 | qmd index writer lane/file lock | pass | batch qmd command set 全量进入 qmd index writer lane/file lock；GraphRAG qmd mutation stage 串行执行。 |
| 5 | subprocess process-group recovery | pass | top-level subprocess 与 Python bridge child 均有 durable registry/process group 边界；same-host live orphan recovery 有测试。 |
| 6 | durable write contract | pass | JSON/YAML/catalog/provider request/cost ledger 关键状态具备 durable write、checksum 或 corrupt-tail recovery。 |
| 7 | terminal commit order | pass | terminal evidence、item/book fence、checkpoint、event、manifest/status 派生与 lease release 顺序保持 fail-closed。 |
| 8 | manifest/status-json projection | pass | status-json 展示 worker、provider slots、wait time、slot generation、running command 与 recovery decision。 |
| 9 | bounded worker pool | pass | 单 coordinator 内 bounded worker pool 证明多书重叠执行，duplicate book 与 fail-fast quiesce 有测试。 |
| 10 | behavioral evidence | pass | 固定基准要求的并行、fencing、provider、qmd lock、subprocess、catalog 和 durable recovery 均有行为证据。 |

## 关键证据

代码证据：

- `scripts/graphrag/batch-epub-workflow.mjs:258`
  `qmdIndexLockedCommandNames = new Set(requiredCommandCheckNames)`。
- `scripts/graphrag/batch-epub-workflow.mjs:6797`
  qmd commands 按 `qmdIndexLockedCommandNames` 进入 qmd index lock。
- `scripts/graphrag/batch-epub-workflow.mjs:5953`
  recovery summary 派生 worker/provider wait/slot generation。
- `scripts/graphrag/batch-epub-workflow.mjs:6429`
  subprocess record 写入 provider slot fence 字段。
- `src/contracts/batch-run.ts:68`
  provider slot lease schema 包含 `waitMs`。
- `src/contracts/batch-run.ts:89`
  subprocess record schema 包含 provider slot fence 字段。
- `src/contracts/batch-run.ts:309`
  recovery summary item schema 包含 `workerId`。
- `src/integrations/python-bridge.ts:136`
  Python bridge 使用 batch env registry。
- `src/integrations/graphrag.ts:162`
  provider request artifact durable JSON write。
- `src/provider/cost-accounting.ts:49`
  cost accounting corrupt-tail recovery。

测试证据：

- `test/cli.test.ts:2486` book concurrency 2 worker pool。
- `test/cli.test.ts:12123` corrupt terminal evidence checksum。
- `test/cli.test.ts:12181` corrupt LanceDB row-count checksum。
- `test/integrations/python-bridge-early-stop.test.ts:45` Python bridge registry
  provider slot fencing。
- `test/integrations/graphrag-cost.test.ts:426` corrupt cost ledger recovery。
- `test/book-job-state.test.ts:3146` graph capability durable/fenced commit hooks。

## 通过的验证命令

- `node --check scripts/graphrag/batch-epub-workflow.mjs`
- `node --check scripts/graphrag/resume-book-workspace.mjs`
- `node --check scripts/graphrag/batch-failure-classifier.mjs`
- `npm run test:types -- --pretty false`
- focused `test/cli.test.ts` 8 个关键用例。
- focused `test/integrations/python-bridge-early-stop.test.ts` 1 个关键用例。
- focused `test/integrations/graphrag-cost.test.ts` 3 个关键用例。
- focused `test/book-job-state.test.ts` 4 个关键用例。

## 非阻塞风险

完整测试套件未在本轮执行。当前 pass 结论覆盖第 5 轮阻塞项与固定 10 条生产
基准的关键行为路径。
