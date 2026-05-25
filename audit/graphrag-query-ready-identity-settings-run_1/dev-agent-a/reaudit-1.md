# GraphRAG query_ready 恢复设计复审报告 - Agent A

## 结论

PASS

本次复审基于当前工作区最新设计文档，并使用固定基准
`audit/graphrag-query-ready-identity-settings-run_1/dev-agent-a/baseline.md`。
四份设计文档已经定义足够的运行时行为，用于指导修复真实 batch EPUB 失败：

- `GraphRAG document identity is missing for query_ready`
- `capabilityScope references unknown or not-ready graphCapabilityId(s)`
- identity sidecar 与 catalog projection 不一致
- `settings.yaml` 受管投影 drift 或 mismatch

设计将 query-ready identity 与 graph capability 缺失归类为本地 projection
repair，要求 reopen 到 pending/continue_pending，保留有效高成本 producer
run ids，并在修复后重新执行正常 resume 与 command checks。source/content、
book/document identity、producer lineage、sidecar adoption 或 settings projection
前置条件不满足时，设计要求 fail-closed。

## 固定基准结果

| # | 结果 | 复审判断 |
|---|---|---|
| 1 | PASS | 设计区分 `graph_extract`、`community_report`、`embed` 与 `query_ready` ownership；`query_ready` 只引用已验证查询产物，并在发布 capability 前验证三个 producer checkpoint 与 artifact 证据。证据：`docs/architecture/unified-retrieval-plane.md:345`、`docs/operations/graphrag-epub-batch-runbook.md:136`。 |
| 2 | PASS | `query_ready` repair 必须把 affected item reopen 到 pending/continue_pending，不得直接 completed。证据：`docs/operations/graphrag-epub-batch-runbook.md:78`、`docs/architecture/unified-retrieval-plane.md:736`。 |
| 3 | PASS | 有效 artifact 存在时，repair 必须保留 `graph_extract`、`community_report`、`embed` producer run ids，并不得重跑这些高成本 stage。证据：`docs/operations/graphrag-epub-batch-runbook.md:96`、`docs/architecture/unified-retrieval-plane.type-dd.yaml:1661`。 |
| 4 | PASS | repair 仅补缺失本地 projection，例如 `DocumentIdentityMap`、producer manifest 或 `query_ready` capability projection；不得借此重建高成本 GraphRAG artifacts。证据：`docs/operations/graphrag-epub-batch-runbook.md:169`、`docs/architecture/unified-retrieval-plane.type-dd.yaml:1747`。 |
| 5 | PASS | missing capability projection 被明确分类为 `graph_query_capability_projection_missing` 本地 projection repair，而不是 provider/network transient failure。证据：`docs/architecture/unified-retrieval-plane.md:744`、`docs/operations/graphrag-epub-batch-runbook.md:180`。 |
| 6 | PASS | document identity missing 或 sidecar/catalog mismatch 在 source/content lineage 匹配时是本地 projection repair candidate；sidecar 只是 repair evidence，不能替代 catalog gate。证据：`docs/architecture/unified-retrieval-plane.md:359`、`docs/operations/graphrag-epub-batch-runbook.md:156`。 |
| 7 | PASS | source hash、normalized content hash、document id、book id、normalizedPath 或 producer lineage mismatch 均 fail-closed。证据：`docs/architecture/unified-retrieval-plane.md:366`、`docs/architecture/unified-retrieval-plane.type-dd.yaml:1724`、`docs/operations/graphrag-epub-batch-runbook.md:161`。 |
| 8 | PASS | repair 后必须执行正常 command checks，且 `normalCommandChecksRequired=true`；reopen 不等于 completed。证据：`docs/operations/graphrag-epub-batch-runbook.md:80`、`docs/operations/graphrag-epub-batch-runbook.md:97`。 |
| 9 | PASS | checkpoint metadata、events 与 recovery summary 必须记录 repair reason、repaired projection、evidence locator 和 reused producer run ids；settings projection repair 也记录 rewrite/reject decision、source fingerprint、locator 和 redacted reason。证据：`docs/operations/graphrag-epub-batch-runbook.md:84`、`docs/architecture/unified-retrieval-plane.md:755`、`docs/architecture/graphrag-integration.md:208`。 |
| 10 | PASS | 设计包含真实失败文本的 regression acceptance，包括 document identity、capabilityScope unknown/not-ready 和 settings projection drift，并要求 producer run ids 不变、不得直接 completed、负例覆盖 provider/network、mixed-book、stale sidecar、mismatch、missing lineage、incomplete artifacts、user-owned settings 和 invalid source config。证据：`docs/operations/graphrag-epub-batch-runbook.md:174`、`docs/architecture/unified-retrieval-plane.type-dd.yaml:2035`。 |

## 必须修复项

无。

## 复审备注

本次复审仅判断设计文档是否足以指导修复；未审计实现代码、测试用例执行结果或
运行时产物。
