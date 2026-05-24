# qmd 与 GraphRAG 统一检索面规范

## 结论

`qmd` 是全集检索入口（whole-corpus retrieval entry）。
`GraphRAG` 是对指定语料启用的图增强层（graph enhancement layer）。

本文定义准生产契约（pre-production contract）和实现映射
（implementation map）。审计时必须同时核对契约文件、实现文件、测试和
运行产物。

两者不是平级产品，也不是两套互不相干的检索宇宙。系统必须满足：

- 所有可检索内容先进入 qmd corpus。
- 启用 GraphRAG 的书或文档同时保留在 qmd corpus 中。
- `qmd query` 覆盖全集，包括已完成图增强的文档。
- `qmd query --graphrag` 覆盖具备 `graph_query` capability 的子集。
- `qmd query --mode auto` 以 qmd 全集召回为入口，并按 typed route
  decision 调用 GraphRAG 增强能力。

正确关系为：

```text
source documents
  -> corpus normalization
  -> qmd corpus index
  -> qmd query

selected corpus documents
  -> graph enhancement
  -> graph_vault
  -> qmd query --graphrag
```

## 数据平面

系统只有一个逻辑语料平面：qmd corpus。

qmd corpus 负责全集事实（whole-corpus facts）：

- 文档身份。
- 内容 hash。
- 规范化文本。
- chunk 身份。
- lexical index。
- vector index。
- rerank candidate。

GraphRAG vault 负责增强事实（enhancement facts）：

- 书级处理状态。
- GraphRAG documents、text units、entities、relationships、communities。
- community reports。
- GraphRAG LanceDB。
- graph capability。

GraphRAG vault 不拥有全集语料身份。它只能引用 qmd corpus 中已登记的
source、document、content 和 chunk identity。

## 职责边界

### qmd 普通查询

`qmd query` 用于全集检索。

适用场景：

- 对全部入库内容做关键词、语义和重排检索。
- 快速定位原文片段、文件、章节、代码或笔记。
- 检索未启用 GraphRAG 的普通文档。
- 检索已启用 GraphRAG 的规范化原文。
- 低成本、高频、探索式查询。

能力边界：

- 返回 chunk 或文档证据。
- 支持 query expansion、embedding 和 rerank。
- 不承担实体关系、多跳归纳或全书级综合报告职责。

### qmd 基础检索命令

`qmd search`、`qmd vsearch` 与 `qmd query` 是同一 qmd corpus 的不同能力
投影，不是三套索引。

| 命令 | 语料范围 | Provider 边界 | 输出契约 | 成本边界 |
| --- | --- | --- | --- | --- |
| `qmd search` | qmd corpus 全集 | 不调用 LLM、embedding、rerank 或 GraphRAG provider | `QmdSearchResult` | 本地 SQLite/FTS 成本 |
| `qmd vsearch` | qmd corpus 全集的 active vector index | 只允许 embedding/vector lookup；不得调用 query expansion、generation、rerank 或 GraphRAG provider | `QmdVectorSearchResult` | embedding provider 成本；已缓存 query embedding 时为本地向量成本 |
| `qmd query` | qmd corpus 全集 | 允许 query expansion、embedding、rerank；generation 只可通过 OpenAI Responses stream | `UnifiedAnswer` | qmd RAG 成本 |
| `qmd query --graphrag` | graph-ready 子集 | 允许 GraphRAG provider、OpenAI Responses stream、Jina embedding/rerank | `UnifiedAnswer` | graph query 成本 |

硬不变量：

- `qmd vsearch` 的 typed request 是 `QmdVectorSearchRequest`。
- `QmdVectorSearchRequest.providerPolicy.generation` 恒为 `false`。
- `QmdVectorSearchRequest.providerPolicy.queryExpansion` 恒为 `false`。
- `QmdVectorSearchRequest.providerPolicy.rerank` 恒为 `false`。
- `qmd vsearch` 只消费已写入 `content_vectors` 与 `vectors_vec` 的向量索引。
- `qmd vsearch` 的查询端 embedding 必须使用 active embedding model 与
  `embedFingerprint` 过滤，不能读取模型不匹配的向量。
- DSPy 只优化 `qmd query` 的 query expansion policy，不改变 `qmd vsearch`
  的无扩展语义。

### GraphRAG 增强查询

`qmd query --graphrag` 是 qmd 的图增强查询能力。

适用场景：

