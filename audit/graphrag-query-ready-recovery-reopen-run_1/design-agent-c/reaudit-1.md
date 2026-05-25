# Design Agent C Reaudit 1

result: PASS

## 剩余发现

无剩余阻断发现。

上次 FAIL 的测试契约缺口已补齐：

- `docs/operations/graphrag-epub-batch-runbook.md:155` 到
  `docs/operations/graphrag-epub-batch-runbook.md:169` 已要求 focused
  regression 覆盖两个真实 persisted failure text：
  `GraphRAG document identity is missing for query_ready: doc-fd8875181a17` 和
  `capabilityScope references unknown or not-ready graphCapabilityId(s):
  book-356ff4920cdf-0bbd8bdb:graph_query`。契约要求 reopen 到 pending repair，
  重新进入 `query_ready` / `qmd query --graphrag` command check，保持
  `graph_extract`、`community_report`、`embed` producer run ids 不变，并禁止直接
  写成 `completed`。
- `docs/architecture/unified-retrieval-plane.md:835` 到
  `docs/architecture/unified-retrieval-plane.md:840` 已把同两条真实 failure text
  纳入验收门槛，要求从 persisted `stop_until_fixed` checkpoint reopen 到
  `pending/continue_pending`，走正常 resume 与 command checks。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1964` 到
  `docs/architecture/unified-retrieval-plane.type-dd.yaml:1988` 已加入两条 focused
  regression、local projection reopen metadata 断言和 negative reopen tests。
- `catalog/data-bus.catalog.yaml:71` 到
  `catalog/data-bus.catalog.yaml:73`、`catalog/data-bus.catalog.yaml:1099` 到
  `catalog/data-bus.catalog.yaml:1102` 已同步数据总线的 reopen metadata 投影边界。

固定基准其余项仍满足：reopen 仅限本地 query-ready / graph-query projection gate，
基于 failure text 和当前 artifacts 重分类；identity 与 capability projection repair
均有 validated evidence gate；reopen 不伪造 completed；高成本 GraphRAG stages 在
producer checkpoints 和 artifacts 有效时不得重跑；mixed-book output、stale sidecar、
content/hash mismatch、missing producer lineage 和 incomplete artifacts 均 fail closed。

## 残余风险

- 本次复审仍只核对设计文件，未运行实现代码或测试套件。
- 历史 checkpoint 的 redacted failure text 若被截断、改写或本地化，classifier 仍需
  实现级测试证明可稳定命中。
- capability projection repair 涉及可重建 catalog 与可能的 qmd sqlite mirror；并发
  resume、stale mirror 和重复 reopen 的幂等性仍需实现级测试覆盖。
