# design-turn_015 agent-1 report

结论：FAIL

## D01_authority_boundaries

PASS。Type DD 继续保持单书包、bookshelf package root、library package root
的权威边界。catalog 明确为 projection / routing view，不拥有上层包闭包，
也不能证明 query-ready。

## D02_fixed_query_budget

FAIL。`--upper-deepening` 被设计为显式启用、默认关闭，并且只从已发布
上层包已选 evidence 中选择固定数量 member book 下钻，方向正确。但文档
引用了未定义预算名 `maxBookshelvesForDeepening`，而
`queryContract.interactiveBudget.default` 只定义了 `maxBookshelves` 与
`maxBooksForDeepening`。这会让 library controlled deepening 的书架目标
预算边界产生歧义，不满足固定预算合同的可执行性要求。

## D03_graphrag_semantic_alignment

PASS。上层索引输入和查询路径仍围绕 community reports、semantic units、
semantic edges、entities / relationships 与 evidence map，没有退化为普通
摘要检索。LLM synthesis 未实现的状态被保留为 remaining capability。

## D04_evidence_traceability

PASS。Type DD 要求 evidence_map、bookId、sourceId、documentId、
contentHash、community report / text_unit lineage，并说明 controlled deepening
只能从已选 upper evidence 下钻。证据回链边界清晰。

## D05_state_recovery

PASS。设计继续要求 package-local staging、quality gate、atomic publish、
CURRENT、PUBLISH_READY、stale marker 和 failed/running/pending fail-closed。
运行态状态闭环满足基准。

## D06_quality_gates

PASS。bookshelf 与 library 均有独立质量门，覆盖 schema、checksum、成员
一致性、evidence lineage、敏感信息扫描和 fixed-budget simulation。质量门
失败时查询不可用并返回 typed error。

## D07_incremental_scaling

PASS。设计记录成员 manifest sha256 / generation，允许局部刷新；无法局部化
时保守生成新 generation。大库通过 bookshelf 分层限制重建影响范围。

## D08_security_privacy

PASS。forbidden inputs 与 diagnostic redaction policy 明确禁止 provider
payload、raw prompt/completion、credential、绝对路径和 query log content
进入可发布索引、manifest 或诊断。

## D09_cli_operability

PASS。scope resolution、legacy catalog-only fail-closed、stale / missing /
over budget typed errors、timing breakdown 与 `--upper-deepening` 显式开关均已
定义。catalog projection 缺失不得阻断显式 package-root 查询。

## D10_testability

PASS。测试合同超过 8 项，覆盖固定预算、多规模 library、catalog projection
删除、legacy catalog-only fail-closed、hotplug 非回归、敏感信息扫描、stale
和 interrupted build。controlled deepening 的测试意图已在实现接地状态中
列出。

## Required Fixes

- 定义 `maxBookshelvesForDeepening` 的含义、默认值、上限和与
  `maxBookshelves` / `maxBooksForDeepening` 的关系；或删除该名称，统一使用
  已定义预算字段。必须明确 `--max-deepening-targets` 只能收窄哪个
  package-local cap。
- 修正 `designAudit` 状态闭环：当前 Type DD 已声明 `design-turn_015`
  三代理通过，但本地未找到
  `docs/architecture/graphrag-hierarchical-library-index-audits/design-turn_015/`。
  在 3 个 agent 报告实际落盘前，不应把 `currentRunDirectory` 和
  `finalAuditSummary.result` 写成 completed / passed。
- 修正实现审计引用闭环：Type DD 引用 `implementation-turn_016` 与
  `implementation-turn-016-summary.md`，但当前审计目录中未找到对应产物。
  应改为 pending / planned，或补齐真实审计报告后再声明 re-audited with risk。

## Minor Notes

- controlled deepening 的 missing `graph_query` capability 当前可通过
  fail-closed 表达，但最好在 CLI typed error 矩阵中明确映射到
  `upper_quality_gate_failed`、`upper_index_stale` 或新增更精确错误码，避免
  运维诊断歧义。
- `synthesisLlMCallCap` 拼写与 `maxLlmCalls.synthesize` 命名不一致，建议统一
  为一个合同字段，避免把“未实现 LLM synthesis”误读为运行预算字段。

## Residual Risks

- LLM synthesis 仍未实现，当前上层回答仍是 fixed-budget report search /
  evidence 输出与可选 controlled deepening。
- 真实外部 provider 的单书 `--graph-book-id` 成功路径仍未验证；
  `--upper-deepening` 当前只能视为 fixture / injectable provider 路径已覆盖。
- membership 创建、自动 repair、增量 refresh 管理生命周期仍是后续能力。
- controlled deepening 虽固定预算，但依赖成员单书 package 的 `graph_query`
  capability 与 provider 可用性；provider timeout 应继续保持 typed runtime
  error，而不能降级为静默缺证。
