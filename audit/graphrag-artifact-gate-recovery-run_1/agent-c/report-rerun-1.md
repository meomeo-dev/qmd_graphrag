# Agent C 复审报告：恢复机制、观测性与 Resume 语义

复审对象：`/Users/jin/projects/qmd_graphrag` 当前未提交工作区。

固定基准：
`/Users/jin/projects/qmd_graphrag/audit/graphrag-artifact-gate-recovery-run_1/agent-c/baseline.md`

首次报告：
`/Users/jin/projects/qmd_graphrag/audit/graphrag-artifact-gate-recovery-run_1/agent-c/report.md`

复审方式：静态复核代码、测试和文档证据；未执行测试套件。

## 1. Transient upstream failure 与永久失败分类

判定：PASS。

证据：
`/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:1`
到 `:58` 将 HTTP 429/5xx 分类为 `transient` 且 `retryable=true`，
将其他 4xx 分类为 `permanent` 且 `retryable=false`。同文件 `:61`
到 `:119` 覆盖 timeout、rate limit、DNS、连接中断和 HTTP client 等
provider transient token；`:121` 到 `:165` 将 GraphRAG 数据兼容性和
本地 artifact gate 失败归入非自动重试路径。测试
`/Users/jin/projects/qmd_graphrag/test/cli.test.ts:1661` 到 `:1778`
覆盖 transient/permanent provider recovery decisions。

结论：当前实现和测试支持基准 1。

## 2. Retriable provider failure checkpoint 可恢复性

判定：PASS。

证据：
`/Users/jin/projects/qmd_graphrag/src/contracts/batch-run.ts:77` 到 `:120`
定义 item checkpoint 的 `bookId`、`attempts`、`failedStage`、
`commandChecks`、`nextRetryAt`、`retryDelaySeconds`、`failureKind`、
`retryable` 和 `recoveryDecision`。
`/Users/jin/projects/qmd_graphrag/src/contracts/book-job.ts:133` 到 `:149`
要求 stage checkpoint 持久化 `attemptCount`、`runId`、
`inputFingerprint`、`contentHash`、`stageFingerprint` 和
`providerFingerprint`。
`/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2284`
到 `:2356` 写入 running/failed/succeeded stage checkpoint 的 attempt、
stage identity、provider fingerprint 和 artifact id；`:2418` 到 `:2431`
追加 run record 保留 attempt history。测试
`/Users/jin/projects/qmd_graphrag/test/cli.test.ts:1921` 到 `:2020`
验证 fail-fast transient failure 留下 `pending`、`retry_same_run_id`、
`nextRetryAt` 和 failed command attempt。

结论：当前实现和测试支持基准 2。

## 3. Stale local 或 remote running checkpoint 可恢复

判定：FAIL。

证据：
实现层支持该基准。
`/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:634`
到 `:655` 在 ownership 缺失、heartbeat 无效、heartbeat 超 TTL 或本机
PID 死亡时判定 orphaned；fresh remote heartbeat 未超 TTL 时不抢占。
同文件 `:2224` 到 `:2264` 将 orphaned running checkpoint 降级为
`pending`，写入 `failureKind=transient`、`retryable=true`、
`recoveryDecision=retry_same_run_id` 和 `item_running_recovered`。
测试 `/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4733` 到 `:4849`
验证 `--status-json` 将 stale remote running 投影为 retryable pending；
`:4962` 到 `:5095` 验证 normal run 会恢复 stale remote running item 并
继续处理。

文档层已部分修复但仍存在冲突。
`/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.md:679`
到 `:683` 明确 fresh remote TTL 内不抢占，缺失 ownership、heartbeat 超 TTL
或本机 PID 死亡时降级为 pending recovery。
`/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:1579`
到 `:1584` 的 `runner_ownership_rule` 也已改为相同语义。
`/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:44`
到 `:53` 同样说明 heartbeat 超 TTL 时降级为 `pending`。

但同一 Type-DD 文件仍保留冲突规则：
`/Users/jin/projects/qmd_graphrag/docs/architecture/unified-retrieval-plane.type-dd.yaml:1634`
到 `:1637` 的 `running_ownership_rule` 声明另一个 runner host 拥有的
running checkpoint 只观测不抢占，且只有 ownership 缺失或同主机 dead PID
才降级为 pending recovery。该文本没有包含 remote heartbeat 超 TTL 后恢复，
与基准 3、实现、测试和同文件前置规则冲突。

