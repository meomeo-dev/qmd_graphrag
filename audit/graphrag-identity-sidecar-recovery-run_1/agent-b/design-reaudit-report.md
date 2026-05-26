# Agent B 设计复审报告

审计对象：`audit/graphrag-identity-sidecar-recovery-run_1/revised-design.md`

固定基准：`audit/graphrag-identity-sidecar-recovery-run_1/agent-b/audit-criteria.md`

真实失败证据：`status.yaml` 指向批处理
`epub-batch-20260526-resume-after-auth`。失败 item 为
`item-9f587b71073a-cff9f38d`，书籍为
`book-9f587b71073a-ad95ce2f`，失败阶段为 `resume-book-1`，错误为
`GraphRAG document identity sidecar evidence is invalid for query_ready:
doc-fd8875181a17`。真实 status 中该失败被标记为 `permanent` 与
`stop_until_fixed`，错误栈位于 `readGraphTextUnitIdentitySidecar`、
`recordGraphTextUnitIdentityIfAvailable` 和 `syncGraphRagBookWorkspace`。

## 逐项复审

1. PASS：设计必须保护 `bookId`、`sourceHash`、`documentId` 和 content hash
   身份边界。

   证据：`revised-design.md` 的 `Invariants` 要求当前 Parquet 身份证据自洽
   后才可重写侧车和 catalog；`Catalog Projection` 明确
   `recordGraphTextUnitIdentity` 必须以 `bookId`、`sourceId`、`sourceHash`、
   `documentId` 和 `contentHash` 绑定当前书籍与当前规范化内容，并只更新同一
   `documentId` 与 `contentHash` 的记录。源码中
   `FileBookJobStateRepository.recordGraphTextUnitIdentity` 也按这些字段匹配
   catalog 记录后才写入 graph identity。

   必要修正建议：无。

2. PASS：设计必须防止旧 GraphRAG 输出与新 producer run 输出混合发布。

   证据：`Invariants` 第 8 条明确禁止把旧 lineage 的下游产物与新
   `graph_extract` 混合成 ready 状态；`Proposed Change` 进一步规定，若当前
   输出目录只有新的 `graph_extract` producer manifest，而
   `community_report` 或 `embed` 只来自旧 checkpoint 或 bootstrap 产物，则
   resume plan 必须继续返回相应下游阶段。`Tests` 第 6 条和
   `Post-Implementation Acceptance Signals` 第 7、8 条把该约束转为验收信号。

   必要修正建议：无。

3. PASS：设计必须保持 `query_ready` 对 `community_report` 与 `embed` 的门控。

   证据：`Query-Ready Gate` 明确 `query_ready` 仍由当前记录的
   `community_report` 与 `embed` 产物、有效 producer run id、required
   artifact kind、book-scoped artifact、stage fingerprint、provider
   fingerprint 和 corpus content hash 共同门控。源码中
   `assertGraphRagStageArtifactsReady` 对 `query_ready` 要求
   `graph_extract`、`community_report` 和 `embed` producer run id，并调用
   `assertQueryReadyProducerArtifacts` 校验每个 producer stage 的 artifact。

   必要修正建议：无。

4. PASS：设计必须明确侧车是派生产物，而不是权威状态。

   证据：`Invariants` 第 3 条直接声明
   `qmd_graph_text_unit_identity.json` 是可修复缓存，不是唯一真源；
   `Proposed Change` 要求优先读取当前 `documents.parquet` 与
   `text_units.parquet`，当前 Parquet 身份存在时重写侧车。该设计把侧车限定为
   当前 Parquet 与 catalog 的派生投影（derived projection）。

   必要修正建议：无。

5. PASS：设计必须避免把恢复失败伪装成外部 provider 错误。

   证据：`Problem` 将失败定位为旧侧车与当前 Parquet 不一致导致的本地恢复
   阻断；`Tests` 第 5 条要求 batch status 不再把该失败标记为永久本地 stop，
   恢复后进入正常 CLI 子命令检查；`Post-Implementation Acceptance Signals`
   第 6 条要求真实失败书恢复时不再出现该侧车错误。设计未把该类失败归类为
   provider transient、rate limit 或 provider recovery。

   必要修正建议：无。

6. PASS：设计必须兼容已有旧状态和 run record 恢复。

   证据：`Query-Ready Gate` 明确 producer run id 必须来自有效 stage
   checkpoint 或 run record；`Invariants` 禁止把旧 `query_ready` checkpoint
   当作 bypass，同时允许旧侧车在能通过当前 Parquet 交叉验证时作为恢复输入。
   源码中的 repository 已存在 checkpoint 与 run record 共同构造 effective
   resume state 的路径，revised design 沿用该模型，没有要求迁移到新状态类型。

   必要修正建议：无。

7. PASS：设计必须明确何时重建、何时只修复本地状态。

   证据：`Proposed Change` 将当前 Parquet 身份自洽定义为本地修复路径：记录到
   repository 并重写侧车；当前 Parquet 身份缺失且侧车也无法提供有效身份时，
   `required=true` 继续失败。设计还规定新的 `graph_extract` 被接受后，下游
   `community_report`、`embed` 和 `query_ready` 必须按 resume plan 继续补齐，
   这明确了身份修复不等价于下游重建完成。

   必要修正建议：无。

8. PASS：设计必须保持错误可观测性，失败时仍能定位到身份证据。

   证据：`Proposed Change` 保留现有 query-ready 身份缺失或无效错误；真实
   status 和 item err 均包含 `documentId`、`bookId`、item id、失败阶段与错误
   栈。`Catalog Projection` 还要求重写后的侧车与 catalog 语义一致，使失败时
   可从 `qmd_graph_text_unit_identity.json` 与
   `document-identity-map.yaml` 交叉定位身份证据。

   必要修正建议：无。

9. PASS：设计不得引入新的数据类型或多套查询逻辑。

   证据：`Proposed Change` 只调整
   `recordGraphTextUnitIdentityIfAvailable` 的身份恢复读取顺序；`Catalog
   Projection` 继续使用现有
   `FileBookJobStateRepository.recordGraphTextUnitIdentity`；`Query-Ready Gate`
   继续使用现有 artifact validator、checkpoint/run record 和 capability
   catalog 发布路径。设计没有引入新的 query state、capability 类型或替代查询
   逻辑。

   必要修正建议：无。

10. PASS：设计必须能用单元测试和真实 batch status 共同验证。

    证据：`Tests` 覆盖侧车与当前 Parquet 不一致、Parquet 身份缺失、旧侧车不
    能发布 capability、既有侧车失败语义、batch status 不再永久停止，以及新
    `graph_extract` 后下游 lineage 必须补齐。`Post-Implementation Acceptance
    Signals` 给出具体单元测试、typecheck、脚本语法检查、真实失败书恢复信号、
    lineage 未完整时不得发布 capability、lineage 完整后 batch item 三类状态
    成功等验收条件。

    必要修正建议：无。

## 复审结论

`revised-design.md` 已覆盖 Agent B 固定基准。设计允许修复旧侧车阻断，但将
身份修复严格限制为本地投影修复，并保留当前 Parquet、producer lineage、
artifact validator、qmd registration 和 capability 发布门控。未发现必须修改的
设计项。

verdict: design_audit_passed
