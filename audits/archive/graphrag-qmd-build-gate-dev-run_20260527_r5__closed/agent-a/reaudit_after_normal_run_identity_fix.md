# normal run identity 修复后复审报告

## 范围

复审对象限定为 agent-c 上轮 FAIL 指出的正常写路径身份问题：

- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`

未读取或输出 `.env` secret。未修改业务代码。报告写入当前已打开审计目录：
`audit/graphrag-qmd-build-gate-dev-run_20260527_r5__open/agent-a/`。

轻量验证：

- `node --check scripts/graphrag/batch-checkpoint-hydration.mjs`：PASS。
- `node --check scripts/graphrag/batch-epub-workflow.mjs`：PASS。
- `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose
  --testTimeout 60000 test/cli.test.ts -t "normal run uses checkpoint
  identity after catalog drift"`：PASS，1 passed，206 skipped。

## 总体结论

结论：FAIL。

主干正常执行路径已基本修复。`loadCheckpoint`、主循环、`markItemRunning`、
`runItem`、completed save、普通 failure save 已经使用 checkpoint-derived
identity，`GraphRAG resume` 返回不同 `bookId` 时也会 fail closed。

但 normal write path 尚未完全收口。`applyProviderAuthReopenPass` 与
`eventProviderRecoveryWaitLimit` 仍把 discovery/catalog item 传入
`withBuildStatusSnapshot()` 或 `saveCheckpoint()`。由于 `saveCheckpoint()` 会用
传入 item 重新计算 `qmdBuildStatus` 与 `graphBuildStatus`，catalog/default
identity drift 下，持久 checkpoint 的核心身份字段可能仍是 checkpoint identity，
但证据快照会按 drift identity 重算。这违反本轮明确要求的 provider wait save
身份传播一致性。

## 固定 10 条审计基准与结论

### 1. Checkpoint 身份优先原则

状态：PASS。

基准：已存在 checkpoint 时，`sourceIdentityPath`、`sourceHash`、
`normalizedPath`、`bookId` 必须以 persisted checkpoint 为权威；catalog/default
只能作为 legacy 缺字段时的回退。

证据：

- `scripts/graphrag/batch-checkpoint-hydration.mjs:39` 到 `47` 的
  `checkpointIdentityFields()` 对四个身份字段优先取 checkpoint。
- `scripts/graphrag/batch-checkpoint-hydration.mjs:85` 到 `89`、
  `113` 到 `116`、`199` 到 `203` 的三条 hydration 返回分支均展开该 helper。
- `src/contracts/batch-run.ts:87` 到 `92` 将 checkpoint 的
  `sourceIdentityPath/sourceHash/normalizedPath/bookId` 定义为持久必需字段。

结论：hydration 层已避免 catalog/default bookId 或 normalizedPath 覆盖
checkpoint identity。

### 2. 证据 item 一致原则

状态：PASS。

基准：`status-json`、`migrate-only` 与普通 load path 对 existing checkpoint
重算 evidence 时，必须使用同一个 checkpoint-derived evidence item。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2167` 到 `2180` 的
  `evidenceItemForCheckpoint()` 从 checkpoint 取
  `sourceIdentityPath/sourceHash/bookId/normalizedPath`。
- `scripts/graphrag/batch-epub-workflow.mjs:2213` 到 `2222` 在
  `--migrate-only` 分支先 hydrate，再用 checkpoint-derived evidence item 执行
  completed downgrade。
- `scripts/graphrag/batch-epub-workflow.mjs:2238` 到 `2244` 在普通 load 分支使用
  同样的 checkpoint-derived evidence item。
- `scripts/graphrag/batch-epub-workflow.mjs:2245` 到 `2257` 在
  `--status-json` 与普通写回前都用 `checkpointEvidenceItem` 重新生成 build
  status snapshot。

结论：existing checkpoint 的只读投影、迁移投影和普通 load 投影在 load 阶段
语义一致。

### 3. 正常运行输入身份原则

状态：PASS。

基准：正常 `run/load/write` path 中实际执行 EPUB normalize、GraphRAG resume、
qmd CLI checks 的 runtime item 必须从 checkpoint identity 派生。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2187` 到 `2194` 的
  `runtimeItemForCheckpoint()` 将 checkpoint-derived `normalizedPath` 转为运行时
  absolute path，并同步 `normalizedRel`。
