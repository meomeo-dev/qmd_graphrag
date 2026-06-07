# implementation-turn_016 / agent-3 审计报告

## Result

PASS

## Scope

- 规范源：`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`。
- 固定基线：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`。
- 实现范围：`library-graph-contracts.ts`、`library-graph.ts`、
  `library-query.ts`、`upper-catalog-projection.ts`、`controlled-deepening.ts`、
  `src/cli/qmd.ts` 与相关测试。
- 审计方式：只读审计（read-only audit），未修改文件。
- 重点：design-turn_016 后 library 受控下钻目标上限必须使用 `maxBookshelves`，
  不得使用历史未定义字段 `maxBookshelvesForDeepening`。

## Evidence

- Type DD 当前预算定义包含 `maxBookshelves: 4` 与 `maxBooksForDeepening: 3`；
  `maxBookshelvesForDeepening` 仅出现在 design-turn_015 问题回顾等历史审计说明中。
- `src/graphrag/upper-index/library-graph-contracts.ts:37-45` 与 `:115-121`
  将 library 质量门和 manifest schema 统一为 `maxBookshelves`，未定义
  `maxBookshelvesForDeepening`。
- `src/graphrag/upper-index/library-graph.ts:374` 默认 `maxBookshelves = 4`，
  `:461-467` 用其生成固定预算模拟，`:679-685` 写入
  `manifest.fixedQueryBudget.maxBookshelves`。
- `src/graphrag/upper-index/upper-catalog-projection.ts:96-101` 与 `:352-357`
  将 library catalog projection 的预算字段投影为 `maxBookshelves`，catalog
  仍标记 `catalogIsAuthority: false`。
- `src/graphrag/upper-index/library-query.ts:421-435` 将
  `scope.manifest.fixedQueryBudget.maxBookshelves` 传给 `applyControlledDeepening()`
  的 `maxDeepeningTargets`。
- `src/graphrag/upper-index/controlled-deepening.ts:310-339` 保持默认关闭，并拒绝
  大于 package budget 的请求；`:341-345` 仅从 upper response evidence 中选目标；
  `:364-383` 缺失单书 capability 时 fail closed；`:386-453` 才调用注入的单书
  GraphRAG runner 并合并证据。
- `src/cli/qmd.ts:3560-3567` 拒绝未启用 `--upper-deepening` 时使用
  `--max-deepening-targets`；`:3680-3716` 与 `:3761-3797` 仅在显式启用时注入
  单书 runtime。
- `test/graphrag-controlled-deepening.test.ts:137-302` 覆盖默认关闭、预算收窄、
  超预算 fail-closed、缺 capability fail-closed、library 按 selected bookshelf
  target 去重。
- Type DD `postImplementationTurn016LocalAdditions` 将 implementation-turn_016 状态
  保留为 `pending`，并明确真实外部 provider 成功路径未执行。
- 验证命令：`npm run test:types` 通过；受控下钻单测 5/5 通过；CLI scope helper
  单测 8/8 通过。较大的目标测试组合在 180 秒超时，未作为通过证据引用。

## D01-D10 Verdicts

- D01_authority_boundaries: PASS。查询读取 package-local CURRENT、manifest、
  PUBLISH_READY 和 quality gate；catalog projection 不作为权威。
- D02_fixed_query_budget: PASS。library 受控下钻 cap 使用 `maxBookshelves`；
  `--max-deepening-targets` 只能收窄，不能放宽。
- D03_graphrag_semantic_alignment: PASS。上层查询仍基于 community reports、
  semantic units、semantic edges 与 evidence map；下钻只是可选增强。
- D04_evidence_traceability: PASS。upper evidence 与 deepening evidence 保留
  `bookId`、`sourceId`、`documentId`、`contentHash`、report/text-unit lineage。
- D05_state_recovery: PASS。构建仍走 staging、generation、CURRENT、publish gate；
  controlled deepening 是查询期只读行为，不发布新状态。
- D06_quality_gates: PASS。bookshelf/library 独立质量门与固定预算模拟仍存在；
  查询前重新校验 package-local readiness。
- D07_incremental_scaling: PASS。manifest sha、generation 与成员边界保留；当前
  实现允许保守重建，未扩大交互查询规模。
- D08_security_privacy: PASS。manifest、projection、diagnostics 和 evidence locator
  继续使用脱敏/相对路径策略，未发现 provider payload 进入上层发布 schema。
- D09_cli_operability: PASS。CLI 覆盖 scope 冲突、legacy catalog-only、
  missing/stale/gate/runtime/budget typed errors，并暴露受控下钻选项。
- D10_testability: PASS。关键 controlled deepening 行为已有单测覆盖；本轮未把
  超时的组合测试误报为通过。

## Findings

- 阻断性发现：无。
- 非阻断观察：历史 implementation-turn_015 retained risk 中仍有
  “controlled deepening remains future” 语句，但其位于历史轮次段落，已被
  `postImplementationTurn016LocalAdditions` 的当前状态覆盖。
- 非阻断观察：library controlled deepening 当前按 `targetBookshelfId` 去重并对每个
  选中书架目标调用一个代表性 member book；这与本轮 `maxBookshelves` 目标 cap
  一致，但后续文档应继续区分 bookshelf target cap 与单书下钻 cap
  （book deepening cap）。

## Residual Risks

- 真实外部 provider 下的单书 `--graph-book-id` 与 `--upper-deepening` 成功路径仍未
  执行；当前证据限于 fixture-tested / injectable runner 路径。
- provider timeout 或 runtime failure 仍需保持 typed runtime error，不能静默降级。
- LLM synthesis over selected upper semantic units 仍是未来能力。
- membership 创建、自动 repair、增量 refresh 管理生命周期仍未完成。
- 较大的 CLI/graph 组合测试本轮超时，需在更长超时或分片环境中复跑。

## Required Fixes

无。
