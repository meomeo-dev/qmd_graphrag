# Design Agent B 状态仓库与恢复设计审计报告

固定基准：
`/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md`

审计范围：`query_ready` document identity 修复的状态仓库
（state repository）与恢复设计（recovery design）。真实失败为
GraphRAG outputs 与 `qmd_graph_text_unit_identity.json` 已存在，但
`query_ready` 同步仍报 document identity missing。

## 基准逐条结论

### 1. 记录 GraphRAG text-unit identity 的单一清晰操作

状态：PASS

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:6`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:223`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1134`
- `/Users/jin/projects/qmd_graphrag/src/contracts/corpus.ts:78`
- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:458`

判断：仓库契约暴露了
`FileBookJobStateRepository.recordGraphTextUnitIdentity`，输入类型为
`GraphTextUnitIdentityMap`，契约字段包含 `graphDocumentId` 与非空
`graphTextUnitIds`。架构文档也把
`graph_text_unit_identity_map` 的消费者指向该仓库操作。

建议：继续实施（continue implementation）。保留该单一写入入口，但后续修复
不应绕过它直接改 catalog。

### 2. 已有 qmd corpus row、缺失 graph 字段、graph 字段陈旧时安全

状态：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:8`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1083`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1104`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1123`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1134`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1144`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:1171`
- `/Users/jin/projects/qmd_graphrag/graph_vault/catalog/document-identity-map.yaml:13366`
- `/Users/jin/projects/qmd_graphrag/graph_vault/catalog/document-identity-map.yaml:13522`
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_graph_text_unit_identity.json:6`
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_graph_text_unit_identity.json:9`
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_graph_text_unit_identity.json:10`

判断：真实状态显示同一 `bookId` 与 `documentId` 的 sidecar 已有 graph identity，
但 `document-identity-map.yaml` 只显示 `qmdCorpusRegistered: true`，没有
`graphDocumentId` 或 `graphTextUnitIds`。实现还存在安全性缺口：
`upsertDocumentIdentityMap` 每次 `registerBookSource` 都用新 identity 替换同书
旧记录，未保留旧 graph 字段；`recordGraphTextUnitIdentity` 只在完整
`bookId/sourceId/sourceHash/documentId/contentHash` 匹配时更新，否则抛错。
这不能证明 graph 字段缺失或陈旧时总能安全修复。

建议：修正（fix）。`upsertDocumentIdentityMap` 应保留仍匹配内容身份的 graph
字段，或显式清除并在同一同步中强制重读 sidecar。`recordGraphTextUnitIdentity`
应定义陈旧字段覆盖规则与冲突诊断。

### 3. `query_ready` 读取能观察同一 resume pass 写入的 identity

状态：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:10`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1559`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1564`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1578`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:707`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:712`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2359`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2390`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2551`
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/checkpoints.yaml:50`

判断：`syncGraphRagBookWorkspace` 会在返回 resume plan 前尝试记录 graph
identity，但真实失败显示同一流程最终仍在 checkpoint 记录
`GraphRAG document identity is missing for query_ready`。`query_ready` 完成时
通过 `validateQueryReadyGraphIdentity` 重新读取 catalog，而不是读取 sidecar；
当 catalog 没被修复时，已存在 sidecar 不会被 `query_ready` 观察到。

建议：补平（fill gap）。在 `query_ready` 完成前增加明确的 identity repair/sync
步骤，并把写入与校验放在同一仓库事务边界或顺序化流程内。校验失败信息应指出
sidecar 是否存在但未投影。

### 4. 仅当有效 outputs 存在时将失败呈现为可修复本地状态

状态：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:12`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:611`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:140`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:149`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1599`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1859`
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/checkpoints.yaml:39`
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/checkpoints.yaml:50`

判断：批处理状态设计能校验 GraphRAG artifact evidence，但 identity missing
文本未被本地 artifact gate 分类覆盖。真实失败被记录在 `graph_extract` failed
checkpoint，错误却来自 `query_ready` identity，状态层没有将“有效 outputs 存在但
identity map 未同步”明确投影为 repairable local state。

建议：补充设计（add design）。新增“GraphRAG identity projection missing”本地
状态分类，仅在 documents/text_units、producer lineage、qmd corpus registration
均有效时才允许修复；否则保持真实 stage failure。

### 5. 避免把 identity contract failure 重标为 provider transient

状态：PASS

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:14`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:33`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:40`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:47`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:54`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:615`

判断：provider transient 分类只覆盖 429、5xx、网络、timeout、rate limit 等
文本。identity missing 不匹配 transient token，默认不会被标为 provider
transient。该点目前满足“不误标 transient”的最低要求。

建议：修正完善设计（refine design）。继续禁止 provider transient 重标，但应新增
非 transient 的 identity-local-state 分类，避免落入 unknown。

### 6. 指明既有 failed checkpoints 的重新打开方式

状态：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:16`
- `/Users/jin/projects/qmd_graphrag/docs/records/architecture/2026-05-24-graphrag-artifact-gate-and-recovery.yaml:62`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3716`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3729`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3739`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3749`
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/checkpoints.yaml:39`

