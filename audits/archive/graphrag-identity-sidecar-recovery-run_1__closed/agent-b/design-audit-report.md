# Agent B 设计审计报告

审计对象：`audit/graphrag-identity-sidecar-recovery-run_1__closed/design.md`

固定基准：`audit/graphrag-identity-sidecar-recovery-run_1__closed/agent-b/audit-criteria.md`

真实失败证据：`status.yaml` 记录批处理
`epub-batch-20260526-resume-after-auth` 中
`item-9f587b71073a-cff9f38d` 在 `resume-book-1` 失败，错误为
`GraphRAG document identity sidecar evidence is invalid for query_ready:
doc-fd8875181a17`。真实 status 将该项标记为本地停止型失败
（local stop failure），错误栈位于侧车身份验证路径，而非外部 provider
调用路径。

## 逐项审计

1. PASS：设计保护 `bookId`、`sourceHash`、`documentId` 和 content hash
   身份边界。设计要求当前 Parquet 证据自洽后才重写侧车和 catalog，并保留
   manifest、stage fingerprint、provider fingerprint、corpus content hash 的
   门控，未允许用旧侧车绕过当前书籍和内容身份。

2. PASS：设计防止旧 GraphRAG 输出与新 producer run 输出混合发布。更新后的
   invariant 明确规定，接受新的 `graph_extract` 后，下游
   `community_report`、`embed` 和 `query_ready` 必须继续按当前 resume plan
   与 producer lineage 推进，不得把旧 lineage 下游产物与新
   `graph_extract` 混合成 ready 状态。

3. PASS：设计保持 `query_ready` 对 `community_report` 与 `embed` 的门控。
   `Query-Ready Gate` 明确 `query_ready` 仍由当前记录的
   `community_report` 和 `embed` 产物、有效 producer run id、book-scoped
   artifact、stage fingerprint、provider fingerprint 和 corpus content hash
   共同门控。

4. PASS：设计明确侧车是派生产物（derived artifact），不是权威状态
   （authoritative state）。设计将 `qmd_graph_text_unit_identity.json`
   定义为可修复缓存，并规定当前 Parquet 身份自洽时优先重写侧车和 catalog。

5. PASS：设计避免把恢复失败伪装成外部 provider 错误。设计把失败定位为
   GraphRAG 身份侧车与当前 Parquet 证据不一致的本地恢复问题，并要求真实
   batch status 不再把该失败固定为永久本地 stop；未引入 provider transient
   或 provider recovery 语义。

6. PASS：设计兼容已有旧状态和 run record 恢复。设计允许 producer run id
   来自有效 stage checkpoint 或 run record，同时禁止把旧 `query_ready`
   checkpoint 当作 bypass；这与现有 repository 的 checkpoint/run record
   恢复模型保持一致。

7. PASS：设计明确何时重建、何时只修复本地状态。当前 Parquet 身份自洽时，
   只修复本地侧车和 document identity catalog；当前 Parquet 缺失或不自洽
   且 required 时继续失败；新的 `graph_extract` 被接受但下游 lineage 不匹配
   时，必须按 resume plan 补齐下游阶段，而不是发布 `query_ready`。

8. PASS：设计保持错误可观测性，失败时仍能定位到身份证据。设计保留现有
   `query_ready` 身份缺失或无效错误语义，错误中包含 `documentId`，真实
   status 同时提供 `bookId`、item id、stage 和错误栈，可定位到对应书籍输出
   目录及侧车身份证据。

9. PASS：设计未引入新的数据类型或多套查询逻辑。变更限定在现有
   `recordGraphTextUnitIdentityIfAvailable` 的读取顺序、侧车重写和现有
   `query_ready` 门控路径内，未新增查询分支或替代 capability 发布逻辑。

10. PASS：设计能用单元测试和真实 batch status 共同验证。测试计划覆盖旧侧车
    与当前 Parquet 不一致、Parquet 证据缺失、旧侧车不能发布 capability、
    既有侧车失败语义、真实 batch status 不再永久停止，以及新增的“新
    `graph_extract` 后下游 lineage 必须补齐”场景。

## 结论

未发现必须修改的设计项。实现时必须保持更新后新增的 lineage 约束：
重写身份侧车只修复本地身份投影，不得让新的 `graph_extract` 与旧
`community_report`、`embed` 或 `query_ready` lineage 混合发布为 ready。

verdict: design_audit_passed
