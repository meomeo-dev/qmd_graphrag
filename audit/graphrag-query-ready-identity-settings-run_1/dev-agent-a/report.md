# GraphRAG query_ready 恢复设计审计报告 - Agent A

## 结论

PASS

现有设计文档足以指导修复本轮关注的真实失败：

- `GraphRAG document identity is missing for query_ready`
- `capabilityScope references unknown or not-ready graphCapabilityId(s)`
- sidecar 与 catalog 投影不一致
- `settings.yaml` 受管配置投影不一致

文档将 query-ready identity 与 capability 缺失归类为本地投影修复
（local projection repair），要求 reopen 到 pending/continue_pending，
保留高成本 producer lineage，并在修复后重新走正常 resume 与 command checks。
对 source/content、book、producer lineage、sidecar、settings fingerprint
不一致的情况，设计要求 fail-closed，而不是伪造 completed。

## 重点失败判断

- Document identity 缺失：已覆盖。`query_ready` 发布 capability 前必须验证
  `DocumentIdentityMap.graphDocumentId`、非空 `graphTextUnitIds` 和 qmd corpus
  registration；缺失时可从 validated sidecar 或 book-scoped output 低成本修复。
- Capability unknown/not-ready：已覆盖。`query_ready` lineage、artifact lineage
  和 document identity 有效时，只重建 graph capability projection，并重新运行
  `qmd query --graphrag` 检查。
- Sidecar mismatch：已覆盖。sidecar 是 repair evidence，不是发布事实源；当
  `bookId/sourceId/sourceHash/documentId/contentHash` 与当前 job/catalog 一致时可
  修复 catalog projection；stale sidecar、混书 output、source/content mismatch、
  空 text unit 或 producer lineage mismatch 必须拒绝。
- Settings projection mismatch：已覆盖为配置漂移（configuration drift）而非
  query_ready 本地 artifact repair。`graph_vault/settings.yaml` 必须由
  `.qmd/index.yml` 投影生成，并通过 managed header 与 source fingerprint 校验；
  fingerprint 不匹配时拒绝运行。

## 固定 Criterion 结果

1. PASS - 设计区分 `graph_extract`、`community_report`、`embed` 与
   `query_ready` ownership。`query_ready` 只引用已验证查询产物，必须先验证三个
   producer checkpoint 与 artifact 证据，且不得改写 producer stage。
   证据：`docs/architecture/unified-retrieval-plane.md:341`、
   `docs/operations/graphrag-epub-batch-runbook.md:121`。

2. PASS - `query_ready` repair 必须 reopen affected item 到 pending 或
   continue_pending，不能直接 completed。设计明确 `stop_until_fixed` 本地 gate
   repair 只进入正常 resume/command-check 路径。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:75`、
   `docs/architecture/unified-retrieval-plane.md:720`。

3. PASS - repair 必须保留有效高成本 producer run ids。metadata 要记录
   `reusedProducerRunIds`，且修复不得重跑 `graph_extract`、`community_report`
   或 `embed`。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:93`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1617`。

4. PASS - repair 只重建缺失本地 projection，例如 `DocumentIdentityMap`、
   producer manifest 或 `query_ready` capability projection。设计禁止为该类
   本地 projection failure 重跑高成本 stage。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:150`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1681`。

5. PASS - capability projection missing 被归类为本地 projection repair，而非
   provider/network transient failure。设计定义
   `graph_query_capability_projection_missing`，只重建 capability projection 并重跑
   GraphRAG query check。
   证据：`docs/architecture/unified-retrieval-plane.md:728`、
   `docs/operations/graphrag-epub-batch-runbook.md:249`。

6. PASS - document identity missing 和 sidecar/catalog 投影不一致在 source/content
   lineage 匹配时属于本地 projection repair candidate。设计同时规定 sidecar
   只能作为 repair evidence，不能绕过 `DocumentIdentityMap` catalog gate。
   证据：`docs/architecture/unified-retrieval-plane.md:355`、
   `docs/operations/graphrag-epub-batch-runbook.md:141`。

7. PASS - source hash、content hash、document id、book id 或 artifact producer
   lineage mismatch 必须 fail-closed。设计要求 repair 前校验 output manifest、
   checkpoints、artifact manifests、stage/provider fingerprints 和 corpus content
   hash；不一致时拒绝 repair。
   证据：`docs/architecture/unified-retrieval-plane.md:362`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1658`。

8. PASS - repair 后必须执行正常 command checks 才能 completed。设计要求
   `normalCommandChecksRequired=true`，并明确 reopen 不等于 completed，不得绕过
   后续 qmd 与 GraphRAG query command checks。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:77`、
   `docs/operations/graphrag-epub-batch-runbook.md:94`。

9. PASS - recovery events 和 checkpoint metadata 必须记录 repair reason、
   repaired projection、evidence locator 与 reused producer run ids。event log 与
   recovery summary 必须投影同一事实。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:81`、
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1620`。

10. PASS - 设计包含真实失败文本的 regression acceptance。文档固定了
    `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`
    与 `capabilityScope references unknown or not-ready graphCapabilityId(s):
    book-356ff4920cdf-0bbd8bdb:graph_query` 两个回归，并要求验证 producer run ids
    不变、不得直接写 completed，且负例覆盖 provider/network failure、mixed-book
    output、stale sidecar、source/content mismatch、missing producer lineage 和
    incomplete artifacts。
    证据：`docs/operations/graphrag-epub-batch-runbook.md:155`、
    `docs/architecture/unified-retrieval-plane.type-dd.yaml:1964`。

## 审计备注

本次为设计文档审计，未验证实现代码或测试执行结果。未发现固定基准范围内的
设计阻断项。
