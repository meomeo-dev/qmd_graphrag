# implementation-turn_009 汇总报告

## 结论

总体结论：`PASS_WITH_RISK`。

三名实施审计代理均依据固定实施审计维度完成只读审计，结论分别为：

- agent-1：`PASS_WITH_RISK`
- agent-2：`PASS_WITH_RISK`
- agent-3：`PASS_WITH_RISK`

主控已处理本轮可操作风险中的关键项：脚本文案从 catalog id 改为 package id；
上层 package-ready helper 增加 `CURRENT.json.sha256`、`CURRENT.current`、
query-ready `readyState`、root/generation quality gate sidecar 和内容一致性、
以及 `PUBLISH_READY` 路径一致性检查；测试补充删除 catalog projection 后仍
可显式查询 package root，以及 `CURRENT.json` 非 query-ready 时 fail closed。

本轮不升级为无风险 `PASS`，原因是三份正式 agent 报告仍为
`PASS_WITH_RISK`，硬化后尚未再启动新一轮三代理复审。当前可记录为：
主要实现风险已通过主控修复与测试验证降低，后续若要求最终无风险结论，应开启
`implementation-turn_010` 复审。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定设计审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 审计轮次：`implementation-turn_009`
- agent 报告：
  - `implementation-turn_009/agent-1/report.md`
  - `implementation-turn_009/agent-2/report.md`
  - `implementation-turn_009/agent-3/report.md`

## 本轮修复

- `scripts/graphrag/build-bookshelf-membership.mjs`：
  `--bookshelf-id` 帮助文案改为 bookshelf package id。
- `scripts/graphrag/build-library-membership.mjs`：
  `--library-id` 帮助文案改为 library package id。
- `src/graphrag/upper-index/upper-package-paths.ts`：
  - 查询前要求 `CURRENT.json.sha256` 存在并匹配 `CURRENT.json` 内容。
  - 要求 `CURRENT.current === generations/{CURRENT.generation}`。
  - 要求 `CURRENT.readyState` 为 scope 对应 query-ready 状态。
  - 校验 generation manifest、root manifest 与 sidecar 一致。
  - 校验 generation quality gate、root quality gate、sidecar 与内容一致。
  - 校验 `PUBLISH_READY.manifestPath`、`qualityGatePath`、
    `currentPath`、scope、generation、readyState 与 manifest sha。
- `test/graphrag-bookshelf-graph.test.ts`：
  - 增加删除 `graph_vault/catalog/bookshelves/{bookshelfId}` projection 后，
    显式 bookshelf package 查询仍成功的覆盖。
  - 增加 `CURRENT.json.readyState=running` 时 validator 与 query
    fail-closed 覆盖。
  - 修正质量门篡改测试，保持 generation/root gate 与 sidecar 一致。
- `test/graphrag-library-graph.test.ts`：
  - 增加删除 `graph_vault/catalog/library/{libraryId}` projection 后，
    显式 library package 查询仍成功的覆盖。
  - 增加 `CURRENT.json.readyState=pending` 时 validator 与 query
    fail-closed 覆盖。
  - 修正质量门篡改测试，保持 generation/root gate 与 sidecar 一致。

## 已验证运行证据

- `node ./node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --pretty false`：
  通过。
- `test/graphrag-bookshelf-graph.test.ts`：4 个测试通过。
- `test/graphrag-library-graph.test.ts`：5 个测试通过。
- `test/graphrag-bookshelf-membership.test.ts`：3 个测试通过。
- `test/graphrag-library-membership.test.ts`：2 个测试通过。
- `test/cli-graphrag-query-scope.test.ts`：7 个测试通过。
- `test/cli-graphrag-route.test.ts`：15 个测试通过。
- `test/cli-graphrag-upper-index-failclosed.test.ts`：1 个测试通过。
- `test/graphrag-book-hotplug-catalog.test.ts`：12 个测试通过。
- `test/graphrag-book-hotplug-runtime-gate.test.ts` 与
  `test/graphrag-capability-scope.test.ts`：12 个测试通过。
- `test/cli-graphrag-timeout.test.ts`：1 个测试通过。
- `test/cli/basic.test.ts -t "vsearch does not emit query expansion diagnostics"`：
  1 个测试通过，51 个非目标测试按过滤条件跳过。

## 逐项汇总

### 1. 单书包复制传播完整性不回归

判定：PASS_WITH_RISK。

单书 hotplug catalog、runtime gate、capability scope 和 qmd vsearch 回归均已通过。
当前测试覆盖证明上层 package-root 迁移没有写回单书包闭包。保留风险是本轮未在
外部 provider 可用条件下取得一次真实单书 `--graph-book-id` 成功回答；当前仅有
route 与 timeout typed error 回归证据。

