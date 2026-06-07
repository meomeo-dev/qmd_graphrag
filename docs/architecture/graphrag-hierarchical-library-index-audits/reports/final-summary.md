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

## 第十一轮

目录：`design-turn_011/`

触发问题：

- 用户指出 bookshelf 与 library 不应作为 `graph_vault/catalog/**` 下的权威
  package closure。
- `graph_vault/catalog/**` 应保持 projection、capability、默认 scope、路由
  索引和观测职责。
- bookshelf 与 library 需要像单书包一样可复制传播，权威根应分别位于
  `graph_vault/bookshelves/{bookshelfId}` 与 `graph_vault/library/{libraryId}`。

结果：

- `agent-1`: fail，指出 D01、D05、D07、D09、D10 不满足新增目录权威约束。
- `agent-2`: fail，指出 D01、D05、D06、D09、D10 不满足新增目录权威约束。
- `agent-3`: fail，指出 D01、D05、D06、D09、D10 不满足新增目录权威约束。

修订闭环：

- Type DD 将 bookshelf authority root 改为
  `graph_vault/bookshelves/{bookshelfId}`。
- Type DD 将 library authority root 改为
  `graph_vault/library/{libraryId}`。
- `graph_vault/catalog/**` 被限定为 projection、capability、默认 scope、
  路由索引和观测状态，不拥有上层包闭包。
- 新增 package-local `CURRENT.json`、`PUBLISH_READY.json`、quality gate、
  generations、staging 和 runs 闭环。
- 新增 `upper_package_migration_required` typed error，阻断 legacy
  catalog-only upper artifacts 被误判为 query-ready。
- UNDO prompt 已同步新上层包目录和恢复规则。

## 第十二轮

目录：`design-turn_012/`

目的：

- 按固定 D01-D10 基准复审上层包目录权威修订。
- 确认 catalog 不再承载 bookshelf/library authority root、quality gate、
  runs、publish marker 或 current generation。
- 确认显式 package scope 查询、legacy catalog-only fail closed、删除 catalog
  projection 不影响显式上层包查询，以及复制传播测试合同均已定义。

结果：

- `agent-1`: pass，D01-D10 全项通过。
- `agent-2`: pass，D01-D10 全项通过。
- `agent-3`: pass，D01-D10 全项通过。

第十二轮未发现阻断项。3 个 agent 均确认修订后的 Type DD 满足固定 D01-D10
设计审计基准。

## 第十三轮

目录：`design-turn_013/`

目的：

- 按固定 D01-D10 基准再次复审当前 Type DD。
- 确认 bookshelf 与 library 仍以 package root 作为权威边界。
- 确认 `graph_vault/catalog/**` 仍仅承担 projection、capability、默认
  scope、路由索引和观测状态。
- 确认 legacy catalog-only upper artifacts 仍必须通过
  `upper_package_migration_required` fail closed。
- 确认 Type DD 未把 catalog projection generation、LLM synthesis、
  controlled deepening、library 管理命令或真实 provider 验证误写为已完成。

结果：

- `agent-1`: pass，D01-D10 全项通过。
- `agent-2`: pass，D01-D10 全项通过。
- `agent-3`: pass，D01-D10 全项通过。

第十三轮未发现阻断项。3 个 agent 均确认当前 Type DD 满足固定 D01-D10
设计审计基准，且没有 required design changes。

## 第十四轮

目录：`design-turn_014/`

目的：

- 按固定 D01-D10 基准复审 catalog projection 当前状态更新后的 Type DD。
- 确认 query-ready bookshelf/library package publish 后生成的 catalog
  projection 仍是非权威派生视图。
- 确认显式 `--bookshelf-id` 与 `--library-id` 查询仍先校验 package-local
  `CURRENT.json`、manifest、`PUBLISH_READY.json` 和 quality gate。
- 确认 Type DD 未把 LLM synthesis、controlled deepening、library 管理命令、
  真实 provider 单书验证或 implementation-turn_013 误写为已完成。

结果：

- `agent-1`: pass，D01-D10 全项通过。
- `agent-2`: pass，D01-D10 全项通过。
- `agent-3`: pass，D01-D10 全项通过。

第十四轮未发现阻断项。3 个 agent 均确认当前 Type DD 满足固定 D01-D10
设计审计基准。历史 implementation-turn_011/012 retained risks 中的
`catalog projection generation remains future` 是当时状态记录；当前状态以
`implementationGrounding`、`pipelineIoContract.currentImplementationStatus` 和
`postImplementationTurn013` 为准。

## 当前最终结论

设计审计通过。当前最新通过轮次为 `design-turn_014`。

唯一规范性设计入口仍为：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

当前通过版本的目录权威边界为：