- `scripts/graphrag/batch-epub-workflow.mjs:5456` 到 `5458` 在每轮 item 处理时先
  以 checkpoint 构造 `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5660` 到 `5663` 在真正启动 item 前用
  `starting` checkpoint 重新构造 `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5688` 到 `5689` 将 `activeItem` 传给
  `markItemRunning()` 和 `runItem()`。
- `scripts/graphrag/batch-epub-workflow.mjs:4641` 到 `4646` 的 EPUB normalize
  使用传入 item 的 `sourcePath` 和 `normalizedPath`。
- `scripts/graphrag/batch-epub-workflow.mjs:4656` 到 `4665` 的 GraphRAG resume
  使用传入 item 的 `sourceIdentityPath` 与 `normalizedPath`。

结论：agent-c 上轮指出的主干 normal work 仍使用 discovery item 的问题已修复。

### 4. running checkpoint 写入原则

状态：PASS。

基准：`markItemRunning()` 持久化 running checkpoint 时，证据快照和核心身份必须
来自 checkpoint-derived runtime item。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5688` 传入
  checkpoint-derived `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5146` 到 `5153` 的
  `markItemRunning()` 读取并比较当前 checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:5166` 到 `5198` 用传入 item 调用
  `withBuildStatusSnapshot()` 并写入 running 状态。
- `scripts/graphrag/batch-epub-workflow.mjs:2261` 到 `2267` 的
  `withBuildStatusSnapshot()` 以传入 item 重算 qmd 与 GraphRAG evidence。

结论：主干 running 写入已依赖 `activeItem`，不再直接使用 discovery item。

### 5. GraphRAG resume fail-closed 原则

状态：PASS。

基准：resume runner 返回的 `bookId` 若与 checkpoint `bookId` 不一致，必须
fail closed，不得继续写 qmd manifest 或 completed checkpoint。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:4992` 到 `5005` 构造
  `resolvedItem` 时优先保留 checkpoint identity。
- `scripts/graphrag/batch-epub-workflow.mjs:5006` 到 `5014` 在
  `resumeResult.bookId !== checkpoint.bookId` 时抛出
  `GraphRAG resume book id mismatch`。
- `scripts/graphrag/batch-epub-workflow.mjs:5015` 到 `5030` 将 mismatch 投影为
  permanent、non-retryable、`stop_until_fixed` 的 command check。
- `scripts/graphrag/batch-epub-workflow.mjs:5032` 之后才执行 CLI checks 和 qmd
  build manifest，因此 mismatch 会在高成本完成证据写入前停止。

结论：resume bookId 与 checkpoint bookId 不一致时会 fail closed。

### 6. qmd manifest 与 completed evidence 同源原则

状态：PASS。

基准：正常完成路径中，qmd build manifest、qmd evidence、GraphRAG evidence 与
completed checkpoint 必须使用同一 checkpoint-derived `bookId/sourceHash/
normalizedPath`，不得出现高成本构建证据与持久 checkpoint 身份不一致。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:4994` 到 `5005` 的 `resolvedItem`
  使用 checkpoint 的 `sourceIdentityPath/sourceHash/normalizedPath/bookId`。
- `scripts/graphrag/batch-epub-workflow.mjs:5032` 到 `5036` 用 `resolvedItem`
  执行 CLI checks、写 qmd build manifest、重算 qmd 与 GraphRAG evidence。
- `scripts/graphrag/batch-epub-workflow.mjs:3369` 到 `3448` 的
  `writeQmdBuildManifest()` 将 `item.bookId`、`item.sourceHash` 与
  `relative(root, item.normalizedPath)` 写入 manifest。
- `scripts/graphrag/batch-epub-workflow.mjs:3451` 到 `3527` 的
  `qmdBuildEvidence()` 校验 manifest 的 runId、itemId、bookId、source path、
  source hash、normalized path/hash、qmd index、config 和 command fingerprint。
- `scripts/graphrag/batch-epub-workflow.mjs:5086` 到 `5108` 构造 completed 并用
  `saveCheckpoint(resolvedItem, completed)` 保存。
- `test/cli.test.ts:9480` 到 `9693` 的 focused regression 覆盖 catalog drift 后
  normal run 仍使用 checkpoint identity，且最终 checkpoint 不等于 drift bookId。

结论：主干 completed 写入路径已保持 manifest、evidence、checkpoint identity
一致。

### 7. failure save 身份传播原则

状态：PASS。

