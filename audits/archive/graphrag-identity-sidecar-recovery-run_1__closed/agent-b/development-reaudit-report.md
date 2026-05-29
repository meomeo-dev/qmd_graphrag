# Agent B 开发复审报告

复审对象：针对
`audit/graphrag-identity-sidecar-recovery-run_1__closed/agent-b/development-audit-report.md`
中 FAIL 项的修复结果，并按原固定开发审计基准重新确认全部条目。

固定基准：
`audit/graphrag-identity-sidecar-recovery-run_1__closed/agent-b/development-audit-criteria.md`

复审证据：

- `git status --short --untracked-files=all` 当前仅列出
  `src/job-state/graphrag-book.ts`、`test/graphrag-book-state.test.ts` 和审计
  `status.yaml`，不再列出 `.tmp-tests`。
- `.tmp-tests` 路径当前不存在。
- `git diff --name-only` 当前仅包含 `src/job-state/graphrag-book.ts` 与
  `test/graphrag-book-state.test.ts`。
- `git diff --check` 当前通过，无空白错误。
- `status.yaml` 已补充 `verification.workspaceHygiene`，记录删除
  `.tmp-tests` 后无运行产物目录；同时补充真实失败书 probe，结果为
  `blocked`、`nextStage: community_report`、`requiresRealRebuild: true`，
  原始 sidecar invalid 错误未复现，且未发布 `query_ready`。

## 逐项复审

1. PASS：实现必须保持 `bookId`、`sourceId`、`sourceHash`、`documentId` 和
   `contentHash` 的身份绑定。

   证据：本项与上次开发审计一致。核心实现仍由当前 job 构造 identity input，
   并由当前 Parquet 读取结果携带当前身份字段写回侧车与 catalog。

   必要修正建议：无。

   剩余风险：GraphRAG 多文档 title 异常时仍会 fail-closed。

2. PASS：Catalog 写入必须继续复用
   `FileBookJobStateRepository.recordGraphTextUnitIdentity`，不得引入第二套
   identity map 写入逻辑。

   证据：当前 diff 仍只调整 `recordGraphTextUnitIdentityIfAvailable` 的读取
   优先级，catalog 写入仍复用 repository 方法，未新增直接写
   `document-identity-map.yaml` 的实现。

   必要修正建议：无。

   剩余风险：无新增风险。

3. PASS：侧车重写必须使用当前规范化路径和当前 content hash，不保留陈旧路径或
   content metadata。

   证据：当前实现仍以当前 job 的 `normalizedContentHash ?? sourceHash` 和当前
   normalized path 构造 mapping；已通过的 sidecar 测试覆盖 stale content 与
   stale path 修复。

   必要修正建议：无。

   剩余风险：无新增风险。

4. PASS：多文档 GraphRAG 输出必须仍依赖当前 title basename 或单文档 fallback，
   不得错误绑定其他文档。

   证据：测试继续保留 unmatched multi-document fixture，确认当前 Parquet 优先
   后仍不会把其他 document 绑定到当前书。

   必要修正建议：无。

   剩余风险：真实异常 title 仍可能触发身份缺失，需要按 fail-closed 处理。

5. PASS：当前 Parquet 损坏、缺 text units 或文档不匹配时，query-ready 身份
   必须失败。

   证据：测试继续覆盖 corrupt text unit Parquet、missing graph document 和
   binds another document 场景。`status.yaml` 记录全量
   `test/graphrag-book-state.test.ts` 已通过。

   必要修正建议：无。

   剩余风险：Python/Pandas 或 Parquet schema 变化仍可能导致读取失败；当前边界
   是明确失败而非降级发布。

6. PASS：恢复脚本和 batch 状态不应把本地身份侧车修复错误伪装成 provider
   transient。

   证据：本次复审未发现恢复脚本或 batch 调度逻辑进入 diff。`status.yaml`
   的真实失败书 probe 显示 sidecar invalid 错误未复现，结果被正确阻塞在
   `community_report` rebuild，而不是 provider transient。

   必要修正建议：无。

   剩余风险：真实批处理全量恢复仍依赖后续实际运行确认。

7. PASS：修改范围必须保持最小，不得触碰配置投影、输出格式、GraphRAG 运行器或
   批处理调度逻辑，除非有直接必要。

   证据：`git diff --name-only` 仅包含
   `src/job-state/graphrag-book.ts` 与 `test/graphrag-book-state.test.ts`；未触碰
   配置投影、输出格式、GraphRAG 运行器或批处理调度逻辑。

   必要修正建议：无。

   剩余风险：无新增范围风险。

8. PASS：测试夹具不得通过降低 gate 或伪造 ready capability 来通过。

   证据：新增测试仍通过真实 Parquet fixture、producer manifest 和
   `syncGraphRagBookWorkspace` 路径验证；graph_extract-only 场景断言
   `canQuery=false` 且 capability 为空。真实失败书 probe 也显示当前 lineage
   未完整时未发布 `query_ready`。

   必要修正建议：无。

   剩余风险：resume planner 若未来改变下游 stage 表达，需要同步更新测试断言。

9. PASS：运行产物不得纳入提交，包括 `.qmd`、`graph_vault`、`inbox`、`tmp`、
   `.tmp-tests` 和 `dist`。

   证据：上次 FAIL 的 `.tmp-tests` 未跟踪运行产物已删除。当前
   `git status --short --untracked-files=all` 不再列出 `.tmp-tests`，且
   `.tmp-tests` 路径不存在。`git diff --name-only` 仅列出源码与测试文件；
   `git diff --cached --name-only` 为空，说明没有运行产物被暂存。工作区存在的
   `.qmd`、`graph_vault`、`inbox`、`tmp`、`dist` 本地目录未进入当前 diff 或
   暂存区，本次提交范围未纳入这些运行产物。

   必要修正建议：无。

   剩余风险：提交前仍应再次执行
   `git status --short --untracked-files=all`，防止后续验证命令重新生成运行
   产物。

10. PASS：代码 diff 必须可读，新增注释必须解释非显然设计边界而非重复代码
    动作。

    证据：唯一新增源码注释解释“sidecar 是 cache，当前 Parquet 输出必须优先”
    的设计边界。`git diff --check` 当前通过，且 `status.yaml` 也记录该命令已
    通过。

    必要修正建议：无。

    剩余风险：无新增可读性风险。

## 复审结论

上次开发审计唯一 FAIL 项已修复：`.tmp-tests` 运行产物已删除，当前状态和 diff
未显示运行产物纳入提交。结合既有验证记录、workspace hygiene 记录和真实失败书
probe，本次开发复审通过。

verdict: development_audit_passed