最小修复建议：删除或修正
`docs/architecture/unified-retrieval-plane.type-dd.yaml:1634` 到 `:1637` 的
`running_ownership_rule`，明确 fresh remote heartbeat 在 TTL 内只观测不抢占；
remote heartbeat 超过 TTL 时应按 stale runner recovery 降级为 `pending`，
并保留 `recoveryDecision=retry_same_run_id`。

是否阻断真实 EPUB 闭环：不阻断运行时真实 EPUB 闭环，因为代码和 normal-run
测试已支持 stale remote recovery；但阻断契约文档一致性和本轮固定基准审计通过。

## 4. Fresh remote running checkpoint 不得被提前抢占

判定：PASS。

证据：
`/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:644`
到 `:654` 先按 TTL 判断 stale，再对 fresh remote heartbeat 返回 false，
不把该 checkpoint 视为 orphaned。`:3821` 到 `:3835` 在 normal run 中只写
`item_running_observed` 并继续，不调用 `markItemRunning`。
测试 `/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4619` 到 `:4730`
验证 `--status-json` 不偷 fresh remote running item；`:4851` 到 `:4960`
验证 normal run 不偷 fresh remote running item，checkpoint 仍为 running，
且没有 `item_start`。

结论：当前实现和测试支持基准 4。

## 5. Recovered stale-runner 不得误入 provider recovery wait

判定：PASS。

证据：
`/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2267`
到 `:2270` 识别已恢复的 runner orphan；`:2282` 到 `:2287` 在
`recoverProviderTransientCheckpoint` 中排除该类 checkpoint，避免将 stale
runner recovery 重新分类为 provider transient wait。
测试 `/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4503` 到 `:4617`
验证非 transient 状态不会投射 stale provider wait；`:4962` 到 `:5095`
验证 stale remote recovery 后继续执行并按后续真实错误收敛，而不是等待
provider retry window。

结论：当前实现和测试支持基准 5。

## 6. Batch fail-fast 必须留下 explicit incomplete manifest

判定：PASS。

证据：
`/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2419`
到 `:2439` 的 `persistFailFastInterruptedManifest` 将 interrupted run 写为
`status=incomplete`，并记录 `interruptedByFailFast` 与 reason。`:3909`
到 `:3915` 和 `:4083` 到 `:4091` 在 fail-fast transient/provider recovery
路径调用该函数。`:2398` 到 `:2403` 仅在 `completed === totalItems` 时写
completed，否则在 pending/running 清空或 provider wait limit 时写 incomplete。
测试 `/Users/jin/projects/qmd_graphrag/test/cli.test.ts:1921` 到 `:2020`
断言 fail-fast transient failure 后 manifest 为 `incomplete`，checkpoint 保持
`pending` 且可同一 runId 恢复。

结论：当前实现和测试支持基准 6。

## 7. Recovery 后不得绕过 stage gate 与 artifact validation 标为 graph-ready

判定：PASS。

证据：
`/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:2359` 到 `:2390`
在 `query_ready` succeeded checkpoint 写入前验证 producer stages 和 query
artifacts；`:2442` 到 `:2443` 只有 `query_ready` succeeded 且 job 存在时
发布 graph capabilities。
`/Users/jin/projects/qmd_graphrag/src/job-state/artifact-validation.ts:520`
到 `:559` 验证 book-scoped graph output、producer run、stage fingerprint、
provider fingerprint、corpus content hash 和磁盘 artifact 有效性。
`/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:707`
到 `:726` 在 query_ready 完成前调用 producer artifact gate。
测试 `/Users/jin/projects/qmd_graphrag/test/cli.test.ts:5350` 到 `:5612`
验证完整 book-scoped producer evidence 可保持 completed；`:6283` 到 `:6556`
验证 stale producer lineage 会被 status-json 重新打开为 pending。
`/Users/jin/projects/qmd_graphrag/test/book-job-state.test.ts:338` 到 `:423`
验证 query-ready artifact 被破坏后 graph enhancement state 变为 not_ready。

