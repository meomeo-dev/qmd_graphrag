```markdown
<提醒: 这是前序发送的全局任务指令，用于维持上下文记忆与状态恢复，请继续执行当前步骤，当前模型 GPT5.5，思考强度 xhigh，果汁值 768>

你作为主控系统，请继续推进【书-书架-Library 层级 GraphRAG 索引改造】。

本次改造的唯一规范性设计入口是：

- `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

## 目标

在既有单书 hotplug package、包内 qmd index、包内 GraphRAG output、catalog
projection、单书 `--graph-book-id` 查询和 query timing 基础上，渐进实现书架
(bookshelf) 与 library 两级派生 GraphRAG 索引。

目标不是把多本书临时拼接成一次超大查询，而是形成：

- 单书包：可复制、可挂载、可直接查询的权威分发单位。
- 书架：由多本单书包组成的稳定语义集合，作为
  `graph_vault/bookshelves/{bookshelfId}/` 下可复制传播的上层包，生成
  可重建派生索引。
- Library：由多个书架组成的上层集合，作为
  `graph_vault/library/{libraryId}/` 下可复制传播的上层包，生成可重建
  派生索引。

交互查询必须保持固定预算 (fixed query budget)：LLM 调用数、候选语义单元数、
token 输入上限和下钻书本数不得随图书总量线性增长。

## 硬边界

- 单书包权威仍然只来自 `graph_vault/books/{bookId}/BOOK_MANIFEST.json`、
  `PUBLISH_READY.json`、包内 qmd index、包内 GraphRAG output 和包内质量门。
- 书架上层包权威根必须是 `graph_vault/bookshelves/{bookshelfId}/`。
- Library 上层包权威根必须是 `graph_vault/library/{libraryId}/`。
- `BOOKSHELF_MANIFEST.json`、`LIBRARY_MANIFEST.json`、`PUBLISH_READY.json`、
  `CURRENT.json`、package-local quality gates、generations、staging 和 runs
  必须位于各自上层包闭包内。
- `graph_vault/catalog/**` 只能保存 book、bookshelf 与 library 的
  projection、capability、默认 scope 指针、路由索引和 runner observability
  state，不得拥有书架或 library 包闭包。
- 书架与 library 不得写回单书包文件闭包。
- `graph_vault/catalog/batch-runs/**` 只能作为 runner ledger / observability
  state，不得作为语义输入。
- 查询路径不得全量扫描所有单书 community_reports 或所有书架产物。
- stale、missing、failed gate、over budget 必须快速返回 typed error。
- 不要向已经超长的核心文件继续堆功能；新增能力优先放入独立 upper-index 模块，
  再通过 CLI/router/capability catalog 进行窄接口接入。

## 必须先确认的设计状态

开始实施前先读取并核对唯一 Type DD 中这些段落：

- `documentAuthority`
- `implementationGrounding`
- `pipelineIoContract`
- `implementationGroundingReview`
- `designAudit`

当前最新设计审计状态：

- Type DD `designAudit.currentRunDirectory` 指向
  `docs/architecture/graphrag-hierarchical-library-index-audits/design-turn_014`；
  `design-turn_014/agent-{1,2,3}/report.md` 均为 PASS。若后续修改 Type DD，
  必须重新进入设计审计循环。

当前实施审计状态：

- query-ready bookshelf/library package 发布后生成非权威 catalog projection 的
  最小实现已进入 `postImplementationTurn013`；implementation-turn_013 三代理
  实施审计结论为 `PASS_WITH_RISK`，无必须修复项。审计后已补充
  `catalog_projection_scope_mismatch` 硬化与回归测试；TypeScript、
  bookshelf graph 和 library graph 目标验证通过。
- implementation-turn_013 后本地补强已新增 `qmd bookshelf/library`
  `status/list/build/rebuild` package-root 管理命令薄适配器；implementation-turn_014
  审出 status/list query-ready 误报问题，implementation-turn_015 修复后
  三代理复审结论为 `PASS_WITH_RISK`，无必须修复项。当前有效管理命令复审状态以
  `docs/architecture/graphrag-hierarchical-library-index-audits/reports/implementation-turn-015-summary.md`
  为准。

