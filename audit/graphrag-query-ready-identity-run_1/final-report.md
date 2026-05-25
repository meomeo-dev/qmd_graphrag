# Query Ready Identity 设计审计汇总

## 结论

设计审计初始结果：FAIL。

最终状态：开发审计通过，准备恢复真实 EPUB 闭环。

三名审计代理均按已固定基准审计，未替换或新增判定标准。共同结论是：
GraphRAG output 与 `qmd_graph_text_unit_identity.json` 已存在时，系统仍缺少
明确的 identity projection repair 设计，导致 `DocumentIdentityMap` 缺失
`graphDocumentId` 或 `graphTextUnitIds` 时无法低成本恢复 `query_ready`。

## 审计输入

- 固定基准：
  - `design-agent-a/baseline.md`
  - `design-agent-b/baseline.md`
  - `design-agent-c/baseline.md`
- 审计报告：
  - `design-agent-a/report.md`
  - `design-agent-b/report.md`
  - `design-agent-c/report.md`
- 真实失败：
  - runId: `epub-batch-20260525-full-real`
  - bookId: `book-9f587b71073a-ad95ce2f`
  - itemId: `item-9f587b71073a-cff9f38d`
  - error:
    `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`

## 共同缺口

- `qmd_graph_text_unit_identity.json` 的角色未被设计为可验证修复证据
  （repair evidence）。
- `DocumentIdentityMap` 作为 query capability 发布读取源的地位已存在，但缺少
  从 sidecar 或 validated parquet output 修复 catalog projection 的契约。
- `upsertDocumentIdentityMap` 可能重建同书 entry 并丢失已验证 graph identity，
  设计中未声明非破坏性合并（non-destructive merge）要求。
- 多 GraphRAG document、source/content mismatch、空 text units 等负例缺少
  fail-closed 规则。
- 有效 output 已存在但 identity projection 缺失时，resume 应执行低成本本地
  修复，而不是重跑 `graph_extract`、`community_report` 或 `embed`。
- 验收缺少真实失败形态：sidecar 已存在、catalog 缺 graph fields、重新 sync
  后 query-ready 成功且高成本 producer run ids 不变。
- 运行产物提交边界未被设计文档明确化，容易误提交 `graph_vault`、临时日志、
  provider sidecar 或 qmd SQLite index。

## 决策

本轮不进入 runtime 实施。先补充并修正设计：

- 补充设计：定义 GraphRAG identity projection repair、sidecar 角色、恢复状态、
  真实失败验收和提交边界。
- 修正完善设计：明确 GraphRAG 内部 document id 与 qmd document id 的映射规则，
  允许可证明的单书修复，拒绝多文档歧义猜测。
- 修剪错误设计：不得通过修改 GraphRAG parquet、重写 producer manifest、重跑
  高成本 GraphRAG stage 或按 title/首行猜测 identity 来修复。
- 继续实施边界：运行代码后续只允许触及状态仓库、GraphRAG book sync 和对应测试；
  既有 retrieval/query 输出设计不扩大改动范围。

设计补丁已按原固定基准完成三路复审，结果均为 DESIGN PASS。随后完成最小运行
实现并进行三路开发审计：Dev Agent B 初审 PASS，Dev Agent C 复审 PASS，Dev
Agent A 第二次复审 PASS。

已通过的最终验证：

- `npm run test:types`
- `test/book-job-state.test.ts`
- `test/graphrag-book-state.test.ts`
- `test/unified-query.test.ts`
- `test/cli-graphrag-route.test.ts`
- `test/integrations/graphrag-cost.test.ts`
- `test/cli.test.ts`
- `test/python/test_graphrag_bridge_scope.py`

下一步必须返回真实 EPUB 闭环，恢复失败书或新真实 run，并确认高成本 producer run
ids 不变、catalog graph identity 被补齐、`query_ready` 与固定 command checks 通过。
