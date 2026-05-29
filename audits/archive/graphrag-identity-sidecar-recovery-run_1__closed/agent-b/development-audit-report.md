# Agent B 开发审计报告

审计对象：当前工作区 diff，重点文件
`src/job-state/graphrag-book.ts`、`test/graphrag-book-state.test.ts`，以及
`audit/graphrag-identity-sidecar-recovery-run_1__closed/revised-design.md`。

固定基准：
`audit/graphrag-identity-sidecar-recovery-run_1__closed/agent-b/development-audit-criteria.md`

验证记录：`status.yaml` 的 `verification.passed` 记录以下命令已通过：

- `npm run test:node -- test/graphrag-book-state.test.ts -t "sidecar"`
- `npm run test:node -- test/graphrag-book-state.test.ts -t "graph_extract identity"`
- `npm run test:node -- test/graphrag-book-state.test.ts`
- `npm run test:node -- test/book-job-state.test.ts`
- `npm run typecheck`
- `node -c scripts/graphrag/batch-epub-workflow.mjs`
- `git diff --check`

## 逐项审计

1. PASS：实现必须保持 `bookId`、`sourceId`、`sourceHash`、`documentId` 和
   `contentHash` 的身份绑定。

   证据：`recordGraphTextUnitIdentityIfAvailable` 构造 `identityInput` 时继续
   使用当前 job 的 `bookId`、`sha256:${sourceHash}`、`sourceHash`、
   `documentId`、当前 `normalizedContentHash ?? sourceHash` 和当前
   `normalizedPath`。`readValidatedGraphTextUnitIdentity` 返回的 mapping 继续
   带回这些身份字段，不从侧车继承陈旧 content metadata。

   必要修正建议：无。

   剩余风险：Parquet 身份读取仍依赖 GraphRAG 输出中的 title basename 或单文档
   fallback；异常 title 会 fail-closed，而不是误绑定。

2. PASS：Catalog 写入必须继续复用
   `FileBookJobStateRepository.recordGraphTextUnitIdentity`，不得引入第二套
   identity map 写入逻辑。

   证据：diff 中 `src/job-state/graphrag-book.ts` 只调整读取优先级；catalog
   写入仍为 `await input.repo.recordGraphTextUnitIdentity(mapping)`。未新增
   `document-identity-map.yaml` 的直接写文件逻辑。

   必要修正建议：无。

   剩余风险：后续若为修复便捷性直接写 catalog，需要再次审计。

3. PASS：侧车重写必须使用当前规范化路径和当前 content hash，不保留陈旧路径或
   content metadata。

   证据：`identityInput` 的 `contentHash` 来自当前 job 的
   `normalizedContentHash ?? sourceHash`，`normalizedPath` 来自当前同步路径；
   `parseGraphTextUnitIdentitySidecar` 也将侧车解析结果的 `contentHash` 与
   `normalizedPath` 重置为 expected 值。既有测试
   `repairs stale GraphRAG identity sidecar content metadata` 与
   `repairs stale GraphRAG identity sidecar path metadata` 仍覆盖该行为。

   必要修正建议：无。

   剩余风险：无新增风险。

4. PASS：多文档 GraphRAG 输出必须仍依赖当前 title basename 或单文档 fallback，
   不得错误绑定其他文档。

   证据：`readValidatedGraphTextUnitIdentity` 在没有显式 graph document id 时先
   尝试 `documentId`，再按 `title_basename(normalizedPath)` 匹配；多文档输出
   时要求 matched document 的 title basename 等于当前 normalized title。
   新增 `writeUnmatchedMultiDocumentGraphOutput` 夹具让多文档 title 都不匹配当前
   `book.md`，并用于“missing graph document”和“binds another document”测试，
   确认不会因当前 Parquet 优先而错误绑定其他文档。

   必要修正建议：无。

   剩余风险：真实 GraphRAG 多文档 title 缺失或异常时仍会身份缺失并
   fail-closed。

5. PASS：当前 Parquet 损坏、缺 text units 或文档不匹配时，query-ready 身份
   必须失败。

   证据：`readValidatedGraphTextUnitIdentity` 要求 `documents.parquet` 具备
   `id`、`text_unit_ids`，`text_units.parquet` 具备 `id`、`document_id`，并要求
   document 的 text unit ids 与按 graph document id 过滤出的 text units 完全
   一致。新增 `writeCorruptTextUnitGraphOutput` 夹具用于缺失 text unit 的
   query-ready 失败测试；不匹配文档场景也通过 unmatched 多文档夹具保持失败。

   必要修正建议：无。

   剩余风险：Pandas 或 Parquet schema 演进可能导致读取失败；当前行为是明确
   失败或返回 null 后在 required 路径 fail-closed。

