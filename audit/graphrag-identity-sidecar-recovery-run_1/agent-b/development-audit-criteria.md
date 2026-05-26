# Agent B Development Audit Criteria

审计对象：GraphRAG identity sidecar recovery implementation。

固定基准如下：

1. 实现必须保持 `bookId`、`sourceId`、`sourceHash`、`documentId` 和
   `contentHash` 的身份绑定。
2. Catalog 写入必须继续复用
   `FileBookJobStateRepository.recordGraphTextUnitIdentity`，不得引入第二套
   identity map 写入逻辑。
3. 侧车重写必须使用当前规范化路径和当前 content hash，不保留陈旧路径或
   content metadata。
4. 多文档 GraphRAG 输出必须仍依赖当前 title basename 或单文档 fallback，
   不得错误绑定其他文档。
5. 当前 Parquet 损坏、缺 text units 或文档不匹配时，query-ready 身份必须失败。
6. 恢复脚本和 batch 状态不应把本地身份侧车修复错误伪装成 provider transient。
7. 修改范围必须保持最小，不得触碰配置投影、输出格式、GraphRAG 运行器或批处理
   调度逻辑，除非有直接必要。
8. 测试夹具不得通过降低 gate 或伪造 ready capability 来通过。
9. 运行产物不得纳入提交，包括 `.qmd`、`graph_vault`、`inbox`、`tmp`、
   `.tmp-tests` 和 `dist`。
10. 代码 diff 必须可读，新增注释必须解释非显然设计边界而非重复代码动作。
