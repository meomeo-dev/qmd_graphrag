# GraphRAG Identity Sidecar Recovery Final Report

## Scope

本 case 修复真实批处理 `epub-batch-20260526-resume-after-auth` 中
`book-9f587b71073a-ad95ce2f` 的本地身份侧车恢复失败。原错误为
`GraphRAG document identity sidecar evidence is invalid for query_ready:
doc-fd8875181a17`。

修复范围限定为 GraphRAG 文本单元身份恢复顺序、对应回归测试和审计记录。
未修改 GraphRAG vendor、CLI 输出格式、research 子命令、配置投影或批处理
调度逻辑。

## Result

开发审计通过。3 个设计复审均通过，3 个开发审计最终均通过。

实现结果：

1. `recordGraphTextUnitIdentityIfAvailable` 优先读取当前
   `documents.parquet` 与 `text_units.parquet` 的自洽身份。
2. 当前 Parquet 身份自洽时，重写 `qmd_graph_text_unit_identity.json` 并通过
   `FileBookJobStateRepository.recordGraphTextUnitIdentity` 写入 catalog。
3. 当前 Parquet 无法提供身份时，才读取并验证侧车。
4. 当前 Parquet 和侧车都无法证明身份且 `required=true` 时，继续
   fail closed。
5. 下游 lineage 未补齐时不发布 `query_ready` 或 `graph_query` capability。

真实失败书 repair-only 探测退出码为 0，stderr 为空。原 sidecar invalid 错误
未复现；当前状态正确停在 `community_report` 真实重建门控：

- `completedStages`: `ingest`, `normalize`, `graph_extract`
- `nextStage`: `community_report`
- `requiresRealRebuild`: `true`
- `repairedCheckpointStages`: `graph_extract`

## Verification

已通过的固定验收命令：

1. `npm run test:node -- test/graphrag-book-state.test.ts -t "sidecar"`
2. `npm run test:node -- test/graphrag-book-state.test.ts -t "graph_extract identity"`
3. `npm run test:node -- test/graphrag-book-state.test.ts`
4. `npm run test:node -- test/book-job-state.test.ts`
5. `npm run typecheck`
6. `node -c scripts/graphrag/batch-epub-workflow.mjs`
7. `git diff --check`
8. 真实失败书 repair-only probe：
   `npx tsx scripts/graphrag/resume-book-workspace.mjs ... --repair-local-artifact-gate-only`

工作区清理已确认：`.tmp-tests` 已删除，运行产物目录未进入提交候选范围。

## Remaining Work

本 case 只关闭本地 identity sidecar 恢复缺陷。真实批处理仍需继续执行
`community_report`、`embed`、`query_ready` 和所有 CLI 子命令检查。后续若失败，
应按实际失败分类处理；若为 provider、网络或凭据问题，不应回退为本地
sidecar 缺陷。
