# design-turn_008 agent-3 设计复审报告

overallStatus: fail

## 审计范围

固定基准：

- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

被审计规范设计：

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

本轮重点：

- membership 最小闭环 runnable target 是否与 `pipelineIoContract` 一致。
- membership-only handoff 是否与 `implementationGroundingReview` 一致。
- 第 8 轮变更是否保持 `designAudit` 的固定基准审计边界。

参考实现只作为接地性证据读取：

- `src/graphrag/upper-index/bookshelf-membership.ts`
- `scripts/graphrag/build-bookshelf-membership.mjs`
- `test/graphrag-bookshelf-membership.test.ts`

## 总体结论

本轮 membership 最小闭环的核心边界是正确的：membership 阶段发布
`BOOKSHELF_MEMBERSHIP_MANIFEST.json`，`queryReady` 固定为 `false`，并声明
后续必须由 `materialized_bookshelf_graph_build` 发布
`BOOKSHELF_MANIFEST.json` 后才能授权 `--bookshelf-id` 查询。该边界与
`pipelineIoContract`、`implementationGroundingReview` 和 `designAudit` 的
方向一致，能防止把 membership runnable target 误读为书架 GraphRAG
query-ready 能力。

但是本轮 runnable target 尚未完整闭合 `pipelineIoContract` 对
`bookshelf_membership_resolution` 的状态与恢复合同。设计要求 membership 阶段
写入 `state/diagnostics.json`、`runs/{runId}/events.jsonl` 和
`runs/{runId}/checkpoints/{decisionId}.json`；当前可运行实现只覆盖 staging、
current、membership manifest、成员文件、split plan、membership quality gate
和 `CURRENT.json`。该缺口影响 D05 状态闭环与恢复，因此本轮总体判定为
`fail`。