判断：已有设计只说明旧 Parquet gate failure 可通过 status/resume after validator fix
恢复；批处理代码只对 local artifact gate failure 执行 repair-only 路径。当前真实
identity missing failed checkpoint 不属于该已定义路径，未说明由状态投影、普通
run、migration 还是显式 repair 重新打开。

建议：补充设计（add design）。为 identity projection failure 明确一种恢复方式：
优先建议显式 repair 或普通 resume 中的 pre-query-ready repair，并记录 reopen event。

### 7. 不要求编辑生成的 GraphRAG parquet artifacts

状态：PASS

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:18`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:621`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:630`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:642`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:732`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:733`

判断：实现从 `documents.parquet` 与 `text_units.parquet` 读取 identity，并写入仓库
catalog 与 `qmd_graph_text_unit_identity.json` sidecar；未要求修改 parquet artifact。

建议：继续实施（continue implementation）。修复应继续只修改状态仓库和 sidecar，
不要编辑 GraphRAG 生成物。

### 8. 保持 artifact lineage、producer run ids、fingerprints 与 provider boundary

状态：PASS

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:19`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1264`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1338`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1356`
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1376`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2367`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2375`
- `/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2377`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1626`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1651`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1739`

判断：`query_ready` artifact readiness 与状态投影会校验 producer run ids、
stage fingerprints、provider fingerprint、corpus content hash 与 book-scoped path。
当前缺陷在 identity 投影，不是 lineage 保护缺失。

建议：继续实施（continue implementation）。identity repair 必须复用既有 lineage
校验，不得通过改 fingerprint 或 producer manifest 绕过。

### 9. 测试证明 identity repair 后可复用 completed graph_extract artifacts

状态：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:21`
- `/Users/jin/projects/qmd_graphrag/test/graphrag-book-state.test.ts:678`
- `/Users/jin/projects/qmd_graphrag/test/graphrag-book-state.test.ts:722`
- `/Users/jin/projects/qmd_graphrag/test/graphrag-book-state.test.ts:745`
- `/Users/jin/projects/qmd_graphrag/test/graphrag-book-state.test.ts:1070`
- `/Users/jin/projects/qmd_graphrag/test/graphrag-book-state.test.ts:1114`
- `/Users/jin/projects/qmd_graphrag/test/book-job-state.test.ts:1890`
- `/Users/jin/projects/qmd_graphrag/test/book-job-state.test.ts:1908`

判断：测试证明正常同步能记录 graph identity，也证明 query_ready 可发布 capability。
但没有测试“既有 failed checkpoint + 已有 GraphRAG outputs/sidecar + 修复 identity
map + 不重新运行 GraphRAG extraction”的恢复路径。

建议：补平（fill gap）。新增回归测试，构造失败书同类状态，断言 repair 后
`graph_extract` checkpoint/runId/artifactIds 不变，`query_ready` 成功完成。

### 10. operator-visible status 显示修复后 qmd/GraphRAG/query 状态并解释可恢复原因

状态：UNCLEAR

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-b/baseline.md:23`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1168`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1171`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1172`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1173`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2537`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2543`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3305`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3306`
- `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3307`

判断：状态输出会重算 `qmdBuildStatus`、`graphBuildStatus` 与 `graphQueryStatus`，
并可输出 recovery summary。但当前没有 identity repair 专属状态字段或事件，因此
不能确认 operator 能看到“sidecar 已存在、identity map 已补齐、无需重跑
graph_extract、因此可 resume”的解释。

建议：修正完善设计（refine design）。在 recovery summary 中加入 identity repair
evidence：sidecar path、graph text unit count、reused producer run ids、reopened
checkpoint、next stage。

## 设计决策建议

- 补充设计：定义 `graph_identity_projection_missing` 本地状态，并规定只有在
  GraphRAG parquet、producer lineage、qmd corpus registration 和 sidecar 均有效时
  才可修复。
- 修正：让 `upsertDocumentIdentityMap` 保留同一 canonical identity 的有效 graph
  字段，或在覆盖后立即强制从 sidecar/parquet 重新投影。
- 修正：在 `query_ready` 前置流程中显式调用 identity repair，并让
  `validateQueryReadyGraphIdentity` 读取同一仓库写入结果。
- 修剪错误设计：不要把 identity missing 挂在 `graph_extract` stage failure 上；
  它是 `query_ready` 本地状态投影失败。
- 继续实施：保留单一仓库写入口、parquet 只读、lineage/fingerprint/provider
  fail-closed 校验。
- 修剪过度实施：不要通过重写 producer manifest、重跑 GraphRAG extraction 或修改
  parquet 来修复 identity map。
- 补平：新增恢复测试，覆盖真实失败形态和 operator-visible status。

## 总体结论

DESIGN FAIL

原因：10 条固定基准中 4 条 PASS、5 条 FAIL、1 条 UNCLEAR。当前设计已有 graph
identity 写入口与严格 lineage 校验，但缺少针对“outputs 与 sidecar 已存在、catalog
未同步”的恢复状态、重新打开路径、同 pass 可见性保证和回归测试。
