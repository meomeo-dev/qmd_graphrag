# Implementation Audit R1

审计对象：GraphRAG 多书并行 Runner 的 book-scoped durable YAML rename
`ENOENT` 子进程投影实现。

审计基准：`criteria.md` 中固定 10 条 Implementation Audit Criteria。

结论：FAIL

## 阻断发现

### 1. Partial envelope fail-closed 校验未覆盖 `marker`、`status`、`itemId`、
`bookId` 与 `workerId`

- 文件：`scripts/graphrag/batch-epub-workflow.mjs:3013`
- 文件：`scripts/graphrag/batch-epub-workflow.mjs:3032`
- 违反基准：2、5、10
- 影响：父 runner 的 `durableEnvelopeMissingFields` 只要求
  `failureKind`、`localFailureClass`、`recoveryDecision`、`targetLocator`、
  `tempId`、`operationId`、`failedSyscall`、`errno`、`renameCause`、`lane`、
  `targetMappingOwner`、`leaseGeneration` 与 `completedPublishRule`。它没有把
  design required fields 中的 `marker`、`status`、`itemId`、`bookId` 与
  `workerId` 纳入缺失判断。一个带 `QMD_GRAPHRAG_DURABLE_FAILURE` marker、
  但缺少这些字段的 partial envelope 会被当作完整 envelope 接受，而不会设置
  `evidenceIncomplete`、`durable_subprocess_evidence_incomplete` 或 unavailable
  sentinels。这样会削弱子进程 durable failure 的 first-hop 证据完整性，并让
  malformed envelope 的 fail-closed 合同不可验证。
- 建议修复：把 `durableEnvelopeMissingFields` 与 Type DD requiredFields 对齐。
  至少补充 `marker`、`status`、`itemId`、`bookId`、`workerId`；若允许父 runner
  从调度 item 补全 identity 字段，应仍记录补全来源，并在缺失时设置
  `evidenceIncomplete` 或专门的 `identityFilledFromParent` 诊断。新增 Vitest
  覆盖 malformed JSON、缺 `marker/status`、缺 identity fields、缺
  `failedSyscall/errno/renameCause` 的 fail-closed projection。

### 2. 现有 child rename ENOENT 测试未证明命中 primary `checkpoints.yaml`
durable YAML rename

- 文件：`test/cli.test.ts:3749`
- 文件：`test/cli.test.ts:3811`
- 文件：`test/cli.test.ts:3813`
- 文件：`test/cli.test.ts:3866`
- 文件：`src/job-state/durable-state-store.ts:485`
- 文件：`src/job-state/durable-state-store.ts:490`
- 违反基准：6、9、10
- 影响：测试名为 “resume-book child projects book YAML rename ENOENT into command
  check”，并通过 `QMD_GRAPHRAG_TEST_RENAME_ENOENT_ONCE_PATTERN:
  "checkpoints.yaml"` 注入一次 rename `ENOENT`。但 durable YAML 写入主
  `checkpoints.yaml` 前，会先调用 `writeJsonAtomicSidecar` 写
  `checkpoints.yaml.sha256.meta.json`，该 sidecar 路径同样包含
  `checkpoints.yaml`。测试只断言 `failedCheck.targetLocator` 包含
  `checkpoints.yaml`，没有排除 `.sha256.meta.json`，因此可能实际覆盖的是
  checksum meta sidecar rename，而不是 primary book-scoped YAML
  `checkpoints.yaml` rename。这样无法满足“真实覆盖 resume-book child book YAML
  checkpoints.yaml rename ENOENT”的验收要求。
- 建议修复：让注入点可精确匹配 primary target，例如新增 exact target 或
  target kind hook，或设置 after-match 使 sidecar rename 被跳过后命中
  primary YAML rename。测试应断言 `targetLocator` 以
  `/graph_vault/books/{bookId}/checkpoints.yaml` 结尾，且不包含
  `.sha256`、`.sha256.meta.json`；同时断言 `lane: checkpointWriterLane`、
  `targetMappingOwner: repository`、`tempId`、`operationId` 与
  `renameCause`。

## 通过证据

- `resume-book-workspace.mjs` 已导出并捕获 `DurableStateError`，在 catch handler
  中输出 `QMD_GRAPHRAG_DURABLE_FAILURE` JSON envelope，并保留
  `failedSyscall`、`errno`、`renameCause` 与
  `completedPublishRule: forbidden`。
- `durable-state-store.ts` 的 `renameWithEvidence` 与
  `renameWithEvidenceSync` 会把 rename `ENOENT` 转换为
  `DurableStateError`，分类为 `durable_temp_rename_enoent`，并写入
  `failedSyscall: rename`、`errno: ENOENT`、`renameCause` 与
  `completedPublishRule: forbidden`。
- 父 runner 在非零退出时先调用 `parseDurableFailureEnvelope`，再 fallback 到
  legacy `classifyFailure`；可解析 envelope 会进入 command check，并由
  `durableProjection` 投影到 `command_failed`、item checkpoint、`item_failed`
  与 recovery summary。
- `BatchCommandCheckSchema`、item checkpoint schema 与 recovery summary item
  schema 均已加入 durable evidence 字段，包括 `failedSyscall`、`errno`、
  `renameCause`、`completedPublishRule`、`evidenceIncomplete` 与
  `unavailableFieldSentinels`。
- `settings-projection.ts` 在 `settings.yaml` 首次 `ENOENT` 时创建 managed
  projection，并在已有非 managed marker 时拒绝 user-owned 文件。实现上未见把
  首次缺失误判为 user-owned 的路径。

## 剩余风险

- 未在本轮重新执行测试；审计依据为代码阅读与已知验证记录。
- `--status-json` 的 read-only fail-closed 路径已有实现迹象，但本审计重点是
  child book YAML rename `ENOENT`，未展开为完整 status-json 回归审计。
- `settings.yaml` 首次缺失创建路径缺少明确的 targeted test 证据；建议在修复
  上述阻断项时一并补充。