- 对已完成 GraphRAG 入库的书或文档做图问答。
- 需要实体、关系、community report 或跨章节综合。
- 需要 `local`、`global`、`drift` 或 `basic` GraphRAG 查询方法。
- 可接受更高延迟和 LLM 成本。

能力边界：

- 只覆盖具备 `graph_query` capability 的文档或书。
- 不绕过 qmd corpus。
- 不直接消费未登记到 qmd corpus 的临时文件。
- 输出必须回连到统一 evidence contract。
- 查询对象未具备 capability 时返回 typed capability error。

## 查询路由

查询路由由 typed request 明确表达。

```text
qmd query <query>
```

route 为 `qmd`，查询全集 qmd corpus。

```text
qmd query --graphrag <query>
```

route 为 `graphrag`，查询 graph-ready 子集。

```text
qmd query --mode auto <query>
```

route 为 `auto`。数据流顺序固定：

1. qmd corpus 召回候选。
2. 将 `QmdRetrievalCandidate` 映射到已验证 `GraphCapability`。
3. `decideRoute()` 原子计算 graph coverage、intent class 和 cost class。
4. `decideRoute()` 产出 `QueryRouteDecision`。
5. `QueryRouteDecision.selectedRoute` 为 `graphrag` 时调用 GraphRAG。
6. `buildUnifiedAnswer()` 将 route decision、答案和 evidence 归一化为
   `UnifiedAnswer`。
7. CLI/MCP formatter 输出 `UnifiedAnswer`。

路由规则：

- 不确定使用哪种能力时，使用 `qmd query`。
- 查询对象尚未 graph-ready 时，`--graphrag` 必须返回 typed capability
  error，而不是静默退回 qmd 普通检索。
- 需要全书总结、概念关系、跨章节归纳、多跳语义时，使用 `--graphrag`
  或 `--mode auto`。
- 普通定位、找原文、找文件、找 chunk 时，使用 `qmd query`。
- `auto` 只有在 intent class 属于 graph synthesis，graph coverage 达到
  routing threshold，且 request cost policy 允许时才升级。

intent class 枚举：

- `lookup`
- `source_location`
- `chunk_retrieval`
- `single_document_summary`
- `graph_synthesis`
- `multi_hop_reasoning`

graph coverage 计算：

```text
graphCoverage = graphReadyCandidateCount / totalCandidateCount
```

cost class 枚举：

- `low`
- `medium`
- `high`

route refusal reason 枚举：

- `no_graph_ready_candidate`
- `coverage_below_threshold`
- `intent_not_graph_synthesis`
- `cost_policy_exceeded`
- `graph_upgrade_disabled`
- `capability_missing`

`provider_unavailable` 与 `provider_response_invalid` 是 GraphRAG 执行期
typed error code，不是 route refusal reason。`auto` 在路由阶段只能基于
capability、intent、coverage 和 cost policy 做升级或回退；provider 调用已开始
后失败时，CLI/MCP 返回 `TypedQueryError`，不伪造为路由回退。

`QueryRouteDecision` 必须包含：

- `requestedRoute`
- `selectedRoute`
- `reasonCode`
- `intentClass`
- `costClass`
- `maxCostClass`
- `graphCoverage`
- `candidateDistribution`
- `selectedSourceIds`
- `selectedDocumentIds`
- `selectedContentHashes`
- `selectedBookIds`
- `candidateEvidenceIds`
- `graphCapabilityIds`
- `graphArtifactIds`
- `candidateDecisions`
- `refusalReasons`

GraphRAG 被选中时，`selectedSourceIds`、`selectedDocumentIds` 和
`selectedContentHashes` 从已验证 `GraphCapability` 派生；qmd 候选只提供召回证据。

`candidateDecisions` 必须逐候选记录：

- `candidateId`
- `sourceId`
- `documentId`
- `bookId`
- `isGraphReady`
- `retrievalScore`
- `rerankScore`
- `selected`
- `selectionReason`
- `refusalReason`

CLI 和 MCP 入口共享同一个 `routeQuery()` 应用服务。CLI、MCP、JSON 输出和
人类可读输出只做参数解析与 formatter 投影，不拥有独立路由逻辑。

## 实现映射

- `qmd query`、`qmd query --mode auto`、`qmd query --graphrag` 均调用
  `src/query/unified-router.ts#routeQuery`。
- CLI 查询入口位于 `src/cli/qmd.ts#querySearch`、
  `src/cli/qmd.ts#autoQuerySearch` 和
  `src/cli/qmd.ts#graphRagQuerySearch`。
