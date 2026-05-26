# Agent C Design Audit Criteria

1. 设计必须满足状态管理和恢复机制要求。
2. 设计必须避免因历史侧车陈旧导致已完成书永久 stop。
3. 设计必须避免在存在可用当前 Parquet 证据时重复昂贵 LLM 重建。
4. 设计必须在 Parquet 证据损坏时停止，而不是静默降级。
5. 设计必须保持 `qmd_graph_text_unit_identity.json` 可审计、可重建。
6. 设计必须说明对 `document-identity-map` 和 `graph_text_unit_identity_map`
   的影响。
7. 设计必须与 GraphRAG 产物隔离和阶段门控前序修复一致。
8. 设计必须限制对运行产物的依赖，不把本地临时路径写入源码。
9. 设计必须给出开发后审计的固定验收信号。
10. 设计必须明确剩余风险和非目标。
