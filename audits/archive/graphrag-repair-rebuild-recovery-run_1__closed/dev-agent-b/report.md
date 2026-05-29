# Development Audit: FAIL

## 审计范围

审计对象为当前未提交改动相对于
`audit/graphrag-repair-rebuild-recovery-run_1__closed/dev-agent-b/baseline.md`
的 10 条固定基准。重点覆盖 GraphRAG text-unit identity sidecar
（文本单元身份旁车）的派生缓存恢复语义（derived cache recovery
semantics）、身份匹配边界（identity boundary）、`query_ready` 发布门控
（publication gate）和测试覆盖（test coverage）。

## 逐条结论

| # | 结论 | 审计结论 |
|---|---|---|
| 1 | PASS | `qmd_graph_text_unit_identity.json` 现在不再把 `contentHash` 和 `normalizedPath` 作为身份真源（source of truth）；解析时使用当前期望值重建派生投影。 |
| 2 | FAIL | stale `contentHash` 和 `normalizedPath` 会被重写，但重写前只验证 `text_units.parquet` 中存在 text-unit id；没有验证 `documents.parquet` 中仍存在并匹配 sidecar 的 `graphDocumentId`。 |
| 3 | PASS | `bookId`、`sourceId`、`sourceHash`、`documentId` 不匹配时，sidecar 解析返回 `null`，不会直接信任该 sidecar。 |
| 4 | PASS | sidecar 引用缺失 text units 时，`readGraphTextUnitIdentitySidecar` 返回 `null`，不会用该 sidecar 发布 graph identity。 |
| 5 | FAIL | sidecar 不可用时会回退到 parquet，但 parquet 回退没有验证 `documents.text_unit_ids` 是否真实存在于 `text_units.parquet`，因此不能保证 `query_ready` 前具备有效 text-unit identity。 |
| 6 | PASS | 修复后的 mapping 会同时写入 `document-identity-map.yaml` 和 sidecar，持久化文档身份映射与 sidecar 保持一致。 |
| 7 | FAIL | 多文档输出下，sidecar 的 `graphDocumentId` 未与 `documents.parquet` 做行级验证；错误的 graph document 仍可在 text-unit id 存在时绑定到当前 book。 |
| 8 | FAIL | 当前路径可把 parquet 关系损坏（例如 documents 声明的 text-unit id 不存在于 text_units）降级为可发布 identity，存在掩盖真实 artifacts 损坏的风险。 |
| 9 | PASS | 现有 `query_ready` 门控仍要求 producer manifest、producer stage checkpoints、artifact lineage、provider/stage/corpus fingerprint 和 qmd corpus registration。 |
| 10 | FAIL | 新测试覆盖了 stale sidecar 元数据修复，但没有覆盖 invalid evidence rejection 与 stale metadata repair 的明确区分，尤其缺少 graph-document 缺失、wrong graphDocumentId、parquet text-unit 关系损坏等拒绝用例。 |

## 阻断问题

1. `src/job-state/graphrag-book.ts:797` 的 sidecar 验证只调用
   `graphTextUnitIdsExist`，而 `graphTextUnitIdsExist` 只读取
   `text_units.parquet`。该路径没有确认 `graphDocumentId` 存在于
   `documents.parquet`，也没有确认 document row 的 `text_unit_ids` 与
   sidecar/text_units 关系一致。结果是 stale metadata repair 不满足
   “graph document and text unit evidence still validate” 的边界。

2. `src/job-state/graphrag-book.ts:671` 的 parquet fallback 会从
   `documents.text_unit_ids` 收集 id，并在 `text_units.parquet` 缺少对应
   `id` 行时仍可能返回 mapping。`recordGraphTextUnitIdentityIfAvailable`
   随后会写入 document identity map 和 sidecar，使无效 text-unit evidence
   进入 `query_ready` 发布链。

3. 测试改动将原本拒绝 stale sidecar `contentHash`/`normalizedPath` 的用例
   改为 repair 用例，但没有新增等价的拒绝用例证明 mismatched
   `bookId/sourceId/sourceHash/documentId`、missing text units、wrong
   `graphDocumentId`、multi-document wrong binding、parquet relation corruption
   仍被阻断。

## 建议修复

1. 增加统一的 GraphRAG text-unit identity evidence validator
   （证据验证器），同时读取 `documents.parquet` 与 `text_units.parquet`：
   必须确认 `graphDocumentId` 存在于 documents；sidecar/fallback 的
   `graphTextUnitIds` 必须是该 document row 与 scoped text_units 的一致集合
   或合法子集；多文档输出不得在缺少明确 document match 时自动绑定。

2. parquet fallback 返回 mapping 前应复用同一个 validator。不能仅凭
   `documents.text_unit_ids` 生成 identity；必须证明这些 id 在
   `text_units.parquet` 中存在，并且按 `document_id` 归属于同一
   `graphDocumentId`。

3. 测试应补齐拒绝矩阵（rejection matrix）：stale metadata repair 通过；
   mismatched book/source/document sidecar 不被信任；sidecar 引用缺失
   text units 被拒绝或仅在独立有效 parquet 证据下恢复；sidecar
   `graphDocumentId` 不存在于 documents 被拒绝；multi-document wrong
   `graphDocumentId` 被拒绝；documents 声明 text-unit id 但 text_units 缺行时
   不允许 `query_ready`。
