# GraphRAG Durable YAML Temp Collision 设计二轮复审

## 结论

Fail。

第二轮补丁已补齐 temp 唯一性、exclusive create、owner evidence、
cleanup decision、lock owner schema、checksum crash window、观测字段和
fault injection 的主要设计缺口。但按原 `criteria.yaml` 固定 10 条基准复审，
仍有阻塞项。

## 阻塞项

### C01_writer_lane_target_coverage

仍未通过。

`writerLanes.protects` 已列出 `graph_vault/catalog/runs.yaml`，但
`targetMapping` 未给 `graph_vault/catalog/runs.yaml` 建立唯一 lane、owner、
durableKind、超时策略和释放规则。固定基准要求任意生产写入路径都能从目标路径
追溯到唯一 lane、持有者、超时策略和释放规则。

`targetMapping` 也未显式列出 `graph_vault/catalog/batch-runs/{runId}/status.json`。
虽然 `manifestWriterLane.protects` 包含 status.json，但固定基准要求目标映射
足够明确，不能只依赖 lane protects 的概括项。

### C08_rename_enoent_failure_policy

仍未通过。

设计已规定 `renameEnoent` 的 `failureKind: local_state_integrity`、
`retryable: false` 和 `recoveryDecision: stop_until_fixed`。但固定基准要求
temp rename `ENOENT` 时区分 temp 名碰撞、调和误删、并发接管、目标已被其他
generation 更新和底层文件系统错误。

当前 `failurePolicy.renameEnoent` 仍是单一分类，未列出上述原因判别矩阵，也未
说明每类证据如何进入同一停止决策或不同恢复决策。因此原因区分要求尚未满足。
