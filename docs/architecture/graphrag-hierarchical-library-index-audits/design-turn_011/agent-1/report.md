# design-turn_011 agent-1 设计审计报告

overallStatus: FAIL

## 结论

当前唯一 Type DD 与最新目录权威要求存在结构性冲突，不能继续作为
bookshelf/library 上层包迁移的通过设计。

最新要求把 bookshelf 与 library 从
`graph_vault/catalog/bookshelves/**`、`graph_vault/catalog/library/**`
迁移为 `graph_vault/bookshelves/**` 与 `graph_vault/library/**` 下的可复制
传播上层包。catalog 只保留 projection、能力索引、成员发现索引和观测状态，
不得承担 bookshelf/library 包闭包权威。

当前 Type DD 仍在 `scope`、`hierarchyModel`、`qualityGates`、
`stateAndRecovery`、`pipelineIoContract` 和 `implementationGroundingReview`
中把 catalog 下的路径定义为 bookshelf/library authority root、graph root、
quality gate path、runs root 和已实现产物位置。该设计在 D01、D05、D07、
D09、D10 上不满足固定基准；D02、D03、D04、D06、D08 的核心语义可保留，
但必须随权威根目录和包闭包合同修订后重新复审。

本报告未修改固定审计基准、Type DD 或实现代码。

## D01_authority_boundaries

status: FAIL

判定：当前设计把 bookshelf/library 的 authority root 放在
`graph_vault/catalog/**`。这与最新要求冲突。固定基准要求保持单书包权威
并把书架与 library 索引限定为可重建派生物；在新要求下，还必须区分
`graph_vault/bookshelves/{bookshelfId}`、`graph_vault/library/{libraryId}` 的
上层包闭包权威与 `graph_vault/catalog/**` 的 projection 职责。

冲突点：

- `scope.included` 声明 catalog/bookshelves 和 catalog/library 为上层根。
- `hierarchyModel.levels.bookshelf.authorityRoot` 指向 catalog。
- `hierarchyModel.levels.library.authorityRoot` 指向 catalog。
- `pipelineIoContract.hardInvariants.catalog_is_derivative` 把 catalog 下的
  bookshelf/library 与 projection、runner ledger 混为派生状态。
- Type DD 未定义上层包复制传播闭包，也未定义 catalog projection 失效时
  上层包自身是否仍可挂载和查询。

通过条件：

- 将 bookshelf authority root 改为 `graph_vault/bookshelves/{bookshelfId}`。
- 将 library authority root 改为 `graph_vault/library/{libraryId}`。
- 明确 catalog 只投影上层包，不拥有 `BOOKSHELF_MANIFEST.json` 或
  `LIBRARY_MANIFEST.json` 的权威闭包。
- 明确删除或损坏 catalog projection 不改变已发布 bookshelf/library 包的
  query-ready 判定。

## D02_fixed_query_budget

status: PASS_WITH_REVISION

判定：固定预算设计本身仍可通过。当前 Type DD 已定义固定 top-K、固定候选
语义单元、固定 token、固定 LLM 调用数和 bounded deepening 限制，并禁止
查询时全量扫描所有单书 community reports。

需修订点：

- 查询阶段的 scope locator 必须从上层包根读取 current generation，而不是从
  catalog 下的 authority root 读取。
- catalog projection 可以作为 scope discovery 输入，但不得成为查询语义输入
  或 query-ready 权威。

通过条件：

- `--bookshelf-id` 和 `--library-id` 查询只读取
  `graph_vault/bookshelves/{id}/current/**` 或
  `graph_vault/library/{id}/current/**` 的已发布包产物。
- scope discovery 使用 catalog 时必须二次校验上层包 manifest、quality gate
  和 checksum。

## D03_graphrag_semantic_alignment

status: PASS_WITH_REVISION

判定：GraphRAG 语义对齐仍基本成立。设计仍要求上层索引输入包含
community reports、entities、relationships 和 text units，并生成
semantic_units、semantic_edges、community_reports 与 evidence_map。

需修订点：

- 上层包应把这些派生语义产物作为包内 GraphRAG output 或等价
  upper-graph output 闭包，而不是 catalog 目录中的 loose derived artifacts。
- library 输入应来自已发布 bookshelf 包的 manifest 和包内 current artifacts，
  不应依赖 catalog/bookshelves 路径。

通过条件：

- Type DD 定义 bookshelf/library 包内 GraphRAG artifact layout，与单书包
  `graphrag/output` 或现有上层 `current` generation 语义一致。
