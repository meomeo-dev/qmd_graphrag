# Agent A Development Audit Criteria

审计对象：GraphRAG identity sidecar recovery implementation。

固定基准如下：

1. 当前 Parquet 身份证据必须优先于
   `qmd_graph_text_unit_identity.json` 侧车。
2. 当前 Parquet 身份自洽时，必须重写侧车并通过 repository 写入 catalog。
3. 当前 Parquet 缺失或不自洽时，才允许读取并验证侧车。
4. 侧车验证失败且 `required=true` 时必须 fail closed，不得静默发布
   `query_ready`。
5. 实现不得降低 `query_ready`、artifact validator、producer lineage、
   provider fingerprint 或 corpus content hash 门控。
6. 实现不得把旧 `community_report`、`embed` 或 `query_ready` lineage 与新
   `graph_extract` 产物混合为 ready。
7. 实现不得修改 GraphRAG vendor、CLI 输出渲染、research 子命令或无关查询逻辑。
8. 新增测试必须覆盖真实失败形态：同一 document sidecar 保持当前身份字段，
   但 graph text unit ids 已陈旧。
9. 新增测试必须覆盖只修复 `graph_extract` 身份时不发布 graph capability。
10. 所有固定验收命令必须通过，失败命令必须记录为审计阻断项。
