# provider wait/auth identity 修复后复审报告

## 范围

复审对象限定为本轮要求的两个 normal write 保存点，以及它们与
normal run checkpoint identity 的一致性：

- `applyProviderAuthReopenPass()` 的 provider auth reopen 写回。
- `eventProviderRecoveryWaitLimit()` 的 provider recovery wait limit 写回。
- 上述路径与 `runtimeItemForCheckpoint()`、`withBuildStatusSnapshot()`、
  `saveCheckpoint()`、`markItemRunning()` 和 focused regression tests 的关系。

未新建 audit run。报告写入当前已打开审计目录：
`audit/graphrag-qmd-build-gate-dev-run_20260527_r5__open/agent-a/`。

未读取项目 `.env` secret，报告未输出 secret value。

## 轻量验证

- `node --check scripts/graphrag/batch-epub-workflow.mjs`：PASS。
- `node --check scripts/graphrag/batch-checkpoint-hydration.mjs`：PASS。
- `node --check src/contracts/batch-run.ts`：PASS。
- `git diff --check`：PASS。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 120000 test/cli.test.ts -t "normal run uses checkpoint
  identity after catalog drift|provider auth reopen preserves checkpoint
  identity during catalog drift|provider recovery wait limit preserves
  checkpoint identity during catalog drift"`：PASS，3 passed，206 skipped。

## 总体结论

结论：PASS。

上一轮 agent-a/agent-b FAIL 的两个阻断点已经修复。`applyProviderAuthReopenPass()`
在 locked write callback 内用最新 loaded checkpoint 派生 `activeItem`，并以同一
`activeItem` 调用 `withBuildStatusSnapshot()` 与
`reopenProviderAuthCheckpoint()`。`eventProviderRecoveryWaitLimit()` 在保存前用
`runtimeItemForCheckpoint(item, checkpoint)` 派生 `activeItem`，再调用
`saveCheckpoint(activeItem, updated)`。

当前实现保留 checkpoint-derived `sourceIdentityPath`、`sourceHash`、
`normalizedPath`、`bookId`，并让 qmd/GraphRAG evidence snapshot 基于同一身份。
`markItemRunning(item, ...)` 内部参数名 `item` 不是 discovery item 证据；调用点传入
的是 `activeItem`。

## 固定 10 条审计基准与结论

### 1. 完成状态闭环原则

状态：PASS。

基准：`completed` 只能由完整闭环证据产生。单个 item 必须同时满足 qmd build
manifest、GraphRAG build、GraphRAG query，以及固定 CLI command checks 全部成功，
才允许保持或写入 `completed`。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3667-3678` 的
  `downgradeCompletedIfClosedLoopInvalid()` 同时要求 `commandCheckStatus`、
  `qmdBuildStatus`、`graphBuildStatus`、`graphQueryStatus` 为 `succeeded`。
- `scripts/graphrag/batch-epub-workflow.mjs:4990-5109` 的 normal completed path 先
  执行 EPUB normalize、GraphRAG resume、CLI checks、qmd build manifest 与三类
  evidence 校验，再 `saveCheckpoint(resolvedItem, completed)`。
- `scripts/graphrag/batch-epub-workflow.mjs:1288-1339` 的 provider auth reopen 只
  将失败 checkpoint 重开为 `pending`；它不写 `completed`。
- `scripts/graphrag/batch-epub-workflow.mjs:5243-5272` 的 provider recovery wait
  limit 只保持 `pending` / `retry_same_run_id`，不写 `completed`。

结论：本轮两个保存点不会绕过 completed gate。normal run 的完成写入仍受闭环证据
约束。

### 2. 独立 qmd build 证据原则

状态：PASS。

基准：`qmdBuildStatus` 必须从当前书的
`books/<bookId>/qmd/qmd_build_manifest.json` 重新计算。不得把历史 checkpoint 字段、
CLI command checks，或导入的 completed seed 当作 qmd build 事实源。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2551-2556` 将 qmd build manifest 定位到
  `books/${item.bookId}/qmd/qmd_build_manifest.json`。
