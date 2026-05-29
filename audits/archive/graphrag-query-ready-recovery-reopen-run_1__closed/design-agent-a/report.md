# GraphRAG Query-Ready Recovery Reopen 设计审计报告

result: FAIL

## 基准逐条判断

1. PASS。本地 gate 限定充分：`stop_until_fixed` 只在当前 classifier
   识别为本地 `query_ready` 或 `graph_query` projection gate 且 artifacts
   已验证时 reopen；provider/network failure 仍走 transient retry，unknown
   仍保持 `stop_until_fixed`。
2. PASS。reopen 依据 persisted failure text 与当前 artifacts，而不是 operator
   intent；设计要求用当前 classifier 重分类，并用 validated artifacts、
   producer lineage、qmd corpus registration 与 identity evidence 证明可修复。
3. PASS。query-ready identity 缺失可由已验证 sidecar 或已验证 book-scoped
   GraphRAG output 修复；`DocumentIdentityMap` 仍是发布事实源。
4. PASS。graph capability readiness 缺失仅在 `query_ready` lineage 与
   document identity 有效后重建 capability projection，再运行查询检查。
5. PASS。reopen 不得写入 `completed`，只能回到 `pending` 或
   `continue_pending`，并必须进入正常 resume 与 qmd/GraphRAG command checks。
6. PASS。设计要求事件、checkpoint、recovery summary、failed stage 与 repair
   evidence 可观测，包含 sidecar locator、text unit count、producer run ids、
   reopened checkpoint 或 next stage。
7. PASS。repair path 明确不得重跑 `graph_extract`、`community_report` 或
   `embed`，前提是 producer checkpoints 与 artifacts 仍有效。
8. PASS。fail-closed 条件覆盖 mixed-book output、stale/invalid sidecar
   identity、source/content mismatch、producer lineage mismatch、空或不存在
   text unit、无效 outputDir、incomplete artifact 等。
9. FAIL。设计没有把本次两个真实 failure shape 都写成必须覆盖的测试：
   `GraphRAG document identity is missing for query_ready` 与
   `capabilityScope references unknown or not-ready graphCapabilityId(s)`。
   现有验收只覆盖一个旧 identity regression，未覆盖 capabilityScope
   unknown/not-ready regression。
10. PASS。边界保持在 failure classification、checkpoint/recovery projection、
    resume repair gates 与 focused tests；qmd search、formatter、vendor
    GraphRAG execution 行为边界保持不变。

## 发现项

- F1 [High] 缺少固定基准要求的真实失败形状测试契约。
  [docs/architecture/unified-retrieval-plane.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:1943)
  仅要求旧 `book-9f587b71073a-ad95ce2f` identity regression；
  [docs/architecture/unified-retrieval-plane.type-dd.yaml](/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:1948)
  仅要求通用负例。虽然
  [docs/operations/graphrag-epub-batch-runbook.md](/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:128)
  到
  [docs/operations/graphrag-epub-batch-runbook.md](/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:135)
  规定了两个 failure text 的重分类与低成本 repair 行为，但没有把它们固化为
  必须测试的 acceptance requirement，且没有明确覆盖
  `book-356ff4920cdf-0bbd8bdb:graph_query` 的 capabilityScope
  unknown/not-ready 失败。

## 必须修复项

- 在 Type DD acceptance requirements 或等价测试设计位置补充两个显式回归测试：
  identity failure text `GraphRAG document identity is missing for query_ready`
  应从 `stop_until_fixed` reopen 到 `pending`/`continue_pending`，修复
  `DocumentIdentityMap` projection，并保持高成本 producer run ids 不变。
- 补充 capability failure text
  `capabilityScope references unknown or not-ready graphCapabilityId(s)` 的
  回归测试，覆盖 `book-356ff4920cdf-0bbd8bdb:graph_query` 在有效
  `query_ready` lineage 与 document identity 下只重建 capability projection，
  然后运行正常 GraphRAG query command check。
- 两个测试都必须断言 fail-closed 负例：mixed-book output、source/content
  mismatch、missing producer lineage、incomplete artifacts 或 stale sidecar
  不得 reopen。

## 残余风险

- 本次仅审计设计文件，未验证实现或实际测试是否已经存在。
- `continue_pending` 的 checkpoint 字段形态在文档中以 recovery decision 表达，
  实现若把它误解为 item status，仍可能产生兼容性风险。
- capability projection 的 canonical source 与 explicit catalog supplement
  优先级较清晰，但并发 runner 同时 repair 同一 projection 时仍需实现层原子写入
  和非破坏性 merge 保护。