基准：正常运行失败、transient retry、provider recovery wait、local artifact gate
repair 等失败保存路径必须用 checkpoint-derived item 保存 checkpoint。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5517` 到 `5519` 在 local artifact gate
  repair 前构造 `activeItem`，并用 `saveCheckpoint(activeItem, repaired)` 保存。
- `scripts/graphrag/batch-epub-workflow.mjs:5568` 使用 `saveCheckpoint(activeItem,
  failed)` 保存 repair failure。
- `scripts/graphrag/batch-epub-workflow.mjs:5612` 到 `5615` 对 retryable failed
  checkpoint 先构造 `activeItem`，再保存 recovered checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:5636` 到 `5638` 对 exhausted pending
  transient checkpoint 同样使用 `activeItem` 保存。
- `scripts/graphrag/batch-epub-workflow.mjs:5697` 到 `5710` 在 normal catch 分支
  重新从 loaded running checkpoint 构造 `activeItem`，再保存 recoverable
  transient checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:5794` 与 `5900` 在 provider wait
  limit 单项失败和普通 failed 保存中使用 `activeItem`。

结论：正常命令失败保存主干已传播 checkpoint identity。

### 8. provider wait save 身份传播原则

状态：FAIL。

基准：provider auth reopen、provider recovery wait、provider wait limit 等正常
写入分支在保存 checkpoint 或重算 evidence snapshot 时，也必须使用
checkpoint-derived item，不得回退到 discovery/catalog item。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2280` 到 `2285` 的
  `saveCheckpoint(item, checkpoint)` 会使用传入 item 调用
  `withBuildStatusSnapshot(item, checkpoint)`。
- `scripts/graphrag/batch-epub-workflow.mjs:2261` 到 `2267` 显示 snapshot 会按
  传入 item 重算 `qmdBuildEvidence(item)` 与 `graphBuildEvidence(item)`。
- `scripts/graphrag/batch-epub-workflow.mjs:1279` 到 `1284` 的
  `applyProviderAuthReopenPass()` 遍历 discovery `items` 并取得 checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:1311` 到 `1338` 在 provider auth
  reopen 的 locked write callback 中直接使用 discovery `item` 调用
  `withBuildStatusSnapshot(item, reopenProviderAuthCheckpoint(item, current,
  currentDecision))`，未先构造 `runtimeItemForCheckpoint(item, current)`。
- `scripts/graphrag/batch-epub-workflow.mjs:5231` 到 `5253` 的
  `eventProviderRecoveryWaitLimit()` 同样从 discovery `items` 组合 checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:5254` 到 `5269` 构造 `updated`
  checkpoint 后调用 `saveCheckpoint(item, updated)`，未使用
  `runtimeItemForCheckpoint(item, checkpoint)`。
- `scripts/graphrag/batch-epub-workflow.mjs:5978` 到 `5981` 在正常运行末尾的
  provider wait limit 分支会调用 `eventProviderRecoveryWaitLimit(items,
  checkpoints)`，因此这是 normal write path。

影响：

catalog/default identity drift 已发生时，上述分支会保留 `updated` checkpoint 的
核心身份字段，但 `qmdBuildStatus` 与 `graphBuildStatus` 可能按 drift bookId 或
drift normalizedPath 重算并持久化。该问题不一定直接写出 `completed`，但违反
provider wait save 身份语义，并会让后续 status/migrate/normal projection 看到
混合身份的 evidence snapshot。

修复建议：

- 在 `applyProviderAuthReopenPass()` 的 locked callback 内，以最新 `current`
  checkpoint 构造 `const currentItem = runtimeItemForCheckpoint(item, current)`，
  并使用 `withBuildStatusSnapshot(currentItem,
  reopenProviderAuthCheckpoint(currentItem, current, currentDecision))`。
- 在 `eventProviderRecoveryWaitLimit()` 的每个 limited item 分支中构造
  `const activeItem = runtimeItemForCheckpoint(item, checkpoint)`，并改为
  `saveCheckpoint(activeItem, updated)`。
- 增加 catalog drift 下 provider auth reopen 与 provider wait limit 的 focused
  regressions，断言 checkpoint 核心身份与 evidence snapshot 的 `bookId`、
  `sourceHash`、`normalizedPath` 均来自 checkpoint。

### 9. status-json 与 migrate-only 边界原则

状态：PASS。

