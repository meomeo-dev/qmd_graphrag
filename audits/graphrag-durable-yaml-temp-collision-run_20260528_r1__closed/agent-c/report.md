# GraphRAG Durable YAML Temp Collision 设计审计报告

## 结论

设计不通过。

当前生产设计和实现不能充分解释并防止
`epub-batch-20260527-real-resume-1` 中
`item-45c6c3f72a50-f5252de5` 在 `resume-book-2` 出现的 durable YAML
temp rename `ENOENT`。核心缺口是：temp 文件名只依赖 `process.pid` 与
`Date.now()`，reconcile 按目标前缀无所有权删除 temp，checksum sidecar 与
target rename 之间仍有 crash window，状态分类不能把该类本地持久化错误
(local persistence error) 稳定归类为可修复代码缺陷
(fixable code defect)。

## 审计范围

本审计仅覆盖本次真实失败链路：

- batch run：`epub-batch-20260527-real-resume-1`
- item：`item-45c6c3f72a50-f5252de5`
- stage：`resume-book-2`
- failure：durable YAML temp file rename `ENOENT`

证据来自本地代码与本轮审计状态文件。未使用外部搜索；未读取 `.env`；
未输出秘密、凭据或环境值。

## 关键证据

`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/reports/status.json`
已把触发条件限定为 durable YAML temp rename `ENOENT`。

`src/job-state/repository.ts` 的 durable YAML writer 使用
`${path}.tmp-${process.pid}-${Date.now()}` 作为 temp 文件名，并在写入后
rename 到 target。该命名不能证明同一进程、多 worker、同毫秒下的 attempt
唯一性。

`src/job-state/repository.ts` 的 reconcile 对
`${basename(path)}.tmp-` 前缀的文件直接 `rm`，未检查 temp owner、attempt id、
创建时间、writer lease 或 liveness。若另一个 writer 已写完 temp、尚未 rename，
该清理可制造 rename `ENOENT`。

`src/graphrag/capability-catalog.ts` 存在独立 durable YAML 实现，使用相同
`process.pid + Date.now()` temp 命名与同类前缀清理策略。该实现与 repository
协议重复，增加语义漂移风险。

`scripts/graphrag/batch-epub-workflow.mjs` 的
`reconcileDurableYamlTarget()` 会在 normal run 中直接扫描并删除 YAML temp，
且不共享 repository 的 per-target lock。它还同时支持旧格式
`basename(path).* .tmp` 与新格式 `basename(path).tmp-*`，清理范围更宽。

`src/graphrag/settings-projection.ts` 的 managed settings 写入也使用
`${settingsPath}.tmp-${process.pid}-${Date.now()}`，且没有 checksum、fsync 或
统一 durable YAML lock。即使它不是本次 item 失败的唯一证据，也说明 durable
YAML 协议尚未单一化。

`scripts/graphrag/batch-failure-classifier.mjs` 当前分类覆盖 provider transient、
SQLite busy/locked、data compatibility 与 local artifact gate，但没有
durable YAML rename `ENOENT`、temp collision、live temp deletion 或 checksum
commit window 的本地代码缺陷分类。

## 基准评估

| 基准 | 结论 | 说明 |
| --- | --- | --- |
| C01 failure scope preservation | 通过 | 本报告只评价 durable YAML 本地持久化失败。 |
| C02 temp name uniqueness | 不通过 | `pid + Date.now()` 不能支撑同 pid、同毫秒、多 worker 唯一性。 |
| C03 same target serialization | 不通过 | batch evidence reader 的 reconcile 可绕过 repository lock。 |
| C04 live temp ownership | 不通过 | temp 清理无 owner、lease、年龄或 liveness 校验。 |
| C05 lock staleness safety | 不通过 | lock 仅记录 pid，stale 删除不校验 session/generation/liveness。 |
| C06 checksum commit atomicity | 不通过 | target rename 与 checksum 写入分离，旧 checksum 可误伤新 target。 |
| C07 fsync recovery contract | 部分通过 | 有 temp fsync 与 parent fsync，但 crash window 未被完整建模。 |
| C08 single durable YAML abstraction | 不通过 | repository、capability、settings、batch reader 各有协议片段。 |
| C09 observable local defect classification | 不通过 | 分类会落到 unknown，不能稳定标记可修复代码缺陷。 |
| C10 fault injection acceptance | 不通过 | 缺针对本次 ENOENT 形态的并发与 crash-window 验收。 |

## 必须补充或修正的设计点

### 1. 统一 durable YAML 协议

必须定义唯一 durable YAML 抽象，并让 repository、graph capability catalog、
settings projection、batch evidence reader、startup reconcile 复用同一协议。
该协议至少包含：

- per-target lock；
- owner session；
- attempt id；
- high-entropy temp name；
- temp 独占创建；
- target rename；
- checksum 或 generation commit；
- parent directory fsync；
- quarantine 与 recovery event。

