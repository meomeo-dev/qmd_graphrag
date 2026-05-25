# 开发审计基准 C：回归测试、观测性与真实闭环风险

caseId: graphrag-query-ready-recovery-reopen

## 审计范围

审计实现是否具备可验证的 focused regression，是否满足每本书 qmd / GraphRAG
状态可观测，并能支撑后续真实 EPUB 批处理恢复。重点文件：

- `test/cli.test.ts`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/architecture/unified-retrieval-plane.md`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml`
- `catalog/data-bus.catalog.yaml`
- `audit/graphrag-query-ready-recovery-reopen-run_1/status.yaml`

## 固定基准

1. 测试必须覆盖真实 failure text：
   `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`。
2. 测试必须覆盖真实 failure text：
   `capabilityScope references unknown or not-ready graphCapabilityId(s):
   book-356ff4920cdf-0bbd8bdb:graph_query`。
3. 测试必须验证 repair 成功写入固定 metadata 字段，不允许字段名漂移。
4. 测试必须验证 repair 不直接 completed，后续仍进入正常闭环执行。
5. 测试必须验证 repair-only 不发起 `runtime.graphQuery`。
6. 测试必须验证 repair blocked loop 不会无限重复 repair。
7. 类型检查必须通过，且新增 metadata 仍满足 JSON schema / zod schema。
8. 文档、Type DD 和 data-bus catalog 必须与实现字段名一致。
9. 每本书状态快照仍必须包含 `qmdBuildStatus`、`graphBuildStatus`、
   `graphQueryStatus`，且 repair 不得绕过这些状态快照。
10. 真实批处理恢复前必须保留可审计证据：固定基准、审计报告、测试命令、
    测试结果、最终决策状态。