- `scripts/graphrag/batch-epub-workflow.mjs:3452-3539` 的 `qmdBuildEvidence(item)`
  读取 manifest 并校验 `runId`、`itemId`、`bookId`、`sourceHash`、
  `normalizedPath`、qmd index、config 和 command fingerprint。
- `scripts/graphrag/batch-epub-workflow.mjs:2262-2268` 的
  `withBuildStatusSnapshot(item, checkpoint)` 重新计算 `qmdBuildEvidence(item)`。
- `scripts/graphrag/batch-epub-workflow.mjs:1335-1339` 在 provider auth reopen
  写回时用 checkpoint-derived `activeItem` 触发 qmd evidence snapshot。
- `scripts/graphrag/batch-epub-workflow.mjs:5255-5271` 在 provider recovery wait
  limit 写回时用 checkpoint-derived `activeItem` 触发 qmd evidence snapshot。
- `test/cli.test.ts:3840-3846` 和 `test/cli.test.ts:6925-6931` 分别断言 provider
  wait limit、provider auth reopen 在 catalog drift 下保存的 `qmdBuildStatus`
  属于 persisted `bookId`。

结论：两个保存点不再用 discovery/catalog item 重算 qmd evidence。

### 3. 固定 command check 集合原则

状态：PASS。

基准：CLI command checks 必须使用稳定固定集合。集合大小、名称、唯一性和每项
`passed` 状态都必须校验；缺失、重复、未知名称或失败项均不得通过完成门。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:4930-4949` 的 `validateCommandChecks()`
  校验固定数量、名称唯一性、缺失项、未知项和失败项。
- `scripts/graphrag/batch-epub-workflow.mjs:3370-3383` 的
  `writeQmdBuildManifest()` 先以 `commandCheckSetEvidence()` 确认 command check
  集合成功。
- `scripts/graphrag/batch-epub-workflow.mjs:3587-3621` 的
  `commandCheckSetEvidence()` 对固定集合进行完成门计算。
- `test/cli.test.ts:10105-10107` 的 normal run identity 回归断言 completed
  checkpoint 的 command check 名称集合等于 `requiredBatchCommandCheckNames`。
- Provider auth reopen 在 `scripts/graphrag/batch-epub-workflow.mjs:1274-1275`
  清空旧 `commandChecks`，因此后续必须重新跑固定集合，不能沿用失败历史。

结论：本轮两个保存点没有放宽 command check 集合门；provider auth reopen 会强制后续
normal run 重建 command checks。

### 4. GraphRAG producer lineage 原则

状态：PASS。

基准：GraphRAG build 证据必须来自当前书的 succeeded stage checkpoint、artifact
manifest 和 producer manifest。stage runId、stage fingerprint、provider
fingerprint、content hash 和 artifact producer 必须一致。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3157-3177` 的 `graphBuildEvidence(item)`
  从 `books/${item.bookId}` 下读取 checkpoints、artifacts 和 producer manifest。
- `scripts/graphrag/batch-epub-workflow.mjs:3074-3079` 拒绝 stage checkpoint
  `bookId` 与当前 item 不一致的 evidence。
- `scripts/graphrag/batch-epub-workflow.mjs:3118-3124` 校验 stage checkpoint
  `runId` 与 producer lineage 一致。
- `scripts/graphrag/batch-epub-workflow.mjs:3232-3242` 校验 producer manifest 的
  `bookId`、`sourceHash`、document/content hash、provider fingerprint、
  `outputDir`、stage producer runId 和 stage fingerprint。
- `scripts/graphrag/batch-epub-workflow.mjs:1335-1339` 与
  `scripts/graphrag/batch-epub-workflow.mjs:5255-5271` 均用 checkpoint-derived
  `activeItem` 触发 `graphBuildEvidence(item)`。