- 单书包权威根：`graph_vault/books/{bookId}`。
- 书架上层包权威根：`graph_vault/bookshelves/{bookshelfId}`。
- Library 上层包权威根：`graph_vault/library/{libraryId}`。
- Catalog：`graph_vault/catalog/**` 仅作为 projection、capability、默认
  scope、路由索引和观测状态。
- Query-ready 上层包发布后可生成 catalog projection；该 projection 不拥有
  manifest、quality gate、publish marker 或 query-ready 权威。

## 实施审计 implementation-turn_009

目录：`implementation-turn_009/`

目的：

- 审计 design-turn_012 后的 package-root 上层包实现。
- 确认 bookshelf 与 library 不再把 `graph_vault/catalog/**` 当作包闭包。
- 确认 legacy catalog-only 上层产物返回
  `upper_package_migration_required` typed error。

结果：

- `agent-1`: `PASS_WITH_RISK`
- `agent-2`: `PASS_WITH_RISK`
- `agent-3`: `PASS_WITH_RISK`

主控后续修复：

- 脚本文案从 catalog id 改为 package id。
- `readQueryReadyPackage()` 增加 `CURRENT.json.sha256`、current generation
  路径、query-ready `readyState`、root/generation quality gate sidecar 和
  内容一致性、`PUBLISH_READY` 路径一致性检查。
- 测试补充删除 catalog projection 后显式 bookshelf/library package 查询仍
  成功。
- 测试补充 bookshelf running 与 library pending `CURRENT.json` 指针
  fail-closed 反例。

验证结果：

- TypeScript build check 通过。
- bookshelf graph、library graph、membership、CLI scope、CLI route、
  upper-index fail-closed、单书 hotplug/runtime gate、capability scope、
  timeout 和 qmd vsearch 目标回归均通过。

当前状态：

- package-root 最小可运行闭环已实现并通过目标测试。
- 本轮正式 agent 报告仍为 `PASS_WITH_RISK`；硬化后已进入
  `implementation-turn_010` 三代理复审。
- 单书 `--graph-book-id` 真实 provider 成功回答仍受外部 runtime/provider
  条件约束，本轮只验证 typed timeout 与既有单书包质量门非回归。

详细报告：

- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-009-summary.md`

## 实施审计 implementation-turn_010

目录：`implementation-turn_010/`

目的：

- 复审 implementation-turn_009 后的 package-root 查询准备校验硬化。
- 确认 `CURRENT.json.sha256`、root/generation manifest、root/generation
  quality gate、`PUBLISH_READY.json` 与 sidecar 均进入 query-ready 闭环。
- 审计删除 catalog projection 后显式上层 package 查询、legacy catalog-only
  typed error、运行中/待发布/stale 指针 fail-closed 和固定预算查询。

结果：

- `agent-1`: `PASS_WITH_RISK`
- `agent-2`: `PASS_WITH_RISK`
- `agent-3`: `PASS_WITH_RISK`

本轮必须修复项：

- F-001：在通用 upper package path 层统一拒绝非法上层 scope id，防止
  `..`、路径分隔符、URI scheme 或 Windows drive 破坏 package root 闭包边界。
- F-002：library evidence bridge 不得在下层 evidence 缺失时写入
  `unknown-*` 占位值；build 与 inspect/validator 必须 fail closed。

主控审计后修复：

- `upper-package-paths.ts` 新增 `assertSafeUpperScopeId()`，所有 package root、
  legacy root 和 locator 生成均调用统一校验。
- `library_graph_bridge_build.py` 在缺失或不可追溯下层 evidence 时返回失败
  diagnostics，不生成占位 lineage。
- `bookshelf_graph_bridge_inspect.py` 拒绝 `evidence_map.parquet` 中缺失字段或
  `unknown-*` lineage。
- bookshelf/library 上层查询 runtime metrics 改为记录真实 bridge elapsed time。
- 补充非法 scope id、缺失下层 evidence 和 `unknown-*` published artifact
  fail-closed 测试。

审计后验证：

- TypeScript build check 通过。
- CLI query scope、bookshelf graph、library graph、bookshelf/library
  membership、CLI route、upper-index fail-closed、单书 runtime gate、
  capability scope 和 qmd vsearch 目标回归均通过。

当前状态：

- implementation-turn_010 的正式 agent 报告仍为 `PASS_WITH_RISK`。
- F-001、F-002 与 runtime metrics 修复发生在 agent 报告之后，不能把
  implementation-turn_010 记为最终无风险通过。
- 这些审计后修复已由 `implementation-turn_011` 三代理复审确认闭环；
  整体状态仍为 `PASS_WITH_RISK`。

详细报告：

- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-010-summary.md`

## 实施审计 implementation-turn_011

目录：`implementation-turn_011/`

目的：

