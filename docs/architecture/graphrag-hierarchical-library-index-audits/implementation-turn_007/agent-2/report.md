overallVerdict: PASS

# implementation-turn_007 agent-2 修复后实施审计报告

审计对象：书-书架-Library 层级 GraphRAG 索引改造。

固定基准：`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`。

唯一规范入口：`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`。

审计范围偏代码/合同同步（code-contract synchronization）：Type DD、
书架与 library 合同、校验器、Python parquet inspect、负例测试、CLI typed
error remediation、查询路径 fail-closed 行为，以及当前 graph_vault 快照。

验证命令：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 \
  test/graphrag-bookshelf-graph.test.ts \
  test/graphrag-library-graph.test.ts \
  test/cli-graphrag-route.test.ts
```

结果：3 个测试文件通过，15 个测试通过。

当前快照抽查结果：

- `software-engineering-library`：
  generation=`library-b5e16d8a55a6a930`，`queryReady=true`，
  gate=`library_query_ready`，`ok=true`。
- `delivery-devops-core`：
  generation=`bookshelf-42d5c276a8ad099d`，`queryReady=true`，
  gate=`bookshelf_query_ready`，`ok=true`。
- `software-architecture-core`：
  generation=`bookshelf-dab8e0be24c6a06c`，`queryReady=true`，
  gate=`bookshelf_query_ready`，`ok=true`。
- 三个 current gate 均包含 `semantic_edges_relation_types_allowed`。
- 实际 `relationType` 值均在 allowed set：
  library 为 `co_clustered_topic,library_membership`；两个书架均为
  `bookshelf_membership,co_clustered_topic`。

## D01_authority_boundaries

verdict: PASS

evidence:

- Type DD 保持单书包权威与上层派生物边界：上层索引缺失、损坏或过期
  不得改变单书包 `query_ready` 判定。
- 书架图测试确认书架 manifest 和 `semantic_units.parquet` 不写入成员书包
  目录，覆盖 `BOOKSHELF_MANIFEST.json` 与 `semantic_units.parquet` 的负例。
- 书架与 library 构建均发布到 `graph_vault/catalog/.../current`，而非
  `graph_vault/books/{bookId}`。

risks:

- 当前审计未重跑全量 hotplug 非回归套件，仅使用相关实施测试和当前快照
  抽查确认边界。

requiredFixes:

- 无。

## D02_fixed_query_budget

verdict: PASS

evidence:

- 当前 manifest 均记录固定预算：`maxSemanticUnits=32`、
  `maxInputTokens=64000`，书架含 `maxBooksForDeepening=3`，library 含
  `maxBookshelvesForDeepening=3`。
- 查询桥接器只从 current `community_reports.parquet` 选取
  `reports[:maxReports]`，并在 `estimatedInputTokens > maxInputTokens` 时返回
  `budget_exceeded_narrow_scope_required`。
- 查询响应的 runtime metrics 显示上层固定预算 report search 不发起 LLM
  请求；相关测试断言 `attemptedRequestCount=0`。

risks:

- 当前实现为固定预算 report search；Type DD 中的 selected upper semantic
  units LLM synthesis 与 bounded deepening 仍属于后续能力。该风险不破坏
  当前固定预算合同。

requiredFixes:

- 无。

## D03_graphrag_semantic_alignment

verdict: PASS

evidence:

- Type DD 定义上层输入与产物包括 `community_reports.parquet`、
  `semantic_units.parquet`、`semantic_edges.parquet` 和 `evidence_map.parquet`。
- allowed relation types 固定为 `shared_entity`、`source_relationship`、
  `co_clustered_topic`、`parent_child_community`、`bookshelf_membership`、
  `library_membership`。
- Python inspect 对 `semantic_edges.parquet` 的 `relationType` 执行 allowed
  set 检查；当前三个 current 索引均通过且非空。

risks:

- 当前构建偏可验证的上层关系与 report search，尚未引入更复杂的 vendor
  GraphRAG 上层社区检测算法。

requiredFixes:

- 无。

## D04_evidence_traceability

verdict: PASS

evidence:

- Type DD 的 `evidence_map.parquet` 要求包含 `targetBookId`、
  `targetSourceId`、`targetDocumentId`、`targetContentHash`、
  `targetCommunityReportId`、`targetTextUnitId` 和 `targetArtifactDigest`。
- 书架与 library 查询测试断言返回 evidence 中包含 book、source、
  document、content hash、text unit 和 scope locator。
- 当前 inspect 显示 library `evidence_map.parquet` 46 行，两个书架各 131 行，
  且 schema 校验通过。

risks:

- 当前查询输出为所选 report 的 evidence 回链摘要，尚未覆盖后续 LLM synthesis
  的逐句引用策略。

requiredFixes:

- 无。

## D05_state_recovery

verdict: PASS

evidence:

- 书架与 library 构建写入 staging 后执行校验，校验通过才 rename 到
  `current`，并写入 `CURRENT.json`。
- 构建产物包含 `runs/{runId}/events.jsonl`、`status.json`、
  `recovery-summary.json` 和成员 checkpoints。
- manifest 记录成员 manifest sha256 与 generation；validator 对成员
  manifest sha 变化返回 stale diagnostics。

risks:

- 本轮未模拟进程中断恢复，仅核对代码路径、状态产物和相关测试覆盖。

requiredFixes:

- 无。

## D06_quality_gates

verdict: PASS

evidence:

- Type DD 的 `bookshelfGate.checkIds` 和 `libraryGate.checkIds` 均包含
  `semantic_edges_relation_types_allowed`；requiredChecks 也明确要求
  `semantic_edges.parquet relationType values are in allowedRelationTypes`。
- `BookshelfGraphChecks` 与 `LibraryGraphChecks` 均包含
  `semantic_edges_relation_types_allowed`。
- validator required check coverage 会将缺失项报告为
  `quality_gate_missing_check:*` 或
  `{scope}_quality_gate_missing_check:*`。
- Python inspect 对 `semantic_edges.parquet` 的实际 `relationType` 值做
  allowed set 校验。
- 负例测试覆盖：删除 gate check 会失败；library 将 `relationType` 改为
  `cross_shelf_topic` 会得到
  `disallowed_relation_type:semantic_edges.parquet:cross_shelf_topic`。

risks:

- allowed set 同时存在于 TypeScript 测试常量与 Python 合同常量中；当前值
  一致，但后续新增 relation type 时仍需同步更新多处合同。

requiredFixes:

- 无。

## D07_incremental_scaling

verdict: PASS

evidence:

- manifest 记录成员 manifest sha256、membership digest、partition/split plan
  digest 和 generation。
- library manifest 记录两个成员书架的 manifest sha256，并以书架 current
  作为上层输入。
- validator 对书架成员书 manifest sha、library 成员书架 manifest sha 的
  变化返回 stale diagnostics，默认查询拒绝 stale。

risks:

- 当前实现偏保守重建与 current generation 校验；更细粒度增量刷新策略仍可
  后续扩展。

requiredFixes:

- 无。

## D08_security_privacy

verdict: PASS

evidence:

- Type DD 禁止 provider payload、原始 prompt/completion、密钥、绝对路径和
  `query.log` 进入可发布上层 manifest 或索引。
- 书架与 library manifest 均记录 `sensitivityPolicy.forbiddenFields` 和
  graph_vault-relative locator rule。
- 构建路径在发布 manifest 与 quality gate 前执行 forbidden text scan。
- CLI GraphRAG 测试覆盖 JSON 输出不包含 workspace graph vault 绝对路径。

risks:

- 本轮未做全库敏感字段扫描，只审计上层 manifest/gate 构建逻辑与相关测试。

requiredFixes:

- 无。

## D09_cli_operability

verdict: PASS

evidence:

- Type DD 的 `upper_index_missing`、`upper_index_stale`、
  `upper_quality_gate_failed` 和 `upper_index_runtime_error` remediation 均指向
  已实现脚本 `scripts/graphrag/build-bookshelf-graph.mjs` 或
  `scripts/graphrag/build-library-graph.mjs`。
- `src/cli/graphrag-query-scope.ts` 的 remediation 生成逻辑使用上述两个脚本，
  未引用未实现的 `qmd library build/status/rebuild` 管理命令。
- CLI 测试断言 missing bookshelf/library index 返回 typed error：
  `upper_index_missing`，exit code 66，并给出对应 build script remediation。
- 查询路径读取 `catalog/bookshelves/{id}/current` 或
  `catalog/library/{id}/current`；missing、stale、gate failed 与预算超限均
  转为 typed failure，不进入全库扫描。

risks:

- Type DD 仍把 `qmd library list/build/status/rebuild` 标为 remaining
  capability/risk gap；这不再污染 typed error remediation。

requiredFixes:

- 无。

## D10_testability

verdict: PASS

evidence:

- Type DD 定义超过 8 个测试合同，覆盖固定预算、状态恢复、证据、安全、
  stale、hotplug 非回归和 CLI typed error。
- 本轮执行的相关测试结果：3 个测试文件通过，15 个测试通过。
- 测试覆盖书架构建、library 构建、quality gate required check、relationType
  负例、CLI missing upper index typed error、scope ambiguity 和 current 查询
  evidence 输出。

risks:

- 本轮未运行仓库全量测试；结论基于固定重点相关测试与现有 current 快照抽查。

requiredFixes:

- 无。

## 结论

实施已满足固定 D01-D10 审计基准。重点修复项已同步到 Type DD、TypeScript
合同、validator required check coverage、Python inspect allowed set、负例测试、
CLI remediation 和 current query fail-closed 路径。当前 graph_vault 快照与
任务给定最终状态一致，未发现必须修复项。
