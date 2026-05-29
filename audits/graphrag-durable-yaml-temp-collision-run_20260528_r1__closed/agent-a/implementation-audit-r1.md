# Durable YAML/JSON Temp Collision 实施审计 R1

结论：fail

## 阻塞项

1. `src/job-state/repository.ts:353`、`src/job-state/repository.ts:374`、
   `src/job-state/repository.ts:501`、`src/job-state/repository.ts:587`

   不满足 I04、I05、I08。YAML lock 只写入 pid，未记录 targetLocator、
   operationId、runnerSessionId、generation、fencingTokenHash、heartbeatAt 或
   expiresAt；temp 写入没有 owner evidence 或 sidecar；stale temp 清理只按
   basename 前缀和 mtime TTL 删除，未校验 owner-dead、lease-expired、target
   generation 未推进或 cleanup reason。`rename(temp, target)` 没有捕获 ENOENT
   并分类为 `local_state_integrity` / `durable_temp_rename_enoent`。

   这会影响真实 runner 恢复：resume 只能看到裸 temp/lock 文件，无法判断 temp
   属于 live writer、旧 generation、误删还是外部 mutation；再次发生 rename
   ENOENT 时只会抛出底层异常，无法写入可复审 checkpoint 并阻断错误 completed。

2. `src/graphrag/capability-catalog.ts:387`、`src/graphrag/capability-catalog.ts:408`、
   `src/graphrag/capability-catalog.ts:544`、`src/graphrag/capability-catalog.ts:514`

   不满足 I01、I04、I05、I08。Graph capability catalog 自带一套 durable YAML
   lock/temp/checksum/reconcile 实现，语义与 `repository.ts` 重复且不包含设计要求
   的 owner evidence、generation/fencing lock schema、heartbeat、cause matrix
   和 local state integrity 分类。temp cleanup 同样只按 mtime TTL 删除。

   这会影响真实 runner 恢复：`graph-capabilities.yaml` 是 completed/query-ready
   能力投影的共享 catalog；该路径发生 temp collision 或 active temp 被清理时，
   runner 无法保留 tempId/operationId/owner 证据，也无法把 capability catalog
   写入失败稳定归类为 stop_until_fixed。

3. `src/job-state/durable-json.ts:30`、`src/job-state/durable-json.ts:47`、
   `src/job-state/durable-json.ts:78`、`src/job-state/durable-json.ts:126`

   不满足 I01、I04、I06、I07、I08。durable JSON helper 与 YAML helper分离实现，
   没有 per-target lock、owner evidence、rename ENOENT 分类、checksum crash
   window 处理或 strict directory fsync 边界。`fsyncDirectoryBestEffort` 吞掉
   directory fsync 错误，checksum missing 时直接 backfill，checksum mismatch 时
   直接 quarantine，未区分 target-new/checksum-old、checksum-missing 等 crash
   window。

   这会影响真实 runner 恢复：batch item checkpoint、manifest、status、lock、
   provider slot、subprocess registry 等 JSON 状态是 runner 恢复权威输入；目录
   fsync 不可证明或 checksum crash window 时，当前实现仍可能让恢复流程读取并
   使用不完整状态。

4. `scripts/graphrag/batch-epub-workflow.mjs:3046`、`scripts/graphrag/batch-epub-workflow.mjs:3084`、
   `scripts/graphrag/batch-epub-workflow.mjs:3151`、`scripts/graphrag/batch-epub-workflow.mjs:3251`

   不满足 I03、I04、I05、I06、I07、I08。runner 内部还有第三套 JSON/YAML durable
   replace/reconcile/lock 实现。lock owner 只包含 pid、runnerSessionId、host、
   runId、acquiredAt；没有 generation、fencingTokenHash、targetLocator、lane、
   operationId、heartbeatAt、expiresAt。reconcile 删除 stale temp 只按 mtime，
   事件只记录 locator。directory fsync 失败被 `fsyncDirectory` 静默吞掉。
   `writeJsonAtomic` 捕获错误后删除 temp 并原样抛出，没有 rename ENOENT cause
   matrix、localFailureClass 或 recoveryDecision。

   这会影响真实 runner 恢复：本次失败发生在 batch runner resume 路径；这些函数
   正是 item checkpoint、manifest、coordinator lock 和 batch 状态的写入入口。
   发生 temp rename ENOENT 时，runner 不能稳定写入
   `durable_temp_rename_enoent`，也不能保留造成 ENOENT 的 owner/cause 证据。

