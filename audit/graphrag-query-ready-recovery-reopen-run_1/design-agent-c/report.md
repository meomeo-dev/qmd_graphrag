# Design Agent C Audit Report

result: FAIL

## 逐条基准判断

1. PASS。设计限定 `stop_until_fixed` reopen 只适用于本地
   query-ready / graph-query readiness gate。Provider、network 和 transient
   failure 仍走 retry/provider recovery 路径，unknown 和 permanent failure 不被
   自动 reopen。证据见
   `docs/operations/graphrag-epub-batch-runbook.md:71`、
   `docs/operations/graphrag-epub-batch-runbook.md:139`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:375`。
2. PASS。reopen 基于 persisted failure text 与当前 validated artifacts，而不是
   operator intent。证据见
   `docs/operations/graphrag-epub-batch-runbook.md:128`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:376`。
3. PASS。缺失 QMD-to-GraphRAG document identity 可在 validated sidecar 或
   validated book-scoped GraphRAG output 存在后修复。证据见
   `docs/operations/graphrag-epub-batch-runbook.md:123`、
   `docs/architecture/unified-retrieval-plane.md:349`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1665`。
4. PASS。unknown / not-ready `graphCapabilityId` 仅在 `query_ready` lineage、
   artifact lineage 和 document identity 有效后重建 capability projection。证据见
   `docs/operations/graphrag-epub-batch-runbook.md:215`、
   `docs/architecture/unified-retrieval-plane.md:728`、
   `catalog/data-bus.catalog.yaml:1087`。
5. PASS。reopen 不得写 `completed`，只能进入 `pending` 或
   `continue_pending`，并继续正常 resume 与 command checks。证据见
   `docs/operations/graphrag-epub-batch-runbook.md:75`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1603`、
   `catalog/data-bus.catalog.yaml:1090`。
6. PASS。event log、item checkpoint、recovery summary、failed stage 和 repair
   reason 的观测面有设计约束。证据见
   `docs/operations/graphrag-epub-batch-runbook.md:28`、
   `docs/operations/graphrag-epub-batch-runbook.md:75`、
   `catalog/data-bus.catalog.yaml:66`、
   `catalog/data-bus.catalog.yaml:114`。
7. PASS。高成本 `graph_extract`、`community_report`、`embed` checkpoint 与
   artifacts 仍有效时不得重跑。证据见
   `docs/operations/graphrag-epub-batch-runbook.md:133`、
   `docs/operations/graphrag-epub-batch-runbook.md:213`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1608`。
8. PASS。混书 output、stale sidecar identity、content/hash mismatch、缺失
   producer lineage 和 incomplete artifacts 均 fail closed。证据见
   `docs/operations/graphrag-epub-batch-runbook.md:219`、
   `docs/architecture/unified-retrieval-plane.md:368`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:493`。
9. FAIL。设计提到两条 persisted failure text，但测试验收没有覆盖本次真实失败
   shapes：`GraphRAG document identity is missing for query_ready` 和
   `capabilityScope references unknown or not-ready graphCapabilityId(s)`。
   Type DD 的 regression acceptance 只覆盖另一个
   `book-9f587b71073a-ad95ce2f` identity repair 场景，未要求
   `doc-fd8875181a17` 和
   `book-356ff4920cdf-0bbd8bdb:graph_query` 的 focused tests。
10. PASS。实现边界被限制在 failure classification、checkpoint/load resume、
    catalog/query_ready projection repair 和 command-check 路径；设计未要求修改
    unrelated qmd search、CLI rendering 或 GraphRAG execution behavior。证据见
    `docs/operations/graphrag-epub-batch-runbook.md:131`、
    `docs/architecture/unified-retrieval-plane.type-dd.yaml:1596`、
    `catalog/data-bus.catalog.yaml:1070`。

## 发现项

- F1 HIGH：回归测试契约未覆盖固定基准要求的两个真实失败形态。
  `docs/operations/graphrag-epub-batch-runbook.md:128` 到
  `docs/operations/graphrag-epub-batch-runbook.md:135` 明确识别了两条历史
  failure text，并规定必须重分类到本地 repair path。但
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:1942` 到
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:1950` 只要求另一个
  `book-9f587b71073a-ad95ce2f` identity repair regression 和若干 negative
  tests；`catalog/data-bus.catalog.yaml:64` 与
  `catalog/data-bus.catalog.yaml:85` 只引用通用 contract fixtures。设计缺少对
  `doc-fd8875181a17` missing identity failure 和
  `book-356ff4920cdf-0bbd8bdb:graph_query` capabilityScope failure 的 focused
  tests，因此不满足基准 9。

## 必须修复项

- 在 Type DD、catalog 或相应测试计划中加入 focused regression tests，覆盖
  `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`
  的 `stop_until_fixed` checkpoint：validated sidecar 或 book-scoped output
  可证明时，同一 `runId` reopen 到 `pending` 或 `continue_pending`，修复
  `DocumentIdentityMap`，重新进入 `query_ready` 与 command checks，且
  `graph_extract`、`community_report`、`embed` producer run ids 不变。
- 加入 focused regression tests，覆盖
  `capabilityScope references unknown or not-ready graphCapabilityId(s):
  book-356ff4920cdf-0bbd8bdb:graph_query`：只有 validated `query_ready`
  lineage、artifact lineage 和 document identity 均有效时，才重建
  graph capability projection 并重新运行 `qmd query --graphrag` 检查；不得直接
  写 `completed`。
- 加入 negative tests，证明 provider/network failure、ambiguous data、
  mixed-book output、stale sidecar、content-hash mismatch、missing producer
  lineage 和 incomplete artifacts 不会被 reopen。

## 残余风险

- 本审计只核对设计文件，未验证实现代码或实际测试结果。
- failure classifier 依赖历史 checkpoint 中保留的 redacted failure text；若旧
  checkpoint 文本被截断或格式变化，仍可能无法命中 reopen 分类。
- capability projection 为可重建投影，仍需要并发 resume 与 stale catalog mirror
  的实现级测试确认不会误发布 capability。
