# qmd_graphrag 集成蓝图（Integration Blueprint）

## 现状结论（Current Finding）

`qmd` 当前已经具备以下能力：

- 本地 BM25 / vector / rerank 混合检索。
- `lex` / `vec` / `hyde` 结构化查询扩写。
- 以 TypeScript 为中心的 SDK、CLI、MCP 接口。

`qmd` 当前不包含 `GraphRAG` 的核心实现：

- 不包含知识图谱抽取（graph extraction）流水线。
- 不包含 community reports 生成与分层聚类。
- 不包含 `local` / `global` / `drift` 这组 `GraphRAG` 查询引擎。

结论：不能把 `qmd` 视为已经具备 `GraphRAG` 能力的仓库。若要继承
`GraphRAG`，应通过清晰的适配层（adapter layer）引入，而不是把 Python
流水线逻辑直接散落进 `qmd` 搜索主干。

## 集成策略（Integration Strategy）

本仓库采用双运行时（dual runtime）结构：

- TypeScript runtime:
  `qmd` 继续承担文档索引、混合检索、CLI、MCP、SDK 的主入口。
- Python sidecar:
  `GraphRAG` 与 `DSPy` 通过受控 bridge 接入。

当前进一步约束如下：

- `GraphRAG` 不作为仓库外部平级目录依赖长期存在。
- `GraphRAG` 应收编为 `qmd_graphrag` 仓内子模块（submodule / 子模块）。
- Python bridge 默认优先解析仓内 `GraphRAG` 子模块路径。
- 上游同步通过子模块升级完成，本地 patch 维持最小边界。

桥接原则如下：

- 所有跨运行时请求必须先经过 `zod schema` 校验。
- TypeScript 与 Python 之间只交换 JSON 可序列化数据。
- 不允许自由拼接 prompt、context、response 的裸字符串结构穿越边界。
- 运行时边界统一收口到 `src/integrations/` 与
  `python/qmd_graphrag/bridge.py`。

## Type DD 数据总线（Typed Data Bus）

本仓库定义两条主数据总线：

### 1. 在线检索总线（Online Retrieval Bus）

流向：

`user / cli / sdk -> GraphRagQueryRequest -> python bridge -> GraphRAG API -> GraphRagQueryResponse`

职责：

- 承载 `local` / `global` / `drift` / `basic` 图检索查询。
- 保证 query method、community level、response type、context payload
  均有明确 schema。

### 2. 离线提示词优化总线（Offline Prompt Optimization Bus）

流向：

`trainset / valset -> DspyQueryPromptOptimizationRequest -> DSPy GEPA -> optimized prompt artifact`

职责：

- 优化 `qmd` 查询扩写（query expansion）提示词。
- 产出可落盘、可审计、可回放的 prompt artifact。
- 避免把 DSPy 放入在线查询热路径。

## Producer / Consumer 约束（Traceability）

关键类型的生产者（producer）与消费者（consumer）已登记在：

- `catalog/data-bus.catalog.yaml`

该 catalog 用于回答两类问题：

- 某个类型是谁生产的？
- 某个类型被哪些下游消费？

## 依赖边界（Dependency Boundary）

`GraphRAG` 与 `DSPy` 被视为边界依赖（boundary dependencies）：

- `GraphRAG` 提供图构建与图查询能力。
- `DSPy` 提供提示词编译与优化能力。

它们都不直接侵入 `qmd` 的核心检索实现，而是通过 adapter 接入。
这样做的收益：

- 主仓库保留 `qmd` 的本地检索稳定性。
- Python 依赖升级不会直接污染 TypeScript 核心。
- 替换 `GraphRAG` 或 `DSPy` 时，退出路径清晰。

## 当前已验证事实（Validated Facts）

- `qmd` 当前没有原生 `GraphRAG` 实现。
- `GraphRAG` 当前原生支持 `LanceDB`。
- `Jina` 可以通过 `LiteLLM` 路径作为 embedding provider 使用。
- 上游 `graphrag-llm` 默认 completion 实现仍走
  `litellm.completion(...)` / `litellm.acompletion(...)`，即
  `chat completions` 路径。
- 本仓库已新增独立 `openai_responses` completion provider，并通过
  `python/qmd_graphrag/graphrag_responses_completion.py` 接入
  `OpenAI Responses API`。
- 当前本地网关上的 `POST /responses` 已验证可用，且 endpoint 直接使用
  `/responses`，不需要强制追加 `/v1/responses`。
- 当前单书冒烟的主要剩余风险不是 provider 可用性，而是 community report
  阶段对网关稳定性较敏感，可能出现 `429` 或 `502`，因此需要更保守的并发、
  retry 和阶段级恢复。

## 向量层选择（Vector Layer Choice）

`GraphRAG` 官方当前原生支持 `LanceDB`，并且默认向量库类型就是
`lancedb`。因此本仓库把 `LanceDB` 视为图检索侧（GraphRAG side）的首选
向量库，不需要额外自研 vector adapter。

