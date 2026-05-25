# GraphRAG Query-Ready Recovery Reopen 设计复审报告

result: PASS

## 剩余发现

无阻断发现。

上次失败项已修复。真实 failure text 回归测试契约已补齐：

- [docs/operations/graphrag-epub-batch-runbook.md](/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:155)
  要求 focused regression 覆盖
  `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`
  和
  `capabilityScope references unknown or not-ready graphCapabilityId(s):
  book-356ff4920cdf-0bbd8bdb:graph_query`。
- [docs/architecture/unified-retrieval-plane.md](/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.md:835)
  将两个历史 failure text 固定为验收门槛，并要求从 persisted
  `stop_until_fixed` checkpoint reopen 到 `pending`/`continue_pending`，
  走正常 resume 与 command checks，且不得直接 completed。
- [docs/architecture/unified-retrieval-plane.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:1964)
  和
  [docs/architecture/unified-retrieval-plane.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:1971)
  分别规定 identity failure 与 capabilityScope failure 的 focused
  regression。

checkpoint reopen 观测字段已足够支撑固定基准：

- [docs/operations/graphrag-epub-batch-runbook.md](/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:81)
  要求 `BatchItemCheckpoint.metadata` 记录 reopenedFromStatus、
  reopenedToStatus、reopenedFromRecoveryDecision、repairReason、
  repairFailureText、repairedProjection、repairEvidenceLocator、
  reusedProducerRunIds 和 `normalCommandChecksRequired=true`。
- [docs/architecture/unified-retrieval-plane.md](/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.md:735)
  要求 reopened checkpoint 保留同一组 machine-readable repair metadata，并规定
  event log 与 recovery summary 只投影 checkpoint facts。
- [docs/architecture/unified-retrieval-plane.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:382)
  将 reopen metadata 写入 Type DD contract；
  [catalog/data-bus.catalog.yaml](/Users/jin/projects/qmd_graphrag/catalog/data-bus.catalog.yaml:1099)
  在 data bus catalog 中同步声明该 metadata。

fail-closed 与高成本 stage 不重跑要求仍满足：

- [docs/operations/graphrag-epub-batch-runbook.md](/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:165)
  要求两个回归断言 `graph_extract`、`community_report`、`embed`
  producer run ids 不变，checkpoint 不得直接 completed。
- [docs/operations/graphrag-epub-batch-runbook.md](/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:167)
  要求 provider/network failure、mixed-book output、stale sidecar、
  source/content mismatch、missing producer lineage 和 incomplete artifacts
  不得被本地 projection reopen。
- [docs/architecture/unified-retrieval-plane.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:1987)
  将 negative reopen tests 写入验收项。

## 残余风险

- 本次仍是设计复审，未验证实现代码或测试实际存在并通过。
- `failedStage` 是 batch event log 与 recovery summary 的 required
  observability field，并且 `BatchItemCheckpoint` 顶层字段包含 failedStage；
  但 reopen metadata 未重复记录 `reopenedFromFailedStage`。实现必须确保 item
  从 failed reopen 到 pending 时不丢失原 failedStage，且 event log 与 recovery
  summary 从 checkpoint 投影该字段。
- `continue_pending` 在设计中作为恢复决策语义出现；实现层需要避免把它误建模为
  与 `pending` 并列的不兼容 item status。
