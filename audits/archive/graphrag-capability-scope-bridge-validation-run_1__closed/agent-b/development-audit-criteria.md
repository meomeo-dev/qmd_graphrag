# Agent B Development Audit Criteria

审计对象：GraphRAG capability scope bridge validation implementation。

固定基准如下：

1. 实现必须与 TypeScript `projectQueryReadyLineage()` 的 artifact projection 语义
   对齐。
2. 实现必须区分 checkpoint 历史 artifact ids 与当前 manifest 真源。
3. 实现必须保持 `graphCapabilityIds` 不得越过请求 scope 的约束。
4. 实现必须保持 `selectedBookIds` 不得被 capability 解析越界的约束。
5. 实现必须保持 source、document、content hash 和 artifact ids request scope
   上界约束。
6. 实现必须不降低对 bootstrap、跨书、缺文件、旧 hash 和旧 provider 产物的拒绝。
7. 新测试必须覆盖真实失败形态：checkpoint stale stats id 与 manifest current
   stats artifact。
8. 新测试必须覆盖 manifest 缺失或 producer run id 错配时仍失败。
9. 实现必须通过真实失败书的 Python bridge 复现探针。
10. 实现和审计文档不得提交 `graph_vault`、`.qmd`、`inbox`、`tmp` 或运行日志。
