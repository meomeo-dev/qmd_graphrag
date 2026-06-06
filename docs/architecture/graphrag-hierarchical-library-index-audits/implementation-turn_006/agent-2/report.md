overallVerdict: PASS_WITH_RISK

# implementation-turn_006 agent-2 审计报告

审计对象：书-书架-Library 层级 GraphRAG 索引改造实现。

固定基准（fixed baseline）：
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
的 D01-D10。

唯一规范入口（canonical Type DD）：
`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`。

验证命令：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 \
  test/graphrag-library-graph.test.ts \
  test/cli-graphrag-query-scope.test.ts \
  test/cli-graphrag-route.test.ts
```

结果：3 个测试文件通过，20 个用例通过。

## 核心结论

- relationType 修复通过。Python contracts 暴露 `ALLOWED_RELATION_TYPES`；
  library builder 仅输出 `library_membership` 与 `co_clustered_topic`；
  inspect bridge 会检查 `semantic_edges.parquet` 的 `relationType` 是否在
  allowed set 中。
- TypeScript quality gate contracts 和测试已包含
  `semantic_edges_relation_types_allowed`。Type DD 已写入等价语义检查
  “relationType values are in allowedRelationTypes”，但未把
  `semantic_edges_relation_types_allowed` 作为字面 checkId 写入 Type DD。
  这是同步风险（synchronization risk），不是当前运行阻断。
- `--bookshelf-id` 与 `--library-id` 查询路径只读取 `current` ready index；
  missing、stale、gate failed、budget exceeded 均走 typed error。remediation
  指向已实现的 `node scripts/graphrag/build-*.mjs`，未引用未实现的
  `qmd library` 管理命令。

## D01_authority_boundaries

verdict: PASS

evidence:

- Type DD 规定单书包权威来自 `BOOK_MANIFEST.json` 与包内 gate，上层索引为
  可重建派生物，且不得写入单书包文件闭包。
- bookshelf graph build 读取成员 book manifest、package gate、runtime gate
  与包内 GraphRAG artifacts，并验证成员 manifest sha 与 generation。
- bookshelf 测试确认构建后成员书目录下没有 `BOOKSHELF_MANIFEST.json` 或
  `semantic_units.parquet` 写入。

risks:

- 未发现当前实现违反单书包权威边界。

requiredFixes:

- 无。

## D02_fixed_query_budget

verdict: PASS

evidence:

- bookshelf 与 library build CLI 均暴露 `--max-semantic-units`、
  `--max-edges` 等固定预算参数。
- query bridge 使用 `maxReports` 与 `maxInputTokens`，超预算返回
  `budget_exceeded_narrow_scope_required`。
- bookshelf 和 library query 测试均验证上层查询为 fixed-budget report
  search，当前 LLM attempted request count 为 0。

risks:

- 当前实现尚未进入 LLM synthesis 与 routed deepening 阶段；后续增加 LLM
  调用时仍需保持固定调用上限。

requiredFixes:

- 无当前阻断项。

## D03_graphrag_semantic_alignment

verdict: PASS_WITH_RISK

evidence:

- Type DD 要求上层输入包含 community reports、semantic units、
  semantic edges 和 evidence map。
- bookshelf/library builders 均从下层 `community_reports.parquet` 派生
  `semantic_units.parquet`、`semantic_edges.parquet`、
  `communities.parquet` 与 `community_reports.parquet`。
- query bridge 基于上层 `community_reports.parquet` 选择固定数量报告，并
  输出 evidence lineage。

risks:

- 当前 semantic edge 生成主要基于 token overlap 与 membership/co-clustered
  关系，`sourceRelationshipIds` 仍偏弱；语义关系（semantic relationship）
  质量可用但仍有 GraphRAG 语义保真风险。

requiredFixes:

- 非本轮阻断。后续应增强 entity/relationship artifact 到 semantic edge 的
  可追溯引用。

## D04_evidence_traceability

verdict: PASS

evidence:

- Type DD 定义 `evidence_map.parquet`，要求回链到 bookId、sourceId、
  documentId、contentHash、community report 或 text_unit。
- builders 为 semantic units、semantic edges 与 community reports 生成
  evidence rows。
- query response evidence 暴露 `bookId`、`sourceId`、`documentId`、
  `contentHash`、`graphTextUnitId`、lower artifact id 和 upper report metadata。

risks:

- 未发现当前实现生成孤立上层结论。

requiredFixes:

- 无。

## D05_state_recovery

verdict: PASS_WITH_RISK

evidence:

- bookshelf/library graph build 写入 staging generation，生成
  `runs/{runId}/events.jsonl`、`status.json`、`recovery-summary.json` 和
  checkpoints。
- builders 在 staging root 通过 quality gate 与 validator 后才 rename 到
  `current`，防止 partial build 发布为 query-ready。
- bookshelf 与 library validation 会重新检查成员 manifest sha，成员变更
  触发 stale diagnostics 或新 generation。

risks:

- 当前代码具备 staging 与可重建恢复闭环，但本轮聚焦测试未覆盖真实中断后
  resume；实现也更接近重新构建（rebuild）而非从 checkpoint 继续。

requiredFixes:

- 补充 interrupted bookshelf/library build 的恢复测试，确认失败 staging 不会
  发布且后续 rebuild 可恢复。

## D06_quality_gates

verdict: PASS_WITH_RISK

evidence:

- Type DD 在 bookshelfGate 与 libraryGate requiredChecks 中包含
  `semantic_edges.parquet relationType values are in allowedRelationTypes`。
- `BookshelfGraphChecks` 与 `LibraryGraphChecks` 均包含
  `semantic_edges_relation_types_allowed`。
- validators 会检查 quality gate 缺失 required check，并调用 parquet inspect
  校验 semantic edge relationType。
- bookshelf 测试删除该 checkId 后验证失败；library 测试把 relationType 改成
  `cross_shelf_topic` 后验证失败。

risks:

- Type DD 尚未把 `semantic_edges_relation_types_allowed` 作为字面 checkId 写入
  requiredChecks；当前靠实现合同和测试维持同步，存在文档到代码追踪风险。

requiredFixes:

- 在 Type DD 的 bookshelf/library quality gate requiredChecks 或 checkIds 中
  明确加入字面 ID：`semantic_edges_relation_types_allowed`。

## D07_incremental_scaling

verdict: PASS_WITH_RISK

evidence:

- bookshelf/library manifests 记录 generation、member manifest sha256、构建
  配置与固定预算参数。
- library build 以 member bookshelf manifest sha 为输入，成员 bookshelf sha
  变化会产生 stale error。
- 大库限制通过书架分层、`maxSemanticUnits`、`maxBookshelvesForDeepening` 和
  `maxEdges` 控制查询和上层图规模。

risks:

- 当前实现以保守全量重建为主，尚未实现真正的增量刷新（incremental
  refresh）。这符合当前阶段可接受边界，但不满足长期扩展目标的完整形态。

requiredFixes:

- 非本轮阻断。后续 phase 应实现或明确保守全量重建条件、失效范围和
  incremental refresh 测试。

## D08_security_privacy

verdict: PASS

evidence:

- Type DD 禁止 provider payload、raw prompt/completion、密钥、绝对路径和
  query log 进入上层 manifest 或 index。
- bookshelf/library manifests 包含 sensitivity policy，builder 对 manifest 与
  quality gate 做 forbidden field scan。
- path validation 禁止绝对路径、`../` 与 URI scheme。
- CLI GraphRAG route 测试验证 JSON 输出不包含 graph vault 绝对路径。

risks:

- 未发现当前实现泄露敏感 payload 或绝对路径。

requiredFixes:

- 无。

## D09_cli_operability

verdict: PASS

evidence:

- `--bookshelf-id` 查询读取
  `graph_vault/catalog/bookshelves/{bookshelfId}/current` 下的 manifest 与
  quality gate。
- `--library-id` 查询读取
  `graph_vault/catalog/library/{libraryId}/current` 下的 manifest 与 quality
  gate。
- CLI route 对 ambiguous scope、missing upper index、stale、quality gate
  failed、budget exceeded 和 runtime error 均映射 typed error。
- remediationCommand 使用已实现的
  `node scripts/graphrag/build-bookshelf-graph.mjs` 与
  `node scripts/graphrag/build-library-graph.mjs`，未引用未实现的
  `qmd library list/build/status/rebuild`。

risks:

- 未发现查询路径自动构建或长时间全库扫描风险。

requiredFixes:

- 无。

## D10_testability

verdict: PASS_WITH_RISK

evidence:

- Type DD testContracts 定义超过 8 个必测案例，覆盖 fixed budget、missing
  index、stale、evidence map、安全、single-book 非回归等。
- 聚焦测试通过：library graph build、disallowed relationType 负例、CLI
  scope helper、missing index typed error、scope ambiguity typed error。
- tests 覆盖 `semantic_edges_relation_types_allowed` 质量门缺失负例，以及
  `cross_shelf_topic` disallowed relationType 负例。

risks:

- 本轮仅运行聚焦测试，未运行全量套件；D05 的真实中断恢复、D07 的多规模
  增量刷新，以及 routed deepening 后续能力仍需更多测试覆盖。

requiredFixes:

- 补充 Type DD 字面 checkId 同步测试或文档检查。
- 后续补齐 interrupted build、stale after deletion、10/100/1000 book budget
  simulation 的持续回归测试。

## 审计结论

implementation-turn_006 的核心 relationType 修复、inspect gate、实现合同、
CLI typed errors 与聚焦测试均达到当前交付要求。唯一需要在后续修订中关闭的
明确问题是 Type DD 未以字面 checkId 形式写入
`semantic_edges_relation_types_allowed`，建议作为 required fix 处理。
