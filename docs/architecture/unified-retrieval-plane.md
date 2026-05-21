# qmd 与 GraphRAG 统一检索面规范

## 结论

`qmd` 是全集检索入口（whole-corpus retrieval entry）。
`GraphRAG` 是对指定语料启用的图增强层（graph enhancement layer）。

本文定义规范契约（normative contract），不声明代码落地状态。审计时必须
分别核对契约文件、实现文件、测试和运行产物。

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

route 为 `auto`。执行顺序固定：

1. qmd corpus 召回候选。
2. 检查候选 evidence 是否具备 `graph_query` capability。
3. 计算 graph coverage、intent class 和 cost class。
4. 满足升级契约时调用 GraphRAG。
5. 记录 `QueryRouteDecision`。
6. 输出 `UnifiedAnswer`。

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

refusal reason 枚举：

- `no_graph_ready_candidate`
- `coverage_below_threshold`
- `intent_not_graph_synthesis`
- `cost_policy_exceeded`
- `capability_missing`
- `provider_unavailable`

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
- `selectedBookIds`
- `candidateEvidenceIds`
- `graphCapabilityIds`
- `candidateDecisions`
- `refusalReasons`

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

- 生成 `GraphEnhancementRequest`。
- 生成 `GraphEnhancementState`。
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
- `documentId`：qmd 文档身份，绑定 collection、relative path、contentHash。
- `bookId`：书级处理身份，由 `sourceHash` 派生。
- `bookDisplaySlug`：书名展示和工作区可读性字段，不参与去重 identity。
- `contentHash`：规范化文本内容 hash，包含 normalization policy version。
- `chunkId`：qmd chunk 身份，基于 contentHash、chunk strategy、seq、pos。
- `graphTextUnitId`：GraphRAG text unit 身份。

必要映射：

```text
sourceHash -> sourceId
sourceId -> canonicalBookId
sourceId -> documentId
documentId -> contentHash
contentHash -> chunkId
chunkId -> graphTextUnitId
canonicalBookId -> graph_vault workspace
```

路径只作为 locator。不同设备路径不得改变 `sourceId`、`bookId`、
`contentHash` 或成本去重 key。内容相同但文件名不同的源文件共享
canonical book identity；展示名通过 alias 记录。

成本去重 key 为：

```text
sourceHash + contentHash + stageFingerprint + providerFingerprint
```

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
- GraphRAG 只能消费已登记的 source/document/chunk identity。
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
- 不把 formatter 输出作为下游输入。

### Graph Enhancement Bus

负责图增强索引。

核心类型：

- `GraphEnhancementRequest`
- `GraphEnhancementState`
- `GraphCapability`
- `GraphRagQueryRequest`
- `GraphRagQueryResponse`

职责：

- 只对 selected subset 运行高成本图构建。
- 记录 document/book 具备的 graph query capability。
- 记录 GraphRAG artifacts 与 qmd corpus identity 的映射。
- query-ready 判定以 validated checkpoint 和 validated manifest 为唯一事实源。
- `GraphCapability` 和 qmd sqlite capability mirror 是可重建投影。

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
- `graphTextUnitId`
- `artifactId`
- `locator`

`TypedQueryError` 必须包含：

- `route`
- `stage`
- `provider`
- `capability`
- `code`
- `retryable`
- `redactedMessage`

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
- 结构化输出 schema 使用 strict JSON schema。
- 所有 object schema 必须显式 `additionalProperties: false`。
- Jina 同时承担 embedding provider 和 rerank provider。

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
  embed: jina:jina-embeddings-v3
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
    embedding_model: jina-embeddings-v3
    rerank_model: jina-reranker-v3

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

密钥规则：

- 配置只保存环境变量名。
- `.env` 保存密钥值。
- `graph_vault/settings.yaml` 使用环境变量占位。
- catalog、artifact manifest、checkpoint、query log、query response、
  stdout tail、stderr tail 和 error summary 不保存密钥值。
- redaction 在持久化前执行，不能只依赖展示层遮盖。

GraphRAG runtime config 是 qmd project config 的投影（projection）。投影文件
必须带 managed header 和 source fingerprint。fingerprint 不匹配时拒绝运行。
同一项 provider、model、endpoint 或 reasoning 配置不得在两个文件中手工维护
为两个来源。

## 状态、迁移与成本

最小处理单位：

- processing unit：`source_document`
- graph business unit：`book_id`
- recovery unit：`book_id + processing_stage`
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

query-ready 判定规则：

```text
validated checkpoint
  + validated artifact manifest
  + kind-specific artifact validators
```

kind-specific validators 包括：

- parquet content hash 校验。
- LanceDB required table 校验。
- LanceDB row count 校验。
- GraphRAG output manifest 校验。
- vault-relative path 解析校验。

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
- `embeddingCount`
- `cacheHit`
- `runId`
- `artifactIds`

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
- Responses API 调用使用 stream 模式和 strict structured output schema。
- Jina embedding 与 rerank 都进入 typed provider bus。
- 成本账本能定位每个高成本 artifact 的生产者、模型和 run。

## 使用规则

- 原文定位、全文检索、快速召回：使用 `qmd query`。
- 已增强书籍的概念关系、跨章节归纳、全书综合：使用
  `qmd query --graphrag`。
- 需要系统自动选择能力：使用 `qmd query --mode auto`。
- 未 graph-ready 的内容不得通过 `--graphrag` 返回普通 qmd 结果。
