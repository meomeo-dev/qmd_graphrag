# Agent C Development Audit Criteria

审计对象：GraphRAG identity sidecar recovery implementation。

固定基准如下：

1. 实现必须满足 `revised-design.md` 的全部 invariants、catalog projection 和
   query-ready gate。
2. 开发结果必须能解除真实批处理失败中的错误：
   `GraphRAG document identity sidecar evidence is invalid for query_ready`。
3. 修复后当前 Parquet 自洽时不得触发不必要的昂贵 `graph_extract` 重跑。
4. 修复后下游 lineage 未补齐时，`resumePlan.canQuery` 必须为 false。
5. `loadGraphQueryCapabilities` 在 lineage 未完整前不得返回该书的
   `graph_query` capability。
6. 既有无效侧车测试必须仍保持 fail-closed 语义，除非当前 Parquet 已提供完整
   自洽身份。
7. TypeScript 类型检查和 Node 语法检查必须通过。
8. `test/graphrag-book-state.test.ts` 和 `test/book-job-state.test.ts` 必须通过。
9. 真实失败书回归探测必须记录状态、命令和结果；若因外部网络或凭据失败，必须
   与本地身份侧车错误区分。
10. 审计报告必须给出明确 verdict，并列出任何剩余风险或测试缺口。
