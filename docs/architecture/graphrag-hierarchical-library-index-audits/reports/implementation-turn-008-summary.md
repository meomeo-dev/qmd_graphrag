# implementation-turn_008 汇总报告

## 结论

总体结论：`PASS_WITH_RISK`。

三名实施审计代理均依据固定 10 项审计维度完成只读审计，结论分别为：

- agent-1：`PASS_WITH_RISK`
- agent-2：`PASS_WITH_RISK`
- agent-3：`PASS_WITH_RISK`

未发现阻断书架/library 两级派生索引发布的 `FAIL` 项，也未提出本轮必须立即修复的
代码级缺陷。当前实现已形成可运行闭环（runnable closure）：书架 membership、
书架 graph build、library membership、library graph build、scoped query、
质量门、typed error、timing、fixed-budget simulation 与真实 library smoke 均有
运行或测试证据。

保留风险必须在完成声明中继续显式标注：单书 `--graph-book-id` 真实 GraphRAG
查询目前仍是外部 provider/runtime blocked/recoverable 状态，短超时路径可返回
retryable typed `provider_unavailable`，但不能计为成功回答。

## 审计输入

- 规范入口：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定审计基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 审计轮次：`implementation-turn_008`
- agent 报告：
  - `implementation-turn_008/agent-1/report.md`
  - `implementation-turn_008/agent-2/report.md`
  - `implementation-turn_008/agent-3/report.md`

## 已验证运行证据

- `npm run build`：通过。
- 相关回归测试：9 个测试文件、44 个测试通过。
- 合同测试：`test/integrations/contracts.test.ts`，75 个测试通过。
- library scoped query smoke：通过，返回 timing 与 evidence lineage。
- qmd `vsearch` smoke：通过，确认单书 qmd 检索非回归。
- 单书 `--graph-book-id` 短超时 smoke：返回 typed JSON error，
  `code=provider_unavailable`、`retryable=true`，未形成成功回答。
- 已发布上层产物 validator：
  - bookshelf `software-architecture-core`：`ok=true`
  - bookshelf `delivery-devops-core`：`ok=true`
  - library `software-engineering-library` membership：`ok=true`
  - library `software-engineering-library` graph：`ok=true`

## D01 单书包复制传播完整性

汇总判定：PASS。

审计一致认为，上层 membership/build/query 读取单书权威 manifest、publish marker、
包内 qmd/GraphRAG output 与质量门，但书架/library 产物根目录限定在
`graph_vault/catalog/**`。未发现上层索引写回单书包文件闭包。

## D02 书架/library 派生索引不污染单书包

汇总判定：PASS。

书架与 library 的 staging、current、runs、manifest、quality gate、CURRENT pointer
均位于 catalog 下。上层索引损坏或 stale 不会改变单书包 hotplug 分发闭包。

## D03 runner ledger 不参与语义检索

汇总判定：PASS。

审计未发现 upper-index membership/build/query 路径读取
`graph_vault/catalog/batch-runs/**` 作为语义输入。`runs/**` 仅作为局部 build
ledger、status、events、checkpoint 与 recovery summary 使用。

## D04 固定查询预算

汇总判定：PASS。

书架/library manifest 保存固定预算参数，构建和查询均按
`maxSemanticUnits`、`maxInputTokens`、`maxReports` 等上限筛选。10/100/1000 本模拟
library 测试证明 selected report 数、输入 token 估算和 evidence 数未随成员书规模
线性增长。超预算路径返回 `budget_exceeded_narrow_scope_required`。

## D05 evidence lineage

汇总判定：PASS。

书架/library 查询输出可追溯到 `bookId`、`sourceId`、`documentId`、
`contentHash`、`graphTextUnitId`、community report artifact 和 upper metadata。
library evidence 还包含 `targetBookshelfId`、`targetCommunityReportId`、
`targetArtifactDigest` 等跨层定位信息。

## D06 staging/failed/running/pending/stale fail-closed

汇总判定：PASS。

查询路径只读取 `current`，并在查询前运行 validator。成员 manifest sha 失配会被
诊断为 stale 并映射到 typed `upper_index_stale`。membership-only manifest 的
`queryReady=false` 不能授权查询。library stale 测试已覆盖 fail-closed 行为。

风险：CLI 级 staging/pending fixture 测试仍可增强。

## D07 manifest、quality gate、publish marker 状态闭环

汇总判定：PASS。

书架与 library build 使用 staging -> quality gate -> atomic publish -> current
generation 语义。validator 校验 manifest schema、quality gate required checks、
file sha/bytes、parquet schema、成员 gate 与 stale 状态。真实发布的两个 bookshelf
和一个 library 均已通过 validator。

## D08 CLI typed error 与 timing 可观测

汇总判定：PASS。

CLI 支持 `--bookshelf-id` 与 `--library-id`，并与 `--graph-book-id` 互斥。missing、
stale、gate failed、budget exceeded、provider timeout 等路径映射为 typed error。
上层查询输出 `cli.query_bookshelf_upper_index` 或 `cli.query_library_upper_index`
timing stage。单书 GraphRAG timeout 测试覆盖 retryable typed
`provider_unavailable`。

## D09 敏感信息隔离

汇总判定：PASS_WITH_RISK。

manifest/gate 写入前执行 forbidden field 和敏感文本策略检查，禁止 provider
payload、raw prompt/completion、credential、absoluteLocalPath、query log 等进入可发布
上层索引描述字段。Python bridge 对 provider payload、secret、Bearer token、`sk-*`
与绝对路径做脱敏。

风险：当前对 parquet artifact 内容的敏感污染反例测试仍偏弱，建议后续补
artifact-level scan/redaction 测试。

## D10 现有单书 GraphRAG 查询和 qmd vsearch 非回归

汇总判定：PASS_WITH_RISK。

qmd `vsearch` smoke 已成功。单书 GraphRAG provider/runtime 卡死问题已通过 Python
bridge timeout 改为 retryable typed failure，并确认短超时后无残留进程。

风险：单书 `--graph-book-id` 真实回答仍未成功，应保持
external blocked/recoverable 状态，不能在最终结论中写成成功 GraphRAG 回答回归。

## 必须修复项

无本轮阻断级必须修复项。

## 保留风险

- 单书真实 GraphRAG provider/runtime 当前 external blocked/recoverable，不能记作成功
  回答。
- `src/cli/qmd.ts` 仍为超长核心文件，upper scope CLI 接线后续应继续下沉。
- `library-membership.ts`、`bookshelf-membership.ts` 等 upper-index 模块超过项目建议
  行数，后续新增能力前应拆分 planner、schema、writer、validator 职责。
- parquet artifact 级敏感污染反例测试仍需补强。
- interrupted upper-index build 恢复 smoke 可继续增强。

## 后续收敛条件

转为无风险 `PASS` 前，应至少完成：

1. 外部 provider/runtime 可用后，重跑单书 `--graph-book-id` 并得到真实成功回答。
2. 增加 upper parquet artifact 敏感污染反例测试。
3. 增加 CLI 级 staging/pending 或 bookshelf stale fail-closed fixture 测试。
4. 在继续新增上层功能前拆分超长 upper-index membership 模块。