- 复审 implementation-turn_010 后的 F-001、F-002 和 runtime metrics 修复。
- 确认非法上层 scope id 在通用 package path 层 fail closed。
- 确认 library evidence bridge 与 parquet inspect 拒绝缺失或 `unknown-*`
  lower lineage。
- 确认 bookshelf/library 上层 query runtime metrics 使用真实 bridge elapsed time。
- 确认文档没有把 implementation-turn_010 的 `PASS_WITH_RISK` 误写成最终无风险通过。

结果：

- `agent-1`: `PASS_WITH_RISK`
- `agent-2`: `PASS_WITH_RISK`
- `agent-3`: `PASS_WITH_RISK`

本轮必须修复项：

- 无。

复审确认：

- F-001 已闭环：`upper-package-paths.ts` 统一拒绝非法 bookshelf/library scope id。
- F-002 已闭环：缺失或 `unknown-*` evidence lineage 不再进入可发布 upper index。
- runtime metrics 已闭环：bookshelf/library query response 使用 measured bridge
  elapsed time，不再固定为 `0`。
- Type DD、turn_010 summary 和 final summary 均保留 implementation-turn_010
  `PASS_WITH_RISK` 状态，没有改写成无风险通过。

当前状态：

- package-root 最小可运行闭环、F-001、F-002 与 runtime metrics 修复均已通过
  三代理复审。
- 整体 implementation-turn_011 当时仍是 `PASS_WITH_RISK`，因为真实外部
  provider 条件下的单书 `--graph-book-id` 成功回答未执行，且
  failed/staging 全状态枚举 CLI fixture 当时仍不完整。该 fixture 覆盖已在
  implementation-turn_012 复审闭环。
- catalog projection 生成、LLM synthesis、受控下钻和 library 管理命令仍属
  后续能力，不得误写为已完成。

turn_011 后本地补强：

- `test/cli-graphrag-route.test.ts` 已新增显式 `--bookshelf-id` 与
  `--library-id` 的 failed/staging `CURRENT.json` CLI fail-closed fixtures。
- 补强后 `cli-graphrag-route` 完整回归通过，当前为 19 个测试。
- 该补强发生在 implementation-turn_011 agent 报告之后，需由
  `implementation-turn_012` 三代理复审确认后才能从审计风险中移除。

详细报告：

- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-011-summary.md`

## 实施审计 implementation-turn_012

目录：`implementation-turn_012/`

目的：

- 复审 implementation-turn_011 后新增的 failed/staging CLI fixture 覆盖。
- 确认 explicit `--bookshelf-id` 与 `--library-id` 在 `CURRENT.json` 为
  failed/staging 时均 fail closed。
- 确认即使 `queryReady: true` 被误置，只要 `readyState` 不是 query-ready，
  查询仍返回 `upper_quality_gate_failed:current_ready_state_mismatch`。
- 确认 package-root authority、legacy catalog-only migration error、F-001、
  F-002 和 runtime metrics 修复未回退。

结果：

- `agent-1`: `PASS_WITH_RISK`
- `agent-2`: `PASS_WITH_RISK`
- `agent-3`: `PASS_WITH_RISK`

本轮必须修复项：

- 无。

复审确认：

- failed/staging CLI fixture 已覆盖 bookshelf failed、bookshelf staging、
  library failed 和 library staging 四个组合。
- 这些 fixture 在 semantic query bridge 启动前 fail closed，返回 exit code
  `65`、typed error `upper_quality_gate_failed` 和 diagnostic
  `current_ready_state_mismatch`。
- failed/staging CLI fixture 覆盖风险已闭环。

当前状态：

- package-root 最小可运行闭环、F-001、F-002、runtime metrics 修复和
  failed/staging CLI fixture 覆盖均已通过三代理复审。
- 整体 implementation-turn_012 仍是 `PASS_WITH_RISK`，因为真实外部 provider
  条件下的单书 `--graph-book-id` 成功回答未执行。
- catalog projection 生成、LLM synthesis、受控下钻和 library 管理命令仍属
  后续能力，不得误写为已完成。

详细报告：

- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-012-summary.md`

## 实施审计 implementation-turn_013

目录：`implementation-turn_013/`

目的：

- 复审 query-ready bookshelf/library package 发布后生成非权威 catalog
  projection 的最小实现。
- 确认 projection 只能从 package-local `CURRENT.json`、manifest、
  `PUBLISH_READY.json` 和 quality gate 派生，不能自证 query-ready。
- 确认删除 catalog projection 不影响显式 `--bookshelf-id` 与
  `--library-id` package-root 查询。
- 确认 `graph_vault/catalog/**` 不包含 bookshelf/library manifest、quality
  gate、publish marker 或语义包闭包。

结果：

- `agent-1`: `PASS_WITH_RISK`
- `agent-2`: `PASS_WITH_RISK`
- `agent-3`: `PASS_WITH_RISK`

本轮必须修复项：

