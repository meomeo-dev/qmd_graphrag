# GraphRAG Durable YAML Temp Rename ENOENT 设计审计报告

## 结论

设计不通过。

现有生产设计已声明 durable YAML/JSON 替换应使用同目录 temp、fsync、atomic
rename 与父目录 fsync，也声明恢复时应处理遗留 temp 文件。但针对本次真实失败
`epub-batch-20260527-real-resume-1` / `item-45c6c3f72a50-f5252de5` /
`resume-book-2` 的 `rename ENOENT`，设计缺少可执行、可验证的并发写入边界。

核心缺口是：设计没有保证 temp 文件身份唯一，没有禁止 active temp 被
reconcile 删除，没有定义 durable YAML 文件锁的 freshness/fencing 规则，也没有
把 `rename ENOENT` 分类为 durable state integrity 故障。因此，该设计不能证明
多书并行 runner 在 resume 场景下可避免同类失败复发。

## 审计范围

- 架构设计：`docs/architecture/graphrag-parallel-runner.type-dd.yaml`
- durable YAML 相关实现证据：
  - `src/job-state/repository.ts`
  - `src/graphrag/capability-catalog.ts`
  - `src/job-state/durable-json.ts`
- 审计状态：`audits/graphrag-durable-yaml-temp-collision-run_20260528_r1__open`

未读取 `.env`，未审计无关 provider、模型质量、GraphRAG 语义正确性或业务内容。

## 关键证据

架构文档已有部分正向约束：

- `durableWriteContract.yamlOrJsonReplace` 要求同目录 temp、fsync、atomic
  rename、fsync 父目录，并包含 generation 或 checksum。
- `partialWriteRecovery.checkpoints` 要求恢复时处理遗留 temp 与无效
  checksum/generation。
- `serialized_global_writes` 要求 catalog、checkpoint、event、manifest 等
  共享写入串行化。

实现证据显示当前设计约束不足以覆盖真实失败：

- `src/job-state/repository.ts` 的 YAML temp 名为
  `${path}.tmp-${process.pid}-${Date.now()}`。
- `src/graphrag/capability-catalog.ts` 的 YAML temp 名同样为
  `${path}.tmp-${process.pid}-${Date.now()}`。
- temp 创建使用普通写入语义，不是 exclusive create；同进程多 worker 在同一
  毫秒内若绕过或抢占同目标锁，存在 temp 复用和后续 `rename ENOENT` 风险。
- reconcile 会删除同目录、同 basename 前缀的所有 temp；设计未规定如何识别
  active temp、stale temp 与 orphan temp。
- durable YAML lock 以 `${path}.lock` 表示，stale 判断基于 lock 文件 mtime；
  设计未要求锁心跳、owner 存活验证、operation generation 或临界区时长上限。
- `repository.ts` 与 `capability-catalog.ts` 各自实现 durable YAML 协议，缺少
  单一共享边界；`durable-json.ts` 又有相似但独立的 temp/rename 逻辑。

## 基准评估

| 基准 | 结果 | 说明 |
| --- | --- | --- |
| C01 同一目标文件写入排他性 | 不通过 | 设计有 writer lane 概念，但未证明所有 YAML 读、写、reconcile 共享同一排他边界。 |
| C02 临时文件身份抗碰撞 | 不通过 | 设计未规定 temp identity 熵、单调序列或 exclusive create。 |
| C03 活跃临时文件清理安全 | 不通过 | 设计只说恢复时删除 temp，未规定 active temp 保护与 owner 校验。 |
| C04 原子替换持久化契约 | 部分通过 | 同目录 temp、fsync、rename、父目录 fsync 已被声明，但 checksum/generation 顺序和失败原子性仍不完整。 |
| C05 锁新鲜度与 fencing | 不通过 | 设计未覆盖 durable YAML 文件锁心跳、stale lock 抢占和提交前后 fencing。 |
| C06 单一 durable YAML 边界 | 不通过 | 当前设计未禁止重复 durable YAML 实现和裸 YAML I/O。 |
| C07 writer lane 与文件锁集成 | 部分通过 | 有 lane 顺序，但缺少 lane 与具体 YAML 文件锁的组合规则。 |
| C08 resume 接管与半写恢复 | 部分通过 | 有 resume 恢复方向，但未细化 resume-book 前对 temp/lock/checksum 的强制检查。 |
| C09 rename ENOENT 错误分类 | 不通过 | 设计未定义 temp rename ENOENT 的 failureKind、事件字段和恢复决策。 |
| C10 并发回归证据 | 不通过 | 验收标准包含 partial temp，但未要求同毫秒碰撞、active temp 删除和 stale lock 抢占测试。 |

## 必须补充或修正的设计点

1. 定义统一 durable YAML API（single durable YAML boundary）。所有 YAML
   catalog、checkpoint、manifest、run record、capability 读写和 reconcile
   必须通过同一模块；设计中列明禁止裸 `YAML.parse(readFile(...))`、重复
   temp/rename 实现和无锁 reconcile。

2. 将 temp identity 升级为抗碰撞设计。temp 文件名至少包含
   `runnerSessionId`、`workerId`、`operationId` 或单调 counter/random id，
   并使用 exclusive create。若发生碰撞，必须重试并记录诊断，不能覆盖或复用
   已存在 temp。

3. 明确 active temp 保护规则。reconcile 删除 temp 前必须验证 owner 已失效、
   generation 未提交、temp 超过安全 TTL，且该 temp 不属于当前活跃 operation。
   未知 owner 的 temp 不得静默删除，必须进入 orphan temp 诊断或 repair。

4. 重写 durable YAML lock 契约。锁文件必须包含 owner、runnerSessionId、
   workerId、operationId、generation、heartbeatAt、expiresAt。stale lock
   break 必须要求 owner 失效或 lease 过期证据；不能仅依赖静态 mtime。

5. 把 writer lane 与文件锁组合写成明确协议。catalogWriterLane、
   checkpointWriterLane、manifestWriterLane 必须先后如何获取、是否允许嵌套、
   timeout 后如何释放，都应绑定到具体 YAML 目标类型。

6. 对 `rename(temp, target)` 的 ENOENT 增加专门 failureKind，例如
   `durable_yaml_temp_missing_before_rename`。事件和 checkpoint 必须记录 target、
   temp identity、owner、generation、operationId、writer lane、recoveryDecision
   与 redacted diagnostics。

7. 在 resume-book 前增加 durable state preflight。恢复流程必须扫描目标目录内
   `.lock`、`.tmp-*`、`.sha256`、target YAML 与 subprocess registry；发现
   active/unknown temp 或 checksum mismatch 时，先 repair 或 stop_until_fixed，
   不得继续提交 completed。

8. 规定 checksum/generation 提交顺序。target YAML 与 `.sha256` 或 generation
   record 之间若存在不一致，恢复时必须能区分 old committed、new committed、
   interrupted-before-rename 与 interrupted-after-rename-before-checksum。

9. 增加并发回归测试要求。测试必须稳定覆盖同进程同毫秒 temp 名碰撞、lock
   被错误 stale 抢占、reconcile 删除 active temp、resume-book-2 重入、多 worker
   同时写 capability/catalog，以及进程中断后的恢复。

10. 将本次真实失败纳入验收证据。后续设计复审必须能用事件、status、
    checkpoint、temp/lock 诊断和测试结果证明：
    `item-45c6c3f72a50-f5252de5` 所属失败类别不会再次由 durable YAML
    temp rename ENOENT 触发。
