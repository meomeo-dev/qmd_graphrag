# implementation-turn_015 汇总报告

## 结论

总体结论：`PASS_WITH_RISK`。

三名实施审计代理均依据固定实施审计维度完成修复后复审，结论分别为：

- agent-1：`PASS_WITH_RISK`
- agent-2：`PASS_WITH_RISK`
- agent-3：`PASS_WITH_RISK`

本轮无必须修复项。implementation-turn_014 / agent-2 发现的管理状态误报
`query_ready` 问题已闭合。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 前序报告：
  `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-013-summary.md`
- 失败轮次证据：
  `docs/architecture/graphrag-hierarchical-library-index-audits/implementation-turn_014/agent-2/report.md`
- 本轮 agent 报告：
  - `implementation-turn_015/agent-1/report.md`
  - `implementation-turn_015/agent-2/report.md`
  - `implementation-turn_015/agent-3/report.md`

## 修复闭环

implementation-turn_014 的 required fix：

- `qmd bookshelf/library status/list` 曾可能把 checksum/sidecar 与
  `PUBLISH_READY.json` 自洽、但 graph manifest 或 quality gate schema 无效的
  上层包误报为 `query_ready`。

修复结果：

- `src/graphrag/upper-index/upper-management.ts` 新增 ready 内容校验。
- `getUpperPackageStatus()` 在返回 `query_ready` 前，先通过
  `readQueryReadyPackage()` 校验 package-local `CURRENT.json`、manifest、
  `PUBLISH_READY.json`、quality gate 和 checksum sidecar 闭环。
- 随后解析 `BookshelfGraphManifestSchema` / `LibraryGraphManifestSchema` 与
  `BookshelfQualityGateSchema` / `LibraryQualityGateSchema`。
- schema 本身要求 query-ready readyState、`queryReady: true` 和
  quality gate `status: "passed"`。
- 修复代码额外校验 manifest/gate 的 scope id 与 current generation 一致。
- schema 损坏、gate 损坏、scope mismatch 或 generation mismatch 均返回
  `not_query_ready`，不得返回 `query_ready`。

回归覆盖：

- `test/cli-graphrag-upper-management.test.ts` 覆盖 bookshelf/library 的
  corrupt-but-checksummed graph manifest 和 quality gate。
- status 与 list 均验证损坏包不再报告 `query_ready`。
- build/rebuild smoke 继续覆盖从 package-root membership 调用现有 builder 与
  validator，并发布 query-ready 上层包。

## 验证证据

主控修复后验证：

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`
  通过。
- `test/cli-graphrag-upper-management.test.ts`：4 个测试通过。
- `test/cli-graphrag-route.test.ts`、`test/cli-graphrag-query-scope.test.ts` 与
  `test/cli-graphrag-upper-index-failclosed.test.ts`：28 个测试通过。
- `test/graphrag-bookshelf-graph.test.ts`：5 个测试通过。
- `test/graphrag-library-graph.test.ts`：7 个测试通过。
- `test/graphrag-bookshelf-membership.test.ts` 与
  `test/graphrag-library-membership.test.ts`：5 个测试通过。
- `test/graphrag-book-hotplug-catalog.test.ts` 与
  `test/graphrag-book-hotplug-qmd-projection.test.ts`：13 个测试通过。
- `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`：
  1 个目标测试通过。
- Type DD 与固定 base YAML 均可解析。

## 逐项汇总

1. 单书包复制传播完整性不回归：`PASS_WITH_RISK`。
   本轮管理命令补强不新增 `graph_vault/books/**` 写入路径。单书 hotplug
   catalog/qmd projection 与目标 vsearch 回归通过。保留风险是真实外部 provider
   条件下的单书 `--graph-book-id` 成功回答仍未执行。

2. 书架/library 派生索引不污染单书包：`PASS`。
   status/list 只读上层 package root 与 catalog projection 存在性；build/rebuild
   仍调用既有 upper builder 和 validator。

3. catalog 仅 projection/route/observability，且不能证明 query-ready：`PASS`。
   管理输出固定 `catalogProjectionIsAuthority=false`。query-ready 状态必须通过
   package-local pointer、manifest、publish marker、quality gate、checksum sidecar
   与 schema 内容校验。

4. 删除 catalog projection 不影响显式查询：`PASS`。
   管理命令不依赖 catalog projection 证明 ready。既有 graph 测试继续覆盖删除
   catalog projection 后显式上层查询成功。

5. runner ledger 不参与语义检索：`PASS`。
   审计范围内未发现 `graph_vault/catalog/batch-runs/**`、runner ledger 或 events
   被作为 semantic input。

6. 查询预算不随书籍数量线性增长：`PASS`。
   build/rebuild 只透传固定预算参数到既有 builder。library graph 继续覆盖
   10、100、1000 book scale 固定预算。

7. evidence lineage 可追溯：`PASS`。
   本轮修复不改变 evidence map 或 query response。validator 与 fail-closed 测试
   继续覆盖 evidence lineage 与污染 parquet。

8. 非 ready 状态不可被当作 query-ready：`PASS_WITH_RISK`。
   membership-only、failed/staging、corrupt-but-checksummed manifest/gate 均不会被
   视为 query-ready。pending/running/stale 的管理 status 专项组合仍可后续补强。

9. manifest、quality gate、publish marker 状态闭环：`PASS`。
   implementation-turn_014 required fix 已闭合。status/list 不再只依赖
   checksum/marker 自洽，而是要求 graph manifest 与 quality gate schema 也有效。

10. CLI typed error 与 timing 可观测：`PASS_WITH_RISK`。
    显式 query 路径 typed error 与 timing 回归通过。管理 status/list 用 exit code
    0 表示命令执行成功，scope readiness 由 `status` 与 `queryReady` 字段表达；
    管理命令仍无专用 timing breakdown。

11. 敏感信息、绝对路径、provider payload 不进入可发布索引：`PASS_WITH_RISK`。
    管理测试继续断言 JSON 输出不包含临时 `graphVault` 绝对路径。新增 diagnostic
    是 schema/gate 错误码，不包含 provider payload、raw prompt/completion、
    credential 或 query log。

12. 现有单书 GraphRAG 与 qmd vsearch 不回归：`PASS_WITH_RISK`。
    单书 fixture 路由、hotplug projection 与 qmd vsearch 目标回归通过。真实外部
    provider 单书 `--graph-book-id` 成功回答仍未验证。

## 保留风险

- 真实外部 provider 条件下的单书 `--graph-book-id` 成功回答未验证。
- LLM synthesis、controlled deepening、membership 创建、自动 repair 和增量
  refresh 管理生命周期仍未完成。
- build/rebuild 仍是从既有 package-root membership 触发现有 builder/validator
  的薄入口，不代表完整管理生命周期。
- 管理命令错误路径仍可继续补充更强的 path-redaction 与 timing 回归。
