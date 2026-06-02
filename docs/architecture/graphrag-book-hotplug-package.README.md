# GraphRAG 单本书热插拔包

## 阅读入口

本主题的对外稳定入口是两份文档：

1. `docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
   主设计文档。用于理解目标、范围、目录边界、生命周期、状态闭环、
   审计结论和最终合同入口。
2. `docs/architecture/graphrag-book-hotplug-package-final-contracts.type-dd.yaml`
   最终实现合同。用于实现、测试和实现审计，包含 manifest 字段敏感
   分类、导入发布前校验、qmd 状态矩阵、GraphRAG 查询门禁和迁移合同。

实现时必须同时遵守两份文档。主设计文档是入口，最终合同文档是规范性
细则。

## 审计状态

设计审计已在 R6 固定基准复审中通过。10 个 Agent 均复用 R1 固定
baseline，未新增、删除、重排、重命名维度，也未改变任何 `passCriteria`。

通过证明：

`docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/reports/final-summary.md`

## 目录说明

- `graphrag-book-hotplug-package.type-dd.yaml`
  主 Type DD，状态为 `final`。
- `graphrag-book-hotplug-package-final-contracts.type-dd.yaml`
  最终实现合同，状态为 `final`。
- `graphrag-book-hotplug-package-audits/`
  设计审计记录、固定 baseline、各轮 Agent 报告和历史修复材料。

历史修复材料已归档在：

`docs/architecture/graphrag-book-hotplug-package-audits/historical-design-repairs/`

这些文件只用于审计追溯，不作为对外实现入口。

## 后续实施约束

1. 不得把全局 catalog 当作单本书包权威状态。
2. 不得将 provider payload、密钥、日志 payload、`.env` 或私人路径写入
   可分发书包。
3. 实现必须覆盖 final contracts 中的 manifest schema、importer
   pre-publish validation、qmd availability、GraphRAG manifest-first resolver
   和 migration rerun/cleanup contracts。
4. 后续实现审计应继续复用固定 baseline，防止审计标准漂移。
