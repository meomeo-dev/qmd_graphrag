# Agent B Design Audit Criteria

1. 设计必须保护 `bookId`、`sourceHash`、`documentId` 和 content hash 身份边界。
2. 设计必须防止旧 GraphRAG 输出与新 producer run 输出混合发布。
3. 设计必须保持 `query_ready` 对 `community_report` 与 `embed` 的门控。
4. 设计必须明确侧车是派生产物，而不是权威状态。
5. 设计必须避免把恢复失败伪装成外部 provider 错误。
6. 设计必须兼容已有旧状态和 run record 恢复。
7. 设计必须明确何时重建、何时只修复本地状态。
8. 设计必须保持错误可观测性，失败时仍能定位到身份证据。
9. 设计不得引入新的数据类型或多套查询逻辑。
10. 设计必须能用单元测试和真实 batch status 共同验证。