- catalog projection 只保存摘要索引和 locator，不保存唯一语义权威。

## D04_evidence_traceability

status: PASS_WITH_REVISION

判定：证据回链字段设计可保留。当前 evidence_map 已覆盖 bookId、
sourceId、documentId、contentHash、community report 和 text_unit。

需修订点：

- evidence lineage 还应记录上层包相对路径、上层包 generation、上层包
  manifest sha256，以及从 library 到 bookshelf 再到 book 的包链路。
- 诊断和回答中的 locator 必须使用 package-relative 或 scope-relative 路径，
  不能继续固定为 catalog-relative 路径。

通过条件：

- bookshelf evidence map 指向 member book package artifacts。
- library evidence map 同时指向 member bookshelf package artifacts 和下层
  book evidence。
- 回答输出能在 catalog projection 缺失时仍从上层包 manifest 追溯证据。

## D05_state_recovery

status: FAIL

判定：当前状态闭环围绕 catalog 下的 authority root、runs root、current
generation 和 quality gate 构建。新要求要求 bookshelf/library 自身成为可复制
传播包，因此构建状态、staging、current、failed、runs、quality gate 和 publish
marker 的归属必须重新定义。

冲突点：

- `stateAndRecovery.ledgerRoots` 仍指向
  `graph_vault/catalog/bookshelves/{bookshelfId}/runs/{runId}` 和
  `graph_vault/catalog/library/{libraryId}/runs/{runId}`。
- `qualityGates.*.path` 仍指向 catalog。
- `pipelineStages.*.authorityRoot` 仍指向 catalog。
- Type DD 未定义上层包复制后如何恢复 current generation、publish marker、
  quality gate 和 stale 判断。
- catalog projection 损坏与上层包自身 failed/stale/running 状态之间缺少
  分层状态规则。

通过条件：

- 在 `graph_vault/bookshelves/{bookshelfId}` 与
  `graph_vault/library/{libraryId}` 下定义 staging、current、runs、state、
  archive 或等价闭包。
- publish marker 和 quality gate 位于上层包闭包内。
- catalog projection 重建只能从已发布上层包读取，不得反向修复或覆盖上层包。
- stale 判断以成员包 manifest sha256、上层包 manifest sha256 和 generation
  为准，不以 catalog projection 更新时间为准。

## D06_quality_gates

status: PASS_WITH_REVISION

判定：质量门检查项本身充分，覆盖 schema、checksum、成员一致性、证据回链、
敏感信息扫描和固定预算模拟。但质量门的 authority path 错误。

需修订点：

- `bookshelfGate.path` 应迁移到 bookshelf 包内 state 目录。
- `libraryGate.path` 应迁移到 library 包内 state 目录。
- 质量门应新增上层包闭包校验：manifest、publish marker、checksum sidecar、
  package-local qmd/upper graph artifacts、state gate 均在同一包闭包内一致。

通过条件：

- 质量门失败时，上层包不发布 `PUBLISH_READY` 或等价上层 publish marker。
- 查询路径读取包内质量门，不以 catalog projection gate 替代。
- catalog projection gate 只证明 projection 新鲜度，不证明上层包 query-ready。

## D07_incremental_scaling

status: FAIL

判定：现有设计记录成员 manifest sha256 和 generation，也有 conservative rebuild
策略。但新要求引入可复制传播上层包后，增量刷新边界必须从 catalog 派生目录
迁移为 package generation 语义；当前 Type DD 未定义该边界。

冲突点：

- library 成员目前按 catalog/bookshelves current 路径读取 bookshelf。
- Type DD 未说明复制来的 bookshelf 包如何被 library membership 挂载、投影和
  stale 检测。
- 未定义上层包 packageGeneration、manifestSha256、publish marker 与 catalog
  projection generation 的关系。

通过条件：

- bookshelf 包 manifest 记录成员 book manifest sha256、packageGeneration 和
  own packageGeneration。
- library 包 manifest 记录成员 bookshelf manifest sha256、generation 和
  packageGeneration。
- catalog projection 记录上层包 manifest sha256，只作为发现与路由缓存。
- 成员包变更影响范围由包 manifest 链路决定，而不是 catalog 路径布局决定。

## D08_security_privacy

status: PASS_WITH_REVISION

判定：安全与隐私规则基本满足。Type DD 已禁止 provider payload、raw prompt、
raw completion、credential、绝对路径和 query.log 进入可发布上层 manifest、
索引和诊断。

