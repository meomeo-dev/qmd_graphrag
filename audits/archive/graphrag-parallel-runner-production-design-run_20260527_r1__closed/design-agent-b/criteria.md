# GraphRAG 多书并行 Runner 生产设计审计基准

## C01 Run Lock 与 Coordinator 单写者

设计必须保证同一 `runId` 任意时刻只有一个有效 coordinator 可以写入共享
状态。基准覆盖 run lock 的持久字段、原子获取、心跳续租、过期接管、
fencing（fencing）与崩溃后恢复边界。

## C02 Item Lease 与 Book Lease 互斥

设计必须分别保证同一 `itemId` 只有一个 worker 持有、同一 `bookId` 只有
一个 writer 产生 book-scoped 产物。基准覆盖 lease 字段、原子 claim、
TTL、heartbeat、fencing token、重复 book 队列策略、过期 lease 回收与
写入前校验。

## C03 Stale Running Reclaim 正确性

设计必须定义 stale `running` 的判定、事件证据、状态迁移和重新领取规则。
未过期 lease 不得被抢占；过期 lease 必须可恢复；旧 worker 的迟到写入
必须被拒绝。

## C04 Checkpoint 持久性与阶段幂等

设计必须把 checkpoint 作为恢复权威之一，并说明阶段状态、失败字段、
attempt、active command、producer lineage、原子持久化和重启后的幂等
重放边界。

## C05 Manifest 派生模型

run manifest 必须从 item checkpoint 与事件流派生，不得依赖 worker 内存
计数。重启后必须可从磁盘状态重算，并且 manifest 刷新本身必须串行化。

## C06 GraphRAG 产物隔离与 Query-Ready 门控

每本书必须使用独立 GraphRAG 工作、输出和报告目录。`query_ready` 只能由
同一 `bookId` 下完成且 lineage 匹配的 graph extract、community report 与
embedding producer 派生。

## C07 Transient Retry 与预算耗尽

transient provider failure 必须进入 retryable 状态，记录 `nextRetryAt`、
attempt 与 retry budget，并释放 lease 让其他书推进。retry budget 耗尽时
必须有确定的停止或失败状态，避免无限 pending 或无限 retry。

## C08 Non-Transient Stop-Until-Fixed

非 transient provider、认证、权限、配置或 schema 错误必须转入
`failed_stop_until_fixed`，持久记录 stop reason，并阻止继续领取新 item。
已完成、retryable 与 running 状态必须在停止过程中保持可恢复。

## C09 状态观测与 Secret 隔离

事件、日志与 `status-json` 必须能观测 run、worker、item、stage、provider
slot、retry、lease 与 stopped reason，同时不得读取或输出 provider secret。

## C10 重启恢复与崩溃后调和

worker crash、coordinator crash 与进程中断后，恢复流程必须扫描 checkpoint、
事件、lease 与已存在产物，重建 manifest，回收过期 running，并对部分产物
进行验证、复用、重建或拒绝。
