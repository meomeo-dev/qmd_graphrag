# Agent A Design Audit Criteria

1. 设计必须区分当前 Parquet 身份证据和历史侧车缓存。
2. 设计不得允许无效侧车单独发布或维持 `query_ready` capability。
3. 设计必须保持 GraphRAG 高成本阶段 artifact validator 的现有强度。
4. 设计必须保持 producer lineage 对非 bootstrap stage checkpoint 的要求。
5. 设计必须说明当前 Parquet 自洽时如何重写侧车。
6. 设计必须说明当前 Parquet 缺失且侧车无效时的失败路径。
7. 设计不得跳过每本书的 qmd 与 GraphRAG 闭环检查。
8. 设计应限定修改面，避免大范围改动恢复、查询或输出渲染逻辑。
9. 设计必须覆盖真实失败项的恢复路径。
10. 设计必须列出可执行回归测试。