- MCP 查询入口位于 `src/mcp/server.ts#createMcpServer`，并共享同一
  `routeQuery` contract。
- qmd 召回候选由 `src/query/qmd-candidates.ts#toQmdRetrievalCandidates`
  投影为 `QmdRetrievalCandidate`。
- GraphRAG capability 由
  `src/graphrag/capability-catalog.ts#loadGraphCapabilities` 和
  `src/graphrag/capability-catalog.ts#resolveCandidateGraphCapabilities`
  提供。
- GraphRAG provider 调用由 `src/integrations/graphrag.ts#runGraphRagQuery`
  执行，provider 失败以 `TypedQueryError` 返回到 CLI/MCP。
- 统一答案由 `src/query/unified-answer.ts#buildUnifiedAnswer` 生成。
- 路由、证据、错误和答案 contract 位于
  `src/contracts/unified-query.ts`。

## 入库不变量

GraphRAG 入库是 qmd 入库的增强，不是替代。

对任意 source document 启用 GraphRAG 时，流水线必须产生两类结果。

### qmd Corpus Registration

必须完成：

- 生成 `SourceDocument`。
- 生成 `CorpusDocument`。
- 生成 `CorpusChunk`。
- 写入 qmd lexical index。
- 写入 qmd vector index。
- 建立 `sourceId -> documentId -> contentHash -> chunkId` 映射。

完成后，该内容可通过 `qmd query` 检索。

### Graph Enhancement Registration

必须完成：

- 通过 `FileBookJobStateRepository.buildGraphEnhancementRequest()` 生成
  `GraphEnhancementRequest`。
- 通过 `FileBookJobStateRepository.getGraphEnhancementState()` 从
  `BookJob`、checkpoint 与 artifact manifest 投影 `GraphEnhancementState`。
- 写入 GraphRAG artifacts。
- 写入 `GraphCapability`。
- 建立 `bookId -> sourceId -> documentId -> graphTextUnitId` 映射。

完成后，该内容可通过 `qmd query --graphrag` 查询。

GraphRAG 失败时不得写入 `graph_query` capability。qmd corpus registration
成功且 GraphRAG registration 失败时，`qmd query` 仍查询全集，
`qmd query --graphrag` 返回 capability error。

## 统一身份模型

核心身份：

- `sourceId`：源文件内容身份，由 `sourceHash` 派生。
- `sourceLocator`：源文件定位信息，不参与 canonical identity。
- `documentId`：qmd 文档身份，绑定 sourceId、contentHash、
  normalizationPolicyVersion。
- `bookId`：书级处理身份，由 `sourceHash` 派生。
- `bookDisplaySlug`：书名展示和工作区可读性字段，不参与去重 identity。
- `contentHash`：规范化文本内容 hash，包含 normalization policy version。
- `chunkId`：qmd chunk 身份，基于 contentHash、chunk strategy、seq、pos。
- `graphTextUnitId`：GraphRAG text unit 身份，由 GraphRAG output 产生。
- `graphDocumentId`：GraphRAG document 身份，由 GraphRAG output 产生。

必要映射：

```text
sourceHash -> sourceId
sourceId -> canonicalBookId
sourceId -> documentId
documentId -> contentHash
contentHash -> chunkId
documentId + contentHash -> graphDocumentId
documentId + contentHash -> graphTextUnitId[]
canonicalBookId -> graph_vault workspace
```

路径只作为 locator。不同设备路径不得改变 `sourceId`、`bookId`、
`documentId`、`contentHash` 或成本去重 key。内容相同但文件名不同的源文件
共享 canonical book identity；展示名通过 alias 记录。规范化内容变化产生
新的 `contentHash` 与 `documentId`。

qmd chunk 与 GraphRAG text unit 都是一等 evidence identity。GraphRAG
readiness 与 query scope 使用 `sourceId/documentId/contentHash/bookId` 和
validated capability 判断。`DocumentIdentityMap` 持久化
`graphDocumentId` 与 `graphTextUnitIds`，用于审计 GraphRAG text unit 的
生产者、消费者和查询证据回连。GraphRAG 内部 document title 只作为 frame
裁剪 locator，不参与 readiness 或权限判断。

