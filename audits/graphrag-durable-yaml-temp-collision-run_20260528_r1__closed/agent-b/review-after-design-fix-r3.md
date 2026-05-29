# GraphRAG Durable YAML Temp Collision 设计三轮复审

## 结论

Pass。

按 `criteria.yaml` 既有 10 条固定基准复审，最新
`docs/architecture/graphrag-parallel-runner.type-dd.yaml` 设计补丁已通过。

`targetMappingContract` 明确要求每个生产持久化目标必须映射到唯一
lane、owner、durableKind、laneTimeoutMs 与 releaseOn，且未列入
`targetMapping` 的 durable YAML/JSON/SQLite 目标不得由并行 runner 写入。
`targetMapping` 已补齐 `graph_vault/catalog/runs.yaml`、
`graph_vault/catalog/batch-runs/{runId}/status.json`、run lock、manifest、
item checkpoint、book job、book checkpoints、artifact manifest、producer
run record、graph capability、provider slot、subprocess registry、book
lease 和 qmd index 等生产目标，并为每项给出唯一 lane、owner、durableKind、
timeout 和 release 规则。

`failurePolicy.renameEnoent` 已给出固定基准要求的原因矩阵，覆盖 temp
身份碰撞或覆盖、调和误删 live temp、并发接管或 stale writer、target 被其他
generation 推进、以及底层文件系统或外部修改。每类均保留
`failureKind: local_state_integrity`、`retryable: false`、
`recoveryDecision: stop_until_fixed`，并要求 `targetLocator`、`tempId`、
`operationId`、owner、lease、syscall 和 errno 等证据。

未发现仍阻塞项。
