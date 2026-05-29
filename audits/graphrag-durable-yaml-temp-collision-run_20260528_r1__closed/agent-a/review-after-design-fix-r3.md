# 第三轮设计修正复审结果

结论：pass

复审仅使用 `criteria.yaml` 固定 10 条基准。最新设计补丁继续满足本次
durable YAML temp rename ENOENT 定向设计审计要求，无设计阻塞项。

## 重点复审结论

- `targetMapping`：通过。`targetMappingContract` 要求每个生产持久化目标
  追溯到唯一 lane、owner、durableKind、laneTimeoutMs 与 releaseOn；未列入
  targetMapping 的 durable YAML/JSON/SQLite 目标不得由并行 runner 写入。
  catalog、book-scoped YAML、batch item checkpoint、manifest/status、lease、
  subprocess registry 与 `.qmd/index.sqlite` 均已有 lane 映射。

- `rename ENOENT` 原因矩阵：通过。`failurePolicy.renameEnoent` 固定为
  `local_state_integrity`、`durable_temp_rename_enoent`、`stop_until_fixed`，
  并要求在 `causeMatrix` 中选择原因；证据不足时仍归入
  `filesystem_or_external_mutation`，不得降级为 provider transient、unknown 或
  普通业务失败。

- directory fsync 平台边界：通过。`platformFsyncBoundary` 明确区分 file
  fsync failure、directory fsync unsupported、directory fsync weak/unknown；
  生产终态 checkpoint、catalog、lock、provider slot、manifest 与 status 默认
  strict mode，fsync 不可证明时禁止发布 completed，并记录 fsync 诊断字段。

- item checkpoint 本地状态失败证据字段：通过。`terminalCommitProtocol.failed`
  与 `itemCheckpointFailureEvidence` 要求本地 durable state 失败写入
  `failureKind`、`localFailureClass`、`recoveryDecision`、`failedStage`、
  `targetLocator` 或 `redactedEvidenceLocator`、`tempId`、`operationId`、
  `leaseGeneration`、`completedPublishRule`，并按 rename ENOENT、lock timeout、
  checksum crash window、live temp deleted 补充条件字段。

## 基准映射

| 基准 | 结论 | 最新补丁对应点 |
| --- | --- | --- |
| C01 同一目标文件写入排他性 | pass | `targetMappingContract`、`targetMapping`、per-target lock 与 `singleDurableBoundary`。 |
| C02 临时文件身份抗碰撞 | pass | `temporaryFileIdentity.requiredFields`、`exclusiveCreate`、同毫秒/forced temp id fault injection。 |
| C03 活跃临时文件清理安全 | pass | `ownerEvidence`、`cleanupDecision`、active/orphan temp acceptance matrix。 |
| C04 原子替换持久化契约 | pass | `yamlOrJsonReplace`、`platformFsyncBoundary`、`checksumCommit` crash windows。 |
| C05 锁新鲜度与 fencing | pass | `durableYamlLock.ownerRecord`、`heartbeatRule`、`fencingRule`、`staleRule`。 |
| C06 单一 durable YAML 边界 | pass | `singleDurableBoundary`、forbidden bypass、adapterRule。 |
| C07 writer lane 与文件锁集成 | pass | lane acquisition order、timeout/release rule、targetMapping laneTimeoutMs/releaseOn。 |
| C08 resume 接管与半写恢复 | pass | `durableStatePreflight.beforeClaim`、`beforeResumeBook`、partial write recovery。 |
| C09 rename ENOENT 错误分类 | pass | `failurePolicy.renameEnoent.causeMatrix`、requiredEvidence、checkpoint/status/recovery summary 字段。 |
| C10 并发回归证据 | pass | `faultInjection` 与 `durableStateAcceptanceMatrix` 覆盖 temp collision、active reconcile、rename ENOENT、fsync boundary 与 resume-book orphan temp。 |

无设计阻塞项。本结论只覆盖设计审计，不代表实现代码或真实批处理已通过验证。
