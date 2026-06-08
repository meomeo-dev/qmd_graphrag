# implementation-turn_020 汇总报告

## 结论

总体结论：`PASS`。

三名实施审计代理均依据固定 D01-D10 审计维度完成复审，结论分别为：

- agent-1：`PASS`
- agent-2：`PASS`
- agent-3：`PASS`

本轮无阻断性 required fixes。implementation-turn_019 保留的真实 provider、
query-time synthesis、management lifecycle 风险已在本轮闭合；build-time
LLM-authored community report synthesis、自动调度 repair 和增量 rebuild
planner 仍作为未来能力记录，不属于本轮已实现范围。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 本轮 agent 报告：
  - `implementation-turn_020/agent-1/report.md`
  - `implementation-turn_020/agent-2/report.md`
  - `implementation-turn_020/agent-3/report.md`

## 本轮闭合能力

- 显式 `--upper-synthesis` 查询能力，默认关闭。
- `--max-synthesis-input-tokens` 与 `--max-synthesis-output-tokens` 只能收窄
  package-local fixed budget。
- OpenAI Responses generate 请求体写入 `max_output_tokens`，并在 synthesis
  prompt 中声明 active output budget。
- `qmd bookshelf/library refresh-membership` 只发布 `queryReady=false` 的
  package-root membership generation。
- `qmd bookshelf/library repair` 从 package-root membership 重建 query-ready
  上层包，不把 catalog projection 当作 authority。

## 主控真实运行证据

- `audit-shelf-a` 从 3 本已发布 book package 构建为 query-ready bookshelf
  package。
- `audit-shelf-b` 从 3 本已发布 book package 构建为 query-ready bookshelf
  package。
- `audit-library` 从 2 个 query-ready bookshelf package 构建为 query-ready
  library package。
- 暂时删除 catalog projection 后，显式 `--bookshelf-id` 与 `--library-id` 查询
  均成功，证明 query-ready 权威来自 package root。
- 最新 repaired `audit-library` generation 普通查询成功，timing 包含
  `library.fixed_budget_report_search`。
- 最新 repaired `audit-library` generation 的真实 provider `--upper-synthesis`
  成功，timing 包含 `upper.llm_synthesis`，stdout 不含 prompt 或 provider
  payload。
- 真实 provider `--max-synthesis-output-tokens 200` smoke fail-closed 为
  `budget_exceeded_narrow_scope_required`，证明收窄预算不会被静默放宽。
- 单书 `--graph-book-id book-00474fb29e5e-59d02d41` 真实 provider 查询成功。
- 单书 `book-00474fb29e5e-59d02d41` package gate 与 runtime gate 均通过。

## 主控测试证据

- `npm run test:types`
- `test/graphrag-upper-synthesis.test.ts`
- `test/cli-graphrag-upper-management.test.ts`
- `test/graphrag-bookshelf-graph.test.ts`
- `test/graphrag-library-graph.test.ts`
- `test/cli-graphrag-route.test.ts`
- `test/cli-graphrag-query-scope.test.ts`
- `test/cli-graphrag-upper-index-failclosed.test.ts`
- `test/llm.test.ts` focused OpenAI Responses and `withLLMSession` tests
- `test/integrations/contracts.test.ts` focused Provider contracts
- `test/graphrag-controlled-deepening.test.ts`
- `test/graphrag-bookshelf-membership.test.ts`
- `test/graphrag-library-membership.test.ts`
- Single-book hotplug regression files:
  `test/graphrag-book-hotplug-creation-gate.test.ts`,
  `test/graphrag-book-hotplug-runtime-gate.test.ts`,
  `test/graphrag-book-hotplug-runtime-gate-hardening.test.ts`,
  `test/graphrag-book-hotplug-catalog.test.ts`,
  `test/graphrag-book-hotplug-qmd-projection.test.ts`,
  `test/graphrag-capability-scope.test.ts`
- Single-book GraphRAG CLI focused tests:
  `test/cli-graphrag-route.test.ts -t "selected book scoped output|single graph book|graph book"`
- qmd vector search regression:
  `test/store.test.ts -t "vsearch|vectorSearchQuery"`
- Type DD 与 fixed base YAML parse check。

## D01-D10 汇总

1. D01_authority_boundaries：`PASS`。
   单书、书架、library 权威根保持隔离；catalog projection 不是 authority。
2. D02_fixed_query_budget：`PASS`。
   上层 report search、controlled deepening 和 synthesis 都受 package-local
   fixed budget 约束。
3. D03_graphrag_semantic_alignment：`PASS`。
   上层索引保留 community reports、semantic units、semantic edges 与
   evidence map，不退化为临时拼接多书摘要。
4. D04_evidence_traceability：`PASS`。
   查询和 synthesis 均保留可追溯 evidence lineage。
5. D05_state_recovery：`PASS`。
   membership-only generation 不授权查询；repair 和 publish marker 闭环已验证。
6. D06_quality_gates：`PASS`。
   书架与 library package-local gates 覆盖 schema、checksum、成员一致性、
   sensitive scan 和 fixed-budget simulation。
7. D07_incremental_scaling：`PASS`。
   library 以已发布 bookshelf package 为输入，成员 generation/manifest sha
   用于 stale 检测；自动增量 planner 正确留作未来能力。
8. D08_security_privacy：`PASS`。
   raw prompt、raw completion、provider payload、凭据和绝对路径不进入可发布
   上层索引或查询响应 metadata。
9. D09_cli_operability：`PASS`。
   CLI 支持 typed error、timing、status/list/build/rebuild/refresh-membership/
   repair 和显式 synthesis/deepening。
10. D10_testability：`PASS`。
    单元、合同、CLI、真实 smoke、hotplug 非回归和 qmd vsearch 回归均通过。

## 后续未来能力

- build-time LLM-authored bookshelf/library community report synthesis。
- 自动调度 repair。
- 增量 rebuild planner。
