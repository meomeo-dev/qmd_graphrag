# implementation-turn_019 汇总报告

## 结论

总体结论：`PASS_WITH_RISK`。

三名实施审计代理均依据固定实施审计维度完成复审，结论分别为：

- agent-1：`PASS_WITH_RISK`
- agent-2：`PASS_WITH_RISK`
- agent-3：`PASS_WITH_RISK`

本轮无阻断性 required fixes。implementation-turn_018 / agent-3 发现的
library 10/100/1000 package-local fixed-budget scale 测试超时阻断项已闭合。

历史 implementation-turn_016、implementation-turn_017 和
implementation-turn_018 的 FAIL 报告保持为原始审计证据。本报告只记录当前
工作区在后续修复后的最终复审状态。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 本轮 agent 报告：
  - `implementation-turn_019/agent-1/report.md`
  - `implementation-turn_019/agent-2/report.md`
  - `implementation-turn_019/agent-3/report.md`

## 修复闭环

implementation-turn_016 / agent-2 的 required fixes 已闭合：

- 上层 scope capability 已建模为 scope-level `graph_query` capability。
- bookshelf/library 查询 evidence 使用同一 upper graph capability id。
- bookshelf/library validator 校验 `semantic_units.parquet` 和
  `community_reports.parquet` 实际行数，超出 fixed budget 时 fail closed。
- CLI `--upper-deepening` 已覆盖默认关闭、显式开启、预算超限和缺失 member book
  capability 失败路径。
- bookshelf scale fixed-budget 测试已补齐。

implementation-turn_017 / agent-2、agent-3 的 required fixes 已闭合：

- `queryBookshelfGraph()` 与 `queryLibraryGraph()` 禁止调用方通过
  `maxReports` 或 `maxInputTokens` 放宽 package-local manifest budget。
- bookshelf/library 10/100/1000 scale 测试均通过 package-local manifest、
  quality gate、`CURRENT.json`、`PUBLISH_READY.json`、validator 和正式 query API。
- library CLI `qmd query --library-id --upper-deepening` 成功路径已验证 bounded
  member book invocation。

implementation-turn_018 / agent-3 的 required fix 已闭合：

- library 10/100/1000 scale 测试改为用固定数量 synthetic bookshelf packages
  表示不同 represented book count，避免 1000 package root I/O。
- 该测试仍保留 package-local `LIBRARY_MANIFEST.json`、quality gate、
  `CURRENT.json`、`PUBLISH_READY.json`、validator 和 `queryLibraryGraph` 正式 API
  闭环。
- 当前主控复验中 `test/graphrag-library-graph.test.ts` 全文件通过，scale 用例
  在全文件运行中耗时约 25 秒。

## 主控验证证据

提交前主控侧复验通过：

- Type DD 与固定 base YAML parse 通过。
- TypeScript build check 通过：
  `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
- `test/graphrag-controlled-deepening.test.ts`：5 个测试通过。
- `test/graphrag-bookshelf-graph.test.ts`：7 个测试通过。
- `test/graphrag-library-graph.test.ts`：8 个测试通过。
- `test/cli-graphrag-query-scope.test.ts`、
  `test/cli-graphrag-route.test.ts` 与
  `test/cli-graphrag-upper-index-failclosed.test.ts`：33 个测试通过。
- `test/graphrag-book-hotplug-creation-gate.test.ts`、
  `test/graphrag-book-hotplug-runtime-gate.test.ts`、
  `test/graphrag-capability-scope.test.ts`、
  `test/graphrag-book-hotplug-catalog.test.ts` 与
  `test/graphrag-book-hotplug-qmd-projection.test.ts`：26 个测试通过。
- `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`：
  1 个目标测试通过。
- `test/store.test.ts -t "vectorSearchQuery does not expand the query or call generation"`：
  1 个目标测试通过。
- `test/graphrag-bookshelf-membership.test.ts`、
  `test/graphrag-library-membership.test.ts` 与
  `test/cli-graphrag-upper-management.test.ts`：9 个测试通过。

## 逐项汇总

1. 单书包复制传播完整性不回归：`PASS_WITH_RISK`。
   单书 hotplug creation/runtime/catalog/qmd projection/capability scope 回归通过。
   真实外部 provider 条件下的单书 `--graph-book-id` 成功回答仍未执行。

2. 书架/library 派生索引不污染单书包：`PASS`。
   上层 package root 位于 `graph_vault/bookshelves/{bookshelfId}` 与
   `graph_vault/library/{libraryId}`，构建、查询和验证不写回单书包闭包。

3. catalog projection 不作为 query-ready 权威：`PASS`。
   projection 标记 `catalogIsAuthority: false`，显式查询读取 package-local
   `CURRENT.json`、manifest、`PUBLISH_READY.json`、quality gate 和 sidecar。

4. 删除 catalog projection 不影响显式查询：`PASS`。
   bookshelf/library graph tests 均覆盖删除 projection 后显式 package query。

5. runner ledger 不参与语义检索：`PASS_WITH_RISK`。
   当前实现和测试未发现 `graph_vault/catalog/batch-runs/**` 作为语义输入。
   该约束仍需在后续 runner lifecycle 中持续保持。

6. 查询预算不随书籍数量线性增长：`PASS`。
   bookshelf/library 10/100/1000 scale 测试通过，并验证 selected report count、
   token budget 与 evidence budget 不随 represented book count 增长。

7. evidence lineage 可追溯：`PASS_WITH_RISK`。
   evidence 可追溯到 book/source/document/contentHash/text unit/community report。
   LLM synthesis 仍未实现，因此真实 synthesis evidence 尚未验证。

8. 非 ready 状态不可被当作 query-ready：`PASS`。
   failed/staging/pending/stale、manifest/gate 损坏、member manifest stale 和
   sensitive parquet 均有 fail-closed 覆盖。

9. manifest、quality gate、publish marker 状态闭环：`PASS`。
   上层 query-ready 读取路径校验 package-local pointer、manifest、quality gate、
   `PUBLISH_READY.json` 和 sha256 sidecar。

10. CLI typed error 与 timing 可观测：`PASS`。
    missing index、legacy catalog-only migration、failed/staging CURRENT、scope
    ambiguity、over-budget 和 upper deepening success/error 路径均有测试覆盖。

11. 敏感信息不进入可发布索引：`PASS`。
    provider payload、raw prompt/completion、绝对路径、query log 样式文本和敏感
    parquet payload 均有 validator 或 fail-closed 测试覆盖。

12. 现有单书 GraphRAG 与 qmd vsearch 不回归：`PASS_WITH_RISK`。
    单书 GraphRAG fixture 路由、hotplug 回归和 qmd vsearch 聚焦回归通过。
    真实外部 provider smoke 仍未执行。

## 保留风险

- 真实外部 provider 单书 GraphRAG 与 controlled deepening smoke 未执行。
- LLM synthesis over selected upper semantic units 尚未实现。
- Membership automatic repair 与 incremental refresh management lifecycle 尚未完成。
- 大型 upper graph 测试组合总耗时仍高；提交前采用拆分命令验证，后续 CI 应分片
  或提高外层 runner timeout。
