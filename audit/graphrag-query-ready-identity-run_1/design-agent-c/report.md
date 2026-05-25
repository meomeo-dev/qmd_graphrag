# Design Agent C 文档与验收设计审计报告

## 审计范围

固定基准（fixed baseline）：
`/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/design-agent-c/baseline.md`

真实失败（real failure）：

- 运行 `epub-batch-20260525-full-real` 在
  `A Philosophy of Software Design (John K. Ousterhout).epub` 上失败。
- 失败阶段为 `resume-book-1`。
- 错误为
  `GraphRAG document identity is missing for query_ready: doc-fd8875181a17`。
- 该书的 `qmd_graph_text_unit_identity.json`、`documents.parquet`、
  `text_units.parquet` 和 `qmd_output_manifest.json` 已存在。

背景证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/status.yaml:6`
  至 `:12` 记录真实 run、书籍、item、失败阶段和错误。
- `/Users/jin/projects/qmd_graphrag/graph_vault/catalog/batch-runs/epub-batch-20260525-full-real/items/item-9f587b71073a-cff9f38d.json:31`
  至 `:54` 记录 qmd/graph/query 状态与相同错误。
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_graph_text_unit_identity.json:3`
  至 `:10` 记录 book、QMD document、GraphRAG document 与 text-unit
  identity 已生成。
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_output_manifest.json:3`
  至 `:23` 记录 book-scoped output、documentId、contentHash 和 stage
  producer run lineage。

## 逐条基准判定

### 1. `query_ready` capability 发布依赖 qmd corpus registration 与 GraphRAG text-unit identity

判定：PASS

证据：

- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.md:341`
  至 `:347` 规定 `query_ready` 发布 graph capability 前必须验证 producer
  checkpoints，并且 `DocumentIdentityMap` 已写入 `graphDocumentId`、
  非空 `graphTextUnitIds`，且 qmd corpus registration 存在。
- `/Users/jin/projects/qmd_graphrag/catalog/data-bus.catalog.yaml:187`
  至 `:190` 规定 `qmdCorpusRegistered` gate `query_ready` capability
  publication，并持久化 `graphDocumentId` 和 `graphTextUnitIds`。

设计决策建议：继续实施。该不变量已进入架构文档和 catalog。

### 2. Type-DD docs 说明 QMD document identity 与 GraphRAG 内部 document identity 的关系

判定：PASS

证据：

- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:235`
  至 `:246` 定义 qmd `document_id` 由 `sourceId`、`contentHash` 和
  `normalizationPolicyVersion` 投影。
- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:271`
  至 `:289` 定义 `graph_text_unit_id` 与 `graph_document_id` 来自
  GraphRAG output，并由 `DocumentIdentityMap` 持久化以供 query scope
  和 evidence lineage 审计。
- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.md:297`
  至 `:339` 给出 source、document、book、content、chunk、GraphRAG
  text unit、GraphRAG document 的映射关系，并明确 GraphRAG 内部
  document title 不作为 authority。

设计决策建议：继续实施。Type-DD 身份边界足够明确。

### 3. Docs 描述允许的 single-document fallback 并明确拒绝 ambiguous multi-document fallback

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:621`
  至 `:666` 的实现从 `documents.parquet` 和 `text_units.parquet` 派生
  GraphRAG identity，并在 `documents` 只有一行时允许 fallback。
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:644`
  至 `:649` 显示仅实现了单文档 fallback 和 unmatched 时返回 `null`；
  文档未把该行为提升为设计契约，也未显式说明多文档歧义必须 fail-closed。
- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.md:334`
  至 `:339` 只说明 GraphRAG text unit 与 title authority 边界，
  未描述 single-document fallback 或 multi-document ambiguity policy。

设计决策建议：补平、修正完善设计。应把现有单文档 fallback 写入设计，并明确
多文档无法匹配 QMD document identity 时必须拒绝，不能选择第一行或按 title 猜测。

