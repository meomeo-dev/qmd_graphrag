# GraphRAG 层级 Library 索引设计复审报告

## 审计范围

- 审计轮次：design-turn_003
- 审计 agent：agent-02
- 审计对象：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 基准维度：D01-D10
- 总体结论：pass

## 重点结论

design-turn_003 新增的书架成员组织策略（membership organization policy）
未破坏固定查询预算、增量扩展或 CLI 可操作性。物化书架
（materialized bookshelf）定义了默认 64 本、softLimit 80 本、hardLimit
120 本，并把成员数量、语义单元预算、主题离散度和候选支配度作为拆分条件。
这些约束足以防止单个物化书架在查询阶段退化为随书籍数量线性扩张的 scope。

超大类别变为虚拟父书架（virtual parent bookshelf）的规则可操作。父书架只
保留分类、导航和子书架关系，不直接生成 `semantic_units` 或
`community_reports`；可查询语义由子物化书架或 library 索引承载。查询虚拟
父书架时必须固定 top-K 选择子书架，或在过宽时返回 scope refinement，因此
不会引入全量扫描路径。

成员策略具备状态恢复条件。动态规则书架必须按 generation 固化解析后的成员
集合，`bookshelf_members.json` 记录成员 manifest sha256、packageGeneration、
决策来源和虚拟父书架关系，`membership_decisions.jsonl` 记录可审计决策。
用户显式锁定优先，LLM 建议在用户接受前不能 query-ready；重新运行 LLM 生成
新建议 generation，不会静默改写已接受书架。

## 逐项结论

### D01_authority_boundaries

- title：权威边界与热插包隔离
- status：pass

设计继续保持单书 `BOOK_MANIFEST.json` 及包内产物作为单书包权威。书架与
library 索引被限定为 catalog 下的可重建派生物，缺失、损坏或 stale 不改变
单书 `query_ready`。新增书架成员策略只影响上层派生索引与导航，不写入单书包
文件闭包，也不改变单书挂载状态。

### D02_fixed_query_budget

- title：固定查询预算
- status：pass

查询合同定义固定默认预算：`maxSemanticUnits: 32`、`maxBookshelves: 4`、
`maxBooksForDeepening: 3`、`maxMemberCommunityRefs: 24`、固定 LLM 调用上限、
`maxInputTokens: 64000` 和 `maxOutputTokens: 4000`。查询阶段先在上层预计算
semantic units 上召回固定数量候选，禁止查询时全量扫描所有成员书
`community_reports`，也禁止按成员数创建不受限 map 调用。

design-turn_003 对物化书架新增 `defaultMaterializedShelfBookLimit: 64`、
`softLimit: 80`、`hardLimit: 120`。超过 hardLimit、语义单元超过固定构建预算、
主题离散度过高，或单一书架会支配超过半数 library 查询候选时，必须拆分为
多个子物化书架，并以虚拟父书架保留原类别导航语义。虚拟父书架查询只能固定
top-K 路由到子书架，或返回 `budget_exceeded_narrow_scope_required` 要求收窄
scope。因此超大类别不会绕过交互查询预算。

### D03_graphrag_semantic_alignment

- title：GraphRAG 语义对齐
- status：pass

上层构建输入包含单书 `community_reports`、entities 和 relationships。设计
定义 `semantic_units.parquet`、`semantic_edges.parquet`、communities 与
上层 `community_reports.parquet`，并要求 semantic edges 保留关系方向、权重、
实体标题、relationship ids、证据引用和 generation。上层综合回答基于预计算
community reports 或 semantic units，不退化为普通摘要检索。

### D04_evidence_traceability

- title：证据可追溯
- status：pass

设计定义 `evidence_map.parquet`，字段覆盖 bookId、sourceId、documentId、
contentHash、community report、text unit 和 artifact digest。每个上层语义
单元、语义边、community 与 community report 都必须具备下层证据引用，除非是
无可回答内容的纯 membership marker。回答合成规则要求输出 traceable evidence
ids，并标明 scoped 或 non-exhaustive 状态。

### D05_state_recovery

- title：状态闭环与恢复
- status：pass

