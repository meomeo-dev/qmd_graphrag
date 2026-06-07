# design-turn_014 / agent-3 设计审计报告

## 结论

PASS

## D01-D10 判定

- D01_authority_boundaries：PASS。Type DD 明确单书包权威仍来自
  `graph_vault/books/{bookId}`，书架和 library 权威根分别为
  `graph_vault/bookshelves/{bookshelfId}` 与 `graph_vault/library/{libraryId}`，
  catalog 仅为 projection / routing 视图。
- D02_fixed_query_budget：PASS。查询合同定义固定 `maxSemanticUnits`、
  `maxBookshelves`、`maxBooksForDeepening`、LLM 调用数和 token 上限，并禁止
  交互路径全量扫描。
- D03_graphrag_semantic_alignment：PASS。上层索引输入和产物包含
  `community_reports`、`entities`、`relationships`、`semantic_edges` 与预计算语义单元。
- D04_evidence_traceability：PASS。设计要求 `evidence_map`，并要求回答回链到
  `bookId`、`sourceId`、`documentId`、`contentHash`、community report 或
  `text_unit`；最新实现状态也声明缺失或 `unknown-*` lineage fail closed。
- D05_state_recovery：PASS。设计覆盖 package-local `staging`、`runs`、
  `generations`、`CURRENT.json`、`PUBLISH_READY.json`、质量门、stale 检测和
  partial publish 防护。
- D06_quality_gates：PASS。书架和 library 均定义独立质量门，包含 schema、
  checksum、成员一致性、evidence lineage、敏感扫描和 fixed-budget simulation。
- D07_incremental_scaling：PASS。设计记录成员 manifest sha256 / generation，
  并说明保守全量重建与局部刷新条件；大库通过书架分层限制影响范围。
- D08_security_privacy：PASS。设计禁止 provider payload、raw prompt/completion、
  query log、credential、绝对路径进入可发布 manifest、索引和诊断；质量门包含
  敏感信息扫描。
- D09_cli_operability：PASS。设计定义 scope resolution order、typed errors、
  exit code、remediation command、timing 字段，以及 legacy catalog-only 的
  `upper_package_migration_required`。
- D10_testability：PASS。测试合同超过 8 项，覆盖固定预算、stale、失败质量门、
  证据、安全扫描、catalog projection 删除后显式查询、单书 hotplug 非回归等场景。

## 阻断项

无。

## 非阻断风险

- Type DD 在 `postImplementationTurn011` 与 `postImplementationTurn012` 的历史
  retained risks 中仍保留 “catalog projection generation remains future”。后文
  `postImplementationTurn013Candidate` 已说明最小 catalog projection 已实现并待
  实施复审，因此不构成设计阻断，但后续摘要读者可能误读历史风险为当前风险。
- `postImplementationTurn013Candidate` 表述为 pending reaudit，当前不应把
  catalog projection 最小实现解读为实施审计完成；Type DD 已保留该边界。
- 当前已实现能力明确限定为 fixed-budget report search、typed error、timing、
  evidence lineage 和非权威 catalog projection；LLM synthesis、受控下钻、
  library 管理命令仍列为未来能力，未发现过度声明。

## 审计依据文件

- `docs/architecture/graphrag-hierarchical-library-index.type-dd.yaml`
- `docs/architecture/graphrag-hierarchical-library-index-audits/base/evaluation-dimensions.yaml`
- `src/graphrag/upper-index/upper-catalog-projection.ts`
- `src/graphrag/upper-index/bookshelf-graph.ts`
- `src/graphrag/upper-index/library-graph.ts`
- `src/job-state/durable-state-store.ts`
- `test/graphrag-bookshelf-graph.test.ts`
- `test/graphrag-library-graph.test.ts`
