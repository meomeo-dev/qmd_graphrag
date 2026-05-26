# GraphRAG Identity Sidecar Recovery Revised Design

## Problem

真实批处理 `epub-batch-20260526-resume-after-auth` 在恢复已具备历史
`query_ready` 状态的图书时失败。失败项为
`A Philosophy of Software Design (John K. Ousterhout).epub`，错误为：

`GraphRAG document identity sidecar evidence is invalid for query_ready:
doc-fd8875181a17`

本地证据显示 `qmd_graph_text_unit_identity.json` 的书级身份字段仍匹配当前
书籍和文档，但当前 `documents.parquet`、`text_units.parquet` 已被新的
`graph_extract` 恢复尝试覆盖。侧车中的 `graphTextUnitIds` 来自旧的有效
GraphRAG 输出，当前 Parquet 输出来自新的 producer run。恢复路径在
`syncGraphRagBookWorkspace` 中先读取侧车并强制用当前 Parquet 验证它，
导致旧侧车与新 Parquet 不一致时直接失败，阻断后续 resume plan。

## Invariants

1. `query_ready` 只能基于真实非 bootstrap 的 `graph_extract`、
   `community_report` 和 `embed` producer lineage 发布。
2. 当前 manifest 和 artifact validator 仍是 GraphRAG 高成本产物门控
   的唯一有效判据，不能回退到未验证 checkpoint。
3. `qmd_graph_text_unit_identity.json` 是可修复缓存，不是唯一真源。
4. 当前 Parquet 身份证据如果自洽，应优先用于重写侧车和 catalog 映射。
5. 当前 Parquet 身份证据不自洽时，不得发布或保留 `query_ready`
   capability。
6. 旧侧车如果不匹配当前 Parquet，只能触发 fallback 或 repair，不能单独
   证明当前 `query_ready`。
7. 修复不得跳过每本书的 qmd 与 GraphRAG 闭环检查。
8. 当前 `graph_extract` 产物被接受后，`community_report`、`embed` 和
   `query_ready` 仍必须按当前 resume plan 与 producer lineage 继续推进；
   不得把旧 lineage 的下游产物与新 `graph_extract` 混合成 ready 状态。

## Proposed Change

在 `src/job-state/graphrag-book.ts` 中调整 GraphRAG 文本单元身份恢复策略。

`recordGraphTextUnitIdentityIfAvailable` 的读取顺序改为：

1. 先从当前 `documents.parquet` 和 `text_units.parquet` 读取并验证身份。
2. 当前 Parquet 身份存在时，记录到 repository，并重写
   `qmd_graph_text_unit_identity.json`。
3. 只有当当前 Parquet 身份缺失时，才读取侧车。
4. 侧车能通过当前 Parquet 交叉验证时，记录并重写规范侧车。
5. 侧车无效且当前 Parquet 也无法提供身份时，在 `required=true` 时继续
   抛出现有 query-ready 身份缺失或无效错误。

该变更把当前 GraphRAG 输出作为身份真源，避免历史侧车阻止恢复，同时保留
query-ready 阶段的强验证边界。

如果当前输出目录只包含新的 `graph_extract` producer manifest，而下游
`community_report` 或 `embed` 只来自旧 checkpoint 或 bootstrap 产物，则恢复
计划必须继续返回相应下游阶段。侧车重写只修复身份映射，不代表下游阶段已经
与当前 `graph_extract` 对齐。

## Catalog Projection

当前 Parquet 身份自洽时，`GraphRagTextUnitIdentity` 必须通过现有
`FileBookJobStateRepository.recordGraphTextUnitIdentity` 写入 catalog。
该记录以 `bookId`、`sourceId`、`sourceHash`、`documentId` 和 `contentHash`
绑定当前书籍与当前规范化内容。

Repository 写入必须保持以下规则：

1. 只更新匹配同一 `documentId` 和 `contentHash` 的
   `document-identity-map.yaml` 记录。
2. `graphDocumentId` 与 `graphTextUnitIds` 使用当前自洽 Parquet 集合替换旧
   graph text unit ids。
3. 保留已存在的 qmd corpus registration 元数据，例如
   `qmdCorpusRegistered`、collection 和 relative path。