### 4. Docs 解释 `qmd_graph_text_unit_identity.json` 的派生方式及其 source of truth 或 repair evidence 角色

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:621`
  至 `:666` 说明实际派生逻辑读取 `documents.parquet`、`text_units.parquet`，
  匹配 document 后收集 GraphRAG text unit IDs。
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:732`
  至 `:735` 显示实现先调用 `recordGraphTextUnitIdentity()`，再写入
  `qmd_graph_text_unit_identity.json` sidecar。
- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:458`
  至 `:470` 只定义 `graph_text_unit_identity_map` 的 schema、storage 和
  source tables，未点名 `qmd_graph_text_unit_identity.json`。
- `/Users/jin/projects/qmd_graphrag/graph_vault/books/book-9f587b71073a-ad95ce2f/output/qmd_graph_text_unit_identity.json:3`
  至 `:10` 证明 sidecar 已存在，但真实同步仍报 document identity missing。

设计决策建议：补充设计、修正完善设计。应声明该 JSON 是从 GraphRAG parquets
派生的 repair evidence（修复证据），还是与 `document-identity-map.yaml` 同级的
source of truth（事实源）。建议以 `document-identity-map.yaml` 为发布事实源，
将该 JSON 定义为可重建的修复证据。

### 5. Docs 描述 GraphRAG outputs 有效但 identity map 缺失或陈旧时的 resume 行为

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:60`
  至 `:75` 说明 batch resume 委托 `BookResumePlan.nextStage`，但没有 identity
  map missing/stale 的专门分支。
- `/Users/jin/projects/qmd_graphrag/catalog/data-bus.catalog.yaml:1051`
  至 `:1062` 只说明 resume plan 可因 checkpoint/artifact 缺失返回
  `artifact_missing`，未覆盖 document identity map 缺失或陈旧。
- `/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:726`
  至 `:730` 显示现有行为是在 required identity 缺失时直接抛出
  `GraphRAG document identity is missing for query_ready`。
- `/Users/jin/projects/qmd_graphrag/graph_vault/catalog/batch-runs/epub-batch-20260525-full-real/items/item-9f587b71073a-cff9f38d.json:52`
  至 `:70` 证明真实失败停在 identity missing，而不是低成本 identity resync。

设计决策建议：补平、修正。应定义低成本恢复路径：当 book-scoped GraphRAG
outputs 与 producer manifest 有效，但 `document-identity-map.yaml` 缺失或陈旧时，
resume 应重建 GraphRAG identity mapping 并重试 `query_ready` 发布，不应重跑
`graph_extract`、`community_report` 或 `embed`。

