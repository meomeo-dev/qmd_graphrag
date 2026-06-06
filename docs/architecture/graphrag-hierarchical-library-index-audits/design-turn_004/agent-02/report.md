# GraphRAG 层级 Library 索引设计复审报告

## 审计范围

- 审计轮次：design-turn_004
- 审计 agent：agent-02
- 审计对象：
  `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- 固定基准：
  `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- 基准维度：D01-D10
- 总体结论：pass

## 重点结论

design-turn_004 新增的 membership quality checks 未破坏固定查询预算
（fixed query budget）、增量扩展（incremental scaling）或 CLI 行为。
这些检查被放在书架和 library 质量门中，失败时通过
`upper_quality_gate_failed` 暴露诊断，不引入查询阶段全量扫描或隐式重建。

新增检查能够覆盖本轮重点风险：超大类别必须在物化索引前拆分，虚拟父书架
不得直接拥有 `semantic_units` 或 `community_reports`，LLM suggestion 在用户
接受前不得 query-ready，接受记录必须包含 `userAcceptedAt` 和 actor。这些规则
与固定 top-K、预算模拟、stale generation 和 typed error 合同一致。

## 逐项结论

### D01_authority_boundaries

- title：权威边界与热插包隔离
- status：pass

设计仍保持单书 `BOOK_MANIFEST.json` 及包内质量门作为单书包权威。书架和
library 索引位于 catalog 下，是可重建派生物。新增 membership checks 只约束
上层成员解析、建议接受、拆分和虚拟书架规则，不写入单书包文件闭包，也不改变
单书 `query_ready` 或挂载状态。

### D02_fixed_query_budget

- title：固定查询预算
- status：pass

查询合同继续使用固定预算参数：`maxSemanticUnits: 32`、`maxBookshelves: 4`、
`maxBooksForDeepening: 3`、`maxMemberCommunityRefs: 24`、固定 LLM 调用上限、
`maxInputTokens: 64000` 和 `maxOutputTokens: 4000`。查询路径先从上层预计算
semantic units 召回固定候选，禁止按成员书数量全量扫描
`community_reports`。

membership quality checks 没有把成员诊断搬入交互查询路径。超大类检查要求
`membership_oversized_category_split` 通过后才能发布物化书架；虚拟父书架检查
要求其不直接拥有查询语义单元；LLM suggestion 检查要求建议在接受前不可
query-ready。若证据无法装入预算，设计使用
`budget_exceeded_narrow_scope_required` fail-closed 或要求收窄 scope。

### D03_graphrag_semantic_alignment

- title：GraphRAG 语义对齐
- status：pass

上层构建输入包含单书 `community_reports`、entities 和 relationships。设计
定义 `semantic_units.parquet`、`semantic_edges.parquet`、上层 communities 和
`community_reports.parquet`，并要求 semantic edges 保留方向、权重、实体、
relationship 证据和 generation。回答综合基于预计算 community reports 或语义
单元，不退化为普通摘要检索。

### D04_evidence_traceability

- title：证据可追溯
- status：pass

设计定义 `evidence_map.parquet`，字段覆盖 `bookId`、`sourceId`、
`documentId`、`contentHash`、community report、text unit 和 artifact digest。
每个上层语义单元、语义边、community 和 community report 都必须具备下层证据
引用，纯 membership marker 例外。回答输出要求包含 traceable evidence ids。

### D05_state_recovery

- title：状态闭环与恢复
- status：pass

构建状态包含 run ledger、`events.jsonl`、`status.json`、checkpoints、
`recovery-summary.json`、质量门和 publish marker。发布协议要求 staging 校验、
checksum sidecars、质量门诊断、原子提升和最后写 publish marker。失败或中断的
构建不会发布 query-ready 上层索引；成员 manifest 变化会在查询使用前标记
stale 或生成新 generation。

membership 决策通过 `membership_decisions.jsonl` 和固化后的
`bookshelf_members.json` 保留。LLM rerun 生成新 suggestion generation，不会
原地改写已接受的物化书架 generation。

### D06_quality_gates

- title：质量门
- status：pass

