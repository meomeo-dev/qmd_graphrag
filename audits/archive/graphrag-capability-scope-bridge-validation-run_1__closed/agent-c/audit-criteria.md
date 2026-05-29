# Agent C Design Audit Criteria

审计对象：GraphRAG capability scope bridge validation 设计。

固定基准如下：

1. 设计必须保护 GraphRAG 产物隔离，不允许跨书 capability 污染。
2. 设计必须保护阶段门控，不允许旧 checkpoint 直接证明当前 `query_ready`。
3. 设计必须让 stats artifact 陈旧 id 的场景可恢复。
4. 设计必须让 manifest 缺失 stats artifact 的场景继续失败。
5. 设计必须让 manifest 中 stats artifact producer lineage 不匹配的场景继续失败。
6. 设计必须要求 Python 单元测试覆盖 `_load_graph_capabilities()`。
7. 设计必须要求既有 scope validation 测试保持通过。
8. 设计必须不改变 LLM 调用、并发、token 或网络恢复策略。
9. 设计必须不改变 qmd / GraphRAG 构建状态展示语义。
10. 设计必须给出可执行验证命令和提交前工作树卫生要求。
