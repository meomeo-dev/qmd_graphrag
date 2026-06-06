# GraphRAG 层级 Library 索引设计审计最终摘要

## 审计对象

- 设计文档：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 审计目录：
  `docs/architecture/graphrag-hierarchical-library-index-audits/`

## 固定基准

审计全程使用 `base/evaluation-dimensions.yaml` 中的 10 个固定维度：

- D01_authority_boundaries
- D02_fixed_query_budget
- D03_graphrag_semantic_alignment
- D04_evidence_traceability
- D05_state_recovery
- D06_quality_gates
- D07_incremental_scaling
- D08_security_privacy
- D09_cli_operability
- D10_testability

基准在所有审计轮次中未修改。

## 第一轮

目录：`design-turn_001/`

结果：

- `agent-01`: pass
- `agent-02`: pass
- `agent-03`: pass_with_minor_notes

第一轮未发现 `fail` 项。主要补强建议集中在：

- 上层 `semantic_edges` 或等价语义关系 schema。
- 质量门失败诊断的最小机器可读字段。
- 诊断脱敏策略。
- CLI typed error、退出码、降级矩阵。
- library 级增量刷新规则。

## 修订结果

设计文档已补充：

- `upperGraphArtifactSchemas.semanticUnits`
- `upperGraphArtifactSchemas.semanticEdges`
- `upperGraphArtifactSchemas.evidenceMap`
- `queryContract.typedErrors`
- `queryContract.cliBehaviorMatrix`
- `qualityGates.failureDiagnostics`
- `stateAndRecovery.publishProtocol`
- `stateAndRecovery.diagnosticRedactionPolicy`
- `libraryContract.buildAlgorithm.incrementalRefresh`
- 对应的质量门、manifest schema 和测试合同扩展。

这些修订保持单书 hotplug package 权威边界不变，仍把书架与 library 索引限定
为 `graph_vault/catalog/**` 下的可重建派生索引。

## 第二轮

目录：`design-turn_002/`

结果：

- `agent-01`: pass，D01-D10 全项通过。
- `agent-02`: pass，D01-D10 全项通过。
- `agent-03`: pass，D01-D10 全项通过。

第二轮复审确认第一轮小建议已补齐。未发现 `fail` 项。

## 第三轮

目录：`design-turn_003/`

触发问题：

- 用户通常按单书包处理，书架成员如何组织。
- 用户自定义、图书馆分类法、规则分类和 LLM 自动聚类的权威关系。
- LLM 自动聚类是否会污染 query-ready 书架。
- 单个书架规模上限。
- 超大类别如何拆成多个书架。
- 虚拟书架与物化书架如何区分。

设计补充：

- `membershipPolicy` 合同。
- `user_membership_authority` 硬不变量。
- `bounded_bookshelf_size` 硬不变量。
- 用户显式、规则、图书馆分类、LLM 建议、用户接受建议、混合策略的
  权威等级。
- `membership_decisions.jsonl` 审计记录。
- 用户 lock include/exclude 的冲突优先级。
- 物化书架 soft/hard 成员上限。
- 超大类别转为虚拟父书架和多个物化子书架。
- LLM suggestion gate 与 promotion rules。
- library 虚拟父书架展开和 direct book limit。

结果：

- `agent-01`: pass_with_minor_notes，D06 提出质量门显式 check id 小建议。
- `agent-02`: pass，D01-D10 全项通过。
- `agent-03`: pass，D01-D10 全项通过。

第三轮未发现 `fail` 项。D06 小建议要求把 membership authority、
`queryReadyAllowed`、LLM suggestion 不可 query-ready、用户 lock、超大类拆分
和虚拟父书架不直接索引显式落到质量门和 check id。

## 第四轮

目录：`design-turn_004/`

设计补强：

- `qualityGates.bookshelfGate.requiredChecks` 增加 membership decision schema、
  authority order、用户 lock、LLM suggestion、接受记录、超大类拆分、虚拟
  父书架不直接索引。
- `qualityGates.libraryGate.requiredChecks` 增加虚拟父书架展开、direct book
  limit 和 library partition 检查。
- `qualityGates.membershipChecks.checkIds` 定义稳定 membership check id。
- `testContracts.requiredCases` 增加 `membership_decisions` fixture。
- `llmSuggestionGate.redactionRule` 明确 proposedRationale 必须是 bounded
  redacted summary。

结果：

- `agent-01`: pass，D01-D10 全项通过，第三轮 D06 minor note resolved。
- `agent-02`: pass，D01-D10 全项通过。
- `agent-03`: pass，D01-D10 全项通过。

第四轮复审确认书架组织策略、规模治理、虚拟书架、LLM 建议门、membership
质量门和测试合同均满足固定基准。未发现 `fail` 项。

## 最终结论

设计审计通过。

## 第五轮

目录：`design-turn_005/`

触发问题：

- 书包、书架和 library 的处理管道是否清楚定义了每个环节输入输出。
- 用户以单书包为基本处理与传播单位时，书架和 library 如何只消费已验证
  包产物并保持 fail-closed。

历史修订结果：

- 当时曾新增：
  `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`