### 6. Acceptance criteria 包含重跑失败真实书且不重做已有效的高成本 GraphRAG extraction

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/audit/graphrag-query-ready-identity-run_1/status.yaml:6`
  至 `:12` 固定了本轮真实失败书和错误。
- `/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:64`
  至 `:75` 提供通用 resume 规则：只执行 `nextStage`，不重跑已完成 stage。
- `/Users/jin/projects/qmd_graphrag/docs/records/architecture/2026-05-24-graphrag-artifact-gate-and-recovery.yaml:41`
  至 `:42` 规定本地验证缺陷不得自动重复完整 GraphRAG LLM build。
- `/Users/jin/projects/qmd_graphrag/docs/records/architecture/2026-05-24-graphrag-artifact-gate-and-recovery.yaml:62`
  至 `:64` 说明旧 artifact gate 失败可通过 status 或 resume 修复且无需
  `graph_vault` reset。

缺口：上述证据是通用恢复设计，未形成针对
`book-9f587b71073a-ad95ce2f` / `item-9f587b71073a-cff9f38d` 的验收标准，
也未断言有效 GraphRAG outputs 已存在时不得产生新的高成本 producer run。

设计决策建议：补充设计、补平。应增加验收：以同一 runId 或明确修复 run 重跑该
真实书，断言 `graph_extract`、`community_report`、`embed` producer runId 不变，
只执行 identity repair / `query_ready` 低成本同步，并最终通过 graph query。

### 7. Acceptance criteria 包含修复后的 qmd、graph build、graph query batch status checks

判定：PASS

证据：

- `/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:247`
  至 `:251` 规定 `recovery-summary.json` 与 `--status-json` 输出每本书的
  `qmdBuildStatus`、`graphBuildStatus` 和 `graphQueryStatus`。
- `/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:340`
  至 `:344` 规定 completed checkpoint 必须包含 27 个 command checks，
  且 qmd、graph build、graph query 三类状态均为 succeeded。
- `/Users/jin/projects/qmd_graphrag/catalog/data-bus.catalog.yaml:50`
  至 `:53` 规定 completed items 需要三类 status succeeded。

设计决策建议：继续实施。该验收门禁已明确。

### 8. Acceptance criteria 包含 graph-ready 后所有 core CLI output formats

判定：PASS

证据：

- `/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:307`
  至 `:338` 列出闭环后的 27 个 CLI checks，覆盖 search JSON/CSV/MD/XML/files、
  vsearch JSON、query JSON、auto JSON、GraphRAG JSON、multi-get JSON 和其他核心
  CLI 命令。
- `/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:340`
  至 `:344` 规定名称集合 exact match 且全部 passed，才能写入 completed。

设计决策建议：继续实施。CLI 输出格式验收覆盖充分。

### 9. Design 声明哪些 generated runtime outputs 不应提交

判定：FAIL

证据：

- `/Users/jin/projects/qmd_graphrag/.gitignore:24`
  至 `:29` 实际忽略 `.env`、`.qmd/*.sqlite*`、`graph_vault/`、`inbox/` 和
  `tmp/`。
- `/Users/jin/projects/qmd_graphrag/catalog/data-bus.catalog.yaml:469`
  至 `:472` 说明 GraphRAG `reportDir` 是 runtime observability output，
  不是 portable graph_vault state。
- `/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:1600`
  至 `:1606` 说明 stage log 是 runtime health evidence，不登记为
  query-ready graph artifact。

缺口：设计文档未把 `.gitignore` 中的 generated runtime outputs 转化为提交边界
契约，也未明确 `graph_vault`、临时 log root、GraphRAG cache/report logs、provider
request sidecars、qmd SQLite index 等生成产物哪些不得提交。

设计决策建议：补充设计。应新增提交边界（commit boundary）小节，列出不得提交
的生成运行产物，并说明哪些 portable audit records 可保留在运行环境但不进入源码
提交。

### 10. Design audit report 决定是否需要 supplementing、correction、trimming、continuation 或 over-implementation pruning

判定：PASS

证据：

- 本报告第 3 至第 9 条逐条给出补平、补充设计、修正完善设计、修正和继续实施
  建议。
- 本报告“设计决策汇总”给出整体补充、修正、修剪与继续实施建议。

设计决策建议：继续实施本审计结论，并将失败项转为文档与验收补丁。

## 设计决策汇总

- 补充设计：补充 `qmd_graph_text_unit_identity.json` 的角色、identity map
  missing/stale resume 语义、真实失败书验收和 generated runtime outputs 提交边界。
- 修正完善设计：把 QMD document identity、GraphRAG document identity、
  single-document fallback、multi-document ambiguity fail-closed 规则写成同一契约。
- 修剪错误设计：不得保留任何会在多文档 GraphRAG output 中按 title、路径或首行
  猜测 identity 的设计。
- 继续实施：保留 query-ready 发布 gate、Type-DD 身份模型、batch status checks
  和 27 项 CLI 输出格式验收。
- 修正：resume 逻辑应能从有效 book-scoped GraphRAG outputs 或 sidecar 修复
  `document-identity-map.yaml`，再发布 `query_ready`。
- 修剪过度实施：未发现需要修剪的已成文过度设计；当前主要风险是文档和验收不足。
- 补平：将实现中已有的单文档 fallback 和 sidecar 写入行为补入设计，并把真实失败
  转成回归验收。

## 总体结论

DESIGN FAIL

原因：10 条固定基准中，1、2、7、8、10 为 PASS；3、4、5、6、9 为 FAIL。
失败项集中在 query-ready identity 修复的文档化、missing/stale identity map 的恢复
语义、真实失败书的低成本验收，以及 generated runtime outputs 的提交边界。
