# Agent C Development Reaudit Report

复审对象：针对
`audit/graphrag-identity-sidecar-recovery-run_1/agent-c/development-audit-report.md`
中 FAIL 项的修复结果，并按原固定开发审计基准复核全项。

固定基准：
`audit/graphrag-identity-sidecar-recovery-run_1/agent-c/development-audit-criteria.md`

重点复审证据：`status.yaml` 中新增的 `verification.realFailureProbe`。

## 逐条结论

1. PASS - 满足 revised design 的 invariants、catalog projection 和
query-ready gate

证据：上轮开发审计已确认实现将当前 Parquet 身份读取置于侧车 fallback 之前，
成功后仍写入 repository 并重写 `qmd_graph_text_unit_identity.json`。本次
`status.yaml` 新增真实失败书 probe 结果为 `nextStage: community_report`，
`completedStages: [ingest, normalize, graph_extract]`，说明身份修复没有跳过
下游 gate，也没有把当前 `graph_extract` 与旧下游 lineage 混合为 ready。

必要修正建议：无。

剩余风险：未来若 query-ready gate 或 capability 派生逻辑变更，仍需同步验证
身份修复与 lineage gate 的一致性。

2. PASS - 解除真实批处理失败中的 sidecar invalid 错误

证据：`verification.realFailureProbe` 目标明确为真实失败书
`book-9f587b71073a-ad95ce2f`、item `item-9f587b71073a-cff9f38d`、
document `doc-fd8875181a17`。probe 分类写明 original sidecar invalid error
did not recur，且命令退出码为 `0`、`stderrBytes: 0`。这补强了上轮本地夹具
测试结论，证明原始
`GraphRAG document identity sidecar evidence is invalid for query_ready`
错误在真实目标上未复现。

必要修正建议：无。

剩余风险：probe 结果仍停在 `community_report` 真实重建前，因此未证明整本书
最终 `query_ready` 完成；该边界符合本 case 的修复目标。

3. PASS - 当前 Parquet 自洽时不得触发不必要的昂贵 `graph_extract` 重跑

证据：真实失败书 probe 使用
`--repair-local-artifact-gate-only`，结果记录 `completedStages` 包含
`graph_extract`，`repairedCheckpointStages` 为 `[graph_extract]`，并进入
`nextStage: community_report`。这说明当前 Parquet 身份修复后复用了当前
`graph_extract` evidence 补齐 checkpoint，没有把恢复停留为必须重跑
`graph_extract`。

必要修正建议：无。

剩余风险：`community_report` 仍需真实 rebuild，后续 provider 或网络失败应按
非 sidecar 错误单独分类。

4. PASS - 下游 lineage 未补齐时 `resumePlan.canQuery` 必须为 false

证据：真实 probe 结果为 `status: blocked`、`nextStage: community_report`、
`requiresRealRebuild: true`、`rebuildStage: community_report`。按 resume plan
语义，`nextStage` 非 `null` 时不可查询；该结果也与本地测试
`does not publish graph capability after repairing graph_extract identity only`
一致。

必要修正建议：无。

剩余风险：probe 摘要未直接打印 `canQuery: false` 字段，但 `nextStage:
community_report` 和 `status: blocked` 足以证明未达到 ready/query 状态。

5. PASS - `loadGraphQueryCapabilities` 在线age 未完整前不得返回该书
`graph_query` capability

证据：本地测试已断言 graph_extract-only 修复后
`loadGraphQueryCapabilities({ graphVault })` 返回空数组。真实 probe 分类进一步
写明 “did not publish query_ready”，且结果停在 `community_report` rebuild
gate，未进入 query-ready capability 发布路径。

必要修正建议：无。

剩余风险：真实 probe 未单独记录一次 `loadGraphQueryCapabilities` 命令输出；
但状态和分类已满足本轮第 9 条 probe 记录要求。

6. PASS - 无效侧车测试保持 fail-closed 语义

证据：上轮开发审计已确认测试对缺失 graph document、绑定其他 document、缺失
text units、损坏 Parquet 均保持 fail-closed。`status.yaml` 的通过命令包含
`npm run test:node -- test/graphrag-book-state.test.ts -t "sidecar"` 和完整
`test/graphrag-book-state.test.ts`，说明这些测试集通过。

必要修正建议：无。

剩余风险：多文档 title 异常仍按设计 fail-closed，可能需要人工判读后续真实
书籍的 normalized title 问题。

7. PASS - TypeScript 类型检查和 Node 语法检查通过

证据：`status.yaml` 的 `verification.passed` 记录包含 `npm run typecheck`、
`node -c scripts/graphrag/batch-epub-workflow.mjs` 和 `git diff --check`。

必要修正建议：无。

剩余风险：本复审未重新运行命令，只复核已记录结果。

8. PASS - `test/graphrag-book-state.test.ts` 和 `test/book-job-state.test.ts`
通过

证据：`status.yaml` 的 `verification.passed` 记录包含
`npm run test:node -- test/graphrag-book-state.test.ts`、
`npm run test:node -- test/book-job-state.test.ts`，以及聚焦测试
`-t "sidecar"` 和 `-t "graph_extract identity"`。

必要修正建议：无。

剩余风险：本复审未重新运行命令，只复核已记录结果。

9. PASS - 真实失败书回归探测记录状态、命令和结果

证据：`status.yaml` 已新增 `verification.realFailureProbe`，包含：

- 目标：run `epub-batch-20260526-resume-after-auth`、item
  `item-9f587b71073a-cff9f38d`、book
  `book-9f587b71073a-ad95ce2f`、document `doc-fd8875181a17`。
- 命令：`npx tsx scripts/graphrag/resume-book-workspace.mjs ... --repair-local-artifact-gate-only`。
- 运行结果：`exitStatus: 0`、`stderrBytes: 0`、stdout/stderr 路径已记录。
- 状态：`status: blocked`、`nextStage: community_report`、
  `completedStages: [ingest, normalize, graph_extract]`、
  `repairedCheckpointStages: [graph_extract]`、`requiresRealRebuild: true`、
  `rebuildStage: community_report`。
- 分类：本地 sidecar recovery fixed，原 sidecar invalid 错误未复现，且 stage
  gate 正确要求真实 `community_report` rebuild，没有发布 `query_ready`。

该记录满足固定基准对真实失败书 probe 的状态、命令和结果要求，并把本地身份
侧车错误与后续真实 `community_report` rebuild 需求区分开。

必要修正建议：无。

剩余风险：probe 未执行真实 `community_report` rebuild；这不是本 sidecar
recovery 修复的验收范围，但应在后续恢复运行中单独跟踪 provider、网络或 LLM
阶段失败。

10. PASS - 审计报告给出明确 verdict，并列出剩余风险或测试缺口

证据：本复审报告逐条给出 PASS、证据、必要修正建议和剩余风险，并在最后一行
使用固定 verdict 格式。

必要修正建议：无。

剩余风险：无阻断性测试缺口。剩余工作是执行真实 `community_report` rebuild
并继续后续 `embed`、`query_ready` lineage，这属于修复后正常恢复流程。

## 总体结论

上轮唯一 FAIL 项为真实失败书回归探测记录缺失。`status.yaml` 已补充真实目标、
命令、退出码、stderr 字节、结果摘要和分类，且结果证明原 sidecar invalid 错误
未复现，当前 `graph_extract` 已被修复为完成状态，下游正确停在
`community_report` 真实重建 gate，未发布 `query_ready`。按 Agent C 固定开发
审计基准，本轮开发复审通过。

verdict: development_audit_passed
