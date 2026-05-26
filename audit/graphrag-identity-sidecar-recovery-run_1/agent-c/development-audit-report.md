# Agent C Development Audit Report

审计对象：当前工作区 diff，重点文件：

- `src/job-state/graphrag-book.ts`
- `test/graphrag-book-state.test.ts`
- `audit/graphrag-identity-sidecar-recovery-run_1/revised-design.md`

固定基准：
`audit/graphrag-identity-sidecar-recovery-run_1/agent-c/development-audit-criteria.md`

已记录通过的验证命令来自 `status.yaml` 的 `verification.passed`。

## 逐条结论

1. PASS - 满足 revised design 的 invariants、catalog projection 和
query-ready gate

证据：生产代码仅将 `recordGraphTextUnitIdentityIfAvailable` 的读取顺序改为当前
Parquet 优先：`readGraphTextUnitIdentity(identityInput)` 先执行，只有无法得到
当前身份时才 fallback 到 `readGraphTextUnitIdentitySidecar(identityInput)`。成功
后仍调用 `repo.recordGraphTextUnitIdentity(mapping)` 并重写
`qmd_graph_text_unit_identity.json`。既有 repository 路径仍按
`bookId/sourceId/sourceHash/documentId/contentHash` 更新
`document-identity-map.yaml` 中匹配项，并写入 `graphDocumentId`、
`graphTextUnitIds` 和 `metadata.graphTextUnitCount`。`query_ready` 发布路径仍由
`validateQueryReadyGraphIdentity` 要求 qmd corpus registration 和 graph 身份，
capability 仍只在 `query_ready` succeeded 后发布。

必要修正建议：无。

剩余风险：实现依赖现有 repository 与 capability gate；未来若这些 gate 改动，
需要同步维护本修复的投影和发布边界。

2. PASS - 能解除真实批处理失败中的身份侧车错误

证据：真实失败错误来自旧侧车先被读取并与当前 Parquet 交叉验证失败。当前 diff
把当前 Parquet 身份读取放在侧车前；新增测试
`rewrites stale same-document sidecar from current parquet identity` 构造同一书、
同一 document 但旧 `graphTextUnitIds` 的侧车，验证同步不再抛出
`GraphRAG document identity sidecar evidence is invalid for query_ready`，并将侧车
和 catalog 重写为当前 Parquet 的 `["tu-1", "tu-2"]`。

必要修正建议：无。

剩余风险：该结论基于本地夹具等价复现。真实失败书的实际回归探测记录缺失，见
第 9 条。

3. PASS - 当前 Parquet 自洽时不得触发不必要的昂贵 `graph_extract` 重跑

证据：`syncGraphRagBookWorkspace` 在身份修复路径中只读取当前 Parquet、记录
catalog、重写侧车；生产 diff 未增加 GraphRAG index 调用，也未修改
`resume-book-workspace.mjs` 的真实工作流执行逻辑。新增同文档旧侧车测试证明
自洽 Parquet 可直接修复身份缓存，不因旧侧车无效而失败。

必要修正建议：无。

剩余风险：新增 `graph_extract identity` 测试证明 graph_extract-only 状态下不发布
capability，但断言 `resumePlan.nextStage` 仍为 `graph_extract`。这说明低层 sync
修复身份后不会把阶段伪装为完成；是否由 resume repair-only 路径复用当前
producer evidence 补全 checkpoint，依赖既有
`completeProducerStageFromEvidence` 路径，当前 diff 未新增端到端测试覆盖该点。

4. PASS - 下游 lineage 未补齐时 `resumePlan.canQuery` 必须为 false

证据：新增测试 `does not publish graph capability after repairing graph_extract
identity only` 只写入当前 `graph_extract` manifest 和 GraphRAG core 输出，不提供
完整下游 lineage；同步后断言 `synced.resumePlan.canQuery` 为 `false`。既有
`buildResumePlan` 逻辑以 `nextStage === null` 才设置 `canQuery=true`。

必要修正建议：无。

剩余风险：测试使用最小本地 fixture；真实批处理下还需依赖 producer manifest、
checkpoint 和 artifact validator 的组合行为。

5. PASS - `loadGraphQueryCapabilities` 在线age 未完整前不得返回该书
`graph_query` capability

