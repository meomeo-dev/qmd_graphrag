# implementation-turn_014 agent-1 实施审计报告

## 结论

结论：`PASS_WITH_RISK`。

implementation-turn_013 后新增的 bookshelf/library 上层管理命令
（management commands）已达到最小闭环：`qmd bookshelf|library`
`status/list/build/rebuild` 接入 CLI，`status/list` 读取 package-root
权威状态，`build/rebuild` 从既有 package-root membership 调用现有
builder/validator，并发布 query-ready 上层包。审计未发现必须阻断发布的
required fix。

保留风险主要在管理命令异常路径与能力边界：管理命令尚未提供独立 timing
阶段报告，部分异常仍经通用 `cli_error` 包装；本轮补强仍不包含 LLM synthesis、
controlled deepening、membership 创建、自动 repair、增量 refresh，也未验证
真实外部 provider 条件下的单书 `--graph-book-id` 成功回答。

## Required Fixes

无。

## 逐维度审计

1. 单书包复制传播不回归：`PASS_WITH_RISK`。
   `upper-management.ts` 与 `graphrag-upper-management.ts` 未出现
   `graph_vault/books/**` 写入路径；build/rebuild 通过既有上层 builder 写入
   `bookshelves/**` 或 `library/**`。`qmd vsearch` 目标回归通过。保留风险是
   真实外部 provider 单书 `--graph-book-id` 未执行。

2. 上层索引不污染单书包：`PASS`。
   管理命令仅调用 bookshelf/library 上层构建器和 validator；既有图测试断言
   单书包内不存在 `BOOKSHELF_MANIFEST.json` 或上层 semantic artifacts。

3. catalog 仅 projection/route/observability，且不能证明 query-ready：`PASS`。
   `getUpperPackageStatus()` 固定返回
   `authority.packageRootIsAuthority=true` 和
   `catalogProjectionIsAuthority=false`。query-ready 判定调用
   `readQueryReadyPackage()`，验证 package-local `CURRENT.json`、manifest、
   `PUBLISH_READY.json`、quality gate 与 checksum sidecar。legacy
   catalog-only artifact 返回 `migration_required`。

4. 删除 catalog projection 不影响显式查询：`PASS`。
   bookshelf 和 library 图测试均覆盖删除
   `graph_vault/catalog/**/projection*` 后显式 package-root 查询仍返回
   evidence。管理命令的状态展示只报告 projection 是否存在，不把其作为
   query-ready 权威。

5. runner ledger 不参与语义检索：`PASS`。
   审计范围内管理命令与上层 builder 接入未读取
   `graph_vault/catalog/batch-runs/**` 或 runner ledger 作为语义输入。

6. 固定查询预算不随规模线性增长：`PASS`。
   管理命令 build/rebuild 暴露固定上限参数
   `--max-semantic-units`、`--max-edges`、`--max-reports-per-book` 和
   `--max-reports-per-shelf`，并将查询预算来自 manifest 的
   `fixedQueryBudget`。library 固定预算模拟覆盖 10、100、1000 book scale。

7. evidence lineage：`PASS`。
   build/rebuild 结果暴露 `semanticUnitCount` 与 `evidenceMapCount`，validator
   要求 evidence map 存在并与 manifest row count 一致。显式查询测试继续验证
   evidence 能回链到 bookId、sourceId、documentId、contentHash 与
   graphTextUnitId。

8. failed/staging/pending/stale 不可 query-ready：`PASS_WITH_RISK`。
   `readQueryReadyPackage()` 要求 `queryReady=true` 且 readyState 匹配
   `bookshelf_query_ready` 或 `library_query_ready`。route 测试覆盖 failed 与
   staging CURRENT fail-closed；管理测试覆盖 membership-only 状态返回
   `not_query_ready`。pending/stale 的完整管理命令展示路径未单独新增测试，
   但查询路径已有 stale fail-closed 合同。

9. manifest/quality gate/publish marker 状态闭环：`PASS`。
   build/rebuild 调用现有 builder，builder 在 staged artifacts 与 validator
   通过后写入 package-root manifest、quality gate、`CURRENT.json` 与
   `PUBLISH_READY.json`，随后重建非权威 catalog projection。status/list 从
   package-root 读取这些权威文件。

