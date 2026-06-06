# GraphRAG 层级 Library 索引设计审计报告

审计对象：`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

固定基准：`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

审计轮次：`design-turn_001`

审计 agent：`agent-02`

总体结论：`pass`

## 结论摘要

该设计保持单书热插包权威边界，并把 bookshelf 与 library 明确定义为
可重建 catalog 派生索引。交互查询路径具备固定 top-K、固定 LLM 调用、
固定 token 与固定下钻范围约束；stale 行为默认拒绝查询，并提供状态、
恢复、质量门和 evidence lineage 合同。

未发现 D01-D10 固定基准的硬性失败项。少量维度仍有可实现性细化空间，
主要集中在 entity/relationship 等价语义关系的落地格式、typed error
枚举、以及质量门诊断输出字段。

## D01_authority_boundaries

status: `pass`

判定：设计满足权威边界与热插包隔离要求。

证据：

- `scope.excluded` 明确排除把书架或 library 索引写入单书可复制包文件闭包，
  并排除以全局 catalog 替代单书 `BOOK_MANIFEST.json` 的包权威。
- `hardInvariants.book_package_authority_preserved` 规定单书包权威只能来自
  单书 manifest、`PUBLISH_READY.json`、包内 qmd/GraphRAG/state 产物和质量门。
- `hardInvariants.derived_upper_indexes_only` 规定上层索引缺失、损坏或过期
  不得使有效单书包变成 `not_query_ready`。
- `compatibilityWithHotplugPackages` 规定安装或删除 book package 不自动修改
  ready bookshelf/library generation，直接单书查询仍由单书 gate 管理。

说明：该维度的三个通过条件均被设计中的硬不变量（hard invariant）覆盖。

## D02_fixed_query_budget

status: `pass`

判定：设计满足固定查询预算要求。

证据：

- `queryContract.interactiveBudget.default` 定义 `maxSemanticUnits: 32`、
  `maxBookshelves: 4`、`maxBooksForDeepening: 3`、`maxMemberCommunityRefs: 24`、
  `maxLlmCalls`、`maxInputTokens` 与 `maxOutputTokens`。
- `hardInvariants.fixed_interactive_query_cost` 禁止交互查询把全部成员书
  `community_reports` 作为 prompt 输入，也禁止按成员书数量创建不受限 map 调用。
- `queryContract.retrieval.firstStage` 和 `secondStage` 均绑定固定预算字段。
- `queryContract.interactiveBudget.rule` 规定 evidence 不能放入 active budget 时
  必须 fail closed 或要求收窄 scope。
- `queryContract.modes.exhaustive_report` 把全量扫描限定为后台 durable report，
  不属于 interactive query path。

说明：该设计把固定成本约束放在术语、硬不变量、查询合同和测试合同多个层面。

## D03_graphrag_semantic_alignment

status: `pass_with_minor_notes`

判定：设计总体贴近 GraphRAG 语义，但 entity/relationship 的上层持久化形态仍可
进一步明确。

证据：

- `scope.included` 规定上层索引基于单书 GraphRAG `community_reports`、
  `entities`、`relationships` 与 qmd 索引派生。
- `hierarchyModel.levels.book.sourceInputs` 包含 `community_reports.parquet`、
  `entities.parquet`、`relationships.parquet` 与 `text_units.parquet`。
- `bookshelfContract.buildInputs.graphInputs` 包含 community report title/summary/rank、
  entity titles/descriptions、relationship summaries。
- `buildAlgorithm.steps` 在 bookshelf 层生成 bookshelf community reports，并在
  library 层生成 library-level community reports。
- `queryContract.synthesis.rule` 规定最终回答来自 selected upper-level community
  reports 与可选单书 deepening evidence。

轻微备注：

- bookshelf/library 输出列出了 `semantic_units.parquet`、`communities.parquet`、
  `community_reports.parquet` 与 `evidence_map.parquet`，但未单独规定上层
  `entities`、`relationships` 或等价 semantic edge 表的 schema。当前设计可通过
  `graphInputs` 和关系摘要满足基准，但实现时应避免把关系信息压扁成普通摘要检索。

## D04_evidence_traceability

status: `pass`

判定：设计满足证据可追溯要求。