证据：新增 graph_extract-only 测试导入并调用 `loadGraphQueryCapabilities`，
断言返回空数组。capability loader 只返回 ready capability，且派生 capability
路径要求有效 `query_ready` checkpoint、lineage artifact ids、qmd corpus
registration 和 graph text unit identity；当前测试未完成 `query_ready`，因此
不会返回 `graph_query`。

必要修正建议：无。

剩余风险：若未来引入新的显式 capability 写入路径，需要继续保证显式 catalog
也经过等价 validator 过滤。

6. PASS - 既有无效侧车测试保持 fail-closed 语义，除非当前 Parquet 提供完整
自洽身份

证据：测试新增 `writeUnmatchedMultiDocumentGraphOutput`，让多文档 Parquet title
不匹配当前 normalized path，避免当前 Parquet fallback 意外证明身份；缺失 graph
document 和绑定其他 document 的侧车测试仍期望
`GraphRAG document identity sidecar evidence is invalid`。测试新增
`writeCorruptTextUnitGraphOutput`，使 text unit 集合不自洽；缺失 text units 测试
仍 fail-closed。另有 `rejects query-ready fallback when parquet text-unit
evidence is corrupt` 继续验证当前 Parquet 损坏时 `required=true` 抛出身份缺失。

必要修正建议：无。

剩余风险：多文档真实输出仍依赖 title basename 匹配；异常 title 会按设计
fail-closed。

7. PASS - TypeScript 类型检查和 Node 语法检查必须通过

证据：`status.yaml` 的 `verification.passed` 记录已通过 `npm run typecheck`、
`node -c scripts/graphrag/batch-epub-workflow.mjs` 和 `git diff --check`。

必要修正建议：无。

剩余风险：本审计未重新执行命令，只审计已记录验证结果。

8. PASS - `test/graphrag-book-state.test.ts` 和 `test/book-job-state.test.ts`
必须通过

证据：`status.yaml` 的 `verification.passed` 记录已通过
`npm run test:node -- test/graphrag-book-state.test.ts` 和
`npm run test:node -- test/book-job-state.test.ts`；还记录了聚焦测试
`-t "sidecar"` 和 `-t "graph_extract identity"` 通过。

必要修正建议：无。

剩余风险：本审计未重新执行命令，只审计已记录验证结果。

9. FAIL - 真实失败书回归探测必须记录状态、命令和结果

证据：`status.yaml` 仅在 `verification.passed` 下记录本地测试、typecheck、
Node 语法检查和 diff 检查。未看到针对真实失败书
`book-9f587b71073a-ad95ce2f`、item `item-9f587b71073a-cff9f38d` 或 run
`epub-batch-20260526-resume-after-auth` 的回归探测命令、退出状态、输出摘要或
失败分类记录。因此无法审计真实失败书是否已实际不再出现身份侧车错误，也无法
在外部网络或凭据失败时与本地身份侧车错误作证据区分。

必要修正建议：在同一 case 的 `status.yaml` 或专门证据文件中追加真实失败书
回归探测记录，至少包含执行命令、执行时间、退出状态、目标 book/item/run、
stdout/stderr 或结果摘要，以及若失败时的分类：本地身份侧车错误、外部网络、
凭据/provider、或其他本地 artifact gate。若真实资源不可运行，也应记录未运行
原因和可替代的本地等价探测命令。

剩余风险：在该证据补齐前，真实批处理恢复效果只能由本地夹具推断，不能作为
已验证事实。

10. PASS - 审计报告给出明确 verdict，并列出剩余风险或测试缺口

证据：本报告逐条列出 PASS/FAIL、证据、必要修正建议和剩余风险；最后一行使用
固定 verdict 格式。

必要修正建议：无。

剩余风险：第 9 条的真实失败书回归探测记录缺口仍未关闭。

## 总体结论

当前实现符合修订设计的核心恢复策略：当前 Parquet 身份优先、侧车作为可修复
缓存、catalog 与侧车被重写、损坏 Parquet fail-closed、下游 lineage 未完整时
不发布 query capability。测试覆盖也针对旧侧车重写、无效侧车保持失败、以及
graph_extract-only 不发布 capability 增强。

本轮开发审计不通过的原因是固定基准第 9 条证据缺口：`status.yaml` 未记录真实
失败书回归探测的状态、命令和结果，无法确认真实失败场景已被实际探测并与外部
网络或凭据问题区分。

verdict: development_audit_failed
