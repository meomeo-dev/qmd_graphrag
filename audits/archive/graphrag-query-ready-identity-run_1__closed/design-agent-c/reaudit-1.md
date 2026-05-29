# Design Agent C 复审报告

## 复审范围

固定基准：
`audit/graphrag-query-ready-identity-run_1__closed/design-agent-c/baseline.md`

初审报告：
`audit/graphrag-query-ready-identity-run_1__closed/design-agent-c/report.md`

设计修复摘要：
`audit/graphrag-query-ready-identity-run_1__closed/design-fix-summary.md`

本次复审仅使用原 10 条基准，不新增、不替换基准。复审对象为指定设计
文件与状态文件。`status.yaml` 已标记设计修复完成且可复审：
`audit/graphrag-query-ready-identity-run_1__closed/status.yaml:41` 至 `:48`。

## 逐条基准判定

### 1. `query_ready` capability 发布依赖 qmd corpus registration 与 GraphRAG text-unit identity

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:341` 至 `:347` 规定
  `query_ready` 必须验证 `graph_extract`、`community_report`、`embed`
  producer checkpoint，并且只有在 `DocumentIdentityMap` 已写入
  `graphDocumentId`、非空 `graphTextUnitIds` 且 qmd corpus registration
  存在时发布 graph capability。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1732` 至 `:1741`
  规定 `qmdCorpusRegistered` 与 `graphDocumentId`、非空
  `graphTextUnitIds` 是 `query_ready` capability 发布 gate。
- `catalog/data-bus.catalog.yaml:193` 至 `:201` 规定
  `qmdCorpusRegistered` gate `query_ready` capability publication，并且
  catalog 是发布事实源，sidecar 只能修复 projection。

剩余缺口：无。

### 2. Type-DD docs 说明 QMD document identity 与 GraphRAG 内部 document identity 的关系

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.type-dd.yaml:235` 至 `:246`
  定义 qmd `document_id` 来自 `sourceId`、`contentHash` 与
  `normalizationPolicyVersion`。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:271` 至 `:289`
  定义 `graph_text_unit_id` 与 `graph_document_id` 来自 GraphRAG output，
  并声明不依赖 GraphRAG document title 作为 authority。
- `docs/architecture/unified-retrieval-plane.md:297` 至 `:339` 给出
  qmd document、content、chunk、GraphRAG text unit 与 GraphRAG document
  的统一身份关系。

剩余缺口：无。

### 3. Docs 描述允许的 single-document fallback 并明确拒绝 ambiguous multi-document fallback

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:368` 至 `:370` 规定
  sidecar 缺失时只允许直接匹配 GraphRAG document id，或在单 GraphRAG
  document output 中 fallback；多 document output 无法唯一证明目标
  document 时必须 fail-closed，且不得按 title、路径、首行或第一行猜测。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:486` 至 `:491`
  规定 repair 在 mismatch 与 producer lineage 问题上 fail-closed，并且
  multi-document GraphRAG output 不得按 title、path、first row 或 first
  text unit 选择。
- `catalog/data-bus.catalog.yaml:232` 至 `:236` 规定多 document GraphRAG
  output 若缺少有效 sidecar 或 direct document identity match，不得按 title
  或 first row 修复。

剩余缺口：无。初审 FAIL 已补平为设计契约。

### 4. Docs 解释 `qmd_graph_text_unit_identity.json` 的派生方式及 source of truth 或 repair evidence 角色

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:351` 至 `:357` 规定 qmd
  identity 的事实源来自 book job 与 qmd corpus registration，graph identity
  的事实源来自已验证的 book-scoped `documents.parquet` 与
  `text_units.parquet`，`qmd_graph_text_unit_identity.json` 是派生的
  repair evidence，不是绕过 `DocumentIdentityMap` 的发布事实源。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:473` 至 `:485`
  将 GraphRAG documents/text units parquet 定义为 source tables，并声明
  sidecar 是 validated GraphRAG output 派生的 repair evidence，不是 query
  capability source of truth。
- `catalog/data-bus.catalog.yaml:225` 至 `:231` 规定 sidecar 来自 validated
  GraphRAG documents 与 text units，不是独立事实源。

剩余缺口：无。初审 FAIL 已补平为明确的事实源和修复证据边界。

### 5. Docs 描述 GraphRAG outputs 有效但 identity map 缺失或陈旧时的 resume 行为

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:717` 至 `:724` 规定当
  book-scoped GraphRAG outputs、producer lineage、qmd corpus registration
  和 identity sidecar 有效，但 `DocumentIdentityMap` 缺失或陈旧时，归类为
  `graph_identity_projection_missing`，恢复必须低成本重建 catalog projection
  并重试 `query_ready`，不得重跑高成本 stage。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1651` 至 `:1659`
  规定 resume 从 sidecar 或 validated parquet extraction 修复 catalog
  projection，再重试 `query_ready`。
- `docs/operations/graphrag-epub-batch-runbook.md:118` 至 `:122` 规定若
  sidecar 已存在但 catalog 缺 graph fields，恢复必须先校验 sidecar 与
  output manifest，再低成本修复 catalog projection。
- `catalog/data-bus.catalog.yaml:1080` 至 `:1086` 规定
  `graph_identity_projection_missing` 只重开 catalog/query_ready projection
  work，不重跑 `graph_extract`、`community_report` 或 `embed`。

剩余缺口：无。初审 FAIL 已补平为恢复分支与低成本行为。