证据：

- `hardInvariants.evidence_traceability` 规定上层回答中的每个证据必须回链到
  `bookId`、`sourceId`、`documentId`、`contentHash`、单书 community report id
  或 text unit id。
- bookshelf 与 library 输出均包含 `evidence_map.parquet`。
- bookshelf build step 写入从 bookshelf reports 到 member reports/books 的
  `evidence_map`。
- library build step 写入从 library reports 到 shelf reports/book reports 的
  `evidence_map`。
- `qualityGates` 要求 bookshelf evidence map 链接每个 upper unit 到 member
  evidence，并要求 library evidence map 链接每个 unit 到 shelf 与 book evidence。
- `queryContract.synthesis.rule` 要求回答包含 traceable evidence ids，并标明 scoped
  或 non-exhaustive。

说明：该维度被硬不变量、构建步骤、质量门、manifest schema 与查询输出要求共同覆盖。

## D05_state_recovery

status: `pass`

判定：设计满足状态闭环、恢复、stale 检测和 partial publish 防护要求。

证据：

- `stateAndRecovery.ledgerRoots` 为 bookshelf 与 library build 定义 run ledger 根。
- `stateAndRecovery.durableState` 包含 derived manifest、status、append-only
  events、unit checkpoints 与 recovery summary。
- `stateAndRecovery.recoveryRules` 规定完成构建必须有 checkpoint、manifest、
  quality gate 和 publish marker。
- 失败 semantic unit generation 不会发布 ready upper index。
- 中断构建从 validated checkpoints 恢复。
- stale member manifest 会在 query use 前标记 upper index stale。
- `compatibilityWithHotplugPackages.staleBehavior` 规定 stale upper index 对上层查询
  呈现为 `stale_not_query_ready`，默认查询拒绝 stale index。

说明：状态闭环和 stale 默认拒绝是该设计的强项。

## D06_quality_gates

status: `pass_with_minor_notes`

判定：设计满足独立质量门要求，但诊断输出的字段可进一步合同化。

证据：

- `qualityGates.bookshelfGate` 定义 bookshelf 独立 gate 路径和 required checks。
- `qualityGates.libraryGate` 定义 library 独立 gate 路径和 required checks。
- 两层 gate 均覆盖 manifest schema、checksum sidecars、成员一致性、schema 校验、
  evidence map、embedding/vector metadata、fixed query budget simulation、
  sensitive payload scan 与 stale marker。
- `stateAndRecovery.recoveryRules` 规定 build completion 需要 quality gate 和
  publish marker。
- `queryContract.interactiveBudget.rule` 和 stale 行为共同保证质量门失败或预算不满足
  时不会进入可用查询路径。

轻微备注：

- 基准要求质量门失败时诊断可见。当前设计通过 `status.json`、`events.jsonl`、
  `recovery-summary.json` 和 bounded diagnostics 表达诊断存在，但未规定 gate failure
  diagnostic 的最小字段，例如 failed check id、artifact path、expected digest、
  observed digest、remediation command。建议实现合同时补充。

## D07_incremental_scaling

status: `pass`

判定：设计满足增量扩展要求。

证据：

- `hardInvariants.build_cost_may_scale` 承认构建成本可随规模增长，但要求状态闭环、
  断点恢复、增量刷新、质量门和可观测成本记录。
- `hardInvariants.stable_membership_generation` 要求记录成员集合、member manifest
  sha256、package generation、build config 和 index schema；成员变化生成新
  generation 或标记 stale。
- `bookshelfContract.identity.generationRule` 和 `libraryContract.identity.generationRule`
  规定 manifest sha256、builder version、embedding fingerprint、clustering config、
  summary config、evidence schema 变化都会变更 generation。
- `bookshelfContract.buildAlgorithm.incrementalRefresh` 允许只重建受影响 semantic units
  和 derived communities；无法以 checksum 证明未变时保守重建 shelf generation。
- `libraryContract.directBookRule` 要求大型 library 通过 bookshelves 分组，以限制刷新
  影响范围。

说明：该设计在成员 fingerprint、generation 和 bookshelf 分层三个层面覆盖扩展风险。

## D08_security_privacy

status: `pass`