- 无。

复审确认：

- `upper-catalog-projection.ts` 只从 query-ready 上层包重建 projection。
- bookshelf/library graph builder 均在 package-root `PUBLISH_READY.json`
  写入后重建 projection。
- durable writer 将 bookshelf/library projection 文件映射到
  `catalogWriterLane`，owner 为 `upperCatalogProjection`。
- projection authority 固定 `catalogIsAuthority=false`，catalog 仍只是
  派生视图。

审计后硬化：

- `loadUpperCatalogProjection()` 已补充 `scopeKind/scopeId` 交叉校验。
- `test/graphrag-bookshelf-graph.test.ts` 已新增
  `catalog_projection_scope_mismatch` 回归用例。

当前状态：

- query-ready 上层包 catalog projection 最小闭环已实现并通过三代理复审。
- 整体 implementation-turn_013 仍是 `PASS_WITH_RISK`，因为真实外部 provider
  条件下的单书 `--graph-book-id` 成功回答未执行。
- turn_013 后本地补强已新增 `qmd bookshelf/library status/list/build/rebuild`
  package-root 管理命令薄适配器。该补强在 implementation-turn_014 被审出
  status/list query-ready 误报问题，并在 implementation-turn_015 修复后通过
  三代理复审，当前结论为 `PASS_WITH_RISK`。
- LLM synthesis、controlled deepening、membership 创建、自动 repair 和增量
  refresh 管理生命周期仍属后续能力，不得误写为已完成。

审计后验证：

- TypeScript build check 通过。
- `test/graphrag-bookshelf-graph.test.ts`：5 个测试通过。
- `test/graphrag-library-graph.test.ts`：7 个测试通过。
- `test/cli-graphrag-route.test.ts`：19 个测试通过。
- `test/cli-graphrag-query-scope.test.ts`：8 个测试通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 个测试通过。
- turn_013 后本地补强验证：TypeScript build check 通过；
  `test/cli-graphrag-upper-management.test.ts`：4 个测试通过；
  `test/cli-graphrag-route.test.ts`、`test/cli-graphrag-query-scope.test.ts`
  和 `test/cli-graphrag-upper-index-failclosed.test.ts` 通过。

详细报告：

- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-013-summary.md`

## 实施审计 implementation-turn_014

目录：`implementation-turn_014/`

目的：

- 复审 implementation-turn_013 后新增的 `qmd bookshelf/library`
  `status/list/build/rebuild` package-root 管理命令薄适配器。
- 确认管理命令不把 catalog projection 当作 query-ready 权威。
- 确认 build/rebuild 只从 package-root membership 调用既有 builder/validator。

结果：

- `agent-1`: `PASS_WITH_RISK`
- `agent-2`: `FAIL`
- `agent-3`: `PASS_WITH_RISK`

本轮必须修复项：

- `qmd bookshelf/library status/list` 曾可能把 checksum/sidecar 与
  `PUBLISH_READY.json` 自洽、但 graph manifest 或 quality gate schema 无效的
  上层包误报为 `query_ready`。

当前状态：

- 本轮为失败轮次，不能作为当前通过状态。
- required fix 已由 implementation-turn_015 修复并复审闭合。

## 实施审计 implementation-turn_015

目录：`implementation-turn_015/`

目的：

- 复审 implementation-turn_014 required fix 的修复结果。
- 确认 `getUpperPackageStatus()` 在返回 `query_ready` 前解析 graph manifest 与
  graph quality gate schema，并校验 scope/generation。
- 确认 corrupt-but-checksummed manifest/gate 不再被 status/list 报为 query-ready。

结果：

- `agent-1`: `PASS_WITH_RISK`
- `agent-2`: `PASS_WITH_RISK`
- `agent-3`: `PASS_WITH_RISK`

本轮必须修复项：

- 无。

复审确认：

- `upper-management.ts` 在 `readQueryReadyPackage()` 通过后继续解析
  `BookshelfGraphManifestSchema` / `LibraryGraphManifestSchema` 和
  `BookshelfQualityGateSchema` / `LibraryQualityGateSchema`。
- graph manifest 或 quality gate schema 损坏、scope mismatch 或 generation
  mismatch 时，管理 status/list 返回 `not_query_ready`，不得返回 `query_ready`。
- `test/cli-graphrag-upper-management.test.ts` 覆盖 bookshelf/library 的
  corrupt-but-checksummed manifest/gate 回归。

当前状态：

- 管理命令薄适配器已通过修复后三代理复审，当前为 `PASS_WITH_RISK`。
- 保留风险仍包括真实外部 provider 单书 `--graph-book-id` 成功回答未验证，
  以及 LLM synthesis、controlled deepening、membership 创建、自动 repair 和
  增量 refresh 管理生命周期未完成。

详细报告：

- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-015-summary.md`
