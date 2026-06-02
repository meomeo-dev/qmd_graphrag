# GraphRAG 单本书热插拔包 R4 复审汇总

## 审计对象

- 主文档：`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 规范性补充文档：
  `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- 运行目录：
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r4-after-r3-fixups/`
- 复审性质：R4 after R3 fixups

## 基准复用校验

R4 继续严格复用 R1 固定基准。每个 Agent 的 `baseline.yaml` 均从
R1 对应目录复制，未生成新基准。

| Agent | 维度数 | 与 R1 baseline 哈希一致 | R4 report |
| --- | ---: | --- | --- |
| agent-01-portable-sharing | 10 | true | exists |
| agent-02-airgap-import | 10 | true | exists |
| agent-03-large-library | 10 | true | exists |
| agent-04-damaged-package | 10 | true | exists |
| agent-05-version-upgrade | 10 | true | exists |
| agent-06-security-privacy | 10 | true | exists |
| agent-07-concurrent-runner | 10 | true | exists |
| agent-08-qmd-index | 10 | true | exists |
| agent-09-graphrag-query | 10 | true | exists |
| agent-10-migration-cleanup | 10 | true | exists |

全部 `report.md` 均包含：

- `scenario`
- `reused_fixed_baseline`
- `baseline_integrity_check`
- `findings`
- `pass_fail`
- `criteria_delta_from_r3`
- `required_design_changes`
- `residual_risks`

## R4 结论

| Agent | 场景 | R4 结论 |
| --- | --- | --- |
| agent-01 | 已完成书复制给另一用户后直接查询 | 通过 |
| agent-02 | 离线机器导入，不能访问 provider | 部分通过 |
| agent-03 | 上千本书同时挂载 | 通过 |
| agent-04 | 缺文件、checksum 损坏、半包混入 | 通过 |
| agent-05 | 旧 schema 书包跨版本升级 | 通过 |
| agent-06 | 分发时防止隐私和密钥泄露 | 部分通过 |
| agent-07 | runner 构建时并发 mount scan/import | 通过 |
| agent-08 | qmd 索引缺失或过期后重建 | 部分通过 |
| agent-09 | 挂载后直接 GraphRAG 查询 | 通过 |
| agent-10 | 当前 38 本与 34 个残留目录迁移 | 未通过 |

总体结论：R4 仍未通过生产设计复审。R4 已清除 R3 的
`agent-05-version-upgrade` Fail，并使 portable sharing 身份语义通过。
但固定 R1 基准下仍存在 1 个 Fail 和 3 个 Partial，不能进入实现阶段。

## 已通过场景

1. Portable sharing 通过。
   `identityFieldSemantics` 明确了 `bookId`、`sourceHash`、
   `packageVersion`、`packageGeneration`、`canonicalTitle` 与 `titleSlug`
   的稳定性、生成来源、冲突参与规则和可变性。

2. 大规模挂载、损坏包恢复、并发 Runner、GraphRAG query 均保持通过。
   R3 补充文档未造成回退。

3. 跨版本升级通过。
   `schemaVersionUpgradeMatrix`、`migrationEvidenceSchema`、
   `artifactSchemaConversionMatrix` 和 fixture contracts 补齐了逐 schema
   version 迁移、identity old/new 审计、兼容诊断和 producer provenance 状态。

## 仍阻塞的缺口

1. Airgap import 仍部分通过。
   `agent-02` 的 AIG-09 仍为 Partial。固定基准要求导入诊断、mount 状态和
   本机运行时状态隔离在 `import/` 或 `state/runtime` 路径类别；当前设计使用
   `.local/book-runtime`、`catalog/mount-scans` 和
   `catalog/qmd-book-projections`，缺少与固定路径类别的统一映射。

2. 安全隐私仍部分通过。
   `agent-06` 的 SP-05 和 SP-10 仍为 Partial。需要补：
   - `BOOK_MANIFEST.json` 全字段敏感边界。
   - metadata、run ids、createdBy、完整命令行、异常/错误字段的分类。
   - manifest 字段级 redaction 与 fail-closed 分类测试。
   - producer evidence schema 安全测试。

3. qmd index 仍部分通过。
   `agent-08` 仍有 4 个 Partial：
   - `qmd_index_presence_policy`
   - `concurrency_and_idempotency`
   - `diagnostics_without_payloads`
   - `qmd_index_test_matrix`
   需要补 qmd 状态原因态矩阵、完整幂等键一致性、expected/observed digest
   差异字段和更完整的 readonly、并发、失败、诊断测试矩阵。

4. 迁移清理仍未通过。
   `agent-10` 总体为 Fail，10 维中 6 个 Pass、4 个 Partial。需要补：
   - migration source-of-truth fail-closed 表。
   - migration idempotency 状态枚举，包括 `already_migrated`、
     `partial_migration`、`failed_interrupted`、`legacy_only`。
   - duplicate/conflict 细化表，覆盖目标目录已存在、source-hash 前缀冲突、
     target bookId 冲突和 manual decision entry。
   - compatibility bridge 生命周期与 migration evidence 的字段需和
     38/34 批量迁移场景完全闭合。

## 下一步行动

继续修订 Type DD，不进入实现。

优先补充以下精确设计块：

1. `runtimeStatePathAliasPolicy`
2. `manifestSensitivitySchema`
3. `qmdStateReasonMatrix`
4. `qmdIdempotencyAndDigestDiagnostics`
5. `migrationSourceTruthFailClosedTable`
6. `migrationIdempotencyStateTable`
7. `migrationConflictDecisionTable`

下一轮 R5 复审仍必须复用 R1 baseline，不得新增基准。只有当固定 R1
基准下 10 个 Agent 全部通过，才能进入实现阶段。
