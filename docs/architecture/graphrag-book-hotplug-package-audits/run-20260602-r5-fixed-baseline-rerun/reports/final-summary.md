# GraphRAG 单本书热插拔包 R5 固定基准复审汇总

## 审计对象

- 主文档：`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 规范性补充文档：
  `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- 运行目录：
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r5-fixed-baseline-rerun/`
- 复审性质：R5 fixed-baseline rerun

## 基准复用校验

R5 严格复用 R1 固定基准。每个 Agent 的 `baseline.yaml` 均从 R1
对应目录复制，未生成新基准，未新增、删除、重排、重命名维度，也未改变
任何 `passCriteria`。

| Agent | 维度数 | 与 R1 baseline 哈希一致 | R5 report |
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
- `criteria_delta_from_previous_run`
- `required_design_changes`
- `residual_risks`

## R5 结论

| Agent | 场景 | R5 结论 |
| --- | --- | --- |
| agent-01 | 已完成书复制给另一用户后直接查询 | 通过 |
| agent-02 | 离线机器导入，不能访问 provider | 通过 |
| agent-03 | 上千本书同时挂载 | 通过 |
| agent-04 | 缺文件、checksum 损坏、半包混入 | 通过 |
| agent-05 | 旧 schema 书包跨版本升级 | 通过 |
| agent-06 | 分发时防止隐私和密钥泄露 | 部分通过 |
| agent-07 | runner 构建时并发 mount scan/import | 未通过 |
| agent-08 | qmd 索引缺失或过期后重建 | 未通过 |
| agent-09 | 挂载后直接 GraphRAG 查询 | 未通过 |
| agent-10 | 当前 38 本与 34 个残留目录迁移 | 未通过 |

总体结论：R5 未通过生产设计复审。固定 R1 基准下，5 个 Agent 通过，
1 个 Agent 部分通过，4 个 Agent 未通过。设计仍不能进入实现阶段。

## 已通过场景

1. Portable sharing 通过。
   单目录可移植闭包、manifest 挂载权威、空 vault 查询、身份冲突、
   checksum 完整性、路径可移植性、查询门禁、隐私排除、接收方状态隔离
   和测试契约均满足固定基准。

2. Airgap import 通过。
   R5 判定当前主文档与 R3 补充文档组合已满足离线闭包、provider 隔离、
   batch catalog 独立、查询就绪门槛和导入状态隔离等固定维度。

3. 大规模挂载、损坏包恢复、跨版本升级通过。
   大库扫描、半包 quarantine、schema upgrade matrix、compatibility bridge、
   migration evidence 与 rollback/audit trail 等设计未出现回退。

## 阻塞缺口

1. 安全隐私仍部分通过。
   `agent-06` 的 SP-05 和 SP-10 仍为 Partial。需要补齐
   `BOOK_MANIFEST.json` 字段级敏感边界，覆盖 metadata、`producerRunIds`、
   `createdBy`、diagnostic detail、异常摘要、命令行字段、环境变量字段、
   forbidden/restricted redaction 规则，以及 manifest、producer evidence、
   importer、mount scanner、compatibility checker 和 query gate 的 fixture
   级安全测试。

2. 并发 Runner 场景未通过。
   `agent-07` 的 CR-03 失败。需要新增 staged importer pre-publish
   validation contract：导入流程必须在
   `graph_vault/.staging/imports/{importId}/{bookId}` 中完成 checksums、
   sidecars、package-relative paths、schema compatibility 和 identity conflict
   校验后，才允许获取 publish lock 并原子替换 live root。direct directory
   copy 只能作为 fail-closed scanner candidate，不等价于 staged import。

3. qmd index 场景未通过。
   `agent-08` 为 6 Pass / 4 Partial，固定基准下总体 Fail。仍需补：
   - qmd availability 原因态矩阵。
   - canonical qmd reindex idempotency key。
   - mount scanner、importer、runner、explicit rebuild command 的并发矩阵。
   - qmd diagnostics 的 `digestKind`、`expectedDigest`、`observedDigest`
     或等价 digest 差异字段。
   - 缺失 index、未声明 `reindex_on_mount`、schema 不兼容、projection
     原子替换、readonly 包重建、并发 reindex、无 payload 诊断的测试矩阵。

4. GraphRAG direct query 场景未通过。
   `agent-09` 有 2 个维度未通过：
   - `direct_query_entrypoint`
   - `artifact_gate_state_machine`
   需要新增 manifest-first resolver 契约，保证在挂载扫描完成后，查询入口
   能仅凭 `BOOK_MANIFEST.json`、manifest `graphrag` section、`files` 闭包、
   artifact metadata rows 和包内 `graphrag/runs` evidence 定位查询上下文。
   committed catalog projection 只能作为可重建 cache。还需新增统一
   `graphRagArtifactGateStateMachine`，覆盖 `copied`、`candidate`、
   `validated`、`mounted`、`query_ready`、`visible_not_query_ready`、
   `quarantined` 及其转移条件、证据、诊断、projection effect 和
   rollback/quarantine 行为。

5. 迁移清理场景未通过。
   `agent-10` 为 6 Pass / 4 Partial，固定基准下总体 Fail。仍需补：
   - migration source-of-truth fail-closed 表。
   - migration rerun contract，覆盖 `already_migrated`、`partial_migration`、
     `failed_interrupted`、`legacy_only`、copy-map resume、checkpoint resume、
     不重复 move/copy、不覆盖用户 metadata、不改变已验证 package identity。
   - 迁移冲突诊断表，覆盖完成书与残留目录同前缀、target live root 已存在、
     staging target 已存在、同 bookId 但 generation/manifest 不一致、目录内容
     与 manifest identity 不一致。
   - 迁移自动化测试，覆盖 source/runs closure 缺失、38 本批量迁移中断重跑、
     34 个 residue quarantine、用户 metadata 保护、目标目录冲突、
     同前缀冲突、catalog cleanup 和 provider payload no-read。

## 下一步行动

继续修订 Type DD，不进入实现。

优先新增一个规范性 R5 修复补充文档，避免继续扩张主文档：

`docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`

该补充文档至少应包含：

1. `manifestSensitivitySchema`
2. `importerPrePublishValidationContract`
3. `qmdAvailabilityReasonMatrix`
4. `qmdCanonicalIdempotencyAndDiagnostics`
5. `qmdReindexActorLockMatrix`
6. `manifestFirstDirectQueryResolver`
7. `graphRagArtifactGateStateMachine`
8. `migrationSourceTruthFailClosedTable`
9. `migrationRerunIdempotencyContract`
10. `migrationConflictDecisionTable`
11. `fixedBaselineTestContracts`

下一轮 R6 复审仍必须复用 R1 baseline，不得新增基准。只有固定 R1 基准下
10 个 Agent 全部通过，才能进入实现阶段。
