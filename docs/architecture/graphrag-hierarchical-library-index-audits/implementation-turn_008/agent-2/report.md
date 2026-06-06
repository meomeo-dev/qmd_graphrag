# implementation-turn_008 / agent-2 审计报告

结论：`PASS_WITH_RISK`

审计范围：书-书架-Library 层级 GraphRAG 索引改造当前实现。  
规范入口：`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`。  
固定基准：
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`。  
审计方式：只读审计，未修改文件。

## 总体判定

当前实现已经形成书架与 library 两级可发布派生索引闭环：membership、
graph build、validator、scoped query、typed error、timing 和固定预算测试均有
实现证据。主线程验证中的 build、相关回归测试、contracts、library smoke query、
qmd vsearch 均通过，可支持本轮 `PASS_WITH_RISK`。

风险保留点：单书真实 GraphRAG 查询仍因外部 provider/runtime 超时返回
`provider_unavailable`，属于 recoverable blocked，不应记为成功回答；另有
`src/graphrag/upper-index/library-membership.ts` 和 `bookshelf-membership.ts`
文件长度超过项目建议阈值，后续新增能力前应拆分。

## D01 单书包复制传播完整性

判定：PASS

证据：书架 membership 读取 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、hotplug
quality gate 和 runtime gate，并调用单书包校验；上层产物根目录限定在
`graph_vault/catalog/bookshelves/**` 与 `graph_vault/catalog/library/**`。主线程
qmd vsearch smoke 成功。

风险：单书真实 GraphRAG provider 仍 blocked，但 timeout 已 fail-closed，不影响
单书包文件闭包。

## D02 上层派生物不污染单书包

判定：PASS

证据：membership/build 写入 `catalog/bookshelves/{id}` 或 `catalog/library/{id}`
的 `staging`、`current`、`runs`、`CURRENT.json`；未见写回
`graph_vault/books/{bookId}` 的路径。书架/library manifest 均为可重建派生物。

风险：无阻断风险。

## D03 runner ledger 不进语义检索

判定：PASS

证据：builder 语义输入来自单书或书架的 `community_reports`、`entities`、
`relationships`、`text_units`、`evidence_map`。`runs/**` 仅写
events/status/checkpoints/recovery summary，并作为状态/观测文件纳入 manifest
closure，不作为 query bridge 的 semantic input。

风险：manifest `files` 包含 `runs/**` 用于闭包校验，需继续防止后续 query 或
builder 将其误用为候选语义源。

## D04 固定查询预算

判定：PASS

证据：书架/library build 将 `maxSemanticUnits` 传入 Python bridge，并在
build/query 阶段执行 token 与 top-K 限制；library 10/100/1000 模拟规模测试验证
`selectedReportCount`、`estimatedInputTokens` 和 evidence count 不随规模线性增长。
超预算返回 `budget_exceeded_narrow_scope_required`。

风险：当前 query 是 fixed-budget report search，尚未实现 LLM synthesis 与受控下钻；
这与 Type DD 的 phased grounding 一致。

## D05 evidence lineage

判定：PASS

证据：query evidence 输出包含 `bookId`、`sourceId`、`documentId`、`contentHash`、
`graphTextUnitId`、community report artifact 和 upper metadata；library evidence 含
`targetBookshelfId`、`targetCommunityReportId`、`targetArtifactDigest`。

风险：当前 evidence lineage 已够审计追溯，但更丰富的跨层图关系仍依赖后续
LLM/community synthesis 增强。

## D06 stale/failed/pending fail-closed

判定：PASS

证据：query 前调用 validator；成员 manifest sha 变化会诊断
`member_manifest_stale` 或 `member_bookshelf_manifest_stale` 并映射为
`upper_index_stale`。membership-only manifest 的 `queryReady=false`，不能授权查询。
library stale 测试覆盖 query 拒绝。

风险：对 `staging/running/pending` 的拒绝主要通过只读 `current` 与 gate/manifest
校验体现，建议继续补 CLI 级 staging/pending fixture 测试。

## D07 manifest/gate/publish 状态闭环

判定：PASS

证据：build 使用 staging -> validate -> atomic publish current；manifest、quality
gate、diagnostics、checksums、CURRENT pointer、runs/status/recovery summary 均形成
闭包。validator 校验 manifest schema、quality gate required checks、file sha/bytes、
parquet schema 和 member stale。

风险：原子发布使用 rename 替换 current，跨文件系统场景未覆盖，但当前 graph_vault
内路径通常满足。

## D08 CLI typed error/timing

判定：PASS

证据：CLI 支持 `--bookshelf-id`、`--library-id` 且与 `--graph-book-id` 互斥；
upper scope error 映射为 typed error，包含 remediation、retryable、
scopeKind/scopeId。上层查询 timing stage 包含 `cli.query_bookshelf_upper_index` 和
`cli.query_library_upper_index`。单书 GraphRAG timeout CLI 测试覆盖
`provider_unavailable` typed JSON。

风险：真实单书 GraphRAG 仍是 external blocked/recoverable，不能作为成功查询能力入账。

## D09 敏感信息隔离

判定：PASS_WITH_RISK

证据：manifest/gate 写入前扫描 forbidden field 名称，禁止 provider payload、
raw prompt/completion、credential、absoluteLocalPath、query log 等进入上层
manifest/gate；locator 规则采用 graph_vault-relative/scope-relative。

风险：扫描以字段名文本匹配为主，不是结构化敏感信息检测；parquet 内容本身的
敏感信息扫描深度有限，建议后续补 artifact-level redaction/scan 测试。

## D10 单书 GraphRAG/qmd vsearch 非回归

判定：PASS_WITH_RISK

证据：主线程 qmd vsearch smoke 成功；单书 GraphRAG provider/runtime 卡死问题已通过
Python bridge timeout 变为 retryable typed failure，并确认无残留进程。相关 timeout
与 non-retry 测试已覆盖。

风险：单书 GraphRAG 真实回答未成功，状态应保持 external blocked/recoverable。最终
完成态不能把该项描述为“成功回答”。

## 必须修复项

无阻断本轮 `PASS_WITH_RISK` 的必须修复项。

转为无风险 `PASS` 前必须处理两点：恢复或替换可用的单书 GraphRAG
provider/runtime，使 `--graph-book-id` 能真实成功回答；在继续新增功能前拆分
`library-membership.ts`、`bookshelf-membership.ts` 等超长 upper-index 模块。

## 建议

保留当前实现方向，进入 implementation-turn_008 汇总时明确标注单书 GraphRAG 为
external blocked/recoverable。后续补三个低成本测试：CLI 级 stale library typed
error、staging/pending upper index 不可查询、上层 parquet artifact 敏感字段扫描。