`query_ready` 只引用已验证的查询产物，不改写产物生产阶段。community report
artifact 的 producer stage 必须是 `community_report`，LanceDB artifact 的
producer stage 必须是 `embed`。`query_ready` checkpoint 引用这些上游产物，
并且只有在 `DocumentIdentityMap` 已写入 `graphDocumentId` 与非空
`graphTextUnitIds` 时发布 graph capability。

成本去重 key 为：

```text
sourceHash + contentHash + stageFingerprint + providerFingerprint
```

`providerFingerprint` 是 provider request boundary fingerprint，由 OpenAI
Responses、Jina、LanceDB 和 GraphRAG 模型边界的脱敏配置投影产生。artifact
locator、artifact path 和 runId 不参与高成本去重 key。

## 统一数据总线

系统数据总线分五层。

### Corpus Bus

负责全集内容入库。

核心类型：

- `SourceDocument`
- `CorpusDocument`
- `CorpusChunk`
- `DocumentIdentityMap`

职责：

- qmd corpus 是全集事实表。
- GraphRAG 只能消费已登记的 source/document/content identity。
- corpus identity 不依赖宿主机绝对路径。
- `normalizationPolicyVersion` 进入 identity map、book job 和 artifact
  manifest。

### QMD Retrieval Bus

负责全集检索。

核心类型：

- `QmdQueryRequest`
- `QmdRetrievalCandidate`
- `QmdSearchResult`

职责：

- 表达 lex、vec、hyde、rerank、query expansion。
- 输出 typed evidence。
- 候选身份从 `document-identity-map` 投影；缺失时 `sourceId` 保持
  `null`，不得由 `contentHash` 伪造。
- 不把 formatter 输出作为下游输入。

### Graph Enhancement Bus

负责图增强索引。

核心类型：

- `GraphEnhancementRequest`
- `GraphEnhancementState`
- `GraphCapability`
- `GraphRagQueryRequest`
- `GraphRagQueryResponse`
- `GraphRagProviderDetail`

职责：

- 只对 selected subset 运行高成本图构建。
- `GraphEnhancementRequest` 是 `graphrag_index_request` 的上游意图投影。
- `GraphEnhancementState` 是 book job、stage checkpoint 与 artifact manifest
  的状态投影，不是手写独立状态源。
- `GraphRagIndexRequest.indexScope` 是单次 GraphRAG index adapter 调用的
  成本血缘作用域；index 成本账不得从全 vault 聚合无关 capability artifact。
- 记录 document/book 具备的 graph query capability。
- 记录 GraphRAG artifacts 与 qmd corpus identity 的映射。
- 记录 `DocumentIdentityMap.graphDocumentId` 与
  `DocumentIdentityMap.graphTextUnitIds`。
- query-ready 判定以 validated checkpoint 和 validated manifest 为唯一事实源。
- GraphRAG provider detail 只携带 provider/method typed metadata。原始
  provider context tables 保留在 bridge 内部状态，不进入数据总线。
- `GraphCapability` 和 qmd sqlite capability mirror 是可重建投影。
- book-state 派生的 `GraphCapability` 是路由权威来源。显式
  `graph-capabilities.yaml` 只补充未被派生结果覆盖的 capability，不能覆盖
  相同 `bookId/kind/method` 的派生 capability。

### Unified Answer Bus

负责用户查询出口。

核心类型：

- `UnifiedQueryRequest`
- `QueryRouteDecision`
- `CandidateRouteDecision`
- `EvidenceRef`
- `UnifiedAnswer`
- `TypedQueryError`

职责：

- 统一表达 `qmd`、`graphrag`、`auto` 三种 route。
- 所有回答引用统一 evidence。
- 不允许裸字符串 context 跨层传递。
- 人类可读 formatter 只消费 typed answer，不生产下游数据。

`EvidenceRef` 必须包含可解析身份：

- `sourceId`
- `documentId`
- `contentHash`
- `chunkId`
- `bookId`
- `graphCapabilityId`
- `graphTextUnitId`
- `artifactId`
- `locator`

qmd-only evidence 的 `sourceId` 可以为空，因为普通 qmd 语料不一定有
graph_vault source catalog。此时 `documentId` 和 `chunkId` 仍必须由 qmd
SQLite 语料事实稳定投影（stable projection），不能依赖 graph_vault 是否存在。
GraphRAG evidence 必须携带 `sourceId`、`documentId`、`contentHash`、`bookId`
和 `graphCapabilityId`。

`TypedQueryError` 必须包含：