建议边界如下：

- `qmd` 侧：
  继续使用其现有本地向量检索实现。
- `GraphRAG` 侧：
  使用 `LanceDB` 承载 entity / report / text unit 的向量索引。

这样做的原因：

- 避免在当前阶段把两套检索引擎的存储层过早耦合。
- `GraphRAG` 对 `LanceDB` 已有现成实现与配置路径。
- 统一存储层通过 typed bus 做跨引擎编排。

## 向量服务选择（Embedding Provider Choice）

`Jina` 可以作为 embedding provider 使用，但语义上应区分：

- `Jina` 在这里同时作为向量服务（embedding service）和重排服务
  （rerank service）。
- 它不是 `GraphRAG` 自己的独立 provider adapter。
- GraphRAG embedding 实际路径是：
  `GraphRAG -> graphrag-llm -> LiteLLM -> Jina`
- qmd rerank 实际路径是：
  `qmd -> src/llm.ts#LlamaCpp.rerankWithJina -> Jina /v1/rerank`

当前建议：

- completion LLM:
  使用 `OpenAI` / `Azure OpenAI` / 其他已验证 completion provider。
- embedding model:
  使用 `Jina`。
- rerank model:
  默认使用 `jina:jina-reranker-v3`。如需离线运行，可通过
  `models.rerank` 或 `QMD_RERANK_MODEL` 切换到 `hf:` 本地 GGUF reranker。

原因：

- `GraphRAG` 的 query / indexing 多个阶段仍然需要 completion LLM。
- `Jina` 更适合作为 embedding 或 rerank provider，而不是直接承担全部
  `GraphRAG` 推理职责。

## 配置建议（Recommended Configuration）

受管配置（managed configuration）由以下投影代码生成：

- `src/graphrag/settings-projection.ts`

参考模板文件：

- `configs/graphrag/settings.lancedb-jina.template.yaml`

`graph_vault/settings.yaml` 必须由 qmd 从 `.qmd/index.yml` 投影生成，不手工
复制模板覆盖。模板只用于审阅当前受管配置形状。投影校验必须使用
`src/graphrag/settings-projection.ts` writer 等价 loader，不得把受管投影与
GraphRAG default-loaded config 比较。

当 `settings.yaml` 带 qmd managed marker 且 `.qmd/index.yml` 有效时，
source fingerprint mismatch 是可恢复 drift：执行器安全重写该受管投影并继续
当前 book resume。缺少 managed marker、目标为 user-owned settings file 或 source
config invalid 时必须 fail-closed，不覆盖用户文件。该修复只允许改写
`graph_vault/settings.yaml`，不得删除或污染
`graph_vault/books/<bookId>/graphrag/output` 下的 GraphRAG 产物。

- `JINA_API_KEY`
- `OPENAI_API_KEY` 或其他 completion provider 对应 key

注意：

- `GraphRAG` 的配置加载器会自动读取 `settings.yaml` 同目录的 `.env`。
- 模板中的 `${JINA_API_KEY}` 会在加载时被替换。
- `default_embedding_model` 用于离线索引，Jina downstream task 固定为
  `retrieval.passage`。
- `query_embedding_model` 用于 `local` / `drift` / `basic` 查询，Jina
  downstream task 固定为 `retrieval.query`。
- Jina request 的 `dimensions`、`normalized`、`embedding_type`、`truncate`、
  endpoint 与 base URL 均由当前 profile 投影，不允许空 `call_args`。
- `JINA_API_KEY` 可复用；GraphRAG root 与 `.env` 的实际落点必须保持一致，
  或在运行前显式导出到进程环境。

## 集成约束（Integration Constraints）

`GraphRAG` 作为仓内受控依赖（controlled in-repository dependency）由
`vendor/graphrag` 提供。qmd_graphrag 的自有适配层承载 `Responses API`、
Jina、LanceDB、状态恢复和 Type DD 数据总线契约；上游 completion 层保持
可合并边界（mergeable boundary），避免二开逻辑散落到上游实现。

`graph_vault` 是 GraphRAG 持久化仓库（persistent vault）。所有可迁移路径
使用 vault-relative locator；`settings.yaml` 是 `.qmd/index.yml` 的受管投影
（managed projection），由 `qmd_graphrag.managed_by` 与
`source_fingerprint` 校验漂移。漂移修复的事件和 recovery summary 必须记录
rewrite/reject decision、source fingerprint、project config locator、
settings locator、evidence locator 和 redacted reason。

查询入口保持统一：`qmd` 覆盖全集检索，GraphRAG 能力通过
`GraphCapability` 暴露为增强子集。`qmd --graphrag` 只能消费已验证的
`query_ready` capability scope，不能从候选文本或路径自由拼接身份。

对应决策记录：

- `docs/records/graphrag/2026-05-20-submodule-and-response-api-decision.yaml`