判定：设计满足安全与隐私要求。

证据：

- `hardInvariants.no_sensitive_payload_export` 禁止 provider payload、原始 prompt、
  原始 completion、密钥、用户绝对路径和运行期 `query.log` 进入上层 manifest、
  索引、质量门和诊断。
- `bookshelfContract.buildInputs.forbiddenInputs` 禁止 provider request/response
  payloads、query logs、local absolute paths 和 unvalidated damaged packages。
- bookshelf 与 library manifest schema 均要求 `sensitivityPolicy`。
- bookshelf 与 library 质量门均包含 `sensitive payload scan passes`。
- `testContracts.requiredCases` 包含敏感扫描拒绝 provider payloads 和 query logs
  进入 upper manifests。

说明：该维度覆盖面充分，且测试合同中包含非回归要求。

## D09_cli_operability

status: `pass_with_minor_notes`

判定：设计满足 CLI 可操作性与降级基准，但 typed error 枚举可进一步明确。

证据：

- `queryContract.routing.scopeResolutionOrder` 定义 explicit book、explicit bookshelf、
  explicit library、configured default library、fast ambiguity error with candidates 的
  scope resolution order。
- `queryContract.routing.noImplicitFullVaultScan` 禁止无 scope 查询在 query path 中
  rebuild all books/shelves/library indexes。
- `hardInvariants.bounded_degradation` 要求上层索引不可用时 CLI 快速返回 typed error、
  回退建议或要求明确 scope，避免长时间全库扫描后失败。
- `compatibilityWithHotplugPackages.staleBehavior` 规定 stale upper index 默认拒绝查询，
  并提供 rebuild/status commands。
- `implementationPlan.phase2` 和 `testContracts.requiredCases` 要求 timing/cost accounting
  可分解到 retrieval、synthesis、optional deepening 与 evidence merge。

轻微备注：

- 设计已经要求 typed error，但未列出稳定错误码集合，例如
  `missing_scope`、`ambiguous_scope`、`stale_upper_index`、`missing_upper_index`、
  `budget_exceeded`。建议在 CLI 合同中补足错误码、退出码和机器可读输出字段。

## D10_testability

status: `pass`

判定：设计满足可测试性要求。

证据：

- `testContracts.requiredCases` 定义 10 个必测案例，超过基准要求的至少 8 个。
- 必测案例包含 10、100、1000 books 模拟下的 fixed top-K 验证。
- 必测案例包含删除 catalog upper indexes 后 single-book query 仍成功，以及删除 book
  只标记依赖 shelf/library stale、不修改 book。
- 必测案例覆盖 stale 默认拒绝、member package gate fail closed、evidence_map、
  sensitive scan、interrupted build 恢复、interactive/exhaustive 分离和分层 timing。

说明：测试合同覆盖正确性、成本边界、恢复、证据、安全和热插兼容。

## 重点关注项结论

- 固定查询成本（fixed query cost）：通过。查询合同限制 semantic units、bookshelves、
  deepening books、member community refs、LLM calls 和 tokens，并对超预算 fail closed。
- GraphRAG 语义对齐（semantic alignment）：通过但需实现细化。设计使用
  community reports、entities、relationships 和 map-reduce/equivalent，但建议补充上层
  semantic edge 持久化 schema。
- 状态恢复（state recovery）：通过。run ledger、events、checkpoints、status、
  recovery summary、publish marker 与质量门构成闭环。
- stale 行为（stale behavior）：通过。成员变化会标记 stale，默认上层查询拒绝 stale
  index，显式允许时才可读 previous generation。
- 证据追溯（evidence traceability）：通过。硬不变量、evidence_map、质量门和回答输出
  均要求可追溯 lineage。

## 建议修订项

1. 在实现合同中补充上层语义关系（semantic relationship）持久化 schema，或明确
   `semantic_units.parquet`/`communities.parquet` 中保存 entity 与 relationship 的字段。
2. 为质量门失败诊断定义最小机器可读字段，确保 `status.json`、`events.jsonl` 和
   `recovery-summary.json` 能被 CLI 与测试稳定消费。
3. 为 CLI typed errors 定义稳定错误码、退出码、用户提示字段和 remediation command。

