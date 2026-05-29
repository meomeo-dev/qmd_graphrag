# 设计审计报告：GraphRAG query-ready recovery reopen

result: FAIL

## 审计范围

- 固定基准：
  `audit/graphrag-query-ready-recovery-reopen-run_1__closed/design-agent-b/baseline.md`
- 被审计设计文件：
  `docs/operations/graphrag-epub-batch-runbook.md`
  `docs/architecture/unified-retrieval-plane.md`
  `docs/architecture/unified-retrieval-plane.type-dd.yaml`
  `catalog/data-bus.catalog.yaml`

## 逐条基准判断

1. PASS。本地 gate 限定明确。设计只允许当前 classifier 识别为本地
   `query_ready` 或 `graph_query` projection gate 时 reopen；provider
   transient 和 permanent/unknown failure 走不同路径。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:71`,
   `docs/operations/graphrag-epub-batch-runbook.md:73`,
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:375`.

2. PASS。reopen 基于 persisted failure text 与当前 artifacts，而非 operator
   intent。设计要求用历史失败文本和当前 book-scoped artifacts、producer
   lineage、qmd corpus registration 与 identity evidence 重新分类。
   证据：`docs/architecture/unified-retrieval-plane.md:717`,
   `docs/architecture/unified-retrieval-plane.md:718`,
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:376`.

3. PASS。query-ready identity failure 可通过 validated sidecar 或 validated
   book-scoped GraphRAG output 修复。设计要求 sidecar/output manifest/producer
   checkpoint 校验后低成本修复 `DocumentIdentityMap`。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:123`,
   `docs/operations/graphrag-epub-batch-runbook.md:126`,
   `docs/architecture/unified-retrieval-plane.md:349`,
   `docs/architecture/unified-retrieval-plane.md:362`.

4. PASS。graph capability readiness failure 只在 validated `query_ready`
   lineage 和 document identity 有效后修复 capability projection。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:215`,
   `docs/operations/graphrag-epub-batch-runbook.md:216`,
   `docs/architecture/unified-retrieval-plane.md:728`,
   `catalog/data-bus.catalog.yaml:1087`.

5. PASS。reopen 不会伪造 completed，会进入 `pending` 或
   `continue_pending`，并继续正常 resume / command checks。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:75`,
   `docs/operations/graphrag-epub-batch-runbook.md:77`,
   `docs/architecture/unified-retrieval-plane.md:720`,
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:380`.

6. FAIL。operator observability 不完整。设计要求 event log 和 recovery
   summary 包含 repair evidence，但没有把 repair reason、reopened-from
   failure text、repaired projection、复用 producer run ids 等字段明确要求写入
   item checkpoint；Type DD 的 event/recovery summary required fields 也未列出
   repair reason 或 repaired fields。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:28`,
   `docs/operations/graphrag-epub-batch-runbook.md:41`,
   `docs/operations/graphrag-epub-batch-runbook.md:75`,
   `docs/architecture/unified-retrieval-plane.md:732`,
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:349`,
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:392`.

7. PASS。高成本 GraphRAG stages 不重跑。设计明确只补
   `DocumentIdentityMap`、producer manifest 或 `query_ready` capability
   projection，不重跑 `graph_extract`、`community_report`、`embed`。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:131`,
   `docs/operations/graphrag-epub-batch-runbook.md:133`,
   `docs/operations/graphrag-epub-batch-runbook.md:214`,
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1607`.

8. PASS。fail-closed 条件覆盖混书 output、stale/mismatched identity、
   content/source hash mismatch、producer lineage mismatch、无效 outputDir、空或
   不存在 text unit、缺少有效 sidecar 的多 document 歧义。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:219`,
   `docs/operations/graphrag-epub-batch-runbook.md:220`,
   `docs/architecture/unified-retrieval-plane.md:365`,
   `docs/architecture/unified-retrieval-plane.md:371`,
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:493`.

