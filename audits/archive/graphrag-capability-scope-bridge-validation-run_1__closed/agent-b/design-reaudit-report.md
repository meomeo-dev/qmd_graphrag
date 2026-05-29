# Agent B 设计复审报告

审计对象：
`audit/graphrag-capability-scope-bridge-validation-run_1__closed/revised-design.md`

固定基准：
`audit/graphrag-capability-scope-bridge-validation-run_1__closed/agent-b/audit-criteria.md`

复审重点：上次 Agent B 审计指出的第 8 条
`graphCapabilityIds` request scope 约束是否已补足。

## 发现项复核

上次发现项 B-1 已修复。

证据：

- `Invariants` 第 7 条新增明确约束：解析出的 capability id 必须属于
  `capabilityScope.graphCapabilityIds`，解析出的 book 必须属于
  `capabilityScope.selectedBookIds`，且 source、document、content hash 和
  artifact id 不得越过请求边界。
- 新增 `Request Scope Validation` 小节，明确
  `_resolve_capability_scoped_book_ids()` 和
  `_validate_capabilities_against_request_scope()` 必须保留既有边界，并列出
  “请求未列入 `graphCapabilityIds` 的 capability 不得被解析或使用”。
- `Tests` 第 5 条已将 `graphCapabilityIds` 加入既有 capability scope 测试应保持
  覆盖的边界列表。

## 风险

1. Python bridge 与 TypeScript 的 artifact projection 仍需后续实现保持同步。
   设计已要求一致 ready 判定，但后续 validator 演进时仍可能再次出现验证漂移。
2. 真实 EPUB 批处理恢复仍被设计为提交后动作。该安排符合固定基准，但设计审计
   不能替代提交后的真实恢复运行。
3. request scope 与 manifest projection 已被设计分层：manifest projection 只
   决定当前有效 artifact 集合，不改变请求 scope。实现时必须避免把 derived
   capability 自动扩展到未请求的 `graphCapabilityIds`。

## 逐条基准结论

1. PASS：设计必须以当前失败书的真实错误为触发证据。

   证据：`Problem` 继续引用真实批处理
   `epub-batch-20260526-after-sidecar-fix`，列出错误
   `capabilityScope references unknown or not-ready graphCapabilityId(s):
   <bookId>:graph_query`，并列出失败书
   `book-356ff4920cdf-0bbd8bdb` 和 `book-2d1d667301e9-e5c877e8`。

   必要修正建议：无。

2. PASS：设计必须清楚区分 checkpoint 历史线索和当前 manifest 真源。

   证据：`Invariants` 第 4 条保留 `checkpoint.artifactIds` 只能作为历史线索的
   边界；`Artifact Selection` 明确 GraphRAG 高成本 producer stage 优先从当前
   `artifacts.yaml` 按 `bookId + stage + producerRunId + requiredKinds` 选择
   artifact ids。

   必要修正建议：无。

3. PASS：设计必须保证 Python bridge 与 TypeScript 的 ready 判定一致。

   证据：`Problem` 明确描述 TypeScript 可解析 capability 而 Python bridge
   验证漂移失败；`Proposed Change` 要求 Python bridge 补齐与 TypeScript 相同的
   查询能力投影规则；`Lineage Projection` 要求从已验证 producer checkpoints 和
   当前 manifest 计算 lineage。

   必要修正建议：无。

4. PASS：设计必须只在 bridge validation 层窄修复，不扩大改动范围。

   证据：`Proposed Change` 将修复限定在 `python/qmd_graphrag/bridge.py` 的
   bridge validation 层；`Non-Goals` 明确不修改 GraphRAG vendor、qmd 查询、
   输出格式、research 命令、并发配置或 token 配置。

   必要修正建议：无。

5. PASS：设计必须继续拒绝 bootstrap checkpoint 和跨书 artifact。

   证据：`Invariants` 第 3 条要求 capability 只来源于当前有效的
   `graph_extract`、`community_report`、`embed` 和 `query_ready` 状态；第 9 条
   明确不得让 bootstrap checkpoint、跨书产物、旧 provider fingerprint、旧
   content hash 或缺失文件通过；`Query-Ready Validation` 保留 book-scoped path
   校验。

   必要修正建议：无。

6. PASS：设计必须继续拒绝 producer run id 不匹配的 artifact。

   证据：`Invariants` 第 6 条要求当前 manifest 无法按 producer run id 和
   required kind 补齐产物时 fail closed；`Query-Ready Validation` 要求 producer
   run id 匹配有效 checkpoint；`Tests` 第 3 条覆盖 producer run id 不匹配时
   fail closed。

   必要修正建议：无。

7. PASS：设计必须继续拒绝 fingerprint、provider 或 corpus hash 不匹配的
   artifact。

   证据：`Query-Ready Validation` 保留 stage fingerprint、provider fingerprint
   和 corpus content hash 校验；`Tests` 第 4 条覆盖 fingerprint、provider
   fingerprint 或 content hash 不匹配时 fail closed。

   必要修正建议：无。

8. PASS：设计必须保留 request scope 对 `selectedBookIds` 和
   `graphCapabilityIds` 的约束。

   证据：`Invariants` 第 7 条、`Request Scope Validation` 小节和 `Tests` 第 5
   条均已显式包含 `graphCapabilityIds`。设计明确未列入
   `capabilityScope.graphCapabilityIds` 的 capability 不得被解析或使用，解析出的
   book 不得超出 `selectedBookIds`，manifest projection 不得改变请求 scope。

   必要修正建议：无。

9. PASS：设计必须记录真实跑恢复是提交后动作，不以测试代替真实跑。

   证据：`Invariants` 第 11 条明确真实 EPUB 处理必须在修复、审计和提交后继续
   运行，不能只停留在单元测试。

   必要修正建议：无。

10. PASS：设计必须明确不提交 `graph_vault`、`.qmd`、`inbox` 和临时运行产物。

    证据：`Non-Goals` 第 5 条明确不提交 `graph_vault`、`.qmd`、`inbox`、`tmp`
    或 `.tmp-tests` 运行产物。

    必要修正建议：无。

## 结论

`revised-design.md` 已补足 Agent B 上次指出的 `graphCapabilityIds` request
scope 约束。按固定审计基准复审，10 条均为 PASS。

verdict: design_audit_passed