- `test/cli.test.ts:3846-3852` 和 `test/cli.test.ts:6931-6937` 断言 provider
  wait/auth drift 回归中的 `graphBuildStatus` 不含 drift `bookId`，artifact IDs
  属于 persisted `bookId`。

结论：两个 provider 保存点的 GraphRAG evidence snapshot 已与 checkpoint identity
同源。

### 5. book-scoped artifact 隔离原则

状态：PASS。

基准：GraphRAG output 必须限定在 `books/<bookId>/output`。共享 output、host
absolute `outputDir`、跨书 artifact、realpath 越界或路径不匹配均不得发布 graph
capability 或支持 completed。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2547-2549` 固定 GraphRAG output locator
  为 `books/${item.bookId}/output`。
- `scripts/graphrag/batch-epub-workflow.mjs:3015-3021` 要求 stage artifacts 位于当前
  `item.bookId` 的 book-scoped output 下。
- `scripts/graphrag/batch-epub-workflow.mjs:3216-3240` 要求 producer manifest
  `outputDir` 等于当前 `item.bookId` 的 expected locator。
- `scripts/graphrag/batch-epub-workflow.mjs:2168-2181` 与
  `scripts/graphrag/batch-epub-workflow.mjs:2188-2195` 确保 provider 保存点使用的
  runtime item 继承 checkpoint `bookId` 与 `normalizedPath`。

结论：provider auth reopen 与 provider recovery wait limit 的 snapshot 不会改用
drift book-scoped output。

### 6. 旧 completed 重开原则

状态：PASS。

基准：加载旧 `completed` checkpoint 时必须重新计算闭环证据。任一证据缺失、陈旧或
失败时，checkpoint 必须降级为 `pending`，保留可恢复失败分类，并记录重开事件或在
只读模式中投影等价状态。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2168-2181` 的
  `evidenceItemForCheckpoint()` 对 `sourceIdentityPath`、`sourceHash`、`bookId`、
  `normalizedPath` 优先取 checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:2188-2195` 的
  `runtimeItemForCheckpoint()` 在运行态继续使用 checkpoint-derived identity。
- `scripts/graphrag/batch-epub-workflow.mjs:2214-2258` 在 load path 中 hydrate 后用
  checkpoint-derived evidence item 做 completed downgrade 与 snapshot 写回。
- `scripts/graphrag/batch-epub-workflow.mjs:3667-3735` 对 stale completed 降级为
  `pending` 并保存 qmd、GraphRAG、query、command check evidence。

结论：旧 completed 重新投影路径与本轮两个 provider 保存点使用同一
checkpoint-derived identity 模型。

### 7. migrate-only 审计迁移原则

状态：PASS。

基准：`--migrate-only` 只允许做 schema/manifest/checkpoint 迁移和可验证的路径规范化，
不得执行 EPUB、GraphRAG、provider、Jina 或 qmd CLI 子命令。缺少闭环证据的旧
completed 必须在迁移中重开，不能沿用旧完成计数。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2216-2237` 的 migrate-only load path 用
  `checkpointEvidenceItem` 重新生成 build status snapshot。
- `scripts/graphrag/batch-epub-workflow.mjs:5397-5417` 的 `migrateOnly` 分支写入迁移
  summary/event 后返回，不进入 normal processing loop。
- `scripts/graphrag/batch-epub-workflow.mjs:5427-5432` 的 provider auth reopen pass
  位于 migrate-only return 之后，因此 migrate-only 不会执行 provider auth reopen
  normal write。
- `scripts/graphrag/batch-epub-workflow.mjs:5982` 的 provider wait limit 分支同样在
  normal loop 内，migrate-only 不会执行。

结论：本轮修复没有扩大 migrate-only 行为边界。

### 8. status-json 只读投影原则

状态：PASS。

