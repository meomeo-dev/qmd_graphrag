# Agent A Design Audit Criteria

审计对象：GraphRAG capability scope bridge validation 设计。

固定基准如下：

1. 设计必须解释 TS capability projection 与 Python bridge validation 的漂移点。
2. 设计必须保持 `query_ready` producer lineage 的强门控。
3. 设计必须要求 artifact 来自当前 `artifacts.yaml`，不能接受不存在的旧 id。
4. 设计必须要求按 `stage + producerRunId + kind` 选择当前 producer artifact。
5. 设计必须保留 stage fingerprint、provider fingerprint 和 content hash 校验。
6. 设计必须保留 book-scoped path、parquet 完整性和 lancedb 完整性校验。
7. 设计不得把 explicit capability catalog 当作绕过 artifact gate 的信任源。
8. 设计不得修改 vendor、输出格式、research 子命令或 EPUB 批处理主流程。
9. 设计必须包含陈旧 checkpoint artifact id 的回归测试要求。
10. 设计必须包含缺失或不匹配 manifest artifact 继续 fail closed 的测试要求。
