# GraphRAG 单本书热插拔包 R6 固定基准复审汇总

## 审计对象

- 主文档：`docs/architecture/graphrag-book-hotplug-package.type-dd.yaml`
- 规范性补充文档：
  `docs/architecture/graphrag-book-hotplug-package-r3-fixups.type-dd.yaml`
- 规范性补充文档：
  `docs/architecture/graphrag-book-hotplug-package-r5-fixups.type-dd.yaml`
- 运行目录：
  `docs/architecture/graphrag-book-hotplug-package-audits/run-20260602-r6-after-r5-fixups/`
- 复审性质：R6 after R5 fixups

## 基准复用校验

R6 严格复用 R1 固定基准。每个 Agent 的 `baseline.yaml` 均从 R1
对应目录复制，未生成新基准，未新增、删除、重排、重命名维度，也未改变
任何 `passCriteria`。

| Agent | 维度数 | 与 R1 baseline 哈希一致 | R6 report |
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

## R6 结论

| Agent | 场景 | R6 结论 |
| --- | --- | --- |
| agent-01 | 已完成书复制给另一用户后直接查询 | 通过 |
| agent-02 | 离线机器导入，不能访问 provider | 通过 |
| agent-03 | 上千本书同时挂载 | 通过 |
| agent-04 | 缺文件、checksum 损坏、半包混入 | 通过 |
| agent-05 | 旧 schema 书包跨版本升级 | 通过 |
| agent-06 | 分发时防止隐私和密钥泄露 | 通过 |
| agent-07 | runner 构建时并发 mount scan/import | 通过 |
| agent-08 | qmd 索引缺失或过期后重建 | 通过 |
| agent-09 | 挂载后直接 GraphRAG 查询 | 通过 |
| agent-10 | 当前 38 本与 34 个残留目录迁移 | 通过 |

总体结论：R6 通过生产设计复审。固定 R1 基准下 10 个 Agent 全部通过。
可以进入后续实现或实现审计阶段。

## 关闭的 R5 缺口

1. 安全隐私通过。
   `manifestSensitivitySchema` 补齐 `BOOK_MANIFEST.json` 字段级敏感边界、
   metadata、`producerRunIds`、`createdBy`、diagnostic detail、异常摘要、
   命令行字段、环境变量字段、redaction 规则和 fixture 级安全测试。

2. 并发 Runner 通过。
   `importerPrePublishValidationContract` 补齐 staged import 发布前校验边界。
   `CR-03` 从 R5 的未通过变为通过。

3. qmd index 通过。
   `qmdAvailabilityReasonMatrix`、canonical qmd reindex key、
   qmd actor/lock 矩阵、digest 差异诊断和 qmd 测试合同关闭了 R5 的
   4 个 Partial。

4. GraphRAG direct query 通过。
   `manifestFirstDirectQueryResolver` 和
   `graphRagArtifactGateStateMachine` 补齐 direct query entrypoint 与 artifact
   gate state machine。

5. migration cleanup 通过。
   `migrationSourceTruthFailClosedTable`、
   `migrationRerunIdempotencyContract`、`migrationConflictDecisionTable` 和
   migration cleanup test contracts 关闭了 R5 的 4 个 Partial。

## 下一步行动

设计审计循环可关闭。下一步可进入开发实施或实现审计循环。

实施前需要保留以下约束：

1. R1 固定 baseline 继续作为后续实现审计对照基准，不得漂移。
2. R3 与 R5 补充 Type DD 是规范性设计合同，不能只实现主文档正文。
3. 实现阶段应先落地 manifest schema、importer pre-publish validation、
   qmd state/diagnostics、manifest-first GraphRAG resolver 和 migration rerun
   contract，再恢复批量 runner 的真实执行。
