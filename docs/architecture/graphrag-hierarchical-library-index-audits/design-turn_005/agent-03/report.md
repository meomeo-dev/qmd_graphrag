# design-turn_005 agent-03 设计审计报告

overallStatus: pass

审计对象：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-pipeline-io.type-dd.yaml`

审计基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

审计重点为反例与故障恢复（counterexample and recovery），尤其检查用户
只复制单书包、qmd index 缺失、GraphRAG 网络中断、LLM suggestion 未接受、
超大分类拆分、虚拟父书架、library direct book 超限、删除 catalog 上层
索引、stale member manifest 等场景下，pipeline I/O 是否 fail closed
且诊断可恢复。

## D01_authority_boundaries

status: pass

设计保持单书包 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、包内 qmd /
GraphRAG / state gate 为包权威。pipeline I/O 明确 catalog、书架和 library
均为派生状态，不改变单书身份、文件闭包或直接单书查询 query_ready 判定。
用户只复制单书包时，只有具备发布标记和包内质量门的包会进入 mount
projection；删除 catalog 上层索引只影响上层 scope，不破坏单书查询。

反例覆盖：

- 只复制单书包但未带 `PUBLISH_READY`：不投影入书架候选，诊断为 rejected
  package。
- 删除 bookshelf/library catalog artifacts：上层返回 missing/stale typed
  error，单书查询仍由单书包 gate 决定。

必须修订项：无。

## D02_fixed_query_budget

status: pass

主设计定义固定交互预算，包括 `maxSemanticUnits`、`maxBookshelves`、
`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用数、输入输出
token 上限。pipeline I/O 的 scoped query 阶段禁止交互时全量扫描所有书
或隐式构建上层索引；超预算输出
`budget_exceeded_narrow_scope_required`，要求收窄 scope。虚拟父书架查询
通过固定 top-K 路由到子物化书架，过宽时返回 scope refinement。

反例覆盖：

- 超大分类拆分：物化书架超过 hard limit 或语义密度预算时先拆分，父节点
  保持虚拟。
- 证据候选超预算：查询 fail closed，不扩大 map 调用或扫描全部成员书。

必须修订项：无。

## D03_graphrag_semantic_alignment

status: pass

上层书架和 library 构建输入包含下层 `community_reports.parquet`、
`entities.parquet`、`relationships.parquet` 与受界的 `text_units` 引用。
设计要求生成 `semantic_edges.parquet`、上层 `communities.parquet` 和
`community_reports.parquet`，并从 entity、relationship、社区关系派生
语义边。查询综合基于预计算 semantic units 和 community reports，未退化
为普通摘要检索。

反例覆盖：

- GraphRAG 构建/网络中断导致必需 artifacts 不完整：质量门不通过，staging
  generation 不发布为 query-ready 上层索引。
- runner ledger、events、recovery summary 被禁止作为语义输入，避免把运行
  诊断误当成 GraphRAG 内容。

必须修订项：无。

## D04_evidence_traceability

status: pass

设计定义 `evidence_map.parquet`，必需字段覆盖 `bookId`、`sourceId`、
`documentId`、`contentHash`、`communityReportId`、`textUnitId`、artifact
digest 与 generation。书架与 library 质量门要求每个上层 semantic unit
或 community report 回链到下层证据；查询输出需提供 evidence lineage。

反例覆盖：

- 上层摘要无证据回链：质量门失败，返回 `upper_quality_gate_failed`，不会
  发布或查询。
- stale member manifest：digest 不匹配时标记 stale，不允许继续使用旧
  evidence lineage 作为默认查询依据。

必须修订项：无。

## D05_state_recovery

status: pass

设计包含 durable checkpoints、events、status、recovery summary、staging
发布协议和 publish marker 最后写入规则。pipeline I/O 要求阶段输出只有在
质量门通过并写入 publish marker 后才能成为下游权威输入；failed、running、
pending、stale 和 staging 产物不得被下游当作 ready 输入。成员 digest
变化会标记 `stale_not_query_ready` 或产生新 generation。

反例覆盖：

- GraphRAG 网络中断或 provider timeout：中断构建可从已验证 checkpoints
  恢复，失败 staging 不提升为 current。
- partial publish：未完成 quality gate 与 publish marker 时，下游拒绝。
- stale member manifest：书架/library 构建或查询前 digest 校验失败，
  返回 stale 诊断并要求 rebuild。

必须修订项：无。

## D06_quality_gates

status: pass

书架和 library 均有独立质量门，覆盖 schema、checksum、成员一致性、
LLM suggestion 接受状态、超大分类拆分、虚拟父书架、direct book limit、
semantic/evidence schema、embedding fingerprint、固定预算模拟、敏感扫描
和 stale marker。失败时输出 `upper_quality_gate_failed` 及 check id，
查询不可用且诊断文件具备机器可读字段。

反例覆盖：

- qmd index 缺失：单书发布 gate 要求 bundled qmd index 有效或包内重建
  完成；mount projection 不得用 stale/failed projection 替代包就绪证明。
