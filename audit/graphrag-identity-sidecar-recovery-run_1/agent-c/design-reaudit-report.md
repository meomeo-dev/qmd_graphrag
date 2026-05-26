# Agent C Design Reaudit Report

审计对象：`audit/graphrag-identity-sidecar-recovery-run_1/revised-design.md`

固定基准：
`audit/graphrag-identity-sidecar-recovery-run_1/agent-c/audit-criteria.md`

真实失败证据：`status.yaml` 记录批处理
`epub-batch-20260526-resume-after-auth` 在 `resume-book-1` 阶段失败，
错误为 `GraphRAG document identity sidecar evidence is invalid for
query_ready: doc-fd8875181a17`。

## 逐条结论

1. PASS - 状态管理和恢复机制要求

证据：修订设计在 `Proposed Change` 中明确调整
`recordGraphTextUnitIdentityIfAvailable` 的恢复顺序，要求先从当前
`documents.parquet` 和 `text_units.parquet` 读取并验证身份，再记录到
repository 并重写侧车；只有当前 Parquet 身份缺失时才读取侧车。
`Query-Ready Gate` 继续要求 producer run id、artifact validator、
book-scoped artifact、fingerprint 和 corpus content hash 门控。

必要修正建议：无。

2. PASS - 避免历史侧车陈旧导致已完成书永久 stop

证据：`Problem` 精确描述旧侧车与新 Parquet 不一致导致恢复阻断的真实失败；
`Invariants` 将侧车定义为可修复缓存而非唯一真源；`Tests` 第 5 条要求批处理
status 不再把该失败标记为永久本地 stop，恢复后进入正常 CLI 子命令检查。

必要修正建议：无。

3. PASS - 避免可用当前 Parquet 证据下重复昂贵 LLM 重建

证据：`Proposed Change` 要求当前 Parquet 身份自洽时直接重写侧车和 catalog
映射，避免因旧侧车不一致而重跑 `graph_extract`。同时修订设计声明新
`graph_extract` 被接受后，下游 `community_report`、`embed` 和
`query_ready` 仍按当前 resume plan 补齐，防止把身份修复误当作全阶段完成。

必要修正建议：无。

4. PASS - Parquet 证据损坏时停止而非静默降级

证据：`Invariants` 第 5 条规定当前 Parquet 身份证据不自洽时不得发布或保留
`query_ready` capability；`Proposed Change` 第 5 步要求侧车无效且当前
Parquet 也无法提供身份时，在 `required=true` 时继续抛出现有
query-ready 身份缺失或无效错误；`Tests` 第 2 条覆盖该失败语义。

必要修正建议：无。

5. PASS - 保持 `qmd_graph_text_unit_identity.json` 可审计、可重建

证据：`Invariants` 第 3 条将
`qmd_graph_text_unit_identity.json` 定义为可修复缓存；`Proposed Change`
要求当前 Parquet 身份存在或侧车通过当前 Parquet 交叉验证后，重写规范侧车；
`Catalog Projection` 第 6 条要求重写后的侧车与 catalog 中
`graph_text_unit_identity_map` 语义一致。

必要修正建议：无。

6. PASS - 说明对 `document-identity-map` 和
`graph_text_unit_identity_map` 的影响

证据：修订设计新增 `Catalog Projection`，明确当前 Parquet 身份自洽时通过
`FileBookJobStateRepository.recordGraphTextUnitIdentity` 写入 catalog，并以
`bookId`、`sourceId`、`sourceHash`、`documentId` 和 `contentHash` 绑定当前
书籍与当前规范化内容。该章节还规定只更新匹配记录，使用当前 Parquet 集合
替换旧 `graphDocumentId` 与 `graphTextUnitIds`，保留
`qmdCorpusRegistered`、collection 和 relative path，不覆盖其他书籍或其他
content hash 的身份记录。

必要修正建议：无。

7. PASS - 与 GraphRAG 产物隔离和阶段门控前序修复一致

证据：`Invariants` 第 1、2、8 条保持真实非 bootstrap producer lineage、
manifest 和 artifact validator 的强门控，并新增禁止把旧 lineage 下游产物与
新 `graph_extract` 混合成 ready 状态的约束。`Query-Ready Gate` 继续限定
`query_ready` capability 只能从通过门控的状态派生。

必要修正建议：无。

8. PASS - 限制对运行产物的依赖，不把本地临时路径写入源码

证据：修订设计只依赖受管理的当前 GraphRAG 输出、producer manifest、
artifact validator、repository catalog 和侧车文件，没有要求把真实运行证据
中的 `/tmp` 路径、`graph_vault` 实例内容或其他本地临时路径写入源码。
`Non-Goals` 第 5 条明确不提交 `graph_vault`、`.qmd`、`inbox`、`tmp` 或
`.tmp-tests` 产物。

必要修正建议：无。

9. PASS - 给出开发后审计的固定验收信号

证据：修订设计新增 `Post-Implementation Acceptance Signals`，列出固定命令
和可观测结果，包括 `npm run test:node -- test/graphrag-book-state.test.ts
-t "sidecar"`、完整 `test/graphrag-book-state.test.ts`、
`test/book-job-state.test.ts`、`npm run typecheck`、`node -c
scripts/graphrag/batch-epub-workflow.mjs` 和 `git diff --check`。该章节还给出
真实失败书不得再次出现原始身份侧车错误、未补齐 lineage 时
`resumePlan.nextStage` 不得为 `null`、当前 lineage 完整前不得返回
`graph_query` capability、完整后批处理状态必须成功的验收信号。

必要修正建议：无。可选措辞优化：第 8 条中的 “发布 capability” 可在实现审计
记录中解释为 `loadGraphQueryCapabilities` 不返回该书 ready capability。

10. PASS - 明确剩余风险和非目标

证据：修订设计新增 `Remaining Risks`，覆盖多文档 GraphRAG 输出误绑定风险、
Python/Pandas Parquet 读取环境风险、输出目录被部分覆盖时仍需 validator 和
resume plan 判定的风险、repair-only 路径仍可能因非身份类 gate 失败而停止，
以及批处理 status 与 repository 等价 gate 逻辑未来可能漂移的维护风险。
`Non-Goals` 明确不修改 GraphRAG Python vendor、不降低 artifact readiness
validator、不把旧 `query_ready` checkpoint 当作 bypass、不改变输出格式或
research 子命令、不提交运行产物。

必要修正建议：无。

## 总体结论

修订设计已补齐上轮缺失的 catalog projection、固定验收信号和剩余风险章节，
并保留当前 Parquet 优先、损坏证据 fail-closed、禁止混用新旧 producer
lineage、query-ready 强门控和运行产物隔离等关键边界。按 Agent C 固定基准，
本轮设计复审通过。

verdict: design_audit_passed