构建状态闭环包含 run ledger、`events.jsonl`、`status.json`、checkpoint、
`recovery-summary.json`、质量门与 publish marker。发布协议要求 staging 校验、
checksum sidecars、质量门诊断、原子提升和最后写 publish marker。失败或中断的
semantic unit generation 不会发布 query-ready 上层索引；成员 manifest stale 会
在查询使用前标记。

新增 membership policy 也具备恢复基础：动态规则查询使用固化 generation，不做
live rescan；成员决策以 `membership_decisions.jsonl` 记录；接受 LLM 建议会创建
新的物化书架 generation；LLM rerun 生成新建议 generation 而非原地修改。

### D06_quality_gates

- title：质量门
- status：pass

书架和 library 均定义独立质量门与 requiredChecks。检查项覆盖 manifest schema、
checksum sidecars、成员 manifest sha256、成员质量门、semantic unit/edge schema、
community reports、evidence map、embedding/vector 元数据、固定预算模拟、敏感
信息扫描和 stale marker。质量门失败时上层查询不可用，并通过有界、机器可读、
脱敏的 diagnostics 暴露失败原因和修复命令。

### D07_incremental_scaling

- title：增量扩展
- status：pass

书架成员记录包含 `manifestSha256`、`packageGeneration`、membership source、
decision id 和虚拟父书架关系；书架 generation 会随成员集合、成员 manifest
sha256、builder、embedding、聚类、摘要或证据 schema 变化而改变。书架增量刷新
允许在 checksum 证明输入未变时只重建受影响 semantic units 和 communities，
否则重建该书架 generation。

library generation 会随书架成员、书架 manifest sha256 与构建配置变化而改变。
当成员书架变化时，library 可局部重建受影响 semantic units、semantic edges 和
communities；若图连通性变化不能局部化，则必须标记当前 generation stale 并创建
新的全量 library generation。大库通过物化书架、虚拟父书架和 nested library
partitions 控制重建影响范围，避免每次变更都重建全库。

### D08_security_privacy

- title：安全与隐私
- status：pass

设计定义 forbidden inputs，禁止 provider request/response payload、query logs、
本地绝对路径和未验证损坏包进入上层构建输入。硬不变量与诊断脱敏策略禁止
provider payload、原始 prompt/completion、密钥、凭据、绝对路径和 query log
内容进入 manifest、索引、质量门或诊断。质量门包含敏感信息扫描，诊断只允许
digest、schema id、有界摘要和脱敏 locator。

### D09_cli_operability

- title：CLI 可操作性与降级
- status：pass

CLI scope resolution order 明确为显式 bookId、显式 bookshelfId、显式
libraryId、configured default library、快速 ambiguity error。无 scope、歧义、
缺上层索引、stale、质量门失败、超预算和运行时错误均有 typed error code、
exitCode、remediationCommand 与 timing fields。查询路径禁止无 scope 时隐式全库
扫描或在查询内重建所有索引。

对虚拟父书架的操作性已覆盖：虚拟父书架不承载直接查询语义单元；library 构建
可展开其子物化书架；查询虚拟父书架只能对 child shelves 做固定 top-K selection，
或在过宽时返回 scope refinement。对 stale membership generation，默认查询拒绝
并返回 `upper_index_stale`，仅在用户显式允许 stale reads 时可使用上一代索引。
timing/cost 观测按 `route.resolve_scope`、`route.validate_generation`、
`route.retrieve_semantic_units`、`route.apply_budget` 等层级阶段分解。

### D10_testability

- title：可测试性
- status：pass

测试合同超过 8 个必测案例，覆盖 hotplug 非回归、用户显式成员优先、LLM 建议不
直接 query-ready、接受建议创建新 generation、超大类别转虚拟父书架、虚拟父书架
固定路由或收窄、10/100/1000 本固定 top-K 验证、超预算 typed error、stale 拒绝、
缺索引不隐式重建、成员包失败 fail-closed、evidence map、semantic edges、敏感
扫描、中断恢复、删除书本 stale 标记、exhaustive report 与交互查询隔离，以及
查询 timing 报告。

## 剩余观察

未发现固定基准 D01-D10 下的 fail 项。后续实现阶段需要把 hardLimit/softLimit、
虚拟父书架 top-K 路由、membership decision replay 和 stale generation 检测落实
为可执行 schema、CLI fixture 和预算模拟测试；这些是实现验证要求，不影响本轮
设计复审通过结论。