### 6. Acceptance criteria 包含重跑失败真实书且不重做已有效的高成本 GraphRAG extraction

判定：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1__closed/status.yaml:6` 至 `:12` 固定真实
  失败 run、失败书、bookId、itemId、失败阶段和错误。
- `docs/architecture/unified-retrieval-plane.md:815` 至 `:818` 规定真实失败
  `book-9f587b71073a-ad95ce2f` 的回归验收必须证明 sidecar 已存在而 catalog
  缺 graph fields 时，resume 可补齐 `DocumentIdentityMap` 并完成
  `query_ready`，同时 `graph_extract`、`community_report` 和 `embed`
  producer run ids 不变。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1928` 至 `:1932`
  规定同一真实回归必须从既有 sidecar 修复 missing catalog graph identity，
  完成 `query_ready`，且不改变高成本 producer run ids。
- `docs/operations/graphrag-epub-batch-runbook.md:198` 至 `:201` 规定同一
  runId resume 只补 catalog projection 并重试 `query_ready`，不得重跑
  `graph_extract`、`community_report` 或 `embed`。

剩余缺口：无。初审 FAIL 已转化为真实书回归验收。

### 7. Acceptance criteria 包含修复后的 qmd、graph build、graph query batch status checks

判定：PASS

证据：

- `docs/operations/graphrag-epub-batch-runbook.md:262` 至 `:266` 规定
  `recovery-summary.json` 与 `--status-json` 输出每本书的
  `qmdBuildStatus`、`graphBuildStatus` 与 `graphQueryStatus`。
- `docs/operations/graphrag-epub-batch-runbook.md:355` 至 `:359` 规定每个
  completed checkpoint 必须包含 27 个固定 command checks，且
  `qmdBuildStatus.status`、`graphBuildStatus.status`、
  `graphQueryStatus.status` 均为 `succeeded`。
- `catalog/data-bus.catalog.yaml:50` 至 `:53` 规定 completed item 需要
  qmd、graph build 与 graph query status 均 succeeded。

剩余缺口：无。

### 8. Acceptance criteria 包含 graph-ready 后所有 core CLI output formats

判定：PASS

证据：

- `docs/operations/graphrag-epub-batch-runbook.md:324` 至 `:353` 列出每本书
  闭环后的 27 个 CLI 检查，覆盖 search JSON/CSV/MD/XML/files、vsearch JSON、
  query JSON、auto JSON、GraphRAG JSON、multi-get JSON 及其他核心 CLI
  命令。
- `docs/operations/graphrag-epub-batch-runbook.md:355` 至 `:357` 规定
  completed checkpoint 的 command check 名称集合必须与该检查集 exact match，
  且全部 passed。

剩余缺口：无。

### 9. Design 声明哪些 generated runtime outputs 不应提交

判定：PASS

证据：

- `docs/architecture/unified-retrieval-plane.md:820` 至 `:834` 新增提交边界，
  明确 `graph_vault/` 运行状态与 GraphRAG output、`.qmd/*.sqlite*`、`inbox/`、
  `tmp/`、GraphRAG report logs、batch log roots、原始 provider payload 与
  credential 不得进入源码提交，并限定 audit 目录只能记录脱敏事实和结论。
- `docs/operations/graphrag-epub-batch-runbook.md:379` 至 `:389` 在运行手册中
  重复声明 generated runtime outputs 不得提交到源码仓库。
- `docs/architecture/unified-retrieval-plane.type-dd.yaml:1830` 至 `:1836`
  规定 provider request sidecar 只保存 redacted fingerprints 与 sanitized
  metadata，排除 secret values 和 raw provider payloads。

剩余缺口：无。初审 FAIL 已补平为提交边界。

### 10. Design audit report 决定是否需要 supplementing、correction、trimming、continuation 或 over-implementation pruning

判定：PASS

证据：

- `audit/graphrag-query-ready-identity-run_1__closed/design-agent-c/report.md:226`
  至 `:240` 的设计决策汇总分别给出补充设计、修正完善设计、修剪错误设计、
  继续实施、修正、修剪过度实施与补平结论。
- `audit/graphrag-query-ready-identity-run_1__closed/design-fix-summary.md:16` 至 `:31`
  记录本轮修复吸收了初审补充、修正和提交边界要求。
- `audit/graphrag-query-ready-identity-run_1__closed/design-fix-summary.md:33` 至 `:42`
  记录后续实施边界，限定最小代码范围并排除重跑高成本 GraphRAG stage、
  编辑 parquet、重写 producer manifest 或修改无关查询输出逻辑。

剩余缺口：无。

## 初审 FAIL/UNCLEAR 复核

初审中第 3、4、5、6、9 条为 FAIL，本轮均已补齐：

- 第 3 条：已明确 single-document fallback 与 multi-document ambiguity
  fail-closed。
- 第 4 条：已明确 sidecar 是 derived repair evidence，不是 source of truth。
- 第 5 条：已明确 missing/stale identity map 的低成本 resume 行为。
- 第 6 条：已加入真实失败书的回归验收，并要求高成本 producer run ids 不变。
- 第 9 条：已加入 generated runtime outputs 的提交边界。

未发现初审 UNCLEAR 项。

## 总体结论

DESIGN PASS

原因：原 10 条固定基准均为 PASS。设计补丁已覆盖初审 FAIL 项，且验收标准
包含真实失败书、低成本 identity projection repair、batch status checks、核心
CLI 输出格式和 generated runtime output 提交边界。
