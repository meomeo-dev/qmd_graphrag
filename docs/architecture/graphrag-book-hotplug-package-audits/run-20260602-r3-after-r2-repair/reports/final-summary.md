# GraphRAG 单本书热插拔包 R3 复审汇总

## 审计对象

- 文档：`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 运行目录：
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r3-after-r2-repair/`
- 复审性质：R3 after R2 repair

## 基准复用校验

R3 继续严格复用 R1 固定基准。每个 Agent 的 `baseline.yaml` 均从
R1 对应目录复制，未生成新基准。

| Agent | 维度数 | 与 R1 baseline 哈希一致 | R3 report |
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
- `criteria_delta_from_r2`
- `required_design_changes`
- `residual_risks`

## R3 结论

| Agent | 场景 | R3 结论 |
| --- | --- | --- |
| agent-01 | 已完成书复制给另一用户后直接查询 | 部分通过 |
| agent-02 | 离线机器导入，不能访问 provider | 通过 |
| agent-03 | 上千本书同时挂载 | 通过 |
| agent-04 | 缺文件、checksum 损坏、半包混入 | 通过 |
| agent-05 | 旧 schema 跨版本升级 | 未通过 |
| agent-06 | 分发时防止隐私和密钥泄露 | 部分通过 |
| agent-07 | runner 构建时并发 mount scan/import | 通过 |
| agent-08 | qmd 索引缺失或过期后重建 | 部分通过 |
| agent-09 | 挂载后直接 GraphRAG 查询 | 通过 |
| agent-10 | 当前 38 本与 34 个残留目录迁移 | 部分通过 |

总体结论：R3 仍未通过生产设计复审。R3 已消除 R2 中多个 Fail 场景，
大规模挂载、损坏包、并发 Runner、GraphRAG query 和离线导入均已通过。
但固定 R1 基准下仍存在 1 个 Fail 和 4 个 Partial，不能进入实现阶段。

## 已改善项

1. 大规模挂载通过。
   `largeLibraryDegradationAndMetrics`、锁兼容矩阵、metrics、progress、
   retention、fault-injection tests 和 deterministic conflict index 补齐了
   agent-03 的固定基准。

2. 损坏包恢复通过。
   `quarantineAndRepairStateMachine` 的 checksum order、stable error codes、
   repair closure、diagnostic bounds 和 damaged package tests 补齐了 agent-04。

3. 并发恢复通过。
   `lockLeaseAndStagingCleanup` 的 lease、fencing token、snapshot change
   policy 和 staging cleanup 补齐了 agent-07。

4. GraphRAG query 通过。
   `graphRagArtifactMetadataContract` 的 artifact rows、closure digest、
   compatibility inputs 和 negative tests 补齐了 agent-09。

5. 离线导入通过。
   `catalogProjectionSchemas` 固定了 catalog projection 字段来源和 forbidden
   inputs，解决了原始 batch catalog 独立性问题。

## 仍阻塞的缺口

1. 跨版本升级仍未通过。
   `agent-05-version-upgrade` 仍为 Fail。需要继续补：
   - 逐 schema version 的升级矩阵，而不仅是 legacy shape rows。
   - identity old/new 审计字段，包括 normalizedHash 和 producerRunIds。
   - 统一兼容诊断枚举，包括 missing file、rebuild failed、
     tool version too old、unsupported legacy schema。
   - producer provenance 缺失标记，防止迁移证据误表达 producer 成功。
   - fixture 级升级专项测试契约。

2. portable sharing 身份语义仍部分通过。
   `agent-01` 的 `identity_conflict` 仍为 Partial。需要明确定义
   `packageVersion`、`packageGeneration`、`canonicalTitle`、`titleSlug` 的
   稳定性、生成来源、是否参与冲突判定和与 sourceHash 的关系。

3. 安全隐私仍部分通过。
   `agent-06` 仍为 Partial。需要补：
   - provider cache 和可还原交互内容的正式 forbidden class。
   - provider auth config 和 credential store 分类。
   - `mount.packageRoot` 语义收紧为 package-relative locator。
   - manifest 全字段敏感边界。
   - importer、scanner、compatibility check 的 no-read 合同。
   - 更细粒度自动化断言。

4. qmd index 仍部分通过。
   `agent-08` 仍为 Partial。需要补：
   - qmd 状态可用性矩阵。
   - re-export/repack 语义。
   - 幂等键覆盖完整 freshness digest。
   - qmd 诊断字段 schema。
   - readonly、并发、失败和诊断测试矩阵。

5. 迁移清理仍部分通过。
   `agent-10` 仍为 Partial。需要补：
   - compatibility locator/symlink 生命周期。
   - migration evidence 的 before/after path/hash、tool version、时间、
     decisionStatus、failureReason、rollbackPlan。

## 下一步行动

继续修订 Type DD，不进入实现。

优先补充以下精确设计块：

1. `identityFieldSemantics`
2. `schemaVersionUpgradeMatrix`
3. `migrationEvidenceSchema`
4. `providerSensitiveClassExtensions`
5. `scannerNoReadContracts`
6. `qmdAvailabilityAndReexportPolicy`
7. `qmdDiagnosticsSchema`
8. `compatibilityBridgeLifecycle`

下一轮 R4 复审仍必须复用 R1 baseline，不得新增基准。只有当固定 R1
基准下 10 个 Agent 全部通过，才能进入实现阶段。
