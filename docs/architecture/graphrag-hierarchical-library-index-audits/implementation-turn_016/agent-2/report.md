**Result**

FAIL（implementation-readiness 未通过）。本轮实现大体满足显式上层查询、
package-local `CURRENT`/`PUBLISH_READY` 校验、typed error、默认关闭且有界的
controlled deepening（受控下钻）要求；指定测试全部通过。但仍有实现就绪阻断项：
上层 capability kind 与 `graph_query` 语义不一致，查询前验证未把实际 parquet
行数重新绑定到固定预算，且 controlled deepening 的真实 CLI 正向路径测试不足。

**Scope**

审计范围包括 Type DD、固定审计基线、相关 upper-index 实现、CLI 查询路由、受控
下钻实现和指定测试文件。未修改任何文件。

**Evidence**

- Type DD 要求显式 upper scope 先校验 package-local `CURRENT`、manifest、
  `PUBLISH_READY`、quality gate，并禁止查询路径全库扫描。
- `readQueryReadyPackage` 校验 package root、`CURRENT.json`、manifest checksum、
  root/generation manifest、quality gate、`PUBLISH_READY.json` 及 sidecar。
- `queryBookshelfGraph` / `queryLibraryGraph` 先读 package-local ready scope，
  再执行 fixed-budget report search；controlled deepening 只在 `enabled` 为
  true 时运行。
- `applyControlledDeepening` 只从 `upperResponse.evidence` 选目标，按
  `requestedMaxDeepeningTargets <= package max` fail-closed。
- CLI 中 `--upper-deepening` 默认为 false；`--max-deepening-targets` 未配合
  `--upper-deepening` 会报错。
- 验证命令通过：
  - `npm run test:types`
  - `npx vitest run ...` 指定 6 个测试文件：45 tests passed。

**D01-D10 Table**

| ID | Result | Evidence / Rationale |
|---|---|---|
| D01 | PASS_WITH_RISK | 上层 query 以 package root 为权威，legacy catalog-only fail-closed；catalog projection 不作为 query-ready 权威。残余风险见 F-003。 |
| D02 | PARTIAL | 当前构建产物有界，controlled deepening 有界；但 query validator 未重新校验实际 `community_reports` / `semantic_units` 行数是否仍在预算内。 |
| D03 | PASS | 上层输入来自 community reports，并保留 semantic units、semantic edges、evidence lineage。 |
| D04 | PARTIAL | evidence map 与输出证据可追溯；但上层 synthetic capability id/kind 与证据 `graphCapabilityId` 不一致，削弱 capability lineage。 |
| D05 | PASS | `CURRENT`、`PUBLISH_READY`、sidecar、generation root 语义清晰；failed/staging CURRENT 被 CLI typed error 拒绝。 |
| D06 | PARTIAL | quality gates 存在并被读取；但预算模拟结果未被 query-time validator 重新绑定到实际 artifact row counts。 |
| D07 | PASS_WITH_RISK | library scale 测试覆盖 10/100/1000；当前仍是保守重建，增量 lifecycle 不是本轮完成范围。 |
| D08 | PASS | 敏感字段扫描、locator sanitization、绝对路径防泄漏测试覆盖。 |
| D09 | PASS_WITH_RISK | CLI typed errors、scope 互斥、选项解析通过；缺少 CLI 成功触发 `--upper-deepening` 的端到端断言。 |
| D10 | PARTIAL | 指定测试全部通过且覆盖多项失败模式；缺少 capability kind、一致性与篡改后超预算回归测试。 |

**Findings By Severity**

High: 无。

Medium:

1. 上层 GraphRAG capability selection 使用 `kind: "global_search"`，但路由和证据
   语义是 `graph_query`。
   - Evidence: `loadBookshelfGraphQueryCapabilities` 和
     `loadLibraryGraphQueryCapabilities` 返回的 synthetic capability `kind` 为
     `global_search`，但 CLI typed errors、provider capability 与 query evidence
     使用 `graph_query`。
   - Impact: routeDecision 的 `graphCapabilityIds` 可能不对应输出 evidence 的
     `graphCapabilityId`，并绕过了既有 `loadGraphQueryCapabilities` 对
     `kind === "graph_query"` 的语义约束。后续若 router 收紧 capability kind，
     会导致 upper scope 查询失效。
   - Required fix: 将 upper synthetic capability 明确建模为 `graph_query`，或定义
     独立 upper graph capability contract，并保证 routeDecision、evidence、typed
     error capability 字段一致。

2. Query-time validator 未重新校验实际 upper artifact row counts 是否符合固定预算。
   - Evidence: bookshelf/library validator 检查 schema、checksum、quality gate、
     evidence_map row count，但未断言实际 `semantic_units.parquet`、
     `community_reports.parquet` 行数仍受 `fixedQueryBudget.maxSemanticUnits`
     约束。query bridge 会读取当前 package 内全部 `community_reports.parquet` 和
     `evidence_map.parquet` 后再排序截断。
   - Impact: 当前 builder 生成的是 bounded artifacts，因此正常路径通过；但若
     builder regression 或 artifact/gate 同步错误产生过量 upper reports，查询路径
     可能随 upper artifact 行数增长，固定预算依赖未被 fail-closed 保护。
   - Required fix: 在 bookshelf/library query readiness validation 中加入 artifact
     row budget checks，并添加篡改后超预算 fail-closed 测试。

Low:

3. CLI 层缺少 `--upper-deepening` 成功路径端到端测试。
   - Evidence: controlled deepening 函数单测覆盖 disabled、预算超限、缺 capability、
     library 去重；CLI route 测试覆盖选项注册和错误路径，但未断言真实
     `qmd query --bookshelf-id/--library-id --upper-deepening` 会调用 bounded member
     book runner。
   - Impact: CLI wiring 依赖静态阅读和函数级测试，缺少端到端防回归。
   - Required fix: 增加 CLI fixture：默认不下钻；显式
     `--upper-deepening --max-deepening-targets 1` 只调用一个 member book；超过
     package budget 返回 `budget_exceeded_narrow_scope_required`。

**Residual Risks**

- 真实外部 provider 的 single-book deepening 成功路径仍未执行；当前依赖 fixture 和
  injectable runner。
- LLM synthesis 仍是 future capability；当前 upper query 是 fixed-budget report
  search，不是完整综合生成。
- library deepening 的递归 member book freshness 主要依赖 selected book capability
  loader 与下层 package state；应继续避免 catalog/runner ledger 被用作语义输入。
- Query bridge 的 lexical scoring 当前会读取 bounded upper reports；长期应考虑使用
  vector/hybrid upper index，以减少对全 upper report materialization 的依赖。

**Required Fixes**

1. 修正 upper scope capability contract：`loadBookshelfGraphQueryCapabilities` 与
   `loadLibraryGraphQueryCapabilities` 返回的 GraphRAG route capability 必须与
   `graph_query` 一致，并增加 routeDecision/evidence capability id 一致性测试。
2. 在 `validateBookshelfGraphAtRoot` 与 `validateLibraryGraphAtRoot` 中校验实际
   artifact row counts 与 `fixedQueryBudget` 一致；过量 rows 必须 fail-closed 为
   `budget_exceeded_narrow_scope_required` 或 `upper_quality_gate_failed`。
3. 增加 CLI 级 controlled deepening 回归测试，覆盖默认关闭、显式开启、预算收窄、
   预算超限、缺少 selected member book capability。
4. 增加 bookshelf scale 固定预算测试，与现有 library 10/100/1000 测试对称。
