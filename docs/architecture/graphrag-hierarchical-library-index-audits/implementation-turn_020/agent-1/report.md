# implementation-turn_020 实施审计报告 agent-1

## 审计结论

finalVerdict: PASS

本轮审计按固定基准
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
的 D01-D10 执行。当前实现未发现阻断性缺陷。书架与 library 上层索引
package-root 权威、显式查询、固定预算、质量门、typed error、evidence lineage、
provider synthesis 和单书非回归验证均已形成可审计闭环。

## 审计范围

- `src/graphrag/upper-index/upper-synthesis.ts`
- `src/cli/qmd.ts`
- `src/cli/graphrag-upper-management.ts`
- `src/llm.ts`
- `src/contracts/provider.ts`
- 相关上层 GraphRAG、CLI、provider contract、hotplug 和 vsearch 测试
- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml` 当前状态同步

本报告未修改代码、Type DD 或 base 审计基准。唯一写入文件为本报告。

## 验证证据

- `audit-shelf-a` 与 `audit-shelf-b` 分别从 3 本已发布 book package 构建为
  query_ready bookshelf package。
- `audit-library` 从 2 个 query_ready bookshelf package 构建为 query_ready
  library package。
- 删除 catalog projection 后，显式 `--bookshelf-id` 与 `--library-id` 查询成功。
- 真实 provider `--upper-synthesis` 对 latest `audit-library` generation 成功，
  timing 包含 `upper.llm_synthesis`，stdout 不含 prompt 或 provider payload。
- `--max-synthesis-output-tokens 200` 的真实 provider smoke fail-closed 为
  `budget_exceeded_narrow_scope_required`。
- 单书 `--graph-book-id` 真实 provider 查询成功；单书 package gate 与 runtime
  gate 通过。
- 测试矩阵通过：`npm run test:types`；上层 synthesis、graph、management、
  route、failclosed、membership、deepening；hotplug、capability、vsearch；
  OpenAI Responses、Provider contracts；YAML parse。
- Type DD 已同步 implementation-turn_020：显式 `--upper-synthesis`、
  `refresh-membership`、`repair` 作为已实现能力记录；build-time LLM-authored
  community report synthesis、自动调度 repair 和增量 rebuild planner 仍列为未来能力。

## D01_authority_boundaries

status: PASS

书架权威根为 `graph_vault/bookshelves/{bookshelfId}/`，library 权威根为
`graph_vault/library/{libraryId}/`。显式上层查询通过 package-local
`CURRENT.json`、manifest、`PUBLISH_READY.json`、quality gate 和 checksum
校验 readiness；catalog projection 只作为派生视图，不能证明 query-ready。
本轮 `refresh-membership` 和 `repair` 均从 package root 读取或重建，不将
catalog 作为语义输入，也不写回单书包闭包。单书 `--graph-book-id` 与 hotplug
gate 验证通过，未发现单书包权威回归。

## D02_fixed_query_budget

status: PASS

上层查询使用 package-local fixed query budget。`--upper-synthesis` 默认关闭；
显式开启时只对已选上层 evidence 执行一次 LLM 调用，输入与输出 token 预算只能
通过 CLI 参数收窄，不能放宽。`--max-synthesis-output-tokens 200` 真实 provider
smoke 以 `budget_exceeded_narrow_scope_required` fail-closed，证明预算超限不会
被静默接受。书架、library 查询不全量扫描所有单书 community reports，也不随
成员书数量线性增加 LLM 调用数或候选 evidence 数。

## D03_graphrag_semantic_alignment

status: PASS

上层 GraphRAG 构建以成员书包或成员书架的 community reports、semantic units、
semantic edges、entities、relationships 和 evidence map 为输入，生成上层
community_reports 与可查询 semantic artifacts。查询先执行固定预算的上层 report
search；可选 synthesis 仅综合已选上层 evidence，不退化为把多本书拼接成一次
超大普通摘要检索。

## D04_evidence_traceability

status: PASS

bookshelf 与 library 输出保留 evidence lineage，可追溯到 `bookId`、`sourceId`、
`documentId`、`contentHash`、community report 或 text unit。`--upper-synthesis`
保留所用 evidence，并在 metadata 中加入 sanitized synthesis 标记与 scope
信息；不会丢失原上层 evidence 引用。删除 catalog projection 后显式查询仍成功，
说明 evidence lineage 来自 package-local 上层包而非 catalog 派生状态。

## D05_state_recovery

status: PASS

membership generation、graph generation、`CURRENT.json`、`PUBLISH_READY.json`、
package-local quality gate 和 manifest sha256 构成状态闭环。`refresh-membership`
只发布 `queryReady=false` 的 membership generation；`repair` 显式读取当前
package-root membership，重新解析成员并构建 query-ready 上层包。staging、
failed、pending、running、stale 或 gate failed 状态不会被查询路径当作 ready。
成员 manifest 或 generation 变化按 stale typed error 拒绝。

## D06_quality_gates

status: PASS

bookshelf 与 library 均有独立 package-local quality gate。检查覆盖 schema、
checksum、成员一致性、artifact closure、evidence map、敏感信息扫描和
fixed-budget simulation。质量门失败、缺失或 scope 不匹配会快速返回
`upper_quality_gate_failed` 等 typed error；不会进入交互查询。

## D07_incremental_scaling

status: PASS

成员记录包含 manifest sha256 与 generation，可检测 member book 或 member
bookshelf stale。library 以已发布 bookshelf package 为输入，不把大量单书直接塞入
交互查询。显式 `refresh-membership` 与 `repair` 已提供 package-root 生命周期恢复
路径；自动调度 repair 与增量 rebuild planner 仍被 Type DD 正确列为未来能力，
未被误判为已完成。

## D08_security_privacy

status: PASS

实现和测试覆盖 raw prompt、raw completion、provider payload、绝对路径、凭据和
query log 不进入可发布上层索引或查询响应 metadata。`upper-synthesis` 构造 prompt
只传给 runner，返回响应经 `sanitizeVaultText` 与 `sanitizeVaultMetadata` 处理；
provider stdout smoke 也确认不含 prompt/provider payload。OpenAI Responses 请求
只记录预算与运行 metrics，不把原始 provider payload 写入上层 package artifacts。

## D09_cli_operability

status: PASS

CLI 已支持 `--bookshelf-id`、`--library-id`、`--upper-synthesis`、
`--max-synthesis-input-tokens`、`--max-synthesis-output-tokens`、
`refresh-membership`、`repair`、`status`、`list`、`build` 和 `rebuild`。
缺 scope、legacy catalog-only、stale、质量门失败、缺索引、超预算和 synthesis
runner 错误均有 typed error 路径。成功查询输出 bounded timing；真实 synthesis
smoke 已出现 `upper.llm_synthesis` timing stage。

## D10_testability

status: PASS

测试覆盖超过固定基准要求：单书 hotplug 非回归、qmd vsearch 非回归、书架和
library membership、上层 graph build/query、删除 catalog projection 后显式查询、
fixed-budget fail-closed、controlled deepening、upper synthesis、CLI route、
OpenAI Responses 与 Provider contracts、YAML parse。真实 provider smoke 覆盖
library synthesis 成功、预算收窄失败闭环和单书 `--graph-book-id` 查询成功。

## 阻断项

无。

## required fixes

无。
