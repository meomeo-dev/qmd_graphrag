# GraphRAG Query-Ready Identity Settings Design Audit

Result: PASS

## Scope

本设计审计覆盖 GraphRAG 产物隔离、`query_ready` 阶段门控、
managed settings projection、per-book qmd/GraphRAG build status，以及
provider 波动下的状态管理与恢复可观测性。

## Decision

设计复审已通过，相关实现审计也已通过：

- Design audit run: `audit/graphrag-query-ready-identity-settings-run_1`
- Implementation audit run:
  `audit/graphrag-query-ready-identity-settings-dev-run_1`

设计侧要求已落地到实现与测试：

- GraphRAG artifacts remain book-scoped and stage-gated.
- `query_ready` publication requires current producer lineage and graph
  capability evidence.
- Managed `settings.yaml` projection is compared against `.qmd/index.yml`,
  repaired only when managed, and rejected when user-owned.
- Per-book batch checkpoints expose qmd / GraphRAG build status and recovery
  decisions.
- Resume/recovery paths record typed metadata for local artifact gates,
  provider recovery, and invalid settings projection source configs.

## Verification Link

开发审计最终通过报告：

`audit/graphrag-query-ready-identity-settings-dev-run_1/final-report.md`
