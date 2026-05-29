# Implementation Audit R2

审计对象：GraphRAG 多书并行 Runner 的 Type DD 可追溯性、真实 runner 门控、
book-scoped YAML 观测闭环、settings projection 安全性与维护性。

审计基准：`criteria.md` 中固定 10 条 Implementation Audit Criteria。

结论：FAIL

## 阻断发现

### 1. Evidence fail-closed 未覆盖 envelope 缺失路径

- 文件：`scripts/graphrag/batch-epub-workflow.mjs`
- 违反基准：5、7
- 影响：缺失 marker 时父 runner 返回 legacy text classifier，不会写入
  `durable_subprocess_evidence_incomplete`、`evidenceIncomplete` 与 unavailable
  sentinels。该路径削弱 commandCheck、checkpoint、events、status-json 与
  recovery summary 的不完整证据闭合。
- 修复要求：当父 runner 可确认失败发生在 durable subprocess boundary 时，缺失
  envelope 必须 fail closed，并在所有观测面保留 incomplete evidence 字段。

### 2. 真实 runner 仍必须门控

- 文件：`audits/.../reports/status.json`
- 违反基准：6
- 影响：本轮实施审计未通过，真实 EPUB runner 不得恢复。
- 修复要求：状态报告继续保持 `realRunner.resumeAllowed=false`，直到后续实施审计
  全部通过。

## 通过证据

- Type DD 已定义 `job.yaml`、`checkpoints.yaml` 与 `artifacts.yaml` primary
  book-scoped YAML targets。
- `resume-book-workspace.mjs` 对 `DurableStateError` 输出
  `QMD_GRAPHRAG_DURABLE_FAILURE` envelope。
- 三类 primary YAML rename ENOENT 测试已覆盖 commandCheck、checkpoint、events、
  status-json 与 recovery summary，并断言不是 `.sha256` sidecar。
- Settings projection 保持 managed projection 与 user-owned rejection 边界。
- `--status-json` read-only 观测路径已有聚焦测试。

## 维护风险

`scripts/graphrag/batch-epub-workflow.mjs`、`test/cli.test.ts`、
`test/graphrag-book-state.test.ts` 与
`src/job-state/durable-state-store.ts` 均超过项目默认行数阈值。该风险不阻断本轮
修复，但后续应拆分 runner durable adapter、envelope projection、preflight
reconciliation 与 CLI fixtures。

