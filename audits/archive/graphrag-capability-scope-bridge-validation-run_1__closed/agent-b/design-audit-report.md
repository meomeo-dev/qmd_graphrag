# Agent B 设计审计报告

审计对象：`audit/graphrag-capability-scope-bridge-validation-run_1__closed/design.md`

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1__closed/agent-b/audit-criteria.md`

## 发现项

### B-1：`graphCapabilityIds` request scope 约束未被显式纳入测试承诺

严重级别：中

证据：固定基准第 8 条要求设计必须保留 request scope 对
`selectedBookIds` 和 `graphCapabilityIds` 的约束。设计的 `Tests` 第 5 条要求
既有 capability scope 测试保持通过，但列出的边界是 `selectedBookIds`、
`sourceIds`、`documentIds`、`contentHashes` 和 `artifactIds`，没有明确列出
`graphCapabilityIds`。本 case 的真实错误正是
`capabilityScope references unknown or not-ready graphCapabilityId(s)`，因此
`graphCapabilityIds` 必须作为显式不变量或测试验收点保留。

影响：实现可能只验证派生 capability 是否落在 selected books 内，却没有在设计
层明确要求“只能解析请求中列出的 `graphCapabilityIds`，不得返回未请求的
capability”。这会削弱 GraphRAG 查询 request scope 的最小授权边界。

必要修正建议：在 `Invariants`、`Query-Ready Validation` 或 `Tests` 中明确加入
以下约束：Python bridge 解析出的 capability id 必须属于请求的
`capabilityScope.graphCapabilityIds`；未请求的 capability 不得被返回；请求的
`graphCapabilityIds` 若 unknown 或 not-ready 必须继续 fail closed。测试项应
明确保留或新增对 `graphCapabilityIds` 的 scope 约束验证。

## 风险

1. 当前设计把核心修复放在 artifact lineage 投影上，方向正确，但如果
   `graphCapabilityIds` 约束没有被显式写入设计验收，实现者可能误以为只要
   `selectedBookIds` 匹配即可返回派生 capability。
2. Python bridge 与 TypeScript 投影一致性的目标依赖对
   `stage + producerRunId + required kind` 的选择规则完全同步。后续 TypeScript
   validator 演进时，Python bridge 仍有再次漂移风险。
3. 真实 EPUB 批处理恢复被设计为提交后动作，符合基准，但这意味着设计审计阶段
   只能确认方案约束，不能证明实际 batch 已恢复。

## 逐条基准结论

1. PASS：设计必须以当前失败书的真实错误为触发证据。

   证据：`Problem` 引用真实批处理
   `epub-batch-20260526-after-sidecar-fix`，列出错误
   `capabilityScope references unknown or not-ready graphCapabilityId(s):
   <bookId>:graph_query`，并列出失败书 `book-356ff4920cdf-0bbd8bdb` 与
   `book-2d1d667301e9-e5c877e8`。`status.yaml` 也记录了对应 item、bookId 和
   错误。

   必要修正建议：无。

2. PASS：设计必须清楚区分 checkpoint 历史线索和当前 manifest 真源。

   证据：`Invariants` 第 4 条声明 `checkpoint.artifactIds` 只能作为历史线索，
   不能覆盖当前 manifest 中按 `stage + producerRunId + kind` 选择出的有效
   artifact。`Artifact Selection` 也规定高成本 producer stage 优先从当前
   `artifacts.yaml` 按 `bookId + stage + producerRunId + requiredKinds` 选择。

   必要修正建议：无。

3. PASS：设计必须保证 Python bridge 与 TypeScript 的 ready 判定一致。

   证据：`Problem` 明确指出 TypeScript projection 可解析 capability，而
   Python bridge 因验证漂移失败；`Proposed Change` 要求 Python bridge 补齐与
   TypeScript 相同的查询能力投影规则；`Tests` 第 1 条要求 stale checkpoint
   stats id 但当前 manifest 有有效 stats artifact 时 Python
   `_load_graph_capabilities()` 通过。

   必要修正建议：无。

4. PASS：设计必须只在 bridge validation 层窄修复，不扩大改动范围。

   证据：`Proposed Change` 明确改动位置为
   `python/qmd_graphrag/bridge.py`，并说明保持改动窄化在 bridge validation 层。
   `Non-Goals` 排除 GraphRAG vendor、qmd 查询、输出格式、research 命令、并发
   配置和 token 配置变更。

   必要修正建议：无。

5. PASS：设计必须继续拒绝 bootstrap checkpoint 和跨书 artifact。

   证据：`Invariants` 第 3 条要求 capability 只来源于当前有效的
   `graph_extract`、`community_report`、`embed` 和 `query_ready` 状态；第 8 条
   明确不得让 bootstrap checkpoint 或跨书产物通过。`Query-Ready Validation`
   要求 path 位于 `books/<bookId>/output/` 或 book-scoped lancedb 目录。

   必要修正建议：无。

6. PASS：设计必须继续拒绝 producer run id 不匹配的 artifact。

   证据：`Invariants` 第 6 条要求当前 manifest 无法按 producer run id 和
   required kind 补齐产物时 fail closed；`Query-Ready Validation` 要求 producer
   run id 匹配有效 checkpoint；`Tests` 第 3 条要求 stats artifact producer run
   id 不匹配时继续 fail closed。

   必要修正建议：无。

7. PASS：设计必须继续拒绝 fingerprint、provider 或 corpus hash 不匹配的
   artifact。

   证据：`Query-Ready Validation` 明确要求 stage fingerprint、provider
   fingerprint 和 corpus content hash 必须匹配。`Tests` 第 4 条覆盖 stats
   artifact fingerprint、provider fingerprint 或 content hash 不匹配时继续
   fail closed。

   必要修正建议：无。

8. FAIL：设计必须保留 request scope 对 `selectedBookIds` 和
   `graphCapabilityIds` 的约束。

   证据：设计保留了 `selectedBookIds` 及 source/document/content/artifact 边界，
   但没有显式列出 `graphCapabilityIds` 作为必须保持的 request scope 边界。详见
   发现项 B-1。

   必要修正建议：补充 `graphCapabilityIds` 约束为设计不变量或测试验收点，明确
   未请求、unknown 或 not-ready 的 capability id 均不得通过。

9. PASS：设计必须记录真实跑恢复是提交后动作，不以测试代替真实跑。

   证据：`Invariants` 第 10 条明确真实 EPUB 处理必须在修复、审计和提交后继续
   运行，不能只停留在单元测试。

   必要修正建议：无。

10. PASS：设计必须明确不提交 `graph_vault`、`.qmd`、`inbox` 和临时运行产物。

    证据：`Non-Goals` 第 5 条明确不提交 `graph_vault`、`.qmd`、`inbox`、`tmp`
    或 `.tmp-tests` 运行产物。

    必要修正建议：无。

## 结论

设计对真实 failure、checkpoint 与当前 manifest 的边界、Python/TypeScript
ready 判定一致性、producer lineage 和 artifact validator 均有清晰约束。但
固定基准第 8 条要求的 `graphCapabilityIds` request scope 约束未被显式写入设计
验收，必须修正后再通过设计审计。

verdict: design_audit_failed
