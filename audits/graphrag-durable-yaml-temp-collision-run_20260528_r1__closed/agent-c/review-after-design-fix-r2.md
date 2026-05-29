# Durable YAML Temp Collision 第二轮设计修正复审

## 结论

fail

本次复审仅沿用
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-c/criteria.yaml`
中的 10 条固定基准，未新增标准。第二轮补丁已覆盖 temp identity、
exclusive create、owner evidence、cleanup decision、durable YAML lock owner
schema、checksum crash window、single durable boundary、preflight、观测字段与
专项 fault injection 的主要缺口。仍有以下阻塞项。

## 阻塞项

### C07 fsync 恢复契约仍未完全满足

设计已明确 temp fsync、rename、checksum/generation commit 与父目录 fsync 的
顺序，并为 target/checksum crash window 定义了恢复矩阵。但固定基准还要求
声明 fsync 的平台边界，特别是 directory fsync 在部分平台或文件系统上的
best-effort 残余风险，以及该残余风险不能导致错误发布 `completed`。

当前 Type DD 中未说明 directory fsync 不可用、失败或语义弱化时的处理策略，
也未把该平台残余风险绑定到 `stop_until_fixed`、重新 reconcile 或禁止发布
`completed` 的规则。

必须补充：directory fsync 平台边界、fsync failure/unsupported 的恢复动作、
残余风险诊断字段，以及“fsync 边界不确定时不得发布 completed”的明确规则。

### C09 本地缺陷可观测分类仍未完全满足

设计已在 event schema、status-json 与 recovery summary 中加入
`localFailureClass`，并规定 rename `ENOENT` 不得降级为 `unknown`、provider
transient 或普通业务失败。但固定基准要求 item checkpoint、event、
status-json 与 recovery summary 均包含稳定 `failureKind`、`localFailureClass`、
`recoveryDecision`、`failedStage` 与 redacted locator。

当前 failed terminal commit 规则仍只要求写入 `failureKind`、`retryable`、
`recoveryDecision`、`failedStage`、`activeCommand`、attempts 与 retry budget；
`durableStateAcceptanceMatrix.rename_enoent` 也只验证 item checkpoint 的
`failureKind`，未要求 item checkpoint 持久写入 `localFailureClass` 与 redacted
locator。这样仍不能证明本次 durable YAML rename `ENOENT` 在最权威的 item
checkpoint 中稳定呈现为可修复本地代码缺陷。

必须补充：item checkpoint schema/failed commit 字段必须包含
`localFailureClass`、`targetLocator` 或 `redactedEvidenceLocator`、`tempId`、
`operationId`，并在 rename `ENOENT`、live temp deletion、checksum crash-window
mismatch 与 lock timeout 的验收矩阵中验证这些字段。
