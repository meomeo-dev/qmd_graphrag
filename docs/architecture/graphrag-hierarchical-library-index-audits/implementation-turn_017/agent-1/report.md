**Result**

PASS_WITH_RISK. 当前工作区已闭合 implementation-turn_016 agent-2 的
required fixes：upper scope capability 已改为 scope-level `graph_query`，
route/evidence capability id 已对齐；query-time validator 已重新校验实际
parquet row counts 与 fixed budget；CLI controlled deepening 已覆盖默认关闭、
显式开启、预算超限和缺 member book capability；bookshelf 与 library 均已有
10/100/1000 规模 fixed-budget 覆盖。

本轮风险不阻断当前实现审计：真实外部 provider smoke 仍未在本轮执行，LLM
synthesis 仍是 Type DD 明确保留的 remaining capability，membership repair /
incremental refresh lifecycle 仍不是当前闭环范围。

**Scope**

- 唯一规范设计入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 对照历史失败项：
  `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_016/agent-2/report.md`
- 实现审计范围：
  `src/graphrag/upper-index/**`、`src/cli/qmd.ts`、相关 GraphRAG / CLI /
  hotplug / vsearch 测试。
- 未修改实现代码；未修改历史 `design-turn_*` 或 `implementation-turn_016`
  报告。

**Evidence**

- `src/graphrag/upper-index/upper-query-capability.ts` 定义
  `upperGraphQueryCapability`，返回单个 scope-level capability，`kind` 为
  `graph_query`，`contentHash` 使用 package manifest sha256，artifact locators
  指向 package-local `community_reports.parquet` 与 `evidence_map.parquet`。
- `bookshelf-query.ts` 与 `library-query.ts` 的 capability loader 均返回单个
  scope-level graph query capability；query evidence 的 `graphCapabilityId`
  使用同一 `upperGraphQueryCapabilityId` helper。
- `bookshelf-graph-validator.ts` 与 `library-graph-validator.ts` 在 readiness
  validation 中调用 parquet inspect，并校验实际
  `semantic_units.parquet`、`community_reports.parquet` row count 与质量门
  `artifactRowCounts`、`fixedQueryBudget.maxSemanticUnits` 一致。超预算诊断
  映射为 `budget_exceeded_narrow_scope_required` typed error。
- `src/cli/qmd.ts` 中 `--upper-deepening` 默认 false；
  `--max-deepening-targets` 未配合 `--upper-deepening` 会直接报错；显式开启后
  只通过 selected upper evidence 调用 bounded member book GraphRAG runner。
- `test/cli-graphrag-route.test.ts` 覆盖 CLI 默认不下钻、显式
  `--upper-deepening --max-deepening-targets 1` 只调用一个 member book、
  requested target 超 package budget fail-closed、selected book capability
  缺失 fail-closed。
- `test/graphrag-bookshelf-graph.test.ts` 与
  `test/graphrag-library-graph.test.ts` 覆盖 scope-level graph capability、
  evidence capability id 一致、catalog projection 删除后显式 package 查询仍
  可用、实际 artifact rows 超预算 fail-closed、10/100/1000 规模 fixed-budget
  fingerprint 不变。
- `upper-package-paths.ts` 的 `readQueryReadyPackage` 校验 package root、
  `CURRENT.json`、generation manifest、root manifest、quality gate、
  `PUBLISH_READY.json`、sha256 sidecars 与 ready state；legacy catalog-only
  上层产物返回 `upper_package_migration_required`。
