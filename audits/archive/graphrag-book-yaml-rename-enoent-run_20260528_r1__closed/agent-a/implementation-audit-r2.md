# Implementation Audit R2

审计对象：GraphRAG 多书并行 Runner 的 book-scoped durable YAML rename
`ENOENT` 子进程投影实现。

审计基准：`criteria.md` 中固定 10 条 Implementation Audit Criteria。

结论：FAIL

## 阻断发现

### 1. 缺失 envelope 未按 durable subprocess boundary fail closed

- 文件：`scripts/graphrag/batch-epub-workflow.mjs`
- 违反基准：5、10
- 影响：`parseDurableFailureEnvelope()` 在未发现
  `QMD_GRAPHRAG_DURABLE_FAILURE` marker 时返回 `null`。父 runner 随后回退到
  legacy text classifier，不会构造
  `durable_subprocess_evidence_incomplete`、`evidenceIncomplete`、
  `evidenceIncompleteReason` 与 unavailable sentinels。若 `resume-book-*` 子进程
  中 durable local state failure 未输出 envelope，`BatchCommandCheck` 不能作为
  first-hop carrier 保留不完整证据诊断。
- 修复要求：在父 runner 可确认 `resume-book-*` 或
  `repair-local-artifact-gate-*` 失败属于 durable local state failure 时，缺失
  marker 必须走 `incompleteSubprocessDurableFailure()`，legacy classifier 只能作为
  确认输入或辅助诊断。

### 2. malformed、missing envelope 与 settings 首次缺失创建测试不足

- 文件：`test/cli.test.ts`
- 文件：`test/graphrag-book-state.test.ts`
- 违反基准：10
- 影响：现有测试覆盖 partial envelope，但未覆盖 malformed JSON envelope 与完全
  missing envelope。settings projection 实现包含首次 `ENOENT` 创建 managed
  projection 路径，但缺少对 `managed_projection_created` 的显式断言。
- 修复要求：新增 malformed JSON envelope、missing envelope fail-closed 测试；新增
  settings projection 首次缺失创建与后续 already-valid 不重写测试。

## 通过证据

- rename `ENOENT` 分类主路径包含 `durable_temp_rename_enoent`、
  `failedSyscall: rename`、`errno: ENOENT`、`renameCause` 与
  `completedPublishRule: forbidden`。
- `resume-book-workspace.mjs` 捕获 `DurableStateError` 时输出 typed envelope。
- 父 runner 在 marker 存在时先解析 typed envelope，再回退 legacy classifier。
- 三类 primary book YAML target 的精确注入测试已覆盖 sidecar 排除。

## 验证证据

- `node --check scripts/graphrag/batch-epub-workflow.mjs` 通过。
- `node --check scripts/graphrag/resume-book-workspace.mjs` 通过。
- `npm run test:types -- --pretty false` 通过。
- Type DD YAML parse 通过。

