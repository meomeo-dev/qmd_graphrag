# Agent B Design Audit Criteria

审计对象：GraphRAG capability scope bridge validation 设计。

固定基准如下：

1. 设计必须以当前失败书的真实错误为触发证据。
2. 设计必须清楚区分 checkpoint 历史线索和当前 manifest 真源。
3. 设计必须保证 Python bridge 与 TypeScript 的 ready 判定一致。
4. 设计必须只在 bridge validation 层窄修复，不扩大改动范围。
5. 设计必须继续拒绝 bootstrap checkpoint 和跨书 artifact。
6. 设计必须继续拒绝 producer run id 不匹配的 artifact。
7. 设计必须继续拒绝 fingerprint、provider 或 corpus hash 不匹配的 artifact。
8. 设计必须保留 request scope 对 selectedBookIds 和 graphCapabilityIds 的约束。
9. 设计必须记录真实跑恢复是提交后动作，不以测试代替真实跑。
10. 设计必须明确不提交 `graph_vault`、`.qmd`、`inbox` 和临时运行产物。