- `schemaVersion`
- `route`
- `stage`
- `provider`
- `capability`
- `code`
- `retryable`
- `redactedMessage`

公共错误出口必须返回 `TypedQueryError` 顶层对象。显式 `--graphrag`
缺少 `graph_query` capability 时，`GraphCapabilityError` 作为领域错误对象嵌入
`TypedQueryError.graphCapabilityError`，并保留 `queriedScope`、`sourceId`、
`documentId` 和 `bookId` 字段。

### Provider Bus

负责外部模型服务边界。

核心类型：

- `OpenAIResponsesProviderConfig`
- `OpenAIResponsesStreamEvent`
- `OpenAIStructuredOutputSchema`
- `JinaEmbeddingRequest`
- `JinaEmbeddingResponse`
- `JinaRerankRequest`
- `JinaRerankResponse`

职责：

- OpenAI 生成能力只通过 Responses API。
- endpoint 使用 `/responses`，不得强制拼接 `/v1/responses`。
- Responses API 使用 stream 模式。
- graphrag-llm completion interface 的兼容对象只存在于 provider 适配边界；
  网络请求不得调用 Chat Completions API。
- 结构化输出 schema 使用 strict JSON schema。
- OpenAI Responses structured output JSON schema 的每个 object 节点必须显式
  `additionalProperties: false`；该规则不扩大为所有 Zod schema 的运行时约束。
- Jina 同时承担 embedding provider 和 rerank provider。
- provider cost accounting 必须引用 redacted request fingerprint artifact，
  不得持久化原始 provider 请求体或密钥值。
- provider cost accounting 必须包含一等字段 `requestArtifactId` 和
  `lineageMode`。`artifactIds` 必须包含 `requestArtifactId`。
- `lineageMode` 取值为 `corpus_artifact`、`graph_artifact`、
  `multi_document_query` 或 `transient_query`。无语料身份的记录只能使用
  `transient_query`。

## 配置模型

项目配置是运行意图的唯一配置入口。

位置：

```text
.qmd/index.yml
```

配置优先级：

```text
explicit --config
  -> nearest project .qmd/index.yml
  -> configured global qmd index
```

配置拥有：

- `collections`
- `models`
- `providers`
- `graphrag`
- `query`

示例：

```yaml
collections:
  books:
    path: graph_vault/input
    pattern: "**/*.md"
    context:
      /: Normalized books available to qmd and GraphRAG.

models:
  embed: jina:jina-embeddings-v5-text-small
  rerank: jina:jina-reranker-v3
  generate: openai:gpt-5.4

providers:
  openai:
    api_key_env: OPENAI_API_KEY
    base_url_env: OPENAI_BASE_URL
    response_api:
      endpoint: /responses
      stream: true
      reasoning_effort: medium
      strict_structured_output: true
  jina:
    api_key_env: JINA_API_KEY
    base_url_env: JINA_API_BASE
    base_url: https://api.jina.ai
    embedding_endpoint: /v1/embeddings
    rerank_endpoint: /v1/rerank
    embedding_profile: text
    embedding_model: jina-embeddings-v5-text-small
    rerank_model: jina-reranker-v3
    embedding_query_task: retrieval.query
    embedding_document_task: retrieval.passage
    embedding_dimensions: 1024
    embedding_normalized: true
    embedding_type: float
    embedding_truncate: true

embedding:
  chunk_strategy: regex

graphrag:
  enabled: true
  vault: graph_vault
  python_bin: .venv-graphrag/bin/python
  default_method: local
  default_response_type: multiple paragraphs
  enhanced_collections:
    - books

query:
  default_route: qmd
  allow_graph_upgrade: true
  auto_route:
    graph_coverage_threshold: 0.7
    max_cost_class: medium
```

`query.default_route` 只接受 `qmd` 或 `auto`。`graphrag` 是显式图增强入口，
只能通过 `qmd query --graphrag` 选择，不能作为无旗标 `qmd query` 的默认
路由。

密钥规则：

- 配置只保存环境变量名。
- `.env` 保存密钥值。
- `qmd` CLI 入口在解析命令前加载项目根 `.env`。项目根由最近的
  `.qmd/index.yml` / `.qmd/index.yaml` 决定；没有 project config 时使用当前工作
  目录。真实环境变量优先，`.env` 不覆盖。
- 加载的 `.env` 仅进入当前进程和子进程环境，用于 OpenAI Responses API、
  Jina 和 Python bridge。