5. `scripts/graphrag/batch-epub-workflow.mjs:3218`、`scripts/graphrag/batch-epub-workflow.mjs:3616`、
   `scripts/graphrag/batch-epub-workflow.mjs:8502`

   不满足 I09。启动时只在 acquire coordinator lock 后调用
   `recoverCoordinatorRuntimeArtifacts()`；未实现设计要求的 durable state
   preflight：claim 新 item 或启动 `resume-book` 前没有统一扫描 durable
   YAML/JSON lock owner records、未过期 temp、orphan temp、checksum/generation、
   provider slot、book lease 与 subprocess registry，并在 unknown/live temp 或
   不可收敛 checksum 时 stop_until_fixed。

   这会影响真实 runner 恢复：当前 runner 可能在存在 unknown temp、半写
   checkpoint/catalog 或不可判定 lock owner 的情况下继续 claim item，并再次进入
   `resume-book`，从而放大原始 local state integrity 失败。

6. `src/contracts/batch-run.ts:154`、`src/contracts/batch-run.ts:288`、
   `src/contracts/batch-run.ts:311`、`scripts/graphrag/batch-epub-workflow.mjs:528`、
   `scripts/graphrag/batch-epub-workflow.mjs:658`、
   `scripts/graphrag/batch-epub-workflow.mjs:686`

   不满足 I08、I10。item checkpoint、event log 和 recovery summary schema 未定义
   `localFailureClass`、`targetLocator`、`redactedEvidenceLocator`、`tempId`、
   `operationId`、`renameCause`、`completedPublishRule`、`lockOwnerEvidence`、
   `checksumRecoveryDecision`、`fsyncTarget`、`fsyncErrno` 等本地状态失败证据字段。

   这会影响真实 runner 恢复：即使 failure classifier 识别出 local state
   integrity，checkpoint/status/summary 也无法保存本次审计要求的可复审证据；
   后续 resume 无法区分 temp collision、active temp deletion、checksum crash
   window 或 directory fsync 边界失败。

7. `scripts/graphrag/batch-failure-classifier.mjs:63`、
   `scripts/graphrag/batch-failure-classifier.mjs:246`

   不满足 I08。classifier 会把 rename ENOENT + `.tmp-` 粗略识别为
   `local_state_integrity`，但 `localFailureClass` 固定为
   `durable_state_integrity`，没有 `durable_temp_rename_enoent`，也没有 cause
   matrix、target/temp/operation/owner/generation/errno 证据抽取。

   这会影响真实 runner 恢复：本次真实失败的根因会被压缩成泛化错误，无法驱动
   stop_until_fixed 的证据化恢复，也无法让后续复审判断是否仍是 temp collision、
   reconcile 误删、旧 generation 写入或外部 mutation。

8. `test/book-job-state.test.ts:409`、`test/book-job-state.test.ts:1526`、
   `test/book-job-state.test.ts:3312`、`test/cli.test.ts:12357`

   不满足 I10。现有测试只覆盖同毫秒随机 temp 基本成功、checksum 缺失 backfill
   和 checksum mismatch quarantine；未覆盖 forced temp id collision、active temp
   reconcile、stale lock live owner、rename ENOENT cause matrix、directory fsync
   unsupported/uncertain、checksum crash window 分类、resume-book orphan temp
   preflight，以及 item checkpoint local state failure evidence 字段。

   这会影响真实 runner 恢复：当前测试不能复现本次 `resume-book-2` durable temp
   rename ENOENT 的关键恢复路径，也不能防止实现继续把 local state integrity
   错误当作普通异常或无证据 stop。
