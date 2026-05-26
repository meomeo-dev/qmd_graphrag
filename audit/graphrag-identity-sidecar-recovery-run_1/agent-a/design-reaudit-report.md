# Agent A 设计复审报告

审计对象：`audit/graphrag-identity-sidecar-recovery-run_1/revised-design.md`

固定基准：`audit/graphrag-identity-sidecar-recovery-run_1/agent-a/audit-criteria.md`

真实失败证据：`status.yaml` 记录的批处理
`epub-batch-20260526-resume-after-auth` 在 `resume-book-1` 阶段失败，错误为
`GraphRAG document identity sidecar evidence is invalid for query_ready:
doc-fd8875181a17`。

源码边界核对：当前 `src/job-state/graphrag-book.ts` 中
`recordGraphTextUnitIdentityIfAvailable` 仍是先读取侧车再读取当前 Parquet；
`src/job-state/repository.ts` 中 `query_ready` 仍要求非 bootstrap producer
checkpoint、artifact validator、fingerprint、corpus hash、qmd corpus
registration 与 graph identity。

1. PASS

   证据：revised design 在 Problem 中明确区分历史
   `qmd_graph_text_unit_identity.json` 侧车与新的 `documents.parquet`、
   `text_units.parquet` producer 输出；Invariants 第 3、4 条将侧车定义为可修复
   缓存，将当前 Parquet 自洽身份作为优先证据；Proposed Change 第 1 至 3 步
   要求先读当前 Parquet，只有当前 Parquet 身份缺失时才读侧车。

   必要修正建议：无。

2. PASS

   证据：Invariants 第 5、6 条声明当前 Parquet 不自洽时不得发布或保留
   `query_ready` capability，旧侧车不能单独证明当前 `query_ready`；Proposed
   Change 第 4、5 步要求侧车必须通过当前 Parquet 交叉验证，否则在
   `required=true` 时失败；Post-Implementation Acceptance Signals 第 8 条要求
   当前 lineage 未完整前不得发布 `graph_query` capability。

   必要修正建议：无。

3. PASS

   证据：Invariants 第 2 条要求当前 manifest 和 artifact validator 仍是
   GraphRAG 高成本产物门控的唯一有效判据；Query-Ready Gate 要求 required
   artifact kind、book-scoped artifact、stage fingerprint、provider fingerprint
   和 corpus content hash 全部匹配；Non-Goals 第 2 条明确不降低 artifact
   readiness validator。

   必要修正建议：无。

4. PASS

   证据：Invariants 第 1 条要求 `query_ready` 只能基于真实非 bootstrap 的
   `graph_extract`、`community_report` 和 `embed` producer lineage 发布；
   Invariants 第 8 条和 Proposed Change 后续说明明确禁止把新 `graph_extract`
   与旧 `community_report`、`embed`、`query_ready` lineage 混合成 ready；
   Query-Ready Gate 要求 producer run id 必须来自有效 stage checkpoint 或 run
   record。

   必要修正建议：无。

5. PASS

   证据：Proposed Change 第 1、2 步说明当前 Parquet 身份存在时，先验证当前
   `documents.parquet` 与 `text_units.parquet`，再记录到 repository 并重写
   `qmd_graph_text_unit_identity.json`；Catalog Projection 进一步要求通过
   `FileBookJobStateRepository.recordGraphTextUnitIdentity` 写入 catalog，并用当前
   自洽 Parquet 集合替换旧 `graphTextUnitIds`。

   必要修正建议：无。

6. PASS

   证据：Proposed Change 第 3 至 5 步说明当前 Parquet 身份缺失时才读取侧车；
   侧车无效且当前 Parquet 也无法提供身份时，在 `required=true` 下继续抛出现有
   query-ready 身份缺失或无效错误。Tests 第 2 条要求覆盖该失败路径。

   必要修正建议：无。

7. PASS

   证据：Invariants 第 7 条明确修复不得跳过每本书的 qmd 与 GraphRAG 闭环检查；
   Catalog Projection 第 4 条要求未完成 qmd corpus registration 的书不得发布
   `query_ready`；Query-Ready Gate 保留 producer、artifact、fingerprint 与
   catalog 派生门控；Post-Implementation Acceptance Signals 第 9 条要求完整
   lineage 后批处理 item 的 qmd、graph build 和 graph query 状态均成功。

   必要修正建议：无。

8. PASS

   证据：Proposed Change 将主要修改面限定在
   `src/job-state/graphrag-book.ts` 的身份恢复读取顺序；Catalog Projection 要求
   复用现有 `FileBookJobStateRepository.recordGraphTextUnitIdentity` 行为；Non-Goals
   明确不修改 GraphRAG Python vendor、输出格式、research 子命令或其他设计。
   设计未要求大范围改动恢复、查询或输出渲染逻辑。

   必要修正建议：无。

9. PASS

   证据：Problem 精确复述真实失败：旧侧车中的 `graphTextUnitIds` 来自旧有效
   GraphRAG 输出，而当前 `documents.parquet`、`text_units.parquet` 已被新的
   `graph_extract` 恢复尝试覆盖，导致先读侧车时失败。Proposed Change 通过先
   读取当前 Parquet 并重写侧车解除该阻断；同一节还要求下游阶段按当前 resume
   plan 和 producer lineage 补齐，避免恢复后直接错误进入 `query_ready`。

   必要修正建议：无。

10. PASS

    证据：Tests 列出 6 条回归测试，覆盖旧侧车与当前 Parquet 不一致、当前
    Parquet 缺失且侧车无效、禁止旧 text unit ids 侧车发布 capability、既有
    无效侧车失败语义、批处理 status 恢复，以及新 `graph_extract` 与旧下游
    lineage 不得混合 ready。Post-Implementation Acceptance Signals 进一步列出
    可执行命令：`npm run test:node -- test/graphrag-book-state.test.ts -t "sidecar"`、
    `npm run test:node -- test/graphrag-book-state.test.ts`、
    `npm run test:node -- test/book-job-state.test.ts`、`npm run typecheck`、
    `node -c scripts/graphrag/batch-epub-workflow.mjs` 和 `git diff --check`。

    必要修正建议：无。

总体复审结论：revised design 满足 Agent A 的 10 条固定设计审计基准。设计在
原侧车恢复路径之外补充了 catalog 投影规则、lineage 防混用约束、真实失败验收
信号和可执行回归命令；未发现必须修改的设计项。

verdict: design_audit_passed