基准：`--status-json` 必须只输出状态投影。它可以在内存中投影 stale completed、
provider auth reopen、orphan running 等恢复决策，但不得写 manifest、checkpoint、
event log、log 文件或迁移 producer manifest。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1906-1913` 的
  `lockedReadWriteTypedJson()` 在 `statusJson` 下只执行 callback，不落盘。
- `scripts/graphrag/batch-epub-workflow.mjs:1916-1922` 的 `writeTypedJson()` 在
  `statusJson` 下只返回 parsed value，不写文件。
- `scripts/graphrag/batch-epub-workflow.mjs:1837-1841` 的 `event()` 在 `statusJson`
  下不写 event log。
- `scripts/graphrag/batch-epub-workflow.mjs:5391-5395` 在 `statusJson` 下打印 summary
  后返回，不进入 provider auth reopen 或 provider wait limit normal writes。

结论：本轮两个保存点只影响 normal write path，不破坏 `--status-json` 只读边界。

### 9. provider auth 恢复安全原则

状态：PASS。

基准：provider auth stop checkpoint 只在当前 provider context ready、fingerprint
已变化、未超过重开上限且未重复使用当前 fingerprint 时重开。输出只能包含
present/missing/source/fingerprint/redacted 级别信息，不得暴露密钥值。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:902-971` 的 `providerAuthContext()` 只
  生成 readiness、fingerprint、presence、source 和 dotenv present 状态。
- `scripts/graphrag/batch-epub-workflow.mjs:1031-1104` 的
  `providerAuthReopenDecision()` 要求 provider auth failure candidate、context
  ready、fingerprint 已变化、未超 attempt limit，且当前 fingerprint 未重复使用。
- `scripts/graphrag/batch-epub-workflow.mjs:1188-1276` 的
  `reopenProviderAuthCheckpoint()` 只重开为 `pending`，设置恢复元数据并清空旧
  command checks。
- `scripts/graphrag/batch-epub-workflow.mjs:1335-1339` 在 locked callback 内用
  `runtimeItemForCheckpoint(item, current)` 得到 `activeItem`，并以 `activeItem`
  调用 `withBuildStatusSnapshot()` 和 `reopenProviderAuthCheckpoint()`。
- `scripts/graphrag/batch-epub-workflow.mjs:1795-1805` 只把 dotenv value 注册进内存
  exact redaction map；报告未输出 secret value。
- `test/cli.test.ts:6690-6937` 覆盖 provider auth reopen 在 catalog drift 下仍保存
  checkpoint identity 与 persisted evidence identity。

结论：provider auth reopen 的身份修复满足安全恢复边界，未发现 secret 输出路径。

### 10. 恢复语义保持原则

状态：PASS。

基准：transient provider/network failure 应保留同一 runId 的恢复语义，包括
`retry_same_run_id`、bounded wait、`nextRetryAt` 和可恢复 pending 状态。非 transient
或本地证据缺失不得被误标为 completed，也不得错误设置为终止态来阻断补跑。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5232-5240` 只把 `pending`、`retryable`、
  `failureKind=transient`、`waitingForProviderRecovery=true` 且 wait 不可用的
  checkpoint 纳入 recovery wait limit。
- `scripts/graphrag/batch-epub-workflow.mjs:5243-5272` 的
  `eventProviderRecoveryWaitLimit()` 保持 `status: "pending"`、
  `retryExhausted: false`、`recoveryDecision: "retry_same_run_id"`，并用
  `saveCheckpoint(activeItem, updated)` 保存。
- `scripts/graphrag/batch-epub-workflow.mjs:5750-5821` 的单项 provider wait limit
  失败分支也保存为 `pending`、`retry_same_run_id`，并记录 bounded wait metadata。
- `test/cli.test.ts:3695-3852` 覆盖 provider recovery wait limit 在 catalog drift
  下保留 persisted checkpoint identity、`pending` 状态和 GraphRAG/qmd evidence
  identity。
- `test/cli.test.ts:9895-10107` 覆盖 normal run 在 catalog drift 下使用 checkpoint
  identity，并完成闭环后写入 persisted `bookId`。

结论：provider recovery wait limit 修复后继续保持同 run recovery semantics，并避免
drift evidence snapshot。

## 针对上轮两个阻断点的收口

### A1. Provider auth reopen 写回不能用 discovery item 重算 evidence

状态：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1311-1315` 在 locked write callback 内取
  latest loaded checkpoint `current`。
