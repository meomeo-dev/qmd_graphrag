Result: PASS

## Findings

无阻断发现。

## Verification Evidence

- 阶段隔离保持有效。`scripts/graphrag/resume-book-workspace.mjs:970`
  到 `scripts/graphrag/resume-book-workspace.mjs:1062` 的 `query_ready`
  分支只刷新 producer manifest、校验 query-ready artifacts 并完成
  `query_ready` checkpoint；高成本 `runtime.graphIndex` 只在后续通用
  GraphRAG stage 分支调用，见 `scripts/graphrag/resume-book-workspace.mjs:1079`
  到 `scripts/graphrag/resume-book-workspace.mjs:1200`。
- `repair-only` 不触发高成本 GraphRAG。`scripts/graphrag/resume-book-workspace.mjs:666`
  到 `scripts/graphrag/resume-book-workspace.mjs:864` 只从既有 producer evidence
  修复 stage/query_ready projection，并用 `graphQueryScopeFromSync` 验证 capability
  可读性；未调用 `runtime.graphIndex` 或 `runtime.graphQuery`。
- repair reopen 不等于完成。`scripts/graphrag/batch-epub-workflow.mjs:3687`
  到 `scripts/graphrag/batch-epub-workflow.mjs:3845` 将本地 artifact gate 修复结果
  重新置为 `pending`、清空旧 `commandChecks`，并固定
  `normalCommandChecksRequired: true`。随后 `scripts/graphrag/batch-epub-workflow.mjs:3922`
  到 `scripts/graphrag/batch-epub-workflow.mjs:3991` 只有完整 `runCliChecks()` 成功后
  才写入 `completed`。
- query_ready 证据闭环保持有效。`src/job-state/graphrag-book.ts:1402`
  到 `src/job-state/graphrag-book.ts:1545` 要求 producer run ids、stage/provider
  fingerprints、corpus content hash 和 book-scoped artifacts；`src/job-state/repository.ts:2472`
  到 `src/job-state/repository.ts:2503` 在接受 succeeded `query_ready` checkpoint 前
  复核 producer stages 与 query artifacts。
- qmd corpus registration 和 graph identity 仍是 capability 发布前置条件。
  `src/job-state/graphrag-book.ts:1689` 到 `src/job-state/graphrag-book.ts:1703`
  在 query-ready artifacts 存在时要求 qmd corpus registration，并触发 required
  graph identity adoption；`src/job-state/repository.ts:2664` 到
  `src/job-state/repository.ts:2698` 要求 `qmdCorpusRegistered`、`graphDocumentId`
  和非空 `graphTextUnitIds`。
- identity sidecar 继续 fail-closed。`src/job-state/graphrag-book.ts:653`
  到 `src/job-state/graphrag-book.ts:662` 校验 `bookId/sourceId/sourceHash/
  documentId/contentHash/normalizedPath` 和 graph text unit ids；`src/job-state/graphrag-book.ts:815`
  到 `src/job-state/graphrag-book.ts:827` 校验 text unit 存在；`src/job-state/repository.ts:1245`
  到 `src/job-state/repository.ts:1290` 只在 catalog identity 全字段匹配时记录
  graph text unit projection。
- 状态、summary、event 类型保持。`src/contracts/batch-run.ts:77`
  到 `src/contracts/batch-run.ts:132` 接受 `activeCommand` checkpoint 字段；
  `src/contracts/batch-run.ts:216` 到 `src/contracts/batch-run.ts:271` 接受
  recovery summary 的 `activeCommand` 与 settings projection 元数据；批处理脚本内
  mirror schema 与 `scripts/graphrag/batch-epub-workflow.mjs:2936` 到
  `scripts/graphrag/batch-epub-workflow.mjs:3017` 的 summary 投影一致。
- 本轮 settings projection 小修未破坏基准。`src/graphrag/settings-projection.ts`
  保持 user-owned settings 拒绝语义，同时允许 managed projection 被重写；
  `src/job-state/graphrag-book.ts:1558` 到 `src/job-state/graphrag-book.ts:1563`
  将修复结果作为 `settingsProjectionRepair` 返回，不绕过后续 identity、
  artifact 或 capability gate。

## Test Evidence

- PASS: `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/graphrag-book-state.test.ts test/integrations/contracts.test.ts --testNamePattern "..."`
  结果为 11 passed / 88 skipped，覆盖 sidecar 修复与拒绝、`normalizedPath`
  mismatch、query_ready artifacts、qmd corpus registration、settings projection
  repair/reject 和 batch contract schema。
- PASS: `node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts --testNamePattern "..."`
  结果为 7 passed / 178 skipped，覆盖 repair-only blocked/reopen、普通 CLI
  checks 重新执行、`normalCommandChecksRequired`、`activeCommand`、
  checkpoint/event/summary settings projection 元数据。

## Residual Risks

- 本次为聚焦复审，未运行全量测试套件。
- CLI 聚焦测试会创建并清理仓库 `.tmp-tests` 下的临时目录；复审未修改代码、
  测试或文档，仅写入本报告文件。