已验证命令：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/graphrag-bookshelf-membership.test.ts
```

结果：1 个测试文件通过，2 个测试通过。

## D01_authority_boundaries

status: PASS

证据：

- 固定基准要求单书包 `query_ready` 不依赖书架或 library 索引，且上层索引
  不写入单书闭包。
- 规范设计把 `BOOKSHELF_MANIFEST.json` 定义为
  `graph_build_query_ready_manifest`，只能由
  `materialized_bookshelf_graph_build` 在上层 GraphRAG 产物和书架质量门通过
  后发布；membership 阶段不得用它表示可查询书架。
- 规范设计把 `BOOKSHELF_MEMBERSHIP_MANIFEST.json` 定义为
  `membership_only_handoff_manifest`，其 `queryReady` 必须为 `false`，只能作为
  `materialized_bookshelf_graph_build` 输入，不能授权 `--bookshelf-id` 查询。
- 参考实现的 `BookshelfMembershipManifestSchema` 将
  `bookshelfIdentity.queryReady` 固定为 `false`，`nextStage.requiredManifest`
  固定为 `BOOKSHELF_MANIFEST.json`。
- 测试断言 membership current 目录不存在 `BOOKSHELF_MANIFEST.json`，并确认单书
  `BOOK_MANIFEST.json` 仍存在。

风险：

- 若后续 CLI 将 membership manifest 当作上层 query-ready manifest 读取，会绕过
  书架 GraphRAG 构建与质量门。当前设计已明确阻断，但后续查询实现仍需测试守护。

结论：

PASS。membership 最小闭环没有改变单书包权威，也没有把 membership-only 输出
提升为可查询书架权威。

## D02_fixed_query_budget

status: PASS

证据：

- 固定基准要求查询阶段固定 top-K、禁止交互查询全量扫描所有单书
  `community_reports`，超预算 fail closed 或收窄 scope。
- 规范设计的 `queryContract.interactiveBudget` 定义固定
  `maxSemanticUnits`、`maxBookshelves`、`maxBooksForDeepening`、LLM call cap、
  token cap 和 `budget_exceeded_narrow_scope_required`。
- `pipelineIoContract.scoped_query_execution` 禁止 missing upper index 在查询
  阶段 auto-build，禁止 interactive exhaustive all-books scan。
- membership runnable target 不实现上层查询，也不发布
  `BOOKSHELF_MANIFEST.json`，因此不会创建绕过固定预算的查询入口。

风险：

- membership 阶段接受显式 `bookIds`，构建成本可随成员数增长；这是构建路径，
  不是交互查询路径。后续 materialized shelf build 必须继续执行固定预算模拟。

结论：

PASS。membership runnable target 没有破坏固定查询预算；它保持在查询前的
handoff 阶段。

## D03_graphrag_semantic_alignment

status: PASS

证据：

- 固定基准要求上层索引输入包含 community reports，并保留 entity /
  relationship 或等价语义关系。
- 规范设计在 `materialized_bookshelf_graph_build` 中要求读取成员
  `community_reports.parquet`、`entities.parquet`、`relationships.parquet` 和
  bounded `text_units.parquet`，并输出 `semantic_units.parquet`、
  `semantic_edges.parquet`、`community_reports.parquet` 和 `evidence_map.parquet`。
- membership 阶段仅解析成员集合，并在 `nextStage` 中指向
  `materialized_bookshelf_graph_build`；它没有声称已经生成 GraphRAG 上层语义
  单元。
- 参考实现的成员记录包含 member GraphRAG artifact 相对路径，指向
  `community_reports.parquet`、`entities.parquet`、`relationships.parquet` 和
  `text_units.parquet`。

风险：

- 当前 runnable target 只验证 artifact 路径存在，不验证 parquet schema 或
  GraphRAG 语义内容；这是后续书架图构建质量门的责任。

结论：

PASS。membership 阶段没有退化或替代 GraphRAG 语义层，而是保留后续图构建所需
输入边界。

## D04_evidence_traceability

status: PASS

证据：

- 固定基准要求定义 `evidence_map` 或等价结构，并能追溯到 bookId、sourceId、
  documentId、contentHash、community report 或 text_unit。
- 规范设计的上层图 artifact schema 定义 `evidence_map.parquet`，并要求每个
  上层 semantic unit、semantic edge、community 和 community report 具备下层
  证据引用，纯 membership marker 除外。
- membership 阶段的 `membership_decisions.jsonl` 需要 `evidenceRefs`；
  参考实现把 `BOOK_MANIFEST.json`、`PUBLISH_READY.json`、hotplug quality gate 和
  runtime gate 写入每个 membership decision 的证据引用。
- 参考实现的成员文件记录 `bookId`、`manifestSha256`、`packageGeneration` 和
  GraphRAG artifact 相对路径。

风险：

- membership evidenceRefs 只证明成员资格与包 readiness，不等同于回答证据
  lineage。真正回答可追溯性仍依赖后续 `evidence_map.parquet` builder。

结论：

PASS。对 membership 最小闭环而言，成员决策证据可追溯；回答级 evidence map
被正确留给后续书架图构建阶段。

## D05_state_recovery

status: FAIL

证据：

- 固定基准要求 durable checkpoints/events/status，partial build 不会发布
  query-ready 上层索引，成员变更会标记 stale 或生成新 generation。
- 规范设计的 `stateAndRecovery` 要求 events、checkpoints、status、
  recovery-summary 和 publish protocol。
- `pipelineIoContract.bookshelf_membership_resolution` 明确要求写入
  `state/membership-quality-gate.json`、`state/diagnostics.json`、
  `runs/{runId}/events.jsonl` 和
  `runs/{runId}/checkpoints/{decisionId}.json`。
- 参考实现写入 staging/current、`bookshelf_members.json`、
  `membership_decisions.jsonl`、`bookshelf_split_plan.json`、
  `state/membership-quality-gate.json`、`BOOKSHELF_MEMBERSHIP_MANIFEST.json` 和
  `CURRENT.json`。
- 参考实现没有写入 `state/diagnostics.json`、`runs/{runId}/events.jsonl`、
  `runs/{runId}/checkpoints/{decisionId}.json`、`status.json` 或
  `recovery-summary.json`。
- 参考实现通过 staging rename 避免发布 `BOOKSHELF_MANIFEST.json`，并将
  membership `queryReady` 固定为 `false`；partial query-ready 发布风险被控制，
  但 durable recovery 合同未完整闭合。

风险：

- membership run 中断后，调用方无法仅从 runs/events/checkpoints 判断
  `ready`、`failed`、`running` 或 `pending_user_acceptance`。
- 后续 materialized bookshelf build 只能依赖 current handoff 文件，缺少可审计
  的 decision checkpoint 和 bounded diagnostics。
- 第 8 轮 runnable target 若被宣称“完整符合 pipeline I/O”，会高估恢复能力。

结论：

FAIL。membership-only handoff 的 query-ready 边界正确，但状态恢复闭环低于
`pipelineIoContract` 和固定 D05 基准。

## D06_quality_gates

status: PASS

证据：

- 固定基准要求 bookshelf 和 library 独立质量门，并覆盖 schema、checksum、
  成员一致性、敏感信息和固定预算模拟。
- 规范设计保留完整 `bookshelfGate` 和 `libraryGate`，并新增
  `membershipChecks`，覆盖 decision schema、authority order、user locks、LLM
  suggestion、accepted suggestion、oversized category、virtual parent、
  direct book limit 和 library partition。
- membership runnable target 的 `MembershipQualityGateSchema` 将
  `stageId` 固定为 `bookshelf_membership_resolution`，`readyState` 固定为
  `membership_resolved`，`queryReady` 固定为 `false`。
- 参考实现写入 `state/membership-quality-gate.json` 并在 validation 中检查
  manifest、members 和 gate schema 以及 checksum sidecar。
- 缺少成员 runtime gate 时，测试验证 `upper_quality_gate_failed`，且不发布
  current membership。

风险：

- 当前 membership gate 的 checks 全部由代码生成 passed，尚未覆盖真实冲突解析、
  oversized split、virtual parent 或 library-level membership checks。
- 固定预算模拟属于 graph build gate，当前 membership target 未覆盖。

结论：

PASS。以 membership 最小闭环为边界，质量门能阻断不合格成员，并且不授权查询。
完整 bookshelf/library quality gate 仍是后续能力。

## D07_incremental_scaling

status: PASS

证据：

- 固定基准要求记录成员 manifest sha256 和 generation，并定义增量刷新或保守
  全量重建条件。
- 规范设计要求 bookshelf generation 随成员集合、成员 manifest sha256、
  builder version、embedding fingerprint、聚类配置、summary 配置或 evidence
  schema 改变。
- membership runnable target 对每个成员记录 `manifestSha256`、
  `packageGeneration`、`membershipDecisionId` 和 membership generation。
- 参考实现的 generation 基于 bookshelfId、排序去重后的 bookIds、policy kind
  和 taxonomy id/version 生成；成员文件记录 manifest sha256，供后续 build
  检测 manifest 漂移。

风险：

- 当前 membership generation 没有把每个 `manifestSha256` 纳入 generation hash；
  同一成员集合但单书 manifest 改变时，成员文件内容会变，但 generation 名称可能
  不变。设计要求 generation 随成员 manifest sha256 改变，这一细节需要后续实现
  收敛。

结论：

PASS。membership handoff 已记录成员 digest 和 package generation，满足可增量
检测的最低证据；generation 命名细节存在后续修订风险。

## D08_security_privacy

status: PASS

证据：

- 固定基准要求禁止 provider payload、密钥、原始 prompt/completion、绝对路径
  和 query.log 进入可发布上层 manifest 或索引。
- 规范设计在 `diagnosticRedactionPolicy` 中列出 forbidden fields，并要求诊断和
  manifest 只记录 digest、schema id、bounded summaries、check id 和 redacted
  locators。
- `pipelineIoContract.bookshelf_membership_resolution` 禁止 raw LLM prompt 或
  completion，以及 runner ledger events 作为 classification evidence。
- 参考实现的 membership manifest 包含 `sensitivityPolicy.forbiddenFields`，
  成员和证据定位使用 `books/{bookId}/...` 形式的 graph_vault-relative 路径。
- 参考实现没有读取或写入 provider payload、raw prompt、raw completion、
  credential、absolute path 或 query log 字段。

风险：

- `validateBookshelfMembership` 的 diagnostics 在内存中可能包含本地绝对 root
  截断后的相对路径；当前报告未发现写入 manifest 的绝对路径，但后续
  diagnostics 文件实现必须保持 scope-relative。

结论：

PASS。membership runnable target 与敏感信息边界一致。

## D09_cli_operability

status: PASS

证据：

- 固定基准要求 scope resolution order、stale 或 ambiguity typed error，以及按
  层级阶段分解 timing/cost。
- 规范设计定义 explicit bookId、bookshelfId、libraryId、default library、快速
  ambiguity error 的 scope resolution order，并定义 `upper_index_missing`、
  `upper_index_stale`、`upper_quality_gate_failed` 等 typed errors。
- `implementationGroundingReview` 明确当前只有单书 `--graph-book-id`，没有
  `--bookshelf-id`、`--library-id` 或 upper typed error mapping，防止误读为已实现。
- membership CLI 脚本只构建 membership handoff，输出 `readyState` 和
  `queryReady`，不提供上层 query 命令。
- 缺 runtime gate 的测试覆盖 `upper_quality_gate_failed` 前缀错误。

风险：

- membership 脚本抛出的错误是字符串形式，不是完整 `typed_query_error_v1`
  结构；这对 build 脚本可接受，但后续 CLI query/status 命令需要结构化错误。

结论：

PASS。membership target 没有伪装为完整 bookshelf/library CLI 查询能力，并与
grounding review 的分阶段实现姿态一致。

## D10_testability

status: PASS

证据：

- 固定基准要求至少 8 个必测案例，并包含不同规模库固定预算验证和单书
  hotplug 非回归。
- 规范设计的主 `testContracts.requiredCases` 超过 8 项，覆盖单书查询不回归、
  membership authority、LLM suggestion、oversized category、固定 top-K、预算
  超限、stale、missing upper index、evidence map、安全扫描、partial publish 和
  timing。
- `pipelineIoContract.testContracts` 也超过 8 项，覆盖 package projection、
  membership resolution、suggestion-only、oversized taxonomy、bookshelf publish、
  library membership、scoped query failure code、预算错误、删除上层 catalog 不
  破坏单书查询和 redacted diagnostics。
- 本轮已有窄范围测试覆盖 query-ready 单书生成 membership generation，以及缺
  runtime gate 时 fail closed 且不发布 current。

风险：

- 当前 runnable target 的测试只有 2 个，尚未覆盖 user lock 冲突、LLM
  suggestion-only、accepted suggestion、oversized split、checksum 变化、
  durable runs/checkpoints 或 sensitive diagnostics。
- 固定预算多规模验证属于后续 graph/query 阶段，当前 membership target 不能替代。

结论：

PASS。规范测试合同满足 D10；本轮 membership 测试是最小可运行切片的起点，但
不能视为完整 D10 测试实现。

## 最终判定

D01 PASS  
D02 PASS  
D03 PASS  
D04 PASS  
D05 FAIL  
D06 PASS  
D07 PASS  
D08 PASS  
D09 PASS  
D10 PASS

结论：

第 8 轮设计在 membership-only 与 query-ready manifest 分离方面方向正确，并与
`implementationGroundingReview` 的 direct extension / new capability 分层一致。
本轮不能判定为全通过，原因是 membership runnable target 尚未满足
`pipelineIoContract` 对 durable events、checkpoints、diagnostics 和 recovery
state 的最小闭环要求。修复 D05 后，应补充对应 fixture 或 contract test，再复审。