- LLM suggestion 未接受：membership gate 和 handoff 均拒绝 suggestion-only
  成员进入构建。
- library direct book 超限：library membership gate 失败，不发布 query-ready
  library。

必须修订项：无。

## D07_incremental_scaling

status: pass

成员记录包含 `manifestSha256`、`packageGeneration` 和 generation。书架与
library generation 规则覆盖成员 digest、builder version、embedding model、
clustering config、summary config 和 evidence schema 变化。设计支持在可由
checksum 证明未变时局部刷新；无法局部化 graph connectivity 变化时，保守
标记 stale 并创建新全量 generation。大库通过物化书架、虚拟父书架和 nested
partition 限制直接重建范围。

反例覆盖：

- stale member manifest：旧上层索引 default query 拒绝，repair/rebuild
  重新跑完整质量门。
- 超大 library：direct book 超限或 shelf count 超限时要求分层/分区后再
  构建交互 GraphRAG 索引。

必须修订项：无。

## D08_security_privacy

status: pass

设计和 pipeline I/O 均定义 forbidden inputs / sensitivity policy，禁止
provider payload、原始 prompt/completion、credential、绝对路径和 query log
进入可发布 manifest、索引或诊断。诊断只允许 digest、schema id、check id、
bounded summary 和 scope-relative locator；质量门包含敏感信息扫描。

反例覆盖：

- GraphRAG 运行日志或 provider payload 被误放入上层 manifest：敏感扫描
  失败并阻止发布。
- LLM suggestion rationale：只允许 bounded redacted summary，不得记录可逆
  请求材料。

必须修订项：无。

## D09_cli_operability

status: minor_note

主设计定义 scope resolution order、typed query errors、exit code、
remediation command 与分阶段 timing fields。无 scope、ambiguous scope、
missing index、stale、quality gate failed、over budget 均有快速 typed
error，不触发隐式全库构建或交互式全量扫描。pipeline I/O 的 scoped query
阶段也要求缺失、stale、超预算或 gate failed 时输出 typed error，并提供
bounded timing breakdown。

非阻断注意事项：

- pipeline I/O scoped query failureOutputs 使用 `scope_not_found`，而主设计
  typedErrors 使用 `missing_scope` 和 `ambiguous_scope`。实现合同应收敛错误码，
  建议将 pipeline I/O 的 `scope_not_found` 映射或改名为主设计的
  `missing_scope`，并保留 `ambiguous_scope` 独立分支，避免 CLI/测试断言分裂。

必须修订项：无阻断修订项。

## D10_testability

status: pass

主设计和 pipeline I/O 均提供超过 8 个 required cases，覆盖 hotplug 非回归、
固定预算、stale、missing upper index、质量门失败、LLM suggestion 未接受、
accepted suggestion 新 generation、超大分类拆分、虚拟父书架、direct book
超限、证据回链、安全扫描和 partial publish 恢复。pipeline I/O 额外包含
qmd projection 存在但 bundled qmd index 缺失、member manifest sha256 变化、
删除 catalog 上层 artifact 不破坏单书查询等反例。

反例覆盖：

- 10/100/1000 books 固定预算验证已在主设计测试合同中列出。
- 单书 hotplug 非回归和 catalog 删除非回归已在两份文档测试合同中列出。

必须修订项：无。

## 故障场景结论

以下指定反例均有 fail-closed 与可恢复诊断路径：

- 用户只复制单书包：缺发布标记或 gate 不通过时不进入书架候选；已发布单书
  不依赖 catalog 上层索引。
- qmd index 缺失：包发布 gate 或 mount handoff 拒绝，并写 typed diagnostic。
- GraphRAG 网络中断：staging 不发布，保留 checkpoints/events/recovery
  summary，可恢复或重跑。
- LLM suggestion 未接受：保持 suggestion-only / pending_user_acceptance，
  不可作为 query-ready 输入。
- 超大分类拆分：超过书架 hard limit 或预算时先生成虚拟父书架与物化子书架。
- 虚拟父书架：不拥有 semantic units 或 community reports；无物化子书架时
  visible but not query-ready。
- library direct book 超限：library membership gate 失败，返回对应 check id。
- 删除 catalog 上层索引：上层 scope 返回 `upper_index_missing`；单书查询
  不受影响。
- stale member manifest：标记 `stale_not_query_ready` 或返回
  `upper_index_stale`，默认查询拒绝并提供 rebuild/status 命令。

## 必须修订字段或章节

无 fail，因此无必须修订字段或章节。

## 非阻断实现注意事项

- 统一 pipeline I/O 与主设计的 scope 缺失错误码，避免
  `scope_not_found`、`missing_scope` 和 `ambiguous_scope` 在 CLI、JSON schema
  与测试断言中形成三套语义。
- qmd index 缺失场景应在实现中区分“可包内重建完成”与“只能使用 catalog
  projection 替代”的情况；后者必须继续拒绝，避免 projection 越权成为包权威。
- GraphRAG provider timeout、网络中断和本地 I/O 中断应统一落到 bounded
  diagnostics，并确保不记录 raw prompt/completion 或 provider payload。