任何直接扫描 YAML temp 的 reader 必须纳入该协议，不能在未持有同一目标锁时
删除 temp。

### 2. 替换 temp 命名规则

必须停止使用只含 `process.pid` 与 `Date.now()` 的 temp 名。设计应要求：

- temp 名包含 `runnerSessionId`、`workerId`、target fingerprint、attempt id
  与 `randomUUID` 或等价随机量；
- temp 创建使用 exclusive create，若已存在则重新生成；
- 同目标重入、同毫秒多 worker、多文件并发均有明确不变量；
- temp 文件内容或 sidecar 记录 target path、checksum、owner 与 createdAt。

该修正直接覆盖同 pid、同毫秒导致的 temp 名碰撞风险。

### 3. 让 reconcile 不再删除 live temp

reconcile 的清理规则必须从“按前缀删除”改为“按所有权与过期状态删除”。
清理前至少应验证：

- temp owner 的 runner/session/worker lease 已过期；
- owner pid 在同 host 不存活，或 generation 已被 fencing；
- temp createdAt 超过最小年龄阈值；
- temp target 与当前 target 完全匹配；
- 清理事件记录 redacted locator、owner、age、reason。

无法证明遗留的 temp 必须保留，并把状态标记为 `stop_until_fixed` 或等待
下一轮 reconcile，而不是直接删除。

### 4. 修正 lock stale 判定

当前 lock 只写 pid，不能支撑单进程多 worker 或跨进程恢复。设计必须要求 lock
包含：

- host；
- pid；
- runnerSessionId；
- workerId；
- target path fingerprint；
- generation；
- fencingToken；
- heartbeatAt；
- expiresAt。

删除 stale lock 前必须校验 TTL、owner liveness 与 generation fencing。超过等待
预算时应产出明确的 local persistence diagnostic，而不是让后续 rename 暴露为
低语义 `ENOENT`。

### 5. 重做 checksum 与 crash recovery 契约

现有顺序是写 temp、fsync temp、rename target、写 checksum、fsync checksum、
fsync parent。该顺序仍有关键 crash window：target 已更新但 checksum 仍是旧值
时，reconcile 会把完整的新 target 当成 checksum mismatch 并 quarantine。

设计必须选择一种可证明的提交模型：

- 在 YAML target 内嵌 generation/checksum，并让 sidecar 只作索引；
- 或用 manifest record 同时描述 target checksum 与 commit generation；
- 或为 checksum sidecar 也使用 temp、fsync、atomic rename、parent fsync，并在
  recovery 中识别 target-new/checksum-old 状态；
- 或保留上一代 valid checkpoint，checksum mismatch 时先回退到上一代，而不是
  无条件 quarantine 当前 target。

每个 crash window 必须有确定恢复动作，并禁止在 evidence 不完整时发布
`completed`。

### 6. 增加本地持久化错误分类

状态观测必须能把本次失败归类为可修复代码缺陷，而不是 `unknown`。建议新增
稳定分类字段：

- `failureKind: "permanent"` 或新增 `failureKind: "local_defect"`；
- `localFailureClass: "durable_yaml_temp_collision"`；
- `localFailureClass: "durable_yaml_live_temp_deleted"`；
- `localFailureClass: "durable_yaml_rename_enoent"`；
- `recoveryDecision: "stop_until_fixed"`；
- `retryable: false`；
- `failedStage: "resume-book-2"`；
- redacted target/temp locator；
- owner/session/generation 诊断字段。

若短期不扩展 `failureKind` enum，也必须用 metadata 或 dedicated local class
表达“本地代码缺陷”，不能让状态停留在 unknown。

### 7. 增加故障注入验收

必须新增最小验收集，覆盖本次失败形态：

- 同一进程内两个 worker 在同毫秒写同一 YAML target；
- 同一进程内多个 worker 在同毫秒写不同 YAML target；
- writer 在 temp fsync 后、rename 前被另一个 reconcile 扫描；
- checksum 写入前 crash；
- checksum 写入中 crash；
- target rename 后 checksum 仍旧；
- stale lock 被误判前后的 fencing；
- batch status-json 对 rename `ENOENT` 的分类输出。

这些测试必须证明：不会误删 live temp，不会把完整 target 误 quarantine，不会把
本地持久化缺陷归为 provider transient，也不会发布错误 completed 状态。

## 最小通过条件

复审通过前，至少需要满足以下条件：

1. durable YAML 协议单一化，所有相关 YAML 路径使用同一 helper 或同一契约。
2. temp 名由 high-entropy attempt id 保证唯一，并用 exclusive create 验证。
3. reconcile 持锁运行，且只清理可证明过期的 temp。
4. checksum/generation 能恢复 target-new/checksum-old crash window。
5. batch runner 能把 durable YAML rename `ENOENT` 标记为本地可修复代码缺陷。
6. 新增并通过针对本次失败的并发与 crash-window fault injection 测试。
