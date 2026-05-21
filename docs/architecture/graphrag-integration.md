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
- 未来若要替换 `GraphRAG` 或 `DSPy`，退出路径清晰。

