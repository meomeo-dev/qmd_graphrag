# Implementation Audit R2

审计对象：GraphRAG 多书并行 Runner 的 durable schema、projection、
status-json diagnostics 与 preflight coverage。

审计基准：`criteria.md` 中固定 10 条 Implementation Audit Criteria。

结论：FAIL

## 阻断发现

### 1. runner-start preflight 未覆盖 temp 与 book-scoped YAML 范围

- 文件：`scripts/graphrag/batch-epub-workflow.mjs`
- 违反基准：8
- 影响：`durablePreflightScanDirectory()` 只有在 `includeTemps !== false` 时扫描
  `.tmp-` 条目，但 runner-start 调用显式传入 `{ includeTemps: false }`。同时
  `durablePreflightTargets(item)` 对 `{bookId}` scope 依赖 item，runner-start
  传入 `undefined` 时会跳过 `graph_vault/books/{bookId}`、
  `graph_vault/books/{bookId}/runs` 与 book output scopes。runner-start 因此不能
  自身覆盖 book-scoped YAML primary、checksum sidecar、checksum meta sidecar、
  temp 与 lock。
- 修复要求：runner-start 必须复用 targetMapping 派生 scope，扫描全局 scopes
  与每个已发现 item 的 book-scoped scopes，并覆盖 temp。新增聚焦测试验证
  runner-start 可阻断 book-scoped YAML unresolved temp。

## 通过证据

- public contract 与 runner 内部 schema 当前保持字段闭合。
- `DurableStateDiagnosticSchema` 已包含 identity、command、cleanup、
  sidecar、repair、incomplete evidence 与 lease 字段。
- `localDurableEvidence()` 与 `durableProjection()` 已投影 sidecar、checksum、
  fsync、repair、cleanup、incomplete、identity 与 lease 字段。
- child envelope 已转发 sidecar、fsync、repair、cleanup、incomplete、identity
  与 lease 字段。
- status-json 主流程保持 read-only inspection。

## 验证证据

- `npm run test:types -- --pretty false` 通过。
- `test/graphrag-runner-status-json-readonly.test.ts` 与
  `test/graphrag-runner-durable-preflight.test.ts` 聚焦测试通过。