- `graph_vault/settings.yaml` 使用环境变量占位。
- catalog、artifact manifest、checkpoint、query log、query response、
  stdout tail、stderr tail 和 error summary 不保存密钥值。
- 持久化 metadata 在写入前完成净化，敏感 key、密钥值和宿主机绝对路径值
  不进入 `graph_vault`。
- batch event、command log 和 recovery summary 的 redaction 覆盖 URL userinfo
  与 URL query credential，包括 `api_key`、`token`、`access_token`、`sig`、
  `signature`、`secret`、`password`、`credential` 和 `client_secret`。
- redaction 在持久化前执行，不能只依赖展示层遮盖。

GraphRAG runtime config 是 qmd project config 的投影（projection）。投影文件
必须带 managed header 和 source fingerprint。fingerprint 不匹配时拒绝运行。
同一项 provider、model、endpoint 或 reasoning 配置不得在两个文件中手工维护
为两个来源。

DSPy offline optimization 使用同一个 OpenAI Responses provider projection。
`qmd dspy optimize-query-prompt` 将 `.qmd/index.yml` 的 `providers.openai` 和
`models.generate` 投影为 typed `OpenAIResponsesProviderConfigSchema`，Python
bridge 将该投影传给 GEPA runner。GEPA runner 只允许 `endpoint=/responses`
且 `stream=true`，不调用 chat completions endpoint。

## 状态、迁移与成本

最小处理单位：

- processing unit：`source_document`
- graph business unit：`book_id`
- recovery unit：`book_id + processing_stage + command_check`
- cache unit：`normalized_provider_request_hash`

`graph_vault` 是可迁移持久化单元。迁移后通过 `restore-from-vault` 从以下
材料重建 qmd index、capability mirror 和查询加速缓存：

- `graph_vault/input`
- `graph_vault/catalog/sources.yaml`
- `graph_vault/catalog/document-identity-map.yaml`
- `graph_vault/catalog/graph-capabilities.yaml`
- validated artifact manifest

恢复执行器必须以 `BookResumePlan.nextStage` 和 typed workflow override 为准。
单书失败不得回滚已成功提交的 qmd 文档、其他书的 checkpoint 或其他书的
GraphRAG capability。

批量 EPUB 执行器必须以一本书为闭环单位（book-closed-loop unit）。批量状态
不替代单书 checkpoint，只记录批量调度事实：

- `BatchRunManifest` 保存于 `graph_vault/catalog/batch-runs/<runId>/manifest.json`。
- `BatchItemCheckpoint` 保存每本 EPUB 的 `pending/running/completed/failed`
  状态、source locator、normalized locator、sourceHash、bookId、attempts、
  expectedCommandCheckCount、failureKind、retryable、retryExhausted、
  recoveryDecision、failedStage、startedAt、completedAt、failedAt 和 redacted
  error summary。
- `BatchEventLog` 保存于 `graph_vault/catalog/batch-runs/<runId>/events.jsonl`。
- 批量恢复时先读取 batch manifest，再读取单书 `BookResumePlan.nextStage`。
- 已 `completed` 的批量 item 不重跑；单书 checkpoint 不完整时以
  `BookResumePlan.nextStage` 继续，不从第一本或第一阶段重跑。
- 加载 `completed` checkpoint 时必须重新计算 qmd/GraphRAG 闭环证据。
  `qmdBuildStatus` 不能替代 27 个固定 command checks。GraphRAG producer
  manifest、stage checkpoint 与 artifact 的 producer run、fingerprint 和
  provider identity 必须一致。
- 非孤儿 `running` checkpoint 表示其他 runner 拥有当前 item；正式运行和
  `--status-json` 都只观测该 item，不抢占、不重写 attempts。
- Provider 429、concurrency limit、timeout、502、503、504 属于 transient
  failure。批量执行器对 transient failure 做有限重试；短周期 retry budget
  耗尽时，item 进入 provider recovery wait，保持 `retryable=true`、
  `retryExhausted=false` 和 `recoveryDecision=retry_same_run_id`，写入
  `nextRetryAt`、`retryDelaySeconds` 与 `waitingForProviderRecovery=true`。
  下一次同一 `runId` 恢复运行到达 retry window 后继续该书闭环。
- `failed` item 只有 `retryable=true` 时由同一 `runId` 自动重试；permanent
  failed item 保持 failed，不阻塞其他 pending item。