确认当前实现边界：

- 已支持：单书 hotplug package、包内 qmd index、包内 GraphRAG output、
  catalog projection、单书 `--graph-book-id` 查询、query timing。
- 已有但需迁移：catalog-based `bookshelf_membership_resolution`、
  `materialized_bookshelf_graph_build`、`library_membership_resolution`、
  `library_graph_build`、书架/library scope 查询和对应 typed errors。
- 新规范能力：将书架权威包根迁移到
  `graph_vault/bookshelves/{bookshelfId}/`，将 library 权威包根迁移到
  `graph_vault/library/{libraryId}/`，从上层包生成 catalog projection，
  支持无 catalog projection 的显式上层包查询，并对 legacy catalog-only
  上层产物返回 `upper_package_migration_required` typed error。

## 可运行目标与收敛原则

每一轮设计、实现和修复都必须先定义一个真实可运行目标 (runnable target)，
再进入审计。原则是：先能跑通，再审计；审计用于确认已跑通的能力是否满足合同，
不得用审计替代真实运行。

本次改造的最小收敛目标按阶段推进：

- membership 阶段：用至少 3 本已通过单书质量门的 book package，在
  `graph_vault/bookshelves/{bookshelfId}/` 生成 1 个 materialized bookshelf
  package，并通过 package-local manifest、members、state 和 quality gate
  校验。
- bookshelf 索引阶段：基于该 bookshelf 构建上层 GraphRAG 派生索引，并完成
  1 次无 catalog projection 依赖的显式 `--bookshelf-id` 查询 smoke test，
  输出 timing 与 evidence lineage。
- library 阶段：用至少 2 个已发布 bookshelf package，在
  `graph_vault/library/{libraryId}/` 构建 1 个 library package，并完成 1 次
  无 catalog projection 依赖的显式 `--library-id` 查询 smoke test，验证固定
  查询预算不随成员书数量线性增长。
- 回归阶段：任意上层能力通过后，必须重跑 1 次单书 `--graph-book-id` 查询和
  单书包质量门，确认单书分发闭包不回归。

若外部 provider、网络或依赖服务中断，状态只能标记为 blocked、failed 或
recoverable，不得把 fixture-only、mock-only 或未完成运行记为通过。

## 推荐实施顺序

1. **状态盘点**
   - 检查工作区是否干净，识别未提交变更和无关未跟踪文件。
   - 读取 `AGENTS.md`、唯一 Type DD、固定审计基准。
   - 用 `rg` 定位现有 hotplug、catalog、query router、timing、GraphRAG runtime
     bridge 和 CLI 接入点。
   - 明确本轮 runnable target、输入书包、预期命令、预期产物和通过条件。

2. **书架 membership 最小闭环**
   - 新增书架 package-local manifest/schema/contract，不修改单书包权威。
   - 从 catalog projection 与已通过质量门的单书包生成 `bookshelf_members.json`。
   - membership 产物写入 `graph_vault/bookshelves/{bookshelfId}/` 上层包闭包；
     catalog projection 只能由该包派生。
   - 支持用户显式集合优先，taxonomy/LLM 建议只能作为可审计 proposal，不得覆盖
     用户锁定决策。
   - 定义 oversized shelf 分区策略：物化子书架承载查询，虚拟父书架只做导航与聚合。

3. **书架派生索引最小闭环**
   - 读取成员书包的 community_reports、entities、relationships、text_units 和 qmd
     metadata。
   - 构建书架级 `semantic_units`、`semantic_edges`、`community_reports`、
     `evidence_map`。
   - 采用 package-local staging -> quality gate -> atomic publish ->
     `generations/{generationId}` -> `CURRENT.json` -> `PUBLISH_READY.json` 的发布语义。
   - publish 后再从上层包重建 catalog projection，不得把 catalog projection
     当作包权威。
   - 质量门必须覆盖 schema、checksum、成员一致性、evidence lineage、敏感信息扫描、
     fixed-budget simulation。