需修订点：

- 因上层包可复制传播，敏感信息扫描应明确覆盖 bookshelf/library 包闭包内所有
  publishable artifacts，而不只是 catalog current artifacts。
- package manifest 不得记录本地绝对 package root；成员 locator 应使用
  scope-relative 或 content-addressed 引用。

通过条件：

- `BOOKSHELF_MANIFEST.json`、`LIBRARY_MANIFEST.json`、state gates、diagnostics、
  parquet artifacts 和 sidecars 都通过敏感扫描。
- catalog projection 不包含 provider payload、raw prompts、raw completions、
  credentials、query logs 或绝对路径。

## D09_cli_operability

status: FAIL

判定：CLI 行为对 stale、missing、over budget 和 quality gate failed 已有 typed
error 设计，但 scope resolution order 仍隐含 catalog authority。新要求下，
CLI 必须能直接查询可复制上层包，并把 catalog 当作 projection fallback。

冲突点：

- Type DD 未定义 `--bookshelf-id` 从 `graph_vault/bookshelves/{id}` 解析的规则。
- Type DD 未定义 `--library-id` 从 `graph_vault/library/{id}` 解析的规则。
- 未定义 catalog projection 缺失但上层包存在时的行为。
- 未定义 catalog projection 指向 stale package manifest 时的 typed error。

通过条件：

- CLI scope resolution order 显式区分 package root lookup、catalog projection
  lookup 和 ambiguity handling。
- 上层包存在且包内质量门通过时，catalog projection 缺失不得阻断查询。
- catalog projection stale 时快速返回 projection-stale 或重新投影建议，但不得
  读取 catalog stale semantic artifacts。
- typed error metadata 包含 scopeKind、scopeId、packageRootKind、
  manifestSha256、generation 和 timingAvailable。

## D10_testability

status: FAIL

判定：当前测试合同数量充足，但未覆盖最新目录权威和上层包复制传播行为。
固定基准要求覆盖正确性、成本边界、恢复、证据、安全和热插兼容；在新要求下，
还必须覆盖 bookshelf/library hotplug package 兼容。

缺口：

- 没有测试复制 `graph_vault/bookshelves/{bookshelfId}` 后在新 vault 中查询。
- 没有测试复制 `graph_vault/library/{libraryId}` 后在新 vault 中查询。
- 没有测试删除 catalog projection 后 bookshelf/library 包仍可验证或查询。
- 没有测试 catalog projection stale 时不被查询路径当作 ready。
- 没有测试 library 从复制来的 bookshelf 包构建或验证。

通过条件：

- 增加 bookshelf package copy/mount/query 非回归测试。
- 增加 library package copy/mount/query 非回归测试。
- 增加 catalog projection rebuild 测试，证明 projection 由上层包派生。
- 增加旧 catalog 路径迁移测试，确保旧产物不会被误判为 ready。
- 增加目录职责测试，证明 `graph_vault/catalog/**` 不包含唯一
  `BOOKSHELF_MANIFEST.json` 或 `LIBRARY_MANIFEST.json` 权威闭包。

## 必须修改的 Type DD 条目

- `scope.included`：将 bookshelf/library 根从 catalog 下迁移到
  `graph_vault/bookshelves/{bookshelfId}` 与 `graph_vault/library/{libraryId}`；
  catalog 改为 projection、discovery 和 capability index。
- `terms.bookshelf`：从“可重建 catalog 产物”改为“可复制、可挂载、可查询的
  上层派生包”。同时保留其派生性：内容可由成员 book 包重建。
- `terms.library`：定义为由 bookshelf 包组成的可复制上层派生包。
- `hardInvariants.derived_upper_indexes_only`：保留可重建派生语义，但把
  “derived catalog artifacts” 改为 “derived upper packages”，并声明 catalog
  损坏不影响已发布上层包。
- `hierarchyModel.levels.bookshelf.authorityRoot`：
  `graph_vault/bookshelves/{bookshelfId}`。
- `hierarchyModel.levels.bookshelf.graphRoot`：改为 bookshelf 包内 graph output
  或 current generation 路径。
- `hierarchyModel.levels.library.authorityRoot`：
  `graph_vault/library/{libraryId}`。
- `hierarchyModel.levels.library.graphRoot`：改为 library 包内 graph output 或
  current generation 路径。
- `qualityGates.bookshelfGate.path` 与 `qualityGates.libraryGate.path`：迁移到
  上层包 state 目录。