10. CLI typed error/timing：`PASS_WITH_RISK`。
    查询路径 typed error 与 `--timing` 字段通过既有 route/query-scope 测试。
    管理命令成功路径输出结构化 JSON；not-ready、missing、migration-required
    作为 status JSON 返回。风险是 build/rebuild 的异常仍由 qmd 通用
    `cli_error` 包装，且管理命令本身没有独立 timing 分解。

11. 敏感信息与绝对路径泄漏：`PASS_WITH_RISK`。
    status/build JSON 使用 graph_vault-relative locators，测试断言输出不包含
    测试 `graphVault` 绝对路径。builder 侧仍执行 forbidden field scan。保留
    风险是管理命令异常消息未做专门 fuzz 覆盖，尤其是外部 `--python-bin`
    或损坏 manifest 的异常文本。

12. 现有单书 GraphRAG 和 qmd vsearch 不回归：`PASS_WITH_RISK`。
    `qmd vsearch` 目标回归通过，GraphRAG route scope/fail-closed 目标用例通过。
    未执行真实外部 provider 单书 `--graph-book-id` 成功回答。

## Type DD 与报告一致性

- Type DD 已将 package-root `status/list/build/rebuild` 管理命令列入已实现
  package-root 能力，并保留 remaining capabilities：LLM synthesis 与 bounded
  deepening。
- implementation-turn_013 汇总报告明确说明该管理命令补强尚未进入
  implementation-turn_013 三代理复审，并列出 membership 创建、自动 repair、
  增量 refresh、LLM synthesis、controlled deepening 仍为后续能力。
- 本轮审计未发现 Type DD 或 turn_013 汇总对管理命令能力边界的明显夸大。

## Risk Notes

- `status/list` 对正常 query-ready、membership-only 和 legacy catalog-only
  状态已覆盖；但损坏 manifest 且 checksum sidecar 被同步篡改的异常路径可能
  走通用 CLI error，而不是返回 `invalid` status。建议后续补充损坏 manifest、
  损坏 quality gate、sidecar mismatch 的管理命令回归。
- 完整管理命令测试较重。一次 180 秒全文件运行超时，随后提高命令超时后
  4 个测试全部通过；library graph publish 单用例默认 60 秒 test timeout
  超时，使用 `--testTimeout 180000` 后通过。建议为重型上层图测试显式标注
  timeout，降低审计噪声。
- `build` 与 `rebuild` 当前语义相同，都是从现有 membership 触发保守重建。
  这符合最小实现，但不是增量 refresh 或 repair lifecycle。
- 管理命令尚未创建 membership，也未提供自动 repair 或 stale refresh 命令；
  不能把本轮结论扩展为完整 library 管理生命周期已完成。

## Evidence Commands

已读取：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-013-summary.md`
- `src/graphrag/upper-index/upper-management.ts`
- `src/cli/graphrag-upper-management.ts`
- `src/cli/qmd.ts`
- `test/cli-graphrag-upper-management.test.ts`
- 相关 bookshelf/library query、graph、projection、package path 源码与测试。

本地验证命令：

```bash
node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false
npx vitest run test/cli-graphrag-upper-management.test.ts --reporter verbose
npx vitest run test/cli-graphrag-query-scope.test.ts --reporter verbose
npx vitest run test/cli-graphrag-upper-index-failclosed.test.ts --reporter verbose
npx vitest run test/cli-graphrag-route.test.ts -t "refuses .* upper CURRENT|legacy catalog" --reporter verbose
npx vitest run test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics" --reporter verbose
npx vitest run test/graphrag-bookshelf-graph.test.ts -t "publishes a query-ready bookshelf graph" --reporter verbose
npx vitest run test/graphrag-bookshelf-graph.test.ts -t "catalog|projection|deleted" --reporter verbose
npx vitest run test/graphrag-library-graph.test.ts -t "publishes a query-ready library graph" --reporter verbose --testTimeout 180000
npx vitest run test/graphrag-library-graph.test.ts -t "keeps library query budget fixed" --reporter verbose --testTimeout 180000
```

结果摘要：

- TypeScript build check 通过。
- `test/cli-graphrag-upper-management.test.ts`：4 个测试通过。
- `test/cli-graphrag-query-scope.test.ts`：8 个测试通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 个测试通过。
- `test/cli-graphrag-route.test.ts` 目标用例：6 个测试通过，13 个跳过。
- `test/cli/basic.test.ts` 的 vsearch 目标用例通过。
- bookshelf graph publish/projection 目标用例通过。
- library graph publish 与固定预算目标用例在显式 test timeout 下通过。
