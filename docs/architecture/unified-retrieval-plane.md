# qmd 与 GraphRAG 统一检索面设计

## 结论

`qmd` 与 `--graphrag` 不应被设计成两个平级检索产品。

目标形态是：

- `qmd` 是全集检索入口（whole-corpus retrieval entry）。
- `GraphRAG` 是对部分高价值文档启用的增强索引层（enhancement layer）。
- 已启用 `GraphRAG` 的书或文档，必须同时进入 `qmd` 普通语料全集。
- `--graphrag` 只表示选择图增强查询能力（graph-enhanced query），不是选择另一个
  与 `qmd` 脱离的数据宇宙。

因此，正确关系是：

```text
all documents -> qmd corpus index -> qmd query
                 |
                 +-> selected documents/books -> GraphRAG vault -> graph query
```

## 当前状态

当前实现仍处于过渡态：

- `qmd query` 读取 qmd 原生索引。
- `qmd query --graphrag` 读取 `graph_vault` 并调用 GraphRAG bridge。
- 两者的运行入口已经同属 `qmd` CLI，但底层数据平面仍未统一。

qmd 原生索引来源：

- 配置文件：项目内 `.qmd/index.yml` 或 `.qmd/index.yaml`。
- 若项目内没有 `.qmd` 配置，则使用全局 `~/.config/qmd/index.yml`。
- 索引数据库：项目内 `.qmd/index.sqlite` 或全局 `~/.cache/qmd/index.sqlite`。
- 数据来源：`collections` 中登记的文件目录和 glob。

GraphRAG 增强索引来源：

- 持久化仓库：`graph_vault`。
- 输入：`graph_vault/input` 中的规范化文本。
- 状态：`graph_vault/books` 和 `graph_vault/catalog`。
- 图与向量产物：`graph_vault/output` 和 `graph_vault/output/lancedb`。

## 原生 qmd 与 GraphRAG 的 Type DD 状态

两者当前不是同一套 Type DD。

qmd 原生检索已有较强 TypeScript 类型，但缺少统一的 zod contract：

- `DocumentResult`
- `SearchResult`
- `ExpandedQuery`
- `HybridQueryResult`
- `HybridQueryOptions`

GraphRAG 集成已经有显式 zod contract：

- `GraphRagQueryRequestSchema`
- `GraphRagQueryResponseSchema`
- `GraphRagIndexRequestSchema`
- `GraphRagIndexResponseSchema`
- `BookJobSchema`
- `BookArtifactManifestSchema`

目标不是强行让两套内部类型完全相同，而是增加统一外层 contract：

- qmd 原生检索继续保留轻量快速的 chunk retrieval。
- GraphRAG 继续保留图查询、community report 和 LanceDB 语义。
- 两者通过统一的 document identity、query request、evidence 和 response
  contract 接入同一条数据总线。

## 职责边界

### qmd 普通查询

适用场景：

- 对全部入库内容做关键词、语义和重排检索。
- 快速定位原文片段、文件、章节、代码或笔记。
- 对未启用 GraphRAG 的普通文档进行检索。
- 低成本、高频、探索式查询。

能力边界：

- 返回 chunk 或文档证据。
- 可以使用 query expansion、embedding 和 rerank。
- 不保证实体关系、多跳归纳或全书级综合报告。

### GraphRAG 增强查询

适用场景：

- 对已完成 GraphRAG 入库的书或文档做图问答。
- 需要实体、关系、community report 或跨章节综合。
- 需要 `local`、`global`、`drift` 或 `basic` 这类 GraphRAG 查询方法。
- 可接受更高延迟和 LLM 成本。

能力边界：

- 只覆盖 `graph_ready` 或 `query_ready` 的增强子集。
- 不应绕过 qmd 全集索引成为另一个孤岛。
- 产出的回答应回连到统一 evidence contract，而不是只返回裸字符串。

## 查询路由策略

目标 CLI 行为：

```text
qmd query <query>
```

默认查询全集 qmd corpus。

```text
qmd query --graphrag <query>
```

显式只查询 GraphRAG 增强子集。

```text
qmd query --mode auto <query>
```

未来可选。先用 qmd 召回全集候选，再根据候选是否具备 graph capability、
查询意图和配置决定是否补充 GraphRAG 查询。

推荐判断规则：

- 不确定查哪里时，先用 `qmd query`。
- 需要问“这本书整体怎么说”“概念之间是什么关系”“跨章节归纳”时，用
  `qmd query --graphrag`。
- 如果普通 `qmd query` 找不到足够证据，但结果显示相关文档已 graph-ready，
  再升级到 `--graphrag`。
- 如果文档尚未 graph-ready，不能期望 `--graphrag` 覆盖它。

## 入库策略

GraphRAG 入库必须是 qmd 入库的增强，不是替代。

对一本书启用 GraphRAG 时，流水线应产生两类结果：

1. qmd corpus registration

   - 将规范化 markdown 作为普通 qmd document 入库。
   - 生成 qmd content hash、document id、chunk ids 和 embeddings。
   - 该书立即可被普通 `qmd query` 覆盖。

