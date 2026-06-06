# GraphRAG 层级 Library 索引设计复审报告

审计对象：`docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`

固定基准：
`docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`

审计轮次：`design-turn_004`

审计 agent：`agent-01`

总体结论：pass

判定规则：逐项使用固定基准 D01-D10。任一维度为 `fail` 时总体为
`fail`；本轮未发现 `fail` 项。

## 第三轮 D06 minor note 复核

status: resolved

第三轮 D06 minor note 要求把 membership authority/queryReadyAllowed、LLM
suggestion not query-ready、user lock、oversized split、virtual parent no
direct index 显式落到 quality gate/check ids/测试合同。

复核结论如下：

- `bookshelfContract.membership.policyKinds` 定义每类成员策略的
  `authority` 与 `queryReadyAllowed`，其中 `llm_suggested` 为
  `suggestion_only` 且 `queryReadyAllowed: false`。
- `qualityGates.bookshelfGate.requiredChecks` 已包含成员决策 schema、成员
  authority 顺序、用户 lock 保留、LLM 建议未接受不可 query-ready、接受记录、
  oversized category 拆分、虚拟父书架不拥有 `semantic_units` 或
  `community_reports`。
- `qualityGates.membershipChecks.checkIds` 已定义
  `membership_authority_order_valid`、`membership_user_locks_preserved`、
  `membership_llm_suggestion_not_query_ready`、
  `membership_oversized_category_split`、
  `membership_virtual_parent_no_direct_index` 等可诊断检查 ID。
- `testContracts.requiredCases` 覆盖用户显式成员覆盖 taxonomy/LLM 建议、
  `membership_decisions` fixture、LLM suggested bookshelf 未接受前不可
  query-ready、接受建议创建新 generation、超大类别变虚拟父书架及物化子
  书架、虚拟父书架固定路由或要求收窄 scope。

因此，第三轮 D06 minor note 已补齐到质量门、检查 ID 和测试合同。

## D01_authority_boundaries：权威边界与热插包隔离

status: pass

设计继续保持单书 `BOOK_MANIFEST.json` 作为单书包权威（package
authority）。`hardInvariants` 规定书架与 library 索引不得改变单书包身份、
文件闭包或 `query_ready` 判定；上层索引缺失、损坏或 stale 不会使有效单书
包变成 `not_query_ready`。热插兼容规则也要求安装或删除 book package 只标记
依赖的上层索引 stale，不自动修改 ready generation 或单书包。

## D02_fixed_query_budget：固定查询预算

status: pass

查询合同定义固定 `maxSemanticUnits`、`maxBookshelves`、
`maxBooksForDeepening`、`maxMemberCommunityRefs`、LLM 调用数和 token 上限。
交互查询必须先从上层预计算 semantic units 召回固定数量候选，禁止把全部成员
书 `community_reports` 作为 prompt 输入，也禁止按成员书数量创建不受限 map
调用。超预算时返回 `budget_exceeded_narrow_scope_required` 或要求收窄 scope。

## D03_graphrag_semantic_alignment：GraphRAG 语义对齐

status: pass

上层构建输入包含成员书的 `community_reports`、`entities`、
`relationships` 与 qmd metadata。书架和 library 输出
`semantic_units.parquet`、`semantic_edges.parquet`、`communities.parquet` 与
`community_reports.parquet`。`semantic_edges` 保留方向、权重、来源 entity、
relationship、证据映射和 generation，避免退化为普通摘要检索。

## D04_evidence_traceability：证据可追溯

status: pass

`evidence_map.parquet` 定义 book、bookshelf、source、document、content hash、
community report、text unit、artifact digest、rank 和 generation 等字段。
每个上层 semantic unit、semantic edge、community 与 community report 必须有
下层证据引用，纯 membership marker 例外。查询综合规则要求最终回答包含可追溯
evidence ids，并标明 scoped 或 non-exhaustive 状态。

## D05_state_recovery：状态闭环与恢复

status: pass

设计定义书架和 library build ledger、`status.json`、`events.jsonl`、
checkpoints、`recovery-summary.json` 与 publish protocol。构建完成要求
checkpoint、manifest、quality gate 和 publish marker 同时成立。失败的
semantic unit generation 不发布 ready 上层索引；成员 manifest 变化在查询使用
前标记 stale。动态成员书架查询使用持久化 generation，不进行 live rescan。

## D06_quality_gates：质量门

status: pass

书架和 library 均定义独立质量门与 `requiredChecks`。书架质量门覆盖 manifest
schema、checksum sidecars、成员 manifest sha256、成员包质量门、成员决策
schema、authority 顺序、用户 lock、LLM 建议不可 query-ready、接受记录、超大
类别拆分、虚拟父书架无直接语义索引、schema 校验、证据映射、embedding/vector
元数据、固定预算模拟、敏感扫描和 stale marker。library 质量门覆盖成员书架
manifest sha256、成员书架质量门、虚拟父书架展开、direct book limit、partition
限制和同类索引质量检查。

`membershipChecks.checkIds` 已为成员相关失败定义稳定检查 ID，诊断规则要求使用
`upper_quality_gate_failed` 并设置 `failedCheckId`。质量门失败时查询不可用且有
机器可读、脱敏诊断。

## D07_incremental_scaling：增量扩展

status: pass

书架 generation 随成员集合、成员 manifest sha256、builder version、embedding
fingerprint、clustering config、summary config 或 evidence schema 变化而变化。
library generation 随 shelf membership、成员 shelf manifest sha256 和构建配置
变化而变化。书架与 library 均允许 checksum 可证明时局部重建；无法局部化时
保守重建或标记 stale 并创建新 generation。大库通过物化书架、虚拟父书架和
nested library partitions 限制重建影响范围。

## D08_security_privacy：安全与隐私

status: pass

设计通过 `no_sensitive_payload_export`、`forbiddenInputs`、manifest
`sensitivityPolicy` 和 `diagnosticRedactionPolicy` 禁止 provider payload、原始
prompt、原始 completion、密钥、凭据、绝对本地路径和 `query.log` 内容进入可
发布上层 manifest、索引、质量门或诊断。质量门包含敏感 payload scan；诊断和
manifest 仅允许 digest、schema id、bounded summary、check id 和 redacted
locator。

## D09_cli_operability：CLI 可操作性与降级

status: pass

CLI scope resolution order 为 explicit book、explicit bookshelf、explicit
library、configured default library、fast ambiguity error。无 scope 查询不得在
query path 中重建或扫描全库。CLI 行为矩阵覆盖 missing scope、ambiguous scope、
missing index、stale、quality gate failed 和 over budget，并为各场景定义 typed
error、fallback、remediation command 与 timing fields。虚拟父书架查询过宽时
固定 top-K 路由到子物化书架或要求 scope refinement。

## D10_testability：可测试性

status: pass

`testContracts.requiredCases` 定义 19 个必测案例，超过基准要求的 8 个。测试覆盖
单书 hotplug 非回归、用户显式成员优先、成员决策 fixture、LLM suggested
bookshelf 未接受前不可 query-ready、接受建议创建新 generation、超大类别拆分、
虚拟父书架固定路由或收窄、10/100/1000 本固定 top-K、超预算 typed error、
stale 默认拒绝、缺索引不在查询路径重建、成员包 gate 失败 fail closed、证据
映射、semantic edge 证据、敏感扫描、中断恢复、删除 book 只标记上层 stale、
exhaustive report 与交互查询分离，以及分层 timing 观测。

