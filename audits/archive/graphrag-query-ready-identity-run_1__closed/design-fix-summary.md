# Query Ready Identity 设计修复摘要

## 范围

本轮修复只补充设计与验收，不修改运行代码。

已修改文档：

- `docs/architecture/unified-retrieval-plane.md`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `catalog/data-bus.catalog.yaml`

## 决策

- `DocumentIdentityMap` 是 `query_ready` capability 发布与查询路由读取的 catalog
  projection。
- `qmd_graph_text_unit_identity.json` 是从 GraphRAG output 派生的可验证 repair
  evidence，不是发布事实源。
- 同一 `canonicalBookId/sourceHash/documentId/contentHash` 的 identity map upsert
  必须非破坏性合并，保留 qmd metadata、chunkIds 与已验证 graph identity。
- 当有效 GraphRAG output、producer lineage、qmd corpus registration 和 sidecar
  存在，但 catalog 缺 graph fields 时，状态归类为
  `graph_identity_projection_missing`。
- resume 对该状态只做低成本 catalog projection repair 和 `query_ready` 重试，不得
  重跑 `graph_extract`、`community_report` 或 `embed`。
- repair 必须 fail-closed：混书 output、source/content mismatch、空 text units、
  text unit id 不存在、无效 output locator、producer lineage 不一致、多 document
  歧义且无有效 sidecar 时全部拒绝。
- 提交边界明确排除 `graph_vault/`、`.qmd/*.sqlite*`、`inbox/`、`tmp/`、运行日志和
  原始 provider payload。

## 后续实施边界

设计通过后，运行代码最小改动范围限定为：

- `src/job-state/repository.ts`
- `src/job-state/graphrag-book.ts`
- 对应回归测试

不得通过编辑 GraphRAG parquet、重写 producer manifest、重跑高成本 GraphRAG stage
或修改无关查询输出逻辑来修复该问题。