2. GraphRAG enhancement registration

   - 在 `graph_vault` 中生成 graph artifacts、community reports 和 LanceDB。
   - 记录 bookId、sourceId、contentHash 与 qmd document id 的映射。
   - 标记该书具备 `graph_query` capability。

入库完成后的用户体验：

```text
qmd query "software complexity dependencies"
```

检索全集，包括已入库书籍的原文 chunk。

```text
qmd query --graphrag "这本书如何解释 complexity 的成因?"
```

只在已增强图索引上做图问答。

## 统一身份模型

必须建立稳定的跨索引 identity。

建议核心标识：

- `sourceId`：源文件内容身份，基于 source hash。
- `documentId`：qmd 文档身份，绑定 collection、path、contentHash。
- `bookId`：书级处理身份，当前已基于文件名 slug 和 source hash。
- `contentHash`：规范化文本内容 hash。
- `chunkId`：qmd chunk 身份，基于 contentHash、chunk strategy、seq、pos。
- `graphTextUnitId`：GraphRAG text unit 身份。

必要映射：

```text
sourceId -> documentId
sourceId -> bookId
documentId -> contentHash
chunkId -> graphTextUnitId
bookId -> graph_vault workspace
```

没有这组映射，qmd 与 GraphRAG 会继续脑裂。

## 统一数据总线

目标数据总线分四层。

### 1. Corpus Bus

负责全集内容入库。

核心类型：

- `SourceDocument`
- `CorpusDocument`
- `CorpusChunk`
- `DocumentIdentityMap`

职责：

- qmd 普通索引是全集事实表（whole-corpus source of truth）。
- GraphRAG 只能消费已登记的 source/document/chunk identity。

### 2. Retrieval Bus

负责 qmd 原生检索。

核心类型：

- `QmdQueryRequest`
- `QmdRetrievalCandidate`
- `QmdSearchResult`

职责：

- 表达 lex、vec、hyde、rerank、query expansion。
- 输出统一 evidence 引用，不直接把 formatter 输出作为下游输入。

### 3. Graph Enhancement Bus

负责 GraphRAG 增强索引。

核心类型：

- `GraphEnhancementRequest`
- `GraphEnhancementState`
- `GraphCapability`
- `GraphRagQueryRequest`
- `GraphRagQueryResponse`

职责：

- 只对 selected subset 运行高成本图构建。
- 记录哪些 document/book 具备哪些 graph query capability。

### 4. Unified Answer Bus

负责对用户输出统一回答。

核心类型：

- `UnifiedQueryRequest`
- `QueryRouteDecision`
- `EvidenceRef`
- `UnifiedAnswer`

职责：

- 允许 `qmd`、`graphrag`、`hybrid` 三种 query route。
- 所有回答都引用统一 evidence，不允许自由拼接 context。

## 配置模型

目标配置应集中在 qmd 项目配置中，密钥仍只来自环境变量。

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
```

`graph_vault/settings.yaml` 仍可存在，但应视为 GraphRAG runtime projection，
未来可从 qmd 配置生成，避免双写模型、provider 和 endpoint。

## 实施阶段

### 阶段 1：收敛配置

- 扩展 qmd config schema，增加 `providers`、`graphrag`、`query`。
- `qmd query --graphrag` 默认从 qmd config 读取 vault、python、method。
- `graph_vault/settings.yaml` 继续使用环境变量占位，不保存密钥。

### 阶段 2：补齐 qmd 原生检索 contracts

- 为 qmd 原生检索补 zod schema。
- 将 `SearchResult`、`HybridQueryResult` 等内部类型提升为明确 contract。
- catalog 中登记 producer、consumer 和 storage。

### 阶段 3：统一入库

- GraphRAG book ingest 完成 normalize 后，同时注册 qmd collection/document。
- 将 normalized markdown 作为 qmd corpus 的普通文档。
- 建立 `bookId/sourceId/documentId/contentHash` 映射 artifact。

### 阶段 4：统一查询响应

- `qmd query` 输出 `UnifiedAnswer` 或 `QmdSearchResult`。
- `qmd query --graphrag` 输出 `UnifiedAnswer`，其中 route 为 `graphrag`。
- `--json` 输出 machine-readable typed response。

### 阶段 5：自动路由

- 增加 `query.default_route: qmd|graphrag|auto`。
- `auto` 先查 qmd，全局召回候选，再判断是否调用 GraphRAG。
- 任何自动升级必须在 response 中记录 `QueryRouteDecision`。

## 不变量

- qmd corpus 是全集。
- GraphRAG corpus 是增强子集。
- GraphRAG 入库不得跳过 qmd 入库。
- 密钥不得写入 `.qmd/index.yml`、`graph_vault/settings.yaml` 或 catalog。
- 任何跨层数据必须经过 schema，不允许裸字符串在模块间自由传递。
- GraphRAG vendor 子模块不承载本仓库业务路由逻辑。

## 当前建议

短期继续使用：

```text
qmd query <query>
```

作为全集检索入口。

对已完成 GraphRAG 入库的书，使用：

```text
qmd query --graphrag <query>
```

作为高级图问答入口。

但后续开发必须把 GraphRAG 入库结果同步回 qmd corpus，否则两个入口会继续
表现为数据脑裂。