基准：`--status-json` 必须只做内存投影；`--migrate-only` 只能写迁移态与
checkpoint-derived evidence，不得执行 normal work 或使用 drift identity 重算
existing checkpoint。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1905` 到 `1912` 的
  `lockedReadWriteTypedJson()` 在 `statusJson` 下只执行 callback，不写文件。
- `scripts/graphrag/batch-epub-workflow.mjs:1915` 到 `1921` 的
  `writeTypedJson()` 在 `statusJson` 下只返回 parsed value。
- `scripts/graphrag/batch-epub-workflow.mjs:2222` 到 `2236` 的 migrate-only 写回
  使用 `checkpointEvidenceItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:2245` 到 `2257` 的 status-json 与
  普通 load 投影也使用 `checkpointEvidenceItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5391` 到 `5394` 在 `statusJson`
  下打印 summary 后返回。
- `scripts/graphrag/batch-epub-workflow.mjs:5395` 到 `5415` 的 migrate-only
  分支在迁移与 summary 后返回，不进入 normal `runItem()`。

结论：只读投影与迁移投影的 checkpoint identity 语义已收敛；失败点限于 C8 的
normal write provider 分支。

### 10. 回归覆盖与验证原则

状态：FAIL。

基准：本问题的回归覆盖必须覆盖 status-json、migrate-only、normal completed
write、resume mismatch fail-closed，以及 provider wait/reopen save 等身份写入
分支。

证据：

- `test/cli.test.ts:9247` 到 `9331` 覆盖 status-json 在 catalog drift 下保留
  persisted completed checkpoint identity。
- `test/cli.test.ts:9333` 到 `9478` 覆盖 status-json 按 persisted invalid book
  identity 降级，而不是使用 drift book evidence。
- `test/cli.test.ts:9480` 到 `9693` 覆盖 normal run 在 catalog drift 后使用
  checkpoint identity，并断言 resume 收到 persisted `sourceIdentityPath` 与
  `normalizedPath`。
- 已执行的 focused Vitest 用例
  `normal run uses checkpoint identity after catalog drift` 通过。
- 未发现覆盖 `applyProviderAuthReopenPass()` 在 catalog drift 下使用
  checkpoint-derived snapshot item 的测试。
- 未发现覆盖 `eventProviderRecoveryWaitLimit()` / provider wait limit save 在
  catalog drift 下使用 checkpoint-derived snapshot item 的测试。

结论：主干 normal completed 回归存在且通过，但 provider wait/reopen save 的身份
回归缺失，并对应 C8 的真实代码缺口。

## 阻断问题

### A1. Provider auth reopen 写回仍用 discovery item 重算 evidence snapshot

状态：FAIL。

位置：

- `scripts/graphrag/batch-epub-workflow.mjs:1279` 到 `1284`
- `scripts/graphrag/batch-epub-workflow.mjs:1311` 到 `1338`
- `scripts/graphrag/batch-epub-workflow.mjs:2261` 到 `2267`

问题：

provider auth reopen 是 normal write path。当前实现从 discovery `items` 取
`item`，在 locked callback 中直接调用 `withBuildStatusSnapshot(item, ...)`。
如果 existing checkpoint 的 `bookId/normalizedPath/sourceIdentityPath/sourceHash`
与 catalog/default discovery item 不同，写回 checkpoint 的 build status snapshot
会按 discovery identity 计算。

建议：

在 locked callback 内以最新 `current` 构造 checkpoint-derived runtime item：

```js
const currentItem = runtimeItemForCheckpoint(item, current);
return withBuildStatusSnapshot(
  currentItem,
  reopenProviderAuthCheckpoint(currentItem, current, currentDecision),
);
```

### A2. Provider recovery wait limit 批量保存仍用 discovery item

状态：FAIL。

位置：

- `scripts/graphrag/batch-epub-workflow.mjs:5231` 到 `5253`
- `scripts/graphrag/batch-epub-workflow.mjs:5254` 到 `5269`
- `scripts/graphrag/batch-epub-workflow.mjs:5978` 到 `5981`

问题：

normal run 末尾的 provider wait limit 分支会调用
`eventProviderRecoveryWaitLimit(items, checkpoints)`。该函数用 discovery item
组合 checkpoint，并以 `saveCheckpoint(item, updated)` 写回。由于
`saveCheckpoint()` 会按传入 item 重算 evidence snapshot，catalog drift 下会形成
checkpoint 核心身份与 evidence snapshot 来源不一致。

建议：

在保存前构造 active item：

```js
const activeItem = runtimeItemForCheckpoint(item, checkpoint);
saveCheckpoint(activeItem, updated);
```

同时增加 provider wait limit drift 回归，断言保存后的 `qmdBuildStatus.bookId`、
`graphBuildStatus` locator 与 checkpoint `bookId/normalizedPath` 对齐。