9. FAIL。测试覆盖没有固定到本次两个真实失败形状。runbook 在恢复规则中列出
   两条历史 failure text，但验收/测试要求只覆盖旧的
   `book-9f587b71073a-ad95ce2f` identity regression 和通用 negative tests；
   未要求用 `doc-fd8875181a17` 的
   `GraphRAG document identity is missing for query_ready`，以及
   `book-356ff4920cdf-0bbd8bdb:graph_query` 的
   `capabilityScope references unknown or not-ready graphCapabilityId(s)` 构造
   persisted `stop_until_fixed` checkpoint 回归。
   证据：`docs/operations/graphrag-epub-batch-runbook.md:128`,
   `docs/operations/graphrag-epub-batch-runbook.md:130`,
   `docs/architecture/unified-retrieval-plane.md:825`,
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1943`,
   `docs/architecture/unified-retrieval-plane.type-dd.yaml:1948`.

10. PASS。实现边界基本保持窄。设计把 reopen 限制在 batch failure
    classification、checkpoint/resume evidence、catalog/query_ready projection
    repair 和 focused checks；没有要求改 qmd search、CLI formatter 或 GraphRAG
    vendor execution semantics。
    证据：`docs/operations/graphrag-epub-batch-runbook.md:131`,
    `docs/operations/graphrag-epub-batch-runbook.md:133`,
    `docs/architecture/unified-retrieval-plane.md:725`,
    `catalog/data-bus.catalog.yaml:1082`.

## 发现项

### F-1: 缺少两个真实失败形状的强制测试要求

Severity: High

固定基准要求测试覆盖以下两类真实 failure text：

- `GraphRAG document identity is missing for query_ready`
- `capabilityScope references unknown or not-ready graphCapabilityId(s)`

当前设计只在恢复规则中识别这两类文本，未在验收/测试要求中固定真实
`doc-fd8875181a17` 与
`book-356ff4920cdf-0bbd8bdb:graph_query` checkpoint 形状。现有验收仍指向
`book-9f587b71073a-ad95ce2f`，且只证明 identity sidecar 修复，不证明 graph
capability not-ready projection reopen。

文件/行号：

- `docs/operations/graphrag-epub-batch-runbook.md:128`
- `docs/operations/graphrag-epub-batch-runbook.md:130`
- `docs/architecture/unified-retrieval-plane.md:825`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1943`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1948`

影响：

缺少精确 regression contract 时，implementation 可能只修复旧 sidecar case，仍让
本次 `doc-fd...` 或 `book-356...:graph_query` 历史 checkpoint 保持
`stop_until_fixed`，或误把 graph capability failure 当作普通 capability error。

### F-2: item checkpoint 的 reopen 观测字段未被强制约束

Severity: Medium

设计要求写入 repair event 和 recovery summary evidence，但没有明确要求
`BatchItemCheckpoint` 在 reopen 后保留原始 failure text、failed stage、repair
reason、repaired projection、复用 producer run ids、previous status/new status 等
审计字段。`unified-retrieval-plane.md` 使用“event 或 recovery summary evidence”
表述，弱于固定基准要求的 event log、item checkpoint、recovery summary 均可观测。

文件/行号：

- `docs/operations/graphrag-epub-batch-runbook.md:28`
- `docs/operations/graphrag-epub-batch-runbook.md:41`
- `docs/operations/graphrag-epub-batch-runbook.md:75`
- `docs/architecture/unified-retrieval-plane.md:732`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:349`
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:392`

影响：

即使执行器正确 reopen，操作者也可能无法仅凭 checkpoint 解释“为什么从
`stop_until_fixed` 改为 pending/continue_pending、修复了哪个 projection、是否复用
原高成本 producer run ids”。

## 必须修复项

1. 在设计验收和 Type DD acceptance 中加入两个 focused regression tests：
   使用 persisted `stop_until_fixed` checkpoint 和精确 failure text，分别覆盖
   `doc-fd8875181a17` 的 query-ready identity reopen，以及
   `book-356ff4920cdf-0bbd8bdb:graph_query` 的 graph capability projection
   reopen。

2. 测试断言必须包括：reclass 来自 persisted failure text 和当前 artifacts；
   reopen 后状态为 `pending` 或 `continue_pending`；不得写入 `completed`；
   正常 qmd 与 GraphRAG command checks 被执行；`graph_extract`、
   `community_report`、`embed` producer run ids 不变；fail-closed negative cases
   仍拒绝 reopen。

3. 明确 `BatchItemCheckpoint` 的 reopen audit 字段或 metadata contract，至少记录
   original failure text、failedStage、repairReason、repairedProjection、
   reopenedFromStatus、reopenedToStatus、reusedProducerRunIds 和 repair evidence
   locator，并要求 event log 与 recovery summary 投影同一事实。

## 残余风险

- 设计依赖 classifier 正确区分 provider/network/transient 与 local projection gate；
  implementation 仍需防止 operator flag 或手工 checkpoint 编辑绕过证据判断。
- 从 parquet 在缺少 sidecar 时推导 identity 的路径较敏感，需要测试 pyarrow
  可用与不可用时都 fail closed。
- capability catalog 与 book-state derived capability 的 merge 顺序必须确定，否则
  可能出现查询检查仍读取旧 not-ready projection 的竞态。
- `--status-json` 被设计为只读投影；实现需测试其不会写 checkpoint、event 或
  producer manifest。