- 后续已合并回：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- pipeline I/O 合同定义 7 个阶段：
  `book_package_publish`、`book_mount_projection`、
  `bookshelf_membership_resolution`、`materialized_bookshelf_graph_build`、
  `library_membership_resolution`、`library_graph_build`、
  `scoped_query_execution`。
- 每个阶段均定义 `requiredInputs`、`forbiddenInputs`、`emittedOutputs`、
  `qualityGate`、`stateWrites`、`failureOutputs` 和 `nextStageInputs`。
- 新增 `handoffMatrix`，明确 stage gate、stale/running/failed 产物阻断、
  publish marker 和下游可消费边界。

结果：

- `agent-01`: pass，D01-D10 全项通过。
- `agent-02`: pass，D01-D10 全项通过。
- `agent-03`: pass，D09 提出非阻断错误码命名对齐建议。

修订闭环：

- 将 pipeline I/O 的 `scope_not_found` 修正为主查询合同中的
  `missing_scope` 与 `ambiguous_scope`。
- 在 pipeline I/O 测试合同中增加 scoped query failure code 与主 typed
  query error 合同一致性检查。
- 第五轮没有 `fail` 项，D09 minor note 已修正。

## 第六轮

目录：`design-turn_006/`

目的：

- 对第五轮 D09 minor note 修正后的最终设计集复审。
- 确认 pipeline I/O 合同、主查询 typed error 合同和 final summary 状态一致。
- 确认书包、书架、library 每个处理环节的输入输出合同在故障反例下仍
  fail closed。

结果：

- `agent-01`: pass，D01-D10 全项通过，确认 `scope_not_found` 已移除并
  对齐为 `missing_scope` / `ambiguous_scope`。
- `agent-02`: pass，D01-D10 全项通过，确认 7 个 pipeline stage 字段完整，
  `handoffMatrix` 可阻断 stale、running、failed 产物。
- `agent-03`: pass，D01-D10 全项通过，确认单书包复制、qmd index 缺失、
  GraphRAG 中断、LLM suggestion 未接受、超大分类拆分、虚拟父书架、
  library direct book 超限、删除 catalog 上层索引和 stale member manifest
  等反例均 fail closed 且诊断可恢复。

第六轮未发现 `fail` 或 `minor_note` 项。

## 接地性评估

历史补充文档：

- `docs/architecture/graphrag-hierarchical-library-grounding-review.type-dd.yaml`

该文档后续已合并回：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

结论：

- 设计没有脱离既有单书 hotplug package 基础。现有代码已经支持单书包发布、
  包内 qmd index、包内 GraphRAG output、catalog book/qmd/capability 投影、
  单书 `--graph-book-id` GraphRAG 查询、query timing 和 provider metrics。
- 书架和 library 的 manifest、membership resolver、upper semantic artifacts、
  builder、quality gate、CLI scope 与 upper typed errors 仍是新能力。
- 主设计已补充 `implementationGrounding`、`pipelineIoContract`、
  `implementationGroundingReview` 和 `currentImplementationStatus`，明确
  already supported、direct extension 和 new capability 的边界。
- 后续实现必须从独立 upper-index 模块开始，不得把书架/library 逻辑误并入
  单书包闭包，也不得把 `graph_vault/catalog/batch-runs/**` 当作语义输入。

## 第七轮

目录：`design-turn_007/`

目的：

- 按固定 D01-D10 基准复审接地性修订。
- 确认设计没有把当前代码尚未实现的书架/library 能力误写成已实现能力。
- 确认现有代码基础、直接扩展项、新能力和风险缺口的边界可审计。

结果：

- `agent-01`: pass，D01-D10 全项通过，确认 bookshelf/library builder、
  upper CLI scope、`BOOKSHELF_MANIFEST` 和 `LIBRARY_MANIFEST` 均未被误写为
  已实现能力。
- `agent-02`: pass，D01-D10 全项通过，确认现有支撑与缺口标注准确：单书
  hotplug package、qmd index、catalog projection、单书 GraphRAG 查询和 timing
  已有代码基础；`--bookshelf-id`、`--library-id`、`upper_index_*` typed errors、
  upper semantic artifacts 和 builder 仍为待实现能力。
- `agent-03`: pass，D01-D10 全项通过，确认设计能阻断 bookshelf/library
  误读、runner ledger 语义污染，并保持无上层索引时单书可查、上层 fail
  closed。

第七轮未发现 `fail` 或 `minor_note` 项。

## 统一权威文件

为降低阅读和实现入口复杂度，pipeline I/O 合同和接地性审计内容已合并回：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

合并后该文件是书-书架-library 层级 GraphRAG 索引设计的唯一规范性
Type DD。原 companion 文件仅作为历史审计上下文出现在报告中，不再作为
独立规范入口。

本设计可以作为后续实现入口。实现阶段必须继续遵守：

- 单书包 `BOOK_MANIFEST.json` 仍是单书分发与直接查询的包权威。
- 书架与 library GraphRAG 索引是可重建派生物，不进入单书可复制包闭包。
- 交互查询必须使用固定查询预算，不得随书籍数量线性增加 token、LLM 调用
  或隐式全库扫描。
- 构建成本可以随规模增长，但必须具备状态闭环、恢复、质量门和可观测性。
- 上层回答必须保留 evidence lineage，并禁止敏感 payload 进入 manifest、
  索引、质量门或诊断。
