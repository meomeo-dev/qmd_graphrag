# Agent A 开发审计报告

审计对象：当前工作区 diff，重点文件为 `src/job-state/graphrag-book.ts`、
`test/graphrag-book-state.test.ts`，并对照
`audit/graphrag-identity-sidecar-recovery-run_1/revised-design.md`。

固定基准：
`audit/graphrag-identity-sidecar-recovery-run_1/agent-a/development-audit-criteria.md`

验证记录来源：`status.yaml` 的 `verification.passed`。本报告未重新执行验证命令。

## 逐条审计

1. PASS

   证据：`src/job-state/graphrag-book.ts` 的
   `recordGraphTextUnitIdentityIfAvailable` 已改为先调用
   `readGraphTextUnitIdentity(identityInput)`，仅在其返回 `null` 时再调用
   `readGraphTextUnitIdentitySidecar(identityInput)`。新增注释明确侧车是缓存，
   当前 Parquet 输出必须优先。

   必要修正建议：无。

   剩余风险：无。

2. PASS

   证据：同一实现路径在取得 `mapping` 后仍调用
   `input.repo.recordGraphTextUnitIdentity(mapping)`，随后将同一 `mapping` 写回
   `qmd_graph_text_unit_identity.json`。新增测试
   `rewrites stale same-document sidecar from current parquet identity` 验证旧侧车
   `graphTextUnitIds` 被当前 Parquet 的 `["tu-1", "tu-2"]` 覆盖，并验证 catalog
   中的 `graphTextUnitIds` 同步更新。

   必要修正建议：无。

   剩余风险：测试断言 catalog 的 text unit ids，但未显式断言 catalog 中
   `graphDocumentId`；当前实现路径会一起写入，风险较低。

3. PASS

   证据：`recordGraphTextUnitIdentityIfAvailable` 使用空值合并顺序：
   当前 Parquet 读取成功时不会读取侧车；只有当前 Parquet 身份缺失或无法证明
   自洽而返回 `null` 时，才进入侧车读取与验证。既有无效侧车测试被调整为使用
   `writeUnmatchedMultiDocumentGraphOutput` 或 `writeCorruptTextUnitGraphOutput`，
   避免有效当前 Parquet 掩盖侧车验证失败路径。

   必要修正建议：无。

   剩余风险：若 Parquet 读取过程抛出环境级错误而非返回 `null`，`required=true`
   会直接失败，不会 fallback 到侧车；该行为保持 fail-closed，符合安全边界。

4. PASS

   证据：`readGraphTextUnitIdentitySidecar` 在侧车无法通过当前 Parquet
   交叉验证时仍抛出
   `GraphRAG document identity sidecar evidence is invalid for query_ready`。
   外层 catch 仅在 `required=false` 时返回；`required=true` 时继续抛错。新增与
   既有测试覆盖 missing graph document、绑定其他 document、缺失 text units 和
   Parquet corrupt 的失败路径。

   必要修正建议：无。

   剩余风险：无。

5. PASS

   证据：实现 diff 仅修改身份恢复读取顺序和测试；未改动
   `assertGraphRagStageArtifactsReady`、artifact validator、producer lineage、
   provider fingerprint、corpus content hash 或 repository 的 `query_ready`
   发布逻辑。`status.yaml` 记录 `test/book-job-state.test.ts`、完整
   `test/graphrag-book-state.test.ts` 和 `npm run typecheck` 已通过，覆盖现有门控
   回归面。

   必要修正建议：无。

   剩余风险：本审计未重新运行命令，仅采信 `status.yaml` 的通过记录。

6. PASS

   证据：实现未修改 repository 的 producer lineage 选择与 `query_ready` gate。
   现有代码仍要求 `graph_extract`、`community_report`、`embed` 均来自真实
   非 bootstrap succeeded checkpoint，并按 producer run id 选择对应 artifacts。
   新增测试 `does not publish graph capability after repairing graph_extract identity only`
   验证只修复当前 `graph_extract` 身份时，`resumePlan.canQuery` 为 `false`，
   `loadGraphQueryCapabilities` 返回空数组，不会发布 graph capability。

   必要修正建议：无。

   剩余风险：新增测试没有直接构造“旧 `community_report`/`embed`/`query_ready`
   checkpoint 与新 `graph_extract` 输出同时存在”的完整历史恢复场景。建议后续用
   集成级 fixture 明确断言该组合不会得到 `nextStage=null` 或 capability。

7. PASS

   证据：`git diff --name-only` 仅显示
   `src/job-state/graphrag-book.ts` 与 `test/graphrag-book-state.test.ts`。未修改
   GraphRAG vendor、CLI 输出渲染、research 子命令或无关查询逻辑。测试文件只新增
   `loadGraphQueryCapabilities` 调用用于断言 capability 未发布。

   必要修正建议：无。

   剩余风险：无。

8. PASS

   证据：新增测试 `rewrites stale same-document sidecar from current parquet identity`
   构造同一 `documentId`、同一 `graphDocumentId` 的侧车，但将
   `graphTextUnitIds` 设置为 `["legacy-tu-1", "legacy-tu-2"]`。测试随后确认侧车
   与 catalog 均被当前 Parquet 身份 `["tu-1", "tu-2"]` 修复，覆盖真实失败中的
   “身份字段仍匹配但 graph text unit ids 陈旧”形态。

   必要修正建议：无。

   剩余风险：真实失败书的 EPUB 名称与实际输出未在单元测试中复现；测试覆盖的是
   等价状态形态。

9. PASS

   证据：新增测试 `does not publish graph capability after repairing graph_extract
   identity only` 只写入当前 `graph_extract` 输出与 producer manifest，不写入完整
   downstream readiness；测试确认侧车被修复后 `resumePlan.canQuery` 仍为 `false`，
   且 `loadGraphQueryCapabilities({ graphVault })` 返回 `[]`。

   必要修正建议：无。

   剩余风险：该测试断言 `resumePlan.nextStage` 为 `graph_extract`，尚未覆盖
   “graph_extract 已完成后继续推进到 `community_report` 或 `embed`”的后续阶段
   断言。

10. PASS

    证据：`status.yaml` 的 `verification.passed` 记录以下固定验收命令已通过：
    `npm run test:node -- test/graphrag-book-state.test.ts -t "sidecar"`、
    `npm run test:node -- test/graphrag-book-state.test.ts -t "graph_extract identity"`、
    `npm run test:node -- test/graphrag-book-state.test.ts`、
    `npm run test:node -- test/book-job-state.test.ts`、`npm run typecheck`、
    `node -c scripts/graphrag/batch-epub-workflow.mjs` 和 `git diff --check`。未发现
    记录的失败命令。

    必要修正建议：无。

    剩余风险：本审计未复跑命令；若工作区在验证记录后继续变化，需要重新执行固定
    验收命令。

## 总体结论

当前实现满足 Agent A 固定开发审计基准。核心行为已从侧车优先改为当前 Parquet
优先，并保持 repository catalog 写入、侧车重写和 `required=true` fail-closed
边界。新增测试覆盖真实失败的陈旧 text unit ids 形态，以及只修复
`graph_extract` 身份时不得发布 graph capability 的能力边界。

verdict: development_audit_passed