4. 不为未完成 qmd corpus registration 的书发布 `query_ready`。
5. 不覆盖其他书籍、其他 source hash、其他 content hash 或其他 document id
   的身份记录。
6. 重写后的 `qmd_graph_text_unit_identity.json` 必须与 catalog 中的
   `graph_text_unit_identity_map` 语义一致。

## Query-Ready Gate

`hasQueryReadyArtifacts` 仍由当前记录的 `community_report` 和 `embed`
产物决定。即使身份侧车被重写，`query_ready` 仍必须通过以下门控：

- producer run id 必须来自有效 stage checkpoint 或 run record。
- required artifact kind 必须满足当前 validator。
- artifact 必须 book-scoped。
- stage fingerprint、provider fingerprint 和 corpus content hash 必须匹配。
- capability catalog 只能从通过上述门控的 `query_ready` 状态派生。

## Tests

需要补充或调整以下测试：

1. 当前 Parquet 身份与旧侧车不一致时，应从 Parquet 重写侧车并恢复成功。
2. 当前 Parquet 身份缺失且侧车无效时，`required=true` 仍失败。
3. 当前 Parquet 身份自洽但侧车绑定旧 text unit ids 时，不能使用旧侧车
   发布 capability。
4. 既有“侧车缺 document、绑定其他 document、缺 text units”测试仍必须
   保持失败语义，除非当前 Parquet 能提供完整自洽身份。
5. 批处理 status 对该失败不再把书标记为永久本地 stop，恢复后应进入正常
   CLI 子命令检查。
6. 新 `graph_extract` 覆盖输出且旧侧车无效时，首次恢复应完成或复用当前
   `graph_extract`，随后继续要求 `community_report` 和 `embed` 按当前 lineage
   补齐，而不是直接 `query_ready`。

## Post-Implementation Acceptance Signals

固定验收信号如下：

1. `npm run test:node -- test/graphrag-book-state.test.ts -t "sidecar"`
   必须通过。
2. `npm run test:node -- test/graphrag-book-state.test.ts` 必须通过。
3. `npm run test:node -- test/book-job-state.test.ts` 必须通过。
4. `npm run typecheck` 必须通过。
5. `node -c scripts/graphrag/batch-epub-workflow.mjs` 必须通过。
6. 真实失败书恢复时，不得再次出现
   `GraphRAG document identity sidecar evidence is invalid for query_ready`。
7. 若新 `graph_extract` 已覆盖输出但下游 lineage 未补齐，
   `resumePlan.nextStage` 必须指向 `community_report`、`embed` 或
   `query_ready`，不得直接 `nextStage=null`。
8. 当前 lineage 未完整前，`loadGraphQueryCapabilities` 不得发布该书的
   `graph_query` capability。
9. 当前 lineage 完整后，批处理 item 必须记录 `qmdBuildStatus.status =
   succeeded`、`graphBuildStatus.stage = query_ready`、`graphQueryStatus.status =
   succeeded`。
10. `git diff --check` 必须通过。

## Remaining Risks

1. 多文档 GraphRAG 输出依赖 title basename 或单文档 fallback 选择 graph
   document。现有测试覆盖多文档场景，但真实 EPUB 中异常 title 仍可能导致
   身份缺失并触发 fail-closed。
2. Parquet 身份读取依赖 Python/Pandas 环境。环境缺失或 Parquet schema 演进
   会导致身份无法读取，应保持明确错误，不静默降级。
3. GraphRAG 输出目录可能在失败 stage 中被部分覆盖。修复只能解除身份侧车
   阻断，仍需要 artifact validator 与 resume plan 判定下游 stage 是否重建。
4. repair-only 路径仍可能因非身份类本地 gate 失败而停止；本 case 不扩大
   repair-only 的职责。
5. 批处理 status 和 repository 仍存在部分等价 gate 逻辑，未来 validator
   演进时需要同步维护，避免诊断漂移。

## Non-Goals

1. 不修改 GraphRAG Python vendor 行为。
2. 不降低 artifact readiness validator。
3. 不把旧 `query_ready` checkpoint 当作 bypass。
4. 不改变输出格式、research 子命令或其他已通过审计的设计。
5. 不提交 `graph_vault`、`.qmd`、`inbox`、`tmp` 或 `.tmp-tests` 产物。
