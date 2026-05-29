# Implementation Audit R5

审计对象：GraphRAG 多书并行 Runner 的 R4 修复后整体实现。

审计基准：仅使用 `agent-c/criteria.md` 固定 10 条 Implementation Audit
Criteria。

结论：PASS

## 判定

R5 未发现违反固定 criteria 的阻断项。当前实现满足 Type DD
（Type-driven design）中 subprocess durable failure envelope、父 runner
typed envelope 优先、durable rename ENOENT 分类、status-json 只读观测、
settings projection 拒绝可观测与真实 runner 门控要求。

本轮未运行真实 EPUB runner，也未读取 `.env`。验证采用静态审计、类型检查与
不会启动 batch runner 的语法检查。

## Criteria 覆盖

1. Type DD 一致性：PASS。
   `docs/architecture/graphrag-parallel-runner.type-dd.yaml:903` 定义
   subprocess durable failure projection；`docs/architecture/graphrag-parallel-runner.type-dd.yaml:954`
   要求父 runner 先解析 typed envelope；`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1404`
   定义 status-json read-only contract；`docs/architecture/graphrag-parallel-runner.type-dd.yaml:1582`
   定义 rename ENOENT 验收面。实现未引入设计外完成态、失败分类或恢复策略。

2. Durable rename ENOENT 分类：PASS。
   shared durable store 将 book-scoped `job.yaml`、`artifacts.yaml`、
   `checkpoints.yaml` 纳入 `checkpointWriterLane` target mapping，见
   `src/job-state/durable-state-store.ts:90`。异步与同步 rename ENOENT 均抛出
   `DurableStateError`，分类为 `local_state_integrity`、
   `durable_temp_rename_enoent`、`retryable=false`、`stop_until_fixed`，见
   `src/job-state/durable-state-store.ts:1336` 与
   `src/job-state/durable-state-store.ts:1366`。

3. 子进程 failure envelope：PASS。
   `resume-book-workspace` 将 `DurableStateError` 转为单行
   `QMD_GRAPHRAG_DURABLE_FAILURE` JSON envelope，并投影 root-cause 字段，见
   `scripts/graphrag/resume-book-workspace.mjs:120` 与
   `scripts/graphrag/resume-book-workspace.mjs:1527`。

4. 父 runner 解析优先级：PASS。
   `runCommand` 先从 stdout/stderr 解析 envelope，再进入 legacy 文本分类，见
   `scripts/graphrag/batch-epub-workflow.mjs:9563` 至
   `scripts/graphrag/batch-epub-workflow.mjs:9581`。durable projection 覆盖
   commandCheck、`command_failed`、item checkpoint、status-json 与 recovery
   summary，见 `scripts/graphrag/batch-epub-workflow.mjs:9606`、
   `scripts/graphrag/batch-epub-workflow.mjs:9632`、
   `scripts/graphrag/batch-epub-workflow.mjs:10990`、
   `scripts/graphrag/batch-epub-workflow.mjs:4488` 与
   `scripts/graphrag/batch-epub-workflow.mjs:8860`。

5. Evidence fail-closed：PASS。
   malformed、unparseable 或 incomplete envelope 被归入
   `durable_subprocess_evidence_incomplete`，并写入 unavailable sentinel 与
   `evidenceIncomplete` 字段，见
   `scripts/graphrag/batch-epub-workflow.mjs:2939`、
   `scripts/graphrag/batch-epub-workflow.mjs:3048` 与
   `scripts/graphrag/batch-epub-workflow.mjs:3107`。

6. 真实 runner 门控：PASS。
   门控仍保持关闭。`audits/graphrag-book-yaml-rename-enoent-run_20260528_r1__open/reports/status.json:145`
   至 `:147` 显示 `realRunner.resumeAllowed=false`，原因是 implementation audit
   r5 仍在进行。

7. 测试闭环：PASS。
   `test/cli.test.ts:3924` 至 `:4052` 覆盖 `job.yaml`、
   `checkpoints.yaml`、`artifacts.yaml` 三个 book-scoped YAML rename ENOENT
   场景，并断言 child stderr envelope、父 commandCheck、checkpoint、
   `command_failed`、`item_failed`、recovery summary、status-json 与
   durableStateFailures 的关键 Type DD 字段。该测试路径未在本审计中执行，以避免
   启动 batch runner。

8. Settings projection 安全性：PASS。
   缺失 managed projection 会创建，见
   `src/graphrag/settings-projection.ts:361`；user-owned
   `graph_vault/settings.yaml` 无 managed marker 时拒绝覆盖，见
   `src/graphrag/settings-projection.ts:393` 与
   `src/graphrag/settings-projection.ts:439`。拒绝 metadata 在 command events、
   item checkpoint 与 recovery summary 可观测，见
   `scripts/graphrag/batch-epub-workflow.mjs:2291`、
   `scripts/graphrag/batch-epub-workflow.mjs:2332`、
   `scripts/graphrag/batch-epub-workflow.mjs:11055`。R4 的
   `activeCommand` 断言已对齐到 `resume-book-1`，见 `test/cli.test.ts:9658`。

9. Durable read-only 约束：PASS。
   `--status-json` 路径直接输出 `buildRecoverySummary` 并返回，见
   `scripts/graphrag/batch-epub-workflow.mjs:11403`。read-only durable inspection
   只读 target/checksum/checksum meta 并记录内存诊断，见
   `scripts/graphrag/batch-epub-workflow.mjs:4537` 至 `:4624`。可写 reconcile、
   quarantine、checksum meta backfill 和 recovery summary 写入均受
   `!statusJson` 或普通运行路径限制，见
   `scripts/graphrag/batch-epub-workflow.mjs:5521`、
   `scripts/graphrag/batch-epub-workflow.mjs:5661`、
   `scripts/graphrag/batch-epub-workflow.mjs:5801` 与
   `scripts/graphrag/batch-epub-workflow.mjs:9040`。测试覆盖 read-only 与
   repair-writer 分界，见 `test/graphrag-runner-status-json-readonly.test.ts:250`。

10. 维护性约束：PASS with recorded risk。
    本修复仍集中在既有 runner 与 durable store 边界，未发现与目标无关的大型
    语义重构。以下文件超过项目行数阈值，作为维护性风险记录：
    - `scripts/graphrag/batch-epub-workflow.mjs`：11913 行。
    - `src/job-state/graphrag-book.ts`：2209 行。
    - `src/job-state/durable-state-store.ts`：2128 行。
    - `scripts/graphrag/resume-book-workspace.mjs`：1542 行。
    - `test/graphrag-runner-status-json-readonly.test.ts`：592 行。

## 验证记录

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：PASS。
- `node --check scripts/graphrag/resume-book-workspace.mjs`：PASS。
- `node --check scripts/graphrag/batch-failure-classifier.mjs`：PASS。
- `npm run test:types`：PASS。

未执行项：

- 未运行真实 EPUB runner。
- 未运行会启动 `batch-epub-workflow.mjs` 的集成测试用例。
- 未读取 `.env`。

## 维护性风险

`batch-epub-workflow.mjs` 已达到 11913 行，承担 coordinator、durable store
等价实现、status-json 投影、worker pool、settings projection observability
和 recovery summary 多个职责。后续应拆分以下边界：

- runner durable adapter 与 target mapping。
- subprocess envelope parsing/projection。
- status-json read-only inspection。
- checksum sidecar repair writer。
- settings projection metadata projection。
- worker scheduling 与 recovery summary builder。

这些风险不阻断 R5 PASS，但应作为后续收敛任务，避免下一轮修复继续扩大单文件
复杂度。