### 2. 书架/library 派生索引不污染单书包

判定：PASS。

书架 membership/graph 写入 `graph_vault/bookshelves/{bookshelfId}`，library
membership/graph 写入 `graph_vault/library/{libraryId}`。测试断言成员单书包中
不存在上层 manifest 或上层 parquet 产物。

### 3. 上层包闭包不写入 catalog

判定：PASS。

构建后不生成 `graph_vault/catalog/bookshelves/{bookshelfId}` 或
`graph_vault/catalog/library/{libraryId}` 作为包闭包。新增测试证明删除 catalog
projection 后，显式 `--bookshelf-id` 与 `--library-id` 查询仍从 package root
成功读取 query-ready generation。

### 4. runner ledger 不参与语义检索

判定：PASS。

上层查询只读取 package-local manifest、quality gate、community reports、
evidence map 和相关 parquet 语义产物。`graph_vault/catalog/batch-runs/**`
仍只作为 runner ledger / observability state，不参与 bookshelf/library 语义输入。

### 5. 查询预算不随书籍数量线性增长

判定：PASS。

library 10、100、1000 book scale 固定预算模拟测试通过，selected report 数、
输入 token 估算和 evidence 数保持固定指纹。over budget 路径返回
`budget_exceeded_narrow_scope_required`。

### 6. evidence lineage 可追溯

判定：PASS。

bookshelf 与 library 查询 evidence 均保留 `bookId`、`sourceId`、
`documentId`、`contentHash`、`graphTextUnitId`、community report locator 和
upper metadata。locator 已指向 package-root generation 路径。

### 7. staging/failed/running/pending/stale 不能被当 ready

判定：PASS_WITH_RISK。

`readQueryReadyPackage()` 现在强校验 `CURRENT.json.sha256`、current generation
路径、query-ready `readyState`、manifest/gate sidecar 和 `PUBLISH_READY`。
新增 bookshelf running、library pending 指针反例均 fail closed。stale member
book 与 stale member bookshelf 反例通过。

保留风险：本轮测试覆盖 running/pending 指针和 stale manifest，尚未增加所有
failed 状态枚举的独立 CLI fixture。

### 8. manifest、quality gate、publish marker 状态闭环

判定：PASS。

package-root `CURRENT.json`、root manifest、generation manifest、root/generation
quality gate、`PUBLISH_READY.json` 与 sidecar 均纳入 query-ready 校验。质量门
篡改测试已按新闭环同步 root 与 generation gate，验证 required check 缺失仍能
被 validator 报出。

### 9. CLI typed error 与 timing 可观测

判定：PASS_WITH_RISK。

CLI route 测试覆盖 missing upper package、legacy catalog-only
`upper_package_migration_required`、scope ambiguity、typed diagnostics 和 timing
字段。保留风险是上层 query response 内部 runtimeMetrics 仍主要是 fixed-budget
logical stage marker，真实外层 CLI timing 已可观测。

### 10. 敏感信息与现有单书 GraphRAG/qmd vsearch 非回归

判定：PASS_WITH_RISK。

upper parquet 污染 fail-closed 测试通过，provider payload、Bearer token 和绝对
路径不会进入可发布查询结果。qmd vsearch 回归通过。保留风险同第 1 项：真实外部
provider 条件下的单书 `--graph-book-id` 成功回答未在本轮完成。

## 保留风险

- 三名 agent 的正式报告仍为 `PASS_WITH_RISK`；硬化后尚未执行
  `implementation-turn_010` 三代理复审。
- 单书 `--graph-book-id` 真实成功回答依赖外部 provider/runtime，本轮只验证了
  route、timeout typed error 和 hotplug/runtime gate 回归。
- 上层 query response 内部 runtimeMetrics 的 stage duration 仍需后续提高精度，
  或明确标注为 fixed-budget logical stage marker。
- `qmd library list/build/status/rebuild` 管理命令、LLM synthesis、受控下钻到
  单书 GraphRAG 仍属后续能力。
- 部分 upper-index 模块已经接近或超过项目建议行数，继续扩展前应拆分 writer、
  validator、planner 与 CLI adapter。

## 后续收敛条件

转为无风险 `PASS` 前，建议至少完成：

1. 开启 `implementation-turn_010`，让 3 个 agent 基于当前硬化后的工作区重新审计。
2. 在外部 provider/runtime 可用时，运行一次真实单书 `--graph-book-id` 成功回答。
3. 增加 failed 状态枚举的 CLI fixture，补齐 running/pending/stale 之外的状态反例。
4. 若继续新增能力，先拆分超长 upper-index 模块，避免向核心文件继续堆功能。