书架和 library 均有独立质量门及 requiredChecks。书架质量门覆盖 manifest
schema、checksum、成员 manifest sha256、成员包质量门、membership decision
schema、authority order、用户锁、LLM suggestion、超大类拆分、虚拟父书架、
semantic artifacts、evidence map、固定预算模拟、敏感信息扫描和 stale marker。

library 质量门覆盖成员书架 manifest sha256、成员书架质量门、虚拟父书架展开、
direct book limit、library partition、semantic artifacts、evidence map、固定预算
模拟、敏感信息扫描和 stale marker。

新增 `membershipChecks.checkIds` 能诊断本轮重点问题：LLM suggestion 未接受却
query-ready、接受记录缺失、超大类未拆分、虚拟父书架直接建索引、direct book
超限和 library 分区缺失。失败诊断要求 `failedCheckId`、决策或策略信息、脱敏
成员 locator 和 remediation command，并通过 `upper_quality_gate_failed` 使查询
不可用且诊断可见。

### D07_incremental_scaling

- title：增量扩展
- status：pass

书架成员记录包含 `manifestSha256`、`packageGeneration`、成员来源、
decision id、用户锁和虚拟父书架关系。书架 generation 会随成员集合、成员
manifest sha256、builder、embedding、聚类、摘要或 evidence schema 变化而改变。
在 checksum 可证明输入未变时，书架可只重建受影响 semantic units 和
communities；否则重建该书架 generation。

library generation 会随成员书架、书架 manifest sha256 和构建配置变化而改变。
成员书架变化时，library 可局部重建受影响 semantic units、semantic edges 和
communities；若图连通性变化不能局部化，则标记当前 generation stale 并创建新的
全量 library generation。membership checks 不要求每次成员变更都重建全库；超大
类别、虚拟父书架和 nested partitions 反而把大库变更限制在较小物化范围内。

### D08_security_privacy

- title：安全与隐私
- status：pass

设计定义 forbidden inputs 和 diagnostic redaction policy，禁止 provider
payload、原始 prompt/completion、密钥、凭据、绝对路径、query log 和未验证损坏
包进入可发布 manifest、索引、质量门或诊断。质量门包含敏感信息扫描。诊断只能
记录 digest、schema id、有界摘要、check id 和脱敏 locator。

### D09_cli_operability

- title：CLI 可操作性与降级
- status：pass

CLI scope resolution order 明确为显式 `bookId`、显式 `bookshelfId`、显式
`libraryId`、configured default library、快速 ambiguity error。无 scope、
scope 歧义、缺索引、stale、质量门失败、超预算和运行时错误均有 typed error、
exitCode、remediationCommand 和 timing fields。查询路径禁止在无 scope 时隐式
全库扫描，也禁止在查询内重建所有索引。

membership quality checks 与 CLI 合同兼容。成员检查失败统一暴露为
`upper_quality_gate_failed`，可通过 `qmd library status --scope <scopeId> --json`
查看失败 check id 和修复命令。虚拟父书架查询只允许固定 top-K 路由到子物化
书架，或在过宽时要求 scope refinement。stale membership generation 默认返回
`upper_index_stale`，仅在用户显式允许 stale reads 时可使用上一代。

### D10_testability

- title：可测试性
- status：pass

测试合同超过 8 个必测案例，覆盖单书 hotplug 非回归、用户显式成员优先、
membership decision fixture、LLM suggestion 未接受不可 query-ready、接受建议
生成新 generation、超大类转虚拟父书架、虚拟父书架固定路由或收窄、
10/100/1000 本固定 top-K 验证、超预算 typed error、stale 拒绝、缺索引不隐式
重建、成员包 gate 失败 fail-closed、evidence map、semantic edges、敏感扫描、
中断恢复、删除书本 stale 标记、exhaustive report 与交互查询隔离，以及查询
timing 分解。

## 剩余观察

未发现固定基准 D01-D10 下的 fail 项。后续实现阶段应把
`membershipChecks.checkIds`、虚拟父书架 top-K 路由、超大类拆分、LLM suggestion
接受记录和预算模拟落实为 schema 校验、CLI fixture 与自动化测试。
