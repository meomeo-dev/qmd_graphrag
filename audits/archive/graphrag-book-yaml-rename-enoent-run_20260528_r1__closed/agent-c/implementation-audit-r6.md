# Implementation Audit R6

审计对象：GraphRAG 多书并行 Runner 的 R6 当前实现。

审计基准：仅使用 `agent-c/criteria.md` 固定 10 条 Implementation Audit
Criteria，未新增或改变标准。

结论：PASS

## 判定

R6 未发现违反固定 criteria 的阻断项。新增 SIGTERM/SIGINT cleanup
（signal cleanup）与 durable schema closure（持久化 schema 闭环）没有破坏
R5 已通过的 durable rename ENOENT 分类、子进程 typed envelope、父 runner
投影优先级、evidence fail-closed、status-json 只读边界、settings projection
拒绝可观测性或 realRunner gate。

本轮未读取 `.env`，未运行真实 EPUB runner。执行的 runner 相关测试均使用
`--skip-dotenv` 与测试 hook；signal cleanup 测试使用 fake resume runner，不恢复真实
EPUB 处理。

## Criteria 覆盖

1. Type DD 一致性：PASS。
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:59` 至 `:61`
   要求 takeover 前处理 durable subprocess registry，无法终止时
   `stop_until_fixed`；`:896` 至 `:902` 要求子进程 process group cleanup；
   `:903` 至 `:977` 定义 subprocess durable failure envelope 与父 runner
   投影规则；`:1404` 至 `:1422` 定义 status-json read-only contract。实现未新增
   设计外完成态、失败分类或恢复策略。

2. Durable rename ENOENT 分类：PASS。
   book-scoped `job.yaml`、`artifacts.yaml`、`checkpoints.yaml` 仍映射到
   `checkpointWriterLane`，见 `src/job-state/durable-state-store.ts:90` 至
   `:94`。异步与同步 rename ENOENT 仍抛出 `DurableStateError`，投影为
   `local_state_integrity`、`durable_temp_rename_enoent`、`retryable=false`、
   `stop_until_fixed`，并保留 `failedSyscall=rename`、`errno=ENOENT`、
   `renameCause` 与 `completedPublishRule=forbidden`，见
   `src/job-state/durable-state-store.ts:1338` 至 `:1390`。

3. 子进程 failure envelope：PASS。
   `resume-book-workspace` 仍在捕获 `DurableStateError` 时输出单行
   `QMD_GRAPHRAG_DURABLE_FAILURE` JSON envelope，并携带 Type DD 要求的根因字段，
   见 `scripts/graphrag/resume-book-workspace.mjs:120` 至 `:170` 与 `:1527`
   至 `:1535`。

4. 父 runner 解析优先级：PASS。
   `runCommand` 先解析 stdout/stderr 中的 typed envelope，再进入 legacy 文本分类，
   见 `scripts/graphrag/batch-epub-workflow.mjs:9610` 至 `:9628`。可解析
   envelope 投影到 commandCheck 与 `command_failed` event，见 `:9653` 至
   `:9707`；durable diagnostics 进入 status-json 与 recovery summary，见
   `:4488` 至 `:4582` 与 `:9038` 至 `:9084`。

5. Evidence fail-closed：PASS。
   malformed、unparseable、缺失或字段不完整 envelope 仍归入
   `durable_subprocess_evidence_incomplete`，并写入 unavailable sentinel、
   `evidenceIncomplete`、`evidenceIncompleteReason` 与 `completedPublishRule`，
   见 `scripts/graphrag/batch-epub-workflow.mjs:2940` 至 `:3132`。缺失 envelope
   只有在 durable subprocess boundary 且 legacy 分类确认本地 durable failure 时
   才 fail closed，见 `:2962` 至 `:2976`。

6. 真实 runner 门控：PASS。
   real runner 仍未恢复。`reports/status.json:100` 至 `:107` 显示
   implementation audit R6 仍在进行；`:160` 至 `:162` 显示
   `realRunner.resumeAllowed=false`，原因是等待所有 agent 通过 R6。

7. 测试闭环：PASS。
   `test/cli.test.ts:3924` 至 `:4046` 覆盖 `job.yaml`、`checkpoints.yaml`、
   `artifacts.yaml` 三个 resume-book child rename ENOENT 场景，并断言 child
   stderr envelope、父 commandCheck、checkpoint、events、status-json 与 recovery
   summary 的关键字段。R6 新增的 `test/graphrag-runner-signal-cleanup.test.ts:141`
   至 `:171` 覆盖 SIGTERM 后事件、subprocess registry 与子进程终止；新增
   `test/integrations/contracts.test.ts:1812` 至 `:1897` 覆盖 commandCheck、
   checkpoint、event、manifest 与 recovery summary 的 durable schema closure。

8. Settings projection 安全性：PASS。
   缺失 managed projection 仍会创建，见
   `src/graphrag/settings-projection.ts:361` 至 `:381`；无 managed marker 的
   user-owned `graph_vault/settings.yaml` 仍拒绝覆盖，见 `:393` 至 `:395` 与
   `:439` 至 `:440`。拒绝 metadata 仍投影到 checkpoint、events 与 summary，
   见 `scripts/graphrag/batch-epub-workflow.mjs:2282` 至 `:2358`、
   `:8999` 至 `:9022`，回归断言见 `test/cli.test.ts:9524` 至 `:9668`。

9. Durable read-only 约束：PASS。
   `--status-json` 路径仍在 `printStatusAndExit` 后返回，不写 recovery summary，
   见 `scripts/graphrag/batch-epub-workflow.mjs:11450` 至 `:11452` 与 `:9094`
   至 `:9098`。读路径仅记录内存 diagnostic，缺失 checksum meta 投影为
   `metadata_missing_read_only` / `read_only_degraded`，见 `:4496` 至 `:4516`
   与 `:4584` 至 `:4665`。聚焦测试确认 status-json 不创建、删除或 rename
   durable sidecar。

10. 维护性约束：PASS with recorded risk。
    R6 变更集中在既有 runner signal cleanup、subprocess registry 与 contract
    tests，未发现与修复目标无关的大型语义重构。以下文件超过项目行数阈值，
    继续作为维护性风险记录：
    - `scripts/graphrag/batch-epub-workflow.mjs`：11961 行。
    - `src/job-state/graphrag-book.ts`：2209 行。
    - `src/job-state/durable-state-store.ts`：2149 行。
    - `scripts/graphrag/resume-book-workspace.mjs`：1542 行。
    - `test/cli.test.ts`：17756 行。
    - `test/integrations/contracts.test.ts`：3678 行。
    - `test/graphrag-runner-status-json-readonly.test.ts`：592 行。

## R6 增量核查

SIGTERM/SIGINT cleanup 实现在 `scripts/graphrag/batch-epub-workflow.mjs:3819`
至 `:3927`：handler 设置 `batchStopRequested`，记录
`batch_stop_requested` 与 `batch_active_subprocesses_terminating`，先向 active
process group 发送 SIGTERM，超时后发送 SIGKILL，并释放 coordinator lock。该路径
使用既有 `stop_until_fixed` 语义，没有新增 failureKind 或 recoveryDecision。

durable schema closure 通过 Zod contract 与回归测试覆盖：`src/contracts/batch-run.ts:45`
至 `:87` 定义 durable diagnostic 字段，`:380` 至 `:448` 覆盖 manifest
durable summary，`:642` 至 `:680` 覆盖 recovery summary durable diagnostics；
测试 `test/integrations/contracts.test.ts:1812` 至 `:1897` 已通过。

## 验证命令

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：PASS。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：PASS。
- `node --check scripts/graphrag/batch-failure-classifier.mjs`：PASS。
- `npm run test:types`：PASS。
- `node -e "import { readFileSync } from 'node:fs'; import YAML from 'yaml';
  YAML.parse(readFileSync('docs/architecture/graphrag-parallel-runner.type-dd.yaml',
  'utf8')); JSON.parse(readFileSync('audits/graphrag-book-yaml-rename-enoent-run_20260528_r1__open/reports/status.json',
  'utf8')); console.log('parse ok')"`：PASS。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/integrations/contracts.test.ts -t
  "accepts durable schema closure payloads across batch contracts"`：PASS。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-runner-status-json-readonly.test.ts`：PASS。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-runner-durable-preflight.test.ts`：PASS。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/graphrag-runner-signal-cleanup.test.ts`：PASS
  （隔离重跑）。

初次并行执行 `test/graphrag-runner-signal-cleanup.test.ts` 与其他聚焦套件时，该
测试曾因 fake resume child 未在 10 秒等待窗口内写入 `resume-started` 而失败；
隔离重跑通过。该现象记录为测试调度/时序风险（test scheduling risk），不构成
固定 criteria 阻断项。

## 未执行项

- 未运行真实 EPUB runner。
- 未读取 `.env`。
- 未修改源码或 criteria。

## 最终结论

PASS。R6 当前实现仍满足 agent-c 固定 10 条 Implementation Audit Criteria；
real runner gate 必须继续保持关闭，直到所有审计 agent 完成并明确允许恢复。
