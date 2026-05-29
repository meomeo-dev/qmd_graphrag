# Durable YAML Temp Collision 第四轮设计修正复审

## 结论

pass

本次复审仅沿用
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-c/criteria.yaml`
中的 10 条固定基准，未新增标准。最新补丁已修复 r3 中 C09 的剩余阻塞项。

## 复审结果

设计通过固定 10 条基准。

最新 Type DD 已明确：

- `durable_replace_failed`、`durable_lock_timeout`、异常
  `durable_temp_reconciled`、以及本地 durable state 失败对应的 `item_failed`
  事件必须写入稳定分类字段。
- `durableFailureEventEvidence.requiredFields` 强制事件携带
  `failureKind`、`localFailureClass`、`recoveryDecision`、`failedStage` 与
  `redactedEvidenceLocator`。
- `durableFailureEventEvidence.appliesTo` 覆盖 `durable_replace_failed`、
  `durable_lock_timeout`、异常 `durable_temp_reconciled`、
  非 committed checksum recovery 事件，以及 `local_state_integrity` 或
  `local_state_lock_timeout` 对应的 `item_failed`。
- `durableFailureEventEvidence.degradationRule` 明确缺失 required fields 时
  必须把 run 标记为 `local_state_integrity` 与 `stop_until_fixed`，不得降级为
  `unknown`、provider transient 或普通业务失败。
- `durableStateAcceptanceMatrix` 已验证 rename `ENOENT`、lock timeout、
  live temp deletion、checksum crash window 与 directory fsync boundary 场景下的
  事件层字段。

此前 C07 关注的 directory fsync 平台边界、fsync failure/unsupported 恢复动作、
残余风险诊断字段，以及不得发布 `completed` 规则，也已由
`platformFsyncBoundary` 与对应验收项覆盖。

无剩余阻塞项。