4. **Library 派生索引最小闭环**
   - 以已发布书架为输入，不直接把大量单书塞进交互查询。
   - 生成 `LIBRARY_MANIFEST`、library members、library semantic artifacts、
     library evidence map 与 library quality gate，全部位于
     `graph_vault/library/{libraryId}/` 上层包闭包。
   - publish 后再从 library package 重建 catalog projection。
   - 支持按书架 generation / manifest sha256 检测 stale，并限制重建影响范围。

5. **Scoped Query 接入**
   - 在保留 `--graph-book-id` 行为不回归的前提下，新增 `--bookshelf-id` 与
     `--library-id` 查询 scope。
   - 显式上层 scope 查询先读取 package root，并校验 package-local
     manifest、`CURRENT.json`、`PUBLISH_READY.json` 和质量门；catalog projection
     只能辅助发现或默认 scope，不能证明 query-ready。
   - 查询只读取已发布且质量门通过的 scope，不在交互路径中隐式构建或修复索引。
   - 只有 legacy catalog upper artifacts 而缺少 package root 时，必须快速返回
     `upper_package_migration_required` typed error。
   - 输出必须包含 bounded timing breakdown 与 evidence lineage。
   - 超预算、缺索引、索引 stale、质量门失败时返回明确 typed error。

6. **验证与审计**
   - 每一阶段完成后运行对应单元测试、合同测试、CLI smoke test 和包质量验证。
   - 单书 hotplug 非回归必须始终通过。
   - 固定查询预算必须有不同规模 library 的测试覆盖。

## 设计审计循环

若实施中发现唯一 Type DD 与现有代码或运行结果不一致，先暂停扩展实现，进入设计审计：

1. 使用固定基准：
   `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
2. 安排 3 个子代理（GPT5.5 xhigh）分别审计。
3. 每次审计结果保存到：
   `/Users/jin/projects/qmd_graphrag/docs/architecture/graphrag-hierarchical-library-index-audits/design-turn_{N}/agent-{K}/`
4. 不得修改 base 审计基准来制造通过。
5. 根据审计结果只修改唯一 Type DD 或必要的实现方案。
6. 循环至 D01-D10 全部通过后再继续实现。

## 实施审计循环

实现完成后安排 3 个子代理（GPT5.5 xhigh）做实施审计。每个子代理必须使用固定
10 项审计维度，不得临时改标准。

实施审计至少覆盖：

- 单书包复制传播完整性不回归。
- 书架/library 派生索引不污染单书包。
- 书架/library 上层包闭包不写入 `graph_vault/catalog/**`。
- 删除 catalog projection 不影响显式书架/library package 查询。
- runner ledger 不参与语义检索。
- 查询预算不随书籍数量线性增长。
- evidence lineage 可追溯到 bookId、sourceId、documentId、contentHash、
  community report 或 text_unit。
- staging/failed/running/pending/stale 产物不能被查询路径当作 ready。
- manifest、quality gate、publish marker 的状态闭环完整。
- CLI typed error 与 timing 可观测。
- 敏感信息、绝对路径、provider payload、raw prompt/completion 不进入可发布索引。
- 现有单书 GraphRAG 查询和 qmd vsearch 不回归。

## 恢复规则

如果遇到上下文压缩或中断：

- 先读本 prompt、唯一 Type DD、固定审计基准和最近一次审计报告。
- 用 `git status --short --branch` 确认工作区。
- 用 package-local gates、`CURRENT.json`、`PUBLISH_READY.json` 和 manifest
  sha256 判断书架/library 真实完成状态；catalog projection 只能作为派生视图，
  不得作为 query-ready 权威。
- 若发现部分构建、stale 或 failed gate，先恢复状态闭环，再继续下一阶段。

任务完成条件：

- 书架与 library 的设计、实现、质量门、查询路径和审计报告全部闭环。
- 单书包 hotplug 分发能力和单书查询能力不回归。
- 不存在把新能力误判为已完成的 running/pending/failed/stale 状态。
- 所有相关测试、验证子命令和审计均通过。
</提醒>
```