结论：当前实现和测试支持基准 7。

## 8. Operator-visible logs/status records 必须暴露恢复上下文

判定：PASS。

证据：
`/Users/jin/projects/qmd_graphrag/src/contracts/batch-run.ts:193` 到 `:210`
定义 event log 字段：`itemId`、`status`、`command`、`failureKind`、
`retryable`、`providerStatusCode`、`recoveryDecision`、`failedStage` 和
redacted message；`:212` 到 `:241` 定义 recovery summary item，包含
`sourceName`、`bookId`、`status`、`attempts`、qmd/GraphRAG/query status、
retryability、next retry 和 runner ownership。
`/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2442`
到 `:2534` 构造 summary；`:2846` 到 `:2870` 在 command failure event 中
记录 attempt、retryability、nextRetryAt 和 recovery decision；`:3123`
到 `:3135` 在 resume pass 完成 event 中记录 next stage。
运行手册 `/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:26`
到 `:34`、`:247` 到 `:251` 要求 manifest、item checkpoint、events 和
recovery-summary 暴露恢复状态。

结论：当前实现、契约和文档支持基准 8。

## 9. Resume 语义必须 idempotent

判定：PASS。

证据：
单书 resume 通过
`/Users/jin/projects/qmd_graphrag/src/job-state/repository.ts:669` 到 `:805`
构造 `BookResumePlan`，按 checkpoint、fingerprint 和 artifact validity 计算
`nextStage`、`completedStages` 和 stale/missing state。
批处理层 `/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3682`
到 `:3684` 对 completed item 只记录 `item_skip_completed` 并跳过；`:3686`
到 `:3714` 仅在 non-migrate run 中把 skipped item 重新打开为 pending；
`:3838` 到 `:3869` 只对当前可运行 item mark running 并处理。
运行手册 `/Users/jin/projects/qmd_graphrag/docs/operations/graphrag-epub-batch-runbook.md:60`
到 `:75` 规定同一 runId 跳过 completed item，retryable failed item 才自动
重试，单书由 `BookResumePlan.nextStage` 防止重复高成本 stage。
测试 `/Users/jin/projects/qmd_graphrag/test/cli.test.ts:5098` 到 `:5230`
验证无真实 GraphRAG evidence 的 completed item 会被 reopen；`:5233`
到 `:5348` 验证 skipped item 在非 migrate run 中不会被当作完成。

结论：当前实现、测试和文档支持基准 9。

## 10. 必要恢复测试覆盖

判定：PASS。

证据：
stale remote runner recovery 由
`/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4733` 到 `:4849` 和
`:4962` 到 `:5095` 覆盖，分别验证 status-json 投影和 normal run 落盘恢复。
fresh remote runner protection 由同文件 `:4619` 到 `:4730` 和 `:4851`
到 `:4960` 覆盖，分别验证 `--status-json` 和 normal run 不抢占 fresh remote
running item。orphaned local runner recovery 由 `:3881` 到 `:4007` 覆盖，
构造同主机 dead PID 并验证投影为 retryable pending、`retry_same_run_id`
且 status-json 不落盘。provider transient recovery 由 `:1661` 到 `:1778`、
`:1789` 到 `:1918`、`:1921` 到 `:2020` 和
`/Users/jin/projects/qmd_graphrag/test/integrations/contracts.test.ts:1414`
到 `:1480` 覆盖。non-transient schema/data compatibility failure 由
`/Users/jin/projects/qmd_graphrag/test/cli.test.ts:4009` 到 `:4205`、
`:4503` 到 `:4617` 和 `:6200` 到 `:6281` 覆盖。

结论：当前测试覆盖基准 10 要求的恢复场景。

## 总体结论

FAIL。

基准 3 的首次问题已部分修复：Markdown 架构文档、运行手册和 Type-DD 中的
`runner_ownership_rule` 已与 stale remote heartbeat 超 TTL 后恢复语义一致。
但 Type-DD 同一上下文仍保留 `running_ownership_rule` 的旧语义，排除了 remote
heartbeat 超 TTL 后恢复。该残留文档冲突不阻断真实 EPUB runtime closed loop，
但阻断本轮固定基准审计通过。
