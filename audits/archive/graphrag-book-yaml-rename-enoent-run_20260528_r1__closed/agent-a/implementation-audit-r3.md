# Implementation Audit R3

审计对象：GraphRAG 多书并行 Runner 的 durable subprocess envelope
fail-closed、typed envelope precedence 与 primary book-scoped YAML rename
`ENOENT` 观测闭环。

审计基准：`criteria.md` 中固定 10 条 Implementation Audit Criteria。

结论：FAIL

## 阻断发现

### 1. 新增 envelope fail-closed 测试稳定性不足

- 文件：`test/cli.test.ts`
- 违反基准：10
- 影响：partial、malformed 与 missing durable subprocess envelope 聚焦用例依赖完整
  batch workflow，单测自身 timeout 为 30000ms。R3 审计环境中三项曾因 timeout
  失败，不能稳定证明 R2 fail-closed 修复。
- 修复要求：降低 fixture 成本，或提高该类确需完整 workflow 的 timeout，并为
  `runBatchWorkflow` 增加子进程 timeout/kill 清理，避免测试失败后遗留进程。

## 通过证据

- 实现路径已先解析 typed envelope，再回退到 confirmed durable local state
  missing-envelope fail-closed，最后才进入 legacy classifier。
- `durableEnvelopeMissingFields()` 覆盖 required fields 与固定值校验。
- 三类 primary YAML exact target 注入测试已断言不是 `.sha256` sidecar。

## 验证证据

- `node --check scripts/graphrag/batch-epub-workflow.mjs` 通过。
- `node --check scripts/graphrag/resume-book-workspace.mjs` 通过。
- `npm run test:types -- --pretty false` 通过。

