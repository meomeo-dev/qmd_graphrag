# Agent C Design Audit Report

审计对象：`audit/graphrag-identity-sidecar-recovery-run_1/design.md`

固定基准：
`audit/graphrag-identity-sidecar-recovery-run_1/agent-c/audit-criteria.md`

真实失败证据：`status.yaml` 记录批处理
`epub-batch-20260526-resume-after-auth` 在 `resume-book-1` 阶段失败，
错误为 `GraphRAG document identity sidecar evidence is invalid for
query_ready: doc-fd8875181a17`。

## 逐条结论

1. PASS - 状态管理和恢复机制要求

设计将 `recordGraphTextUnitIdentityIfAvailable` 调整为当前 Parquet 优先，
随后才读取侧车，并在 `required=true` 时保持失败边界。该策略覆盖
`syncGraphRagBookWorkspace` 恢复路径、repository 记录、侧车重写和
`query_ready` 门控，不把身份修复等同于阶段完成。

2. PASS - 避免历史侧车陈旧导致已完成书永久 stop

设计明确把 `qmd_graph_text_unit_identity.json` 作为可修复缓存
（repairable cache），当前 `documents.parquet` 与 `text_units.parquet`
自洽时可重写侧车，避免旧侧车阻断恢复计划。测试要求也覆盖批处理 status
不再把该失败标记为永久本地 stop。

3. PASS - 避免可用当前 Parquet 证据下重复昂贵 LLM 重建

设计要求优先复用当前 Parquet 身份证据，并新增约束：新的 `graph_extract`
被接受后，下游 `community_report` 和 `embed` 仍按 resume plan 补齐。这避免
因旧侧车不一致重复执行 `graph_extract` 高成本 LLM 阶段，同时不伪造下游完成。

4. PASS - Parquet 证据损坏时停止而非静默降级

设计声明当前 Parquet 身份证据不自洽时不得发布或保留 `query_ready`
capability；侧车只有通过当前 Parquet 交叉验证才可使用。当前 Parquet 损坏且
`required=true` 时，恢复路径应继续抛出身份缺失或无效错误。

5. PASS - 保持侧车可审计、可重建

设计把侧车定义为可修复缓存而非唯一真源，并要求在当前 Parquet 身份存在或
侧车交叉验证通过后重写规范侧车。该策略保留可审计 JSON 证据，同时允许从
GraphRAG 当前输出重建。

6. FAIL - 缺少对 `document-identity-map` 与
`graph_text_unit_identity_map` 的明确影响说明

设计只写到记录到 repository 和重写 catalog 映射，未明确
`GraphTextUnitIdentityMap` 输入如何投影到
`catalog/document-identity-map.yaml`，也未说明 `graphDocumentId`、
`graphTextUnitIds`、`metadata.graphTextUnitCount`、`normalizedPath` 与既有
`qmdCorpusRegistered` 元数据的更新和保留规则。

必须修改的设计项：增加 “Catalog Projection” 或等价章节，明确当前 Parquet
身份修复后生成 `GraphTextUnitIdentityMap`，repository 以匹配
`bookId/sourceId/sourceHash/documentId/contentHash` 的记录更新
`document-identity-map.yaml`；说明不会创建未登记 QMD corpus 的新身份，不会
覆盖无关书籍记录，并声明旧 graph text unit ids 被当前自洽 Parquet 集合替换。

7. PASS - 与 GraphRAG 产物隔离和阶段门控前序修复一致

更新后的设计明确禁止把新 `graph_extract` 与旧 `community_report`、
`embed`、`query_ready` lineage 混合成 ready 状态。`Query-Ready Gate` 仍要求
producer run id、book-scoped artifact、stage fingerprint、provider
fingerprint 和 corpus content hash 匹配，符合前序产物隔离和阶段门控边界。

8. PASS - 限制运行产物依赖且不把本地临时路径写入源码

设计依赖受管理的当前 GraphRAG 输出、producer manifest、artifact validator
和侧车文件，没有要求把 `/tmp`、真实运行目录、`graph_vault` 实例路径或其他
本地临时路径写入源码。`Non-Goals` 也明确不提交运行产物。

9. FAIL - 缺少开发后审计的固定验收信号

设计列出了测试场景，但没有给出固定验收信号（acceptance signals），例如
必须执行的命令、必须通过的测试名称、批处理 status 中必须出现或不得出现的
字段，以及 capability catalog 的最终可观测条件。仅有场景描述不足以作为
后续审计的稳定判据。

必须修改的设计项：增加 “Post-Implementation Acceptance Signals” 章节，
列出固定命令和期望结果，例如指定 `vitest` 文件或测试名必须通过；真实失败
夹具恢复后不再出现 `recoveryDecision=stop_until_fixed`；新 `graph_extract`
被复用后 `resumePlan.nextStage` 必须指向待补齐下游阶段；未完成当前 lineage
前不得发布 `graph_query` capability。

10. FAIL - 缺少明确剩余风险

设计包含 `Non-Goals`，但没有单独列出剩余风险（residual risks）。本次变更
涉及历史侧车、当前 Parquet、producer manifest、batch repair 和 capability
发布的交界面，缺少剩余风险会降低后续实现和审计时的问题定位能力。

必须修改的设计项：增加 “Remaining Risks” 章节，至少说明 Parquet 选择逻辑
在多文档输出中的误绑定风险、Python/Pandas 读取 Parquet 的环境风险、
producer manifest 与实际输出被部分覆盖时的恢复风险，以及批处理 repair-only
路径仍可能因非身份类本地 gate 失败而 stop 的边界。

## 总体结论

更新后的设计已覆盖真实失败的核心原因，并补上禁止混用新旧 producer lineage
的关键约束。但在 catalog map 影响、固定验收信号和剩余风险三项固定基准上仍
缺少必须的设计内容，因此本轮设计审计不通过。

verdict: design_audit_failed
