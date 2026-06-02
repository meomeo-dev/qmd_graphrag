# GraphRAG 单本书热插拔包 R2 复审汇总

## 审计对象

- 文档：`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 运行目录：
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r2-after-revision/`
- 复审性质：R2 after design-audit revision

## 基准复用校验

R2 严格复用 R1 固定基准。每个 Agent 的 `baseline.yaml` 均从 R1 对应
目录复制，未生成新基准。

| Agent | 维度数 | 与 R1 baseline 哈希一致 | R2 report |
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
- `criteria_delta_from_r1`
- `required_design_changes`
- `residual_risks`

## R2 结论

| Agent | 场景 | R2 结论 |
| --- | --- | --- |
| agent-01 | 已完成书复制给另一用户后直接查询 | 通过，有非阻塞澄清项 |
| agent-02 | 离线机器导入，不能访问 provider | 部分通过 |
| agent-03 | 上千本书同时挂载 | 未通过 |
| agent-04 | 缺文件、checksum 损坏、半包混入 | 未通过 |
| agent-05 | 旧 schema 跨版本升级 | 未通过 |
| agent-06 | 分发时防止隐私和密钥泄露 | 部分通过 |
| agent-07 | runner 构建时并发 mount scan/import | 未完全通过 |
| agent-08 | qmd 索引缺失或过期后重建 | 部分通过 |
| agent-09 | 挂载后直接 GraphRAG 查询 | 部分通过 |
| agent-10 | 当前 38 本与 34 个残留目录迁移 | 部分通过 |

总体结论：R2 明显改善，但仍未通过生产设计复审。修订版已经解决
R1 的大多数结构性问题，包括原子发布、mount scan generation、last-good
projection、readiness gate、安全导出 allowlist、迁移状态机和残留隔离。
但固定 R1 基准下仍有 3 个 Fail 场景和多个 Partial 场景，不能进入实现。

## 仍阻塞的设计缺口

1. 大规模挂载边界仍不足。
   `agent-03` 仍为 Fail。需要补最大文件闭包、字节级 I/O 预算、退化策略、
   校验层级、锁兼容矩阵、可扩展冲突索引、诊断保留策略，以及 metrics、
   progress 和故障注入测试。

2. 损坏包恢复合同仍不足。
   `agent-04` 仍为 Fail。需要补 checksum/bytes/sidecar 一致性细节、
   quarantine 持久化状态机、retry 和 clear 条件、修复恢复闭包、validator
   I/O 契约、稳定错误码和损坏包专项测试矩阵。

3. 跨版本升级设计仍不足。
   `agent-05` 仍为 Fail。需要补逐版本 migration path matrix、artifact
   schema conversion table、identity migration record、compatibility
   diagnostics schema、migration tool evidence，以及升级专项 fixture/test
   matrix。

4. Catalog projection schema 仍未固定。
   `agent-02` 指出派生 `books.yaml`、`sources.yaml`、
   `document-identity-map.yaml` 和 `graph-capabilities.yaml` 的字段来源没有
   明确 schema。

5. 并发恢复细节仍不足。
   `agent-07` 指出扫描稳定快照变化处理、锁过期、残留 staging 清理和完整
   竞态测试矩阵仍未闭合。

6. qmd rebuild 仍缺 per-book 原子协议。
   `agent-08` 指出 freshness digest、rebuild input closure、per-book SQLite
   原子替换、并发 retry 和 qmd 诊断 schema 仍不足。

7. GraphRAG query gate 仍缺逐项 artifact metadata。
   `agent-09` 指出最低 artifact 闭包需要逐项 role、schema version、
   directory validation granularity、producer upstream fields 和专项负例测试。

8. 安全隐私仍需补细类。
   `agent-06` 指出 provider cache、usage 明细、`.npmrc`、`.netrc`、SSH/TLS
   凭据、manifest 细字段和 importer/scanner 不读取敏感根的规则仍需显式化。

9. 迁移清理仍需人工决策与测试矩阵。
   `agent-10` 指出 compatibility bridge 生命周期、人工冲突决策 schema、
   migration evidence 字段完整性和专项迁移测试仍需补强。

## 下一步行动

继续修订 Type DD，不进入实现。

优先补充以下设计块：

1. `catalogProjectionSchemas`
2. `quarantineAndRepairStateMachine`
3. `largeLibraryDegradationAndMetrics`
4. `upgradePathMatrix`
5. `artifactSchemaConversionMatrix`
6. `lockLeaseAndStagingCleanup`
7. `qmdRebuildTransaction`
8. `graphRagArtifactMetadataContract`
9. `sensitiveMaterialTaxonomy`
10. `manualConflictDecisionWorkflow`

下一轮复审仍必须复用 R1 baseline，不得新增基准。只有当 R1 固定基准下
所有 Agent 至少达到通过，且没有 Fail 或阻塞性 Partial，才能进入实现阶段。