- 验证命令：
  - `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
    通过。
  - Type DD 与固定审计基准 YAML parse 通过。
  - `test/graphrag-controlled-deepening.test.ts`：5 tests passed。
  - `test/graphrag-bookshelf-graph.test.ts`：7 tests passed。
  - `test/graphrag-library-graph.test.ts`：8 tests passed。
  - `test/cli-graphrag-query-scope.test.ts`
    `test/cli-graphrag-route.test.ts`
    `test/cli-graphrag-upper-index-failclosed.test.ts`：32 tests passed。
  - `test/graphrag-book-hotplug-creation-gate.test.ts`
    `test/graphrag-book-hotplug-runtime-gate.test.ts`：10 tests passed。
  - `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`：
    1 test passed。
- 一次合并运行
  `test/graphrag-controlled-deepening.test.ts`
  `test/graphrag-bookshelf-graph.test.ts`
  `test/graphrag-library-graph.test.ts`
  因 420 秒外层 command timeout 中断；已按文件拆分重跑并全部通过。

**D01-D10 Table**

| ID | Result | Evidence / Rationale |
|---|---|---|
| D01_authority_boundaries | PASS | 单书包权威仍由 book package manifest/gate/publish marker 管理；上层查询从 `bookshelves/**` 与 `library/**` package root 读取；测试断言上层 manifest 不写入单书包，catalog projection 删除不影响显式 upper package 查询。 |
| D02_fixed_query_budget | PASS | query path 使用 fixed `maxReports`、`maxInputTokens`、`maxSemanticUnits` 与 controlled deepening target budget；validator 重新检查实际 parquet rows；bookshelf/library 10/100/1000 scale 测试证明 query budget fingerprint 不随规模线性增长。 |
| D03_graphrag_semantic_alignment | PASS | 上层 build/query 消费 community reports、semantic units、semantic edges、evidence map；测试覆盖 relation type allowlist 与 fixed-budget report search。 |
| D04_evidence_traceability | PASS | query evidence 暴露 bookId、sourceId、documentId、contentHash、text unit / community report lineage；library 测试覆盖 unknown placeholder 拒绝；scope-level graph capability id 与 evidence 已一致。 |
| D05_state_recovery | PASS | `readQueryReadyPackage` 校验 `CURRENT.json`、generation、manifest sha、quality gate、`PUBLISH_READY.json`；failed/staging/pending/running CURRENT 被 CLI typed error 拒绝。 |
| D06_quality_gates | PASS | bookshelf/library quality gate required checks 被 validator 复核；gate sidecar、manifest file closure、actual row counts、sensitive scan 与 budget simulation 均有测试覆盖。 |
| D07_incremental_scaling | PASS_WITH_RISK | manifest 记录 member manifest sha / generation，stale member 会 fail-closed；当前仍以保守 rebuild 为主，自动 repair 与细粒度 incremental refresh 未作为本轮完成能力。 |
| D08_security_privacy | PASS | upper validator 检测 provider payload / sensitive text；locators 使用 package-relative path；测试确认输出不包含本地 graph vault 绝对路径。 |
| D09_cli_operability | PASS | CLI scope 互斥、legacy migration、missing/stale/failed gate、budget exceeded、runtime error 均映射 typed error；timingAvailable 字段与 upper timing stage 保留。 |
| D10_testability | PASS | 覆盖 controlled deepening、capability lineage、row-budget tamper、scale budget、catalog deletion、state fail-closed、hotplug gate、single-book graph route 与 qmd vsearch 非回归。 |

**Findings by Severity**

High: 无。

Medium: 无。

Low:

1. 外部 provider 成功 smoke 仍未完成。
   - Evidence: 本轮验证使用 unit / fixture / fake bridge；未执行真实 provider
     single-book deepening 成功路径。
   - Impact: provider 环境、网络和模型配置问题仍可能在真实运行中暴露。
   - Required fix: 无。本项是残余风险，不阻断当前 package-root upper query
     与 controlled deepening implementation audit。

2. LLM synthesis 仍未实现。
   - Evidence: Type DD `remainingCapabilities` 明确保留
     `LLM synthesis over selected upper semantic units`；当前 query 是
     fixed-budget report search 与显式受控单书下钻。
   - Impact: 当前能力不能声明为完整 LLM 综合回答闭环。
   - Required fix: 无。本项与 Type DD 当前实现边界一致。

**Residual risks**

- 真实外部 provider / network smoke 仍可能因环境、凭据或模型配置失败；不得把
  fixture-only 成功记为真实 provider 通过。
- 当前上层 query bridge 是 bounded report search；后续 LLM synthesis 接入时仍需
  重新审计 token budget、provider payload redaction 和 evidence attribution。
- Membership repair、自动重建与增量 refresh lifecycle 仍需后续合同和测试闭环；
  当前实现只证明 package-root build/query/readiness/stale fail-closed。
- 长期性能仍依赖上层 build 阶段把 reports 限制为 fixed budget；当前新增
  query-time row budget validator 已提供 fail-closed 保护。

**Required fixes**

无。
