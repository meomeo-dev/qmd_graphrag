# Provider Requests Preflight Quarantine Failure

## 状态

`epub-batch-20260529-post-r3-real-1` 在真实 EPUB 批处理启动阶段失败。
runner 未创建 batch manifest，失败发生在 `runner_start` durable preflight
期间。

## 固定失败证据

- runId: `epub-batch-20260529-post-r3-real-1`
- event log:
  `graph_vault/catalog/batch-runs/epub-batch-20260529-post-r3-real-1/events.jsonl`
- events: 739
- `durable_json_target_quarantined`: 731
- `durable_yaml_target_quarantined`: 1
- `durable_checksum_meta_backfilled`: 7
- local failure class: `durable_checksum_mismatch`
- recovery decision: `stop_until_fixed`
- affected scope: `graph_vault/catalog/provider-requests/*.json`

## 失败定义

真实 runner 在 manifest 创建前扫描历史 provider request durable JSON target。
大量 target 被判定为 checksum mismatch 并隔离。该行为使 runner 无法进入
38 本 EPUB 的正常处理闭环，并可能继续扩大历史 provider request 隔离范围。

## 审计边界

本轮只审计 provider request durable preflight 与 recovery 设计是否允许
runner-start 对历史 provider request target 执行大规模写入式 quarantine，
以及该行为是否与 Type DD 中的状态恢复、观测恢复、fail-closed 和
manifest-before-work 不变量一致。