6. PASS：恢复脚本和 batch 状态不应把本地身份侧车修复错误伪装成 provider
   transient。

   证据：本次 diff 未修改恢复脚本、batch workflow 或 provider transient 分类
   逻辑。`scripts/graphrag/resume-book-workspace.mjs` 仍将 identity sidecar
   错误归入 local artifact gate 相关文本匹配，而不是 provider transient。
   `status.yaml` 记录 `node -c scripts/graphrag/batch-epub-workflow.mjs` 已通过。

   必要修正建议：无。

   剩余风险：真实 batch status 的最终恢复信号仍需在运行环境中确认；本审计仅
   依据当前 diff 和已记录验证命令判断。

7. PASS：修改范围必须保持最小，不得触碰配置投影、输出格式、GraphRAG 运行器或
   批处理调度逻辑，除非有直接必要。

   证据：`git diff --name-only` 仅包含
   `src/job-state/graphrag-book.ts` 与 `test/graphrag-book-state.test.ts`。源码
   改动是将读取顺序从“侧车优先”改为“当前 Parquet 优先”，并添加一条解释设计
   边界的注释；测试仅补充相关身份恢复和 gate 场景。

   必要修正建议：无。

   剩余风险：无新增范围风险。

8. PASS：测试夹具不得通过降低 gate 或伪造 ready capability 来通过。

   证据：新增测试使用真实 Parquet 夹具、现有 `writeGraphRagOutputProducerManifest`
   和 `syncGraphRagBookWorkspace` 路径；`does not publish graph capability after
   repairing graph_extract identity only` 明确断言 `canQuery=false` 且
   `loadGraphQueryCapabilities({ graphVault })` 返回空数组。测试没有直接写
   capability catalog 或绕过 `query_ready` validator。

   必要修正建议：无。

   剩余风险：该测试断言当前 resume plan 返回 `graph_extract`；若未来 resume
   planner 改为更精细地下游 stage 指向，需要同步更新测试语义。

9. FAIL：运行产物不得纳入提交，包括 `.qmd`、`graph_vault`、`inbox`、`tmp`、
   `.tmp-tests` 和 `dist`。

   证据：`git status --short --untracked-files=all` 显示大量未跟踪
   `.tmp-tests/...` 文件，包括 `.tmp-tests/*/graph_vault/...`、fixture
   `Book.epub`、`config/index.yml` 和 batch-run manifest。`git diff --name-only`
   未显示这些文件，说明它们不是 tracked diff，但当前工作区中存在运行产物，
   若执行 `git add -A` 将违反该基准。

   必要修正建议：在提交实现前删除或移出 `.tmp-tests` 运行产物，并复核
   `git status --short --untracked-files=all` 不再列出 `.tmp-tests`、`.qmd`、
   `graph_vault`、`inbox`、`tmp` 或 `dist` 产物。审计报告和 case 文件可以按
   审计流程保留，但运行产物不能进入提交。

   剩余风险：只要 `.tmp-tests` 仍存在于工作区，提交卫生依赖人工排除，存在误
   加入提交的风险。

10. PASS：代码 diff 必须可读，新增注释必须解释非显然设计边界而非重复代码动作。

    证据：`src/job-state/graphrag-book.ts` 的唯一新增注释为
    “The sidecar is a cache; recovered current Parquet output must win.”，解释侧车是
    缓存、当前 Parquet 优先的设计边界。`git diff --check` 已在
    `status.yaml` 中记录通过。

    必要修正建议：无。

    剩余风险：无新增可读性风险。

## 总体结论

核心实现和测试符合 revised design：当前 Parquet 身份优先，catalog 写入复用
现有 repository 方法，损坏或不匹配 Parquet 在 query-ready 路径 fail-closed，
且 graph_extract-only 身份修复不会发布 graph capability。

开发审计未通过的唯一阻断项是工作区存在未跟踪 `.tmp-tests` 运行产物。该问题不
属于源码逻辑缺陷，但违反固定开发审计基准第 9 条，必须在提交前清理或移出。

verdict: development_audit_failed
