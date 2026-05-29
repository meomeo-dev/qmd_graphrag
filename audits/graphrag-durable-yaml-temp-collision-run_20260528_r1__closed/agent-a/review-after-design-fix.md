# 设计修正后复审结果

结论：fail

## 阻塞项

1. C02 临时文件身份抗碰撞仍未完全满足。新增
   `temporaryFileIdentity` 要求 high-entropy uuid 或 nonce，并禁止仅使用
   `process.pid + Date.now`，但设计未明确要求 temp 文件以 exclusive create
   语义创建。缺少该约束时，碰撞不能被稳定地转化为重试或明确诊断。

2. C03 活跃临时文件清理安全仍未完全满足。新增
   `temporaryFileLifecycle` 规定未过期 temp 不得删除、旧格式 temp 超过 stale
   TTL 后才可清理，但设计未要求 temp 文件或 sidecar 记录 owner、target、
   generation、createdAt。active、stale、orphan 与 unknown temp 的判定证据
   仍不足。

3. C05 锁新鲜度与 fencing 仍未完全满足。新增 `durableYamlLock` 的
   `ownerRecord` 只要求 pid、optional host、optional runnerSessionId、
   createdAt 或 mtime，未强制包含 generation，且 runnerSessionId 仍为可选。
   设计也未把 durable YAML commit 前后 fencing token 验证绑定到该文件锁协议。

4. C06 单一 durable YAML 边界未满足。设计仍未定义共享 durable YAML API
   边界，也未列明禁止重复实现 durable YAML 协议、裸 `YAML.parse(readFile(...))`
   或无锁 YAML reconcile 的清单。catalog、checkpoint、manifest、run record 与
   capability YAML 的统一所有权仍不明确。

5. C08 resume 接管与半写恢复仍未完全满足。`partialWriteRecovery` 已补充
   temp、checksum/generation 与 durable replace 分类，但设计未明确要求
   resume 在 claim 新工作前统一扫描 durable YAML lock、temp、checksum、
   generation 与 subprocess registry。`resume-book` 阶段的 durable state
   preflight 仍不是硬性前置条件。

6. C09 rename ENOENT 错误分类仍未完全满足。新增 `durableReplace` 已要求
   atomic rename ENOENT 分类为 `local_state_integrity`，但设计未要求错误记录
   保留 target、temp identity、owner、generation、operationId 与
   recoveryDecision。事件、status 与 checkpoint 的可复审字段仍不足。

7. C10 并发回归证据未满足。现有 `validationRequirements` 仍未明确覆盖
   同进程同毫秒 temp 名碰撞、stale lock 抢占、active temp 被 reconcile 删除、
   `resume-book` 重入与多 worker catalog/capability 写入这些固定场景，也未要求
   观测字段证明没有 temp collision、lost write 或错误 completed。