- `scripts/graphrag/batch-epub-workflow.mjs:1328-1334` 在锁内重新计算
  `currentDecision`，防止锁外 decision 过期。
- `scripts/graphrag/batch-epub-workflow.mjs:1335` 用
  `runtimeItemForCheckpoint(item, current)` 派生 `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:1336-1339` 用同一个 `activeItem` 调用
  `withBuildStatusSnapshot()` 和 `reopenProviderAuthCheckpoint()`。
- `test/cli.test.ts:6925-6937` 断言保存后的 checkpoint 为 persisted `bookId`、
  `sourceIdentityPath`、`normalizedPath`，`qmdBuildStatus.bookId` 为 persisted
  `bookId`，`graphBuildStatus` 不含 drift `bookId`。

结论：已修复。

### A2. Provider recovery wait limit 写回不能用 discovery item 重算 evidence

状态：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5243-5252` 从 candidates 中选择符合
  provider recovery wait limit 的 checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:5255` 用
  `runtimeItemForCheckpoint(item, checkpoint)` 派生 `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5256-5270` 的 `updated` checkpoint 保留
  原 checkpoint 字段，仅更新 recovery wait metadata。
- `scripts/graphrag/batch-epub-workflow.mjs:5271` 用
  `saveCheckpoint(activeItem, updated)` 保存。
- `test/cli.test.ts:3840-3852` 断言保存后的 checkpoint 为 persisted `bookId`、
  `sourceIdentityPath`、`normalizedPath`，`qmdBuildStatus.bookId` 为 persisted
  `bookId`，`graphBuildStatus` 不含 drift `bookId`。

结论：已修复。

## 参数名 `item` 的误判排除

`markItemRunning(item, ...)` 内部参数名 `item` 不能按字符串视为 discovery item。
当前 normal run 调用点先以 `runtimeItemForCheckpoint(item, starting)` 派生
`activeItem`，再调用 `markItemRunning(activeItem, starting, checkpoints,
manifest)`。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5663-5665` 以 `starting` checkpoint 派生
  `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5690-5691` 将 `activeItem` 传给
  `markItemRunning()` 和 `runItem()`。
- `scripts/graphrag/batch-epub-workflow.mjs:5147-5168` 的 `markItemRunning()`
  使用参数 `item` 调用 `itemPath()` 与 `withBuildStatusSnapshot()`；该参数在上述
  调用点实际为 `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:2090-2091` 的 `itemPath(item)` 只依赖
  `itemId`，不会把 evidence identity 重新绑定到 discovery fields。

结论：无误判风险。

## 测试覆盖结论

状态：PASS。

证据：

- `test/cli.test.ts:3695-3852` 覆盖 provider recovery wait limit 在 catalog drift
  下的 checkpoint identity 与 qmd/GraphRAG evidence identity。
- `test/cli.test.ts:6690-6937` 覆盖 provider auth reopen 在 catalog drift 下的
  checkpoint identity 与 qmd/GraphRAG evidence identity。
- `test/cli.test.ts:9895-10107` 覆盖 normal run 在 catalog drift 下的 checkpoint
  identity、resume 参数、completed checkpoint identity 与 command check 集合。

说明：两条 provider drift regression 对 `sourceHash` 的覆盖主要来自 evidence success
路径的结构性校验（structural validation）。同一 `itemId` 场景下 source hash 通常不
发生 catalog drift；实现层仍通过 `evidenceItemForCheckpoint()` 保留 checkpoint
`sourceHash`，并由 qmd/GraphRAG evidence mismatch gates 校验。
