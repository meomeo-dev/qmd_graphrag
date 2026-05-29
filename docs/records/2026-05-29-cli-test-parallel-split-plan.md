# `test/cli.test.ts` 并行拆分计划

## 目标

将 `test/cli.test.ts` 从单个超大测试文件拆分为多个可独立运行的
测试文件，降低审阅、定位和并行执行成本，同时保持现有测试语义
（test semantics）不变。

## 约束

- 本轮先做结构性拆分，不改生产代码行为。
- 拆分前后测试断言、命令参数、环境变量和 fixture 内容保持等价。
- 共享测试状态必须按文件隔离，避免多文件并行时污染同一临时目录、
  数据库路径或配置目录。
- GraphRAG runner 相关测试必须继续使用固定审计基准对应的行为边界，
  不引入新的验收标准。
- 不移动无关文件，不回滚既有工作树变更。
- 拆分后的单文件行数优先控制在项目约束内；GraphRAG 巨型块允许先按
  领域分组拆出，再继续二次收敛。

## 当前结构

`test/cli.test.ts` 当前约 17,772 行。主要结构如下：

- 顶部共享 CLI 集成测试 harness、fixture 和全局 hook。
- 常规 CLI 命令测试：Help、Skills、Embed、Init、Add、Status、Search
  等。
- `GraphRAG EPUB batch runner`：约 15,186 行，是主要超限来源。
- 文档命令、集合命令、输出格式、路径隐藏等后续 CLI 测试。
- MCP daemon 和 stdio launcher 测试。

## 目标布局

- `test/helpers/cli-harness.ts`
  - CLI 子进程执行器。
  - 临时目录、数据库、配置目录和基础 fixture 初始化。
  - `createCliTestHarness()` 返回每个测试文件自己的状态访问器。

- `test/cli/basic.test.ts`
  - Help、Skills、Embed、Skill Commands。
  - Init、Add、Status、Search 基础命令。

- `test/cli/query.test.ts`
  - Unified Query Route。
  - 查询输出格式、集合过滤和路径标准化中与查询强相关的测试。

- `test/cli/document-commands.test.ts`
  - Get、Multi-Get、Update、Add-Context、Cleanup。
  - Error Handling、Output Formats、Context Management、ls。
  - Collection Commands、ignore patterns、editor URI templates。
  - status / collection list 路径隐藏测试。

- `test/cli/mcp.test.ts`
  - `mcp http daemon`。
  - `mcp stdio launcher`。

- `test/helpers/graphrag-runner-harness.ts`
  - GraphRAG EPUB batch runner 专用 fixture、manifest、workspace 和
    子进程辅助函数。
  - 固定状态文件、artifact 和失败分类辅助逻辑。

- `test/graphrag-runner-*.test.ts`
  - 按 GraphRAG runner 子领域拆分：
    durable recovery、provider recovery、status recovery、
    manifest reconciliation、query readiness、concurrency、auth/preflight。

## 执行顺序

1. 抽取 `test/helpers/cli-harness.ts`，让每个测试文件通过
   `createCliTestHarness()` 获取独立状态。
2. 先拆常规 CLI describe 块到 `test/cli/*.test.ts`，保留
   `test/cli.test.ts` 中 GraphRAG 巨型块，运行定向验证。
3. 抽取 GraphRAG runner 专用 harness，保持 helper 名称和断言逻辑稳定。
4. 将 `GraphRAG EPUB batch runner` 按子领域移动到多个
   `test/graphrag-runner-*.test.ts` 文件。
5. 所有拆分文件通过后，删除或清空旧 `test/cli.test.ts`，避免重复执行。

## 验证命令

每轮结构迁移后运行对应定向命令：

```bash
npm run test:types
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 120000 \
  test/cli/*.test.ts
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 120000 \
  test/graphrag-runner-*.test.ts
```

最终验证：

```bash
npm run test:types
CI=true node ./node_modules/vitest/vitest.mjs run \
  --reporter=verbose --testTimeout 120000 \
  test/cli/*.test.ts test/graphrag-runner-*.test.ts
```

## 风险与控制

- 风险：原文件全局 `beforeAll`/`beforeEach` 共享状态在拆分后失效。
  控制：使用工厂式 harness，避免导出跨文件可变全局对象。
- 风险：GraphRAG runner helper 与局部变量耦合深。
  控制：先移动整块，再做领域切分；每次只移动一个稳定边界。
- 风险：MCP daemon 测试对子进程生命周期敏感。
  控制：单独文件运行，并保留超时和清理逻辑。
- 风险：拆分后重复执行旧文件。
  控制：目标文件通过后移除旧文件中的对应 describe 块。

## 收敛发现

拆分后反复失败的原因固定为测试结构回归（split regression），不是新的
审计基准。后续修复只按以下规则收敛，不扩大生产行为边界。

- Durable 状态 fixture 必须使用 checksum-aware helper 写入。凡是写入
  `graph_vault/catalog/batch-runs/*/manifest.json`、
  `graph_vault/catalog/batch-runs/*/items/*.json`、
  `graph_vault/catalog/books.yaml`、`graph_vault/books/*/artifacts.yaml`、
  `graph_vault/books/*/checkpoints.yaml`、`qmd_output_manifest.json`、
  `context.json`、`stats.json` 等受 durable preflight 管理的状态文件，
  必须使用 `writeDurableJsonFixture()`、`writeDurableYamlFixture()` 或
  `writeDurableTextFixture()`。源码 EPUB、配置、fake script、事件日志、
  lock/temp/corrupt sidecar 等故意非 durable fixture 可继续裸写。
- Status-only 测试必须保持命令模式一致。测试标题、断言和
  `JSON.parse(result.stdout)` 指向 status JSON 时，命令必须使用
  `--status-json` 或 `runBatchStatusJson()`；migrate-only 测试才使用
  `--migrate-only` 或 `runBatchMigrateOnly()`。
- 真实 runner 的慢路径测试不得无意跑完整 27 项命令检查。除非测试目标是
  完整命令检查覆盖，否则子进程环境应在
  `QMD_GRAPHRAG_ENABLE_TEST_HOOKS=1` 下设置
  `QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES` 为
  `qmd-version,qmd-query-auto-json,qmd-query-graphrag-json`，以保留 GraphRAG
  查询 readiness 覆盖并降低单文件超时风险。