- 批次完成条件只接受 `completedItems == totalItems`。`skippedItems` 和
  `importedCompletedItems` 是调度事实，不抵扣闭环完成。
- 每个 completed checkpoint 必须包含 27 个固定名称的 command checks，且全部
  为 `passed`。

active vault 目录必须保持 canonical：

- `graph_vault/books/<bookId>` 和 `graph_vault/sources/<bookId>` 使用
  `book-<sourceHash前12位>`。
- 同一 `sourceHash` 的路径型、文件名型、截断书名型 legacy 目录必须合并到
  canonical 目录。
- 合并后 legacy 目录移动到 `graph_vault/archive/legacy-books/` 或
  `graph_vault/archive/legacy-sources/`，不留在 active 区。
- 合并必须重写 job、checkpoint、artifact、run record、run catalog 和 typed
  catalog 中的 `bookId` 与 artifact 引用。
- artifact identity 不包含 artifact path、runId 或设备 locator。

query-ready 判定规则：

```text
validated checkpoint
  + validated artifact manifest
  + kind-specific artifact validators
```

kind-specific validators 包括：

- parquet content hash 校验。
- parquet 文件必须通过 `PAR1` magic、footer metadata 和 `row_count > 0`
  校验；Python bridge 在 pyarrow 可用时执行 fail-closed metadata 校验。
- LanceDB required table 与非空 data fragment 校验。
- LanceDB `qmd_row_count.json` 正行数校验。
- `lancedb_index` artifact content hash 只覆盖 required table 的
  `data/*.lance` fragment 与 `qmd_row_count.json` sidecar。`_versions/**`
  与其他 vendor-volatile 文件不参与 canonical artifact hash。
- GraphRAG output manifest 校验。
- GraphRAG 与 LanceDB artifact 的 `contentHash` 表示 artifact 字节或目录哈希；
  `metadata.corpusContentHash` 表示生产该 artifact 的规范化书内容哈希。
  query-ready 校验必须同时验证二者，避免同书名或同 bookId 的旧产物误用。
- vault-relative path 解析校验。

显式 GraphRAG 查询拒绝规则：

- `qmd query --graphrag` 不产生普通 qmd fallback 决策。
- 缺少 graph capability 时，`QueryRouteDecision.selectedRoute` 保持
  `graphrag`，`status` 为 `refused`，并返回 typed capability error。
- `auto` 路由在 capability 不满足时选择 qmd，且在 route decision 中记录
  refusal reasons。

成本账本（cost accounting）记录：

- `sourceId`
- `documentId`
- `bookId`
- `contentHash`
- `stage`
- `provider`
- `model`
- `requestCount`
- `tokenCount`
- `tokenCountStatus`
- `embeddingCount`
- `embeddingCountStatus`
- `cacheHit`
- `runId`
- `artifactIds`

`tokenCountStatus` 与 `embeddingCountStatus` 取值为 `reported`、`estimated`
或 `unknown`。未知计数的数值字段使用 `0` 作为聚合中性值，不能解释为真实零成本。

## 验收门槛

系统满足以下标准才视为统一检索面成立：

- 任意 GraphRAG source 同时存在 qmd corpus registration。
- `qmd query` 能检索 GraphRAG source 的规范化文本。
- `qmd query --graphrag` 只查询具备 `graph_query` capability 的 source。
- `qmd query --mode auto` 输出 `QueryRouteDecision`。
- qmd result、GraphRAG response 和 unified answer 均有 zod schema。
- evidence 可从用户回答追溯到 source、document、chunk 或 graph text unit。
- `graph_vault` 可迁移，不包含宿主机绝对路径作为 identity。
- provider 密钥只通过环境变量解析。
- GraphRAG vendor 子模块不承载本仓库业务路由逻辑。
- CLI 与 MCP 查询入口共享同一 typed route contract。
- Responses API 调用使用 stream 模式；需要结构化结果的调用使用 strict
  structured output schema，纯文本调用不发送 `text.format`。
- Jina embedding 与 rerank 都进入 typed provider bus。
- 成本账本能定位每个高成本 artifact 的生产者、模型和 run。

## 使用规则

- 原文定位、全文检索、快速召回：使用 `qmd query`。
- 已增强书籍的概念关系、跨章节归纳、全书综合：使用
  `qmd query --graphrag`。
- 需要系统自动选择能力：使用 `qmd query --mode auto`。
- 未 graph-ready 的内容不得通过 `--graphrag` 返回普通 qmd 结果。
