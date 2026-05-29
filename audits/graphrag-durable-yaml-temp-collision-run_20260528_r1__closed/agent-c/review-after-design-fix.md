# Durable YAML Temp Collision 设计修正复审

## 结论

fail

本次复审沿用
`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open/agent-c/criteria.yaml`
中的 10 条固定基准，未重新制定标准。补充后的
`temporaryFileIdentity` 已禁止仅使用 `process.pid + Date.now()`，并要求
high-entropy nonce；`temporaryFileLifecycle` 与 `durableReplace` 也补充了
未过期 temp 不得清理、rename `ENOENT` 分类等规则。但设计仍未满足全部阻塞
基准。

## 阻塞项

### C04 live temp 所有权保护未满足

设计要求 recovery 只能清理超过 durable temp stale TTL 的 temp，并禁止仅凭
basename 前缀删除未过期 temp。该规则能降低误删风险，但仍未满足固定基准：
temp 文件本身没有被要求携带 `writerSessionId`、`attemptId`、完整 target、
`createdAt` 与可验证状态；清理前也未要求确认 owner lease 过期或 owner
进程不可存活。仅以 stale TTL 判定 orphan temp，仍可能删除被长时间阻塞但
仍存活的 writer temp。

必须补充：temp identity/metadata schema、writer owner 关联、owner lease 或
pid liveness 校验，以及清理前的最小年龄与 owner-dead 双条件。

### C05 stale lock 安全性未满足

`durableYamlLock.ownerRecord` 目前包含 `pid`、可选 `host`、可选
`runnerSessionId`、`createdAt or mtime`。固定基准要求 lock 文件包含
session、pid、host、generation 与 heartbeat，并在删除前校验 TTL、owner
liveness、generation fencing，且记录可审计事件。

当前设计中 `host` 与 `runnerSessionId` 是可选字段，缺少 generation、
heartbeat/heartbeatAt、expiresAt 或等价心跳字段，也未明确 stale lock removal
必须产出 durable audit event。该 lock 记录不足以证明 live writer 不会被误判。

必须补充：强制 owner schema、heartbeat 更新规则、generation/fencing token、
expiresAt、owner liveness 检查顺序，以及 stale lock removal event。

### C06 checksum 提交原子性未满足

设计仍描述为 target rename 成功后再写 checksum，并在 checksum fsync 后 fsync
父目录。`partialWriteRecovery.durableReplace` 补充了 checksum/generation 无效
时回退到上一份 valid checkpoint，但没有明确 checksum sidecar 自身也使用
durable replace，或把 checksum/generation 嵌入同一提交记录。

固定基准要求能区分旧 target、新 target、旧 checksum、新 checksum 与 crash
中间态，并保证新 target 不因旧 checksum 被误隔离。当前设计未完整描述
target-new/checksum-old、target-new/checksum-missing、checksum temp partial 等
窗口的恢复规则。

必须补充：checksum sidecar 的 durable replace 协议或同记录提交模型，并逐项
定义 target/checksum crash window 的恢复动作。

### C08 单一 durable YAML 抽象未满足

补充段落定义了 durable replace 行为，但没有明确 repository、capability
catalog、settings projection、batch evidence reader 与 startup reconcile 必须
复用同一 durable YAML helper 或适配同一契约。固定基准要求不存在各自实现的
temp 命名、lock、reconcile、checksum 或 fsync 语义漂移。

当前 Type DD 仍只在通用 durableWriteContract 中描述规则，没有列出所有 YAML
写入/读取边界的强制迁移范围，也未声明 evidence reader 的 read-before-reconcile、
checksum backfill、quarantine 必须持有同一 per-target lock。

必须补充：统一 durable YAML abstraction 的适用清单、禁止旁路规则，以及
repository/capability/settings/batch evidence reader 的一致协议边界。

### C09 本地缺陷可观测分类未满足

`partialWriteRecovery.durableReplace` 已要求 atomic rename `ENOENT` 与 live temp
被 reconcile 删除分类为 `local_state_integrity`，lock timeout 分类为
`local_state_lock_timeout`。但固定基准要求 item checkpoint、event、status-json
与 recovery summary 包含稳定 `failureKind`、`localFailureClass`、
`recoveryDecision`、`failedStage` 与 redacted locator。

当前 observability 段落没有把 `localFailureClass`、`recoveryDecision`、redacted
target/temp locator、durable replace owner evidence 纳入 event/status-json/
recovery summary 的必备字段，也没有规定这类失败不得降级为 `unknown` 或
provider transient。

必须补充：durable YAML 本地缺陷的稳定状态字段、事件类型、status-json 字段、
recovery summary 字段，以及与 `failed_stop_until_fixed` 的绑定规则。

### C10 故障注入验收未满足

现有 fault injection 仍停留在通用项，如 checkpoint temp file left behind
before rename、partial JSONL tail、manifest mismatch。固定基准要求覆盖同 pid
同毫秒写入、同目标并发、reconcile 清理 live temp、target/checksum crash
window 与分类输出。

当前设计未列出能稳定复现本次 rename `ENOENT` 形态的故障注入，也未要求验证
修正后不会误删 live temp、不会发布错误 completed、并能输出本地代码缺陷诊断。

必须补充：面向本次失败的专门 fault-injection/acceptance matrix，并把每项绑定
到 event、status-json、checkpoint、recovery summary 或 redacted locator 证据。
