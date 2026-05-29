# Agent A 设计审计报告

审计对象：`audit/graphrag-identity-sidecar-recovery-run_1__closed/design.md`

固定基准：`audit/graphrag-identity-sidecar-recovery-run_1__closed/agent-a/audit-criteria.md`

真实失败证据：`status.yaml` 记录的
`GraphRAG document identity sidecar evidence is invalid for query_ready:
doc-fd8875181a17`

源码边界核对：
`src/job-state/graphrag-book.ts` 当前身份恢复路径仍是先读侧车缓存
（sidecar cache）再读当前 Parquet；`src/job-state/repository.ts` 中
`query_ready` 发布仍依赖非 bootstrap producer lineage、artifact validator、
fingerprint 和 qmd corpus registration；`test/graphrag-book-state.test.ts`
已有侧车、Parquet、qmd 和 GraphRAG 闭环相关回归基础。

1. PASS：设计区分了当前 Parquet 身份证据和历史侧车缓存。设计明确将
   `documents.parquet` 与 `text_units.parquet` 作为当前身份真源，将
   `qmd_graph_text_unit_identity.json` 定义为可修复缓存，而非唯一真源。

2. PASS：设计不允许无效侧车单独发布或维持 `query_ready` capability。
   设计要求旧侧车必须通过当前 Parquet 交叉验证；不能通过验证时只能触发
   fallback、repair 或失败，不能作为当前 `query_ready` 证明。

3. PASS：设计保持 GraphRAG 高成本阶段 artifact validator 的现有强度。
   设计明确当前 manifest 和 artifact validator 仍是高成本产物门控的唯一
   有效判据，不回退到未验证 checkpoint，也不降低 book-scoped、kind、
   fingerprint 或 corpus hash 校验。

4. PASS：设计保持 producer lineage 对非 bootstrap stage checkpoint 的要求。
   设计要求 `query_ready` 只能基于真实非 bootstrap 的 `graph_extract`、
   `community_report` 和 `embed` producer lineage 发布；新增约束进一步要求
   新 `graph_extract` 不能与旧 `community_report`、`embed` 或 `query_ready`
   lineage 混合成 ready 状态。

5. PASS：设计说明了当前 Parquet 自洽时如何重写侧车。读取顺序改为先验证
   当前 Parquet；一旦身份存在且自洽，记录到 repository，并用该映射重写
   `qmd_graph_text_unit_identity.json`。

6. PASS：设计说明了当前 Parquet 缺失且侧车无效时的失败路径。设计要求只在
   当前 Parquet 无法提供身份时读取侧车；若侧车也无效且 `required=true`，
   继续抛出 query-ready 身份缺失或无效错误，不发布能力。

7. PASS：设计未跳过每本书的 qmd 与 GraphRAG 闭环检查。设计保留 qmd corpus
   registration 要求，并声明修复不得跳过每本书的 qmd 与 GraphRAG 闭环；
   `query_ready` gate 仍依赖当前 producer、artifact、fingerprint 和 catalog
   门控。

8. PASS：设计限定了修改面。设计将代码变更限定在
   `src/job-state/graphrag-book.ts` 的 GraphRAG 文本单元身份恢复策略，不修改
   GraphRAG Python vendor、查询逻辑、输出格式、research 子命令或渲染逻辑。

9. PASS：设计覆盖了真实失败项的恢复路径。真实失败由历史侧车中的旧
   `graphTextUnitIds` 与新 `graph_extract` Parquet 不一致触发；设计通过优先
   使用当前 Parquet 自洽身份重写侧车，解除侧车阻断，同时要求下游阶段继续
   按当前 resume plan 补齐，避免错误直接 ready。

10. PASS：设计列出了可执行回归测试。测试清单覆盖旧侧车与当前 Parquet
    不一致的恢复、Parquet 缺失且侧车无效的失败、禁止旧侧车发布 capability、
    既有无效侧车失败语义、批处理 status 恢复，以及新增的新 `graph_extract`
    与旧下游 lineage 不得混合 ready 场景。

必须修改的设计项：无。

verdict: design_audit_passed