- `qualityGates.failureDiagnostics.pathPattern`：迁移到上层包内 diagnostics。
- `stateAndRecovery.ledgerRoots`：明确上层包内 runs 与 catalog runner ledger 的
  职责边界。包构建 runs 可随包复制；全局 runner ledger 只能观测。
- `pipelineIoContract.hardInvariants.catalog_is_derivative`：改为 catalog 只投影
  book、bookshelf、library 包；catalog 不包含上层包权威闭包。
- `pipelineStages.bookshelf_membership_resolution.authorityRoot`：
  `graph_vault/bookshelves/{bookshelfId}`。
- `pipelineStages.materialized_bookshelf_graph_build.authorityRoot`：
  `graph_vault/bookshelves/{bookshelfId}`。
- `pipelineStages.library_membership_resolution.authorityRoot`：
  `graph_vault/library/{libraryId}`。
- `pipelineStages.library_graph_build.authorityRoot`：
  `graph_vault/library/{libraryId}`。
- `handoffMatrix`：增加 catalog projection 到上层包 mount 的 handoff，并确保
  library 从 bookshelf package manifest 读取成员。
- `stateClosure`：增加上层包复制后的 ready、failed、stale、running、pending
  判断规则。
- `testContracts.requiredCases`：加入上层包复制传播、catalog projection 删除、
  stale projection 拒绝、旧 catalog 迁移和 library-from-copied-shelves 测试。
- `implementationGroundingReview`：更新 implemented artifacts 路径与
  grounding status，避免把旧 catalog 布局标记为满足最新设计。

## 实现迁移影响

- `src/graphrag/upper-index/bookshelf-membership.ts`、`bookshelf-graph.ts`、
  `bookshelf-query.ts`、`bookshelf-graph-validator.ts` 需要把 root resolver 从
  `graphVault/catalog/bookshelves/{id}` 改为 `graphVault/bookshelves/{id}`，并保留
  旧路径迁移或拒绝策略。
- `src/graphrag/upper-index/library-membership.ts`、`library-graph.ts`、
  `library-query.ts`、`library-graph-validator.ts` 需要把 library root 从
  `graphVault/catalog/library/{id}` 改为 `graphVault/library/{id}`。
- library membership 当前读取 member bookshelf 的
  `catalog/bookshelves/{bookshelfId}/current/**`，需改为读取
  `bookshelves/{bookshelfId}/current/**` 或 package manifest 指定的包相对路径。
- manifest 中的 file records、redacted locators、membership manifest path 和
  diagnostics 需要从 catalog-relative 改为 package-relative 或 vault-relative。
- capability catalog 和 CLI scope resolution 需要新增 bookshelf/library package
  projection：catalog 可缓存 `scopeId`、manifestSha256、generation、
  packageRootKind、queryReady 和 capability，但查询必须回读包内 manifest/gate。
- 构建脚本 `build-bookshelf-membership.mjs`、`build-bookshelf-graph.mjs`、
  `build-library-membership.mjs`、`build-library-graph.mjs` 的输出路径和 usage
  文案需要更新。
- 测试中硬编码 `catalog/bookshelves`、`catalog/library` 的断言需要迁移，并补充
  复制传播与 projection 删除场景。
- 旧真实产物位于 `graph_vault/catalog/bookshelves/**` 与
  `graph_vault/catalog/library/**`。迁移前查询路径必须拒绝把旧位置误判为最新
  ready 包，或通过显式 migration command 搬迁并重跑质量门。

## 残余风险

- 术语风险：如果继续称 bookshelf/library 为“派生索引”而未定义“上层包”，实现
  容易再次把 catalog 当作权威目录。
- 迁移风险：旧 catalog current 产物可能被新查询路径误读为 ready，必须通过
  schema version、layoutVersion 或 manifest kind 拦截。
- 复制风险：上层包若记录绝对 member packageRoot，复制后会产生不可复现或泄露
  本地路径的问题。
- 状态风险：全局 runner ledger 与包内 runs 若职责不清，会把运行观测状态混入
  可传播包闭包，或反过来让复制包缺少恢复证据。
- 投影风险：catalog projection stale 时若没有独立 typed error，CLI 可能误用
  旧 locator 或重复扫描全库。
- 回归风险：目录迁移范围较大，必须重跑单书 hotplug package 质量门、
  `--graph-book-id` 查询、qmd vsearch、bookshelf query、library query 和固定预算
  测试，确认新上层包规则不污染单书包。
