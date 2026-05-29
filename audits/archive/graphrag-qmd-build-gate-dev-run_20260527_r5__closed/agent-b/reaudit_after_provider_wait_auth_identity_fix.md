# r5 agent-b provider wait/auth identity 修复复审报告

## 范围与方法

复审范围限定为两个上一轮阻断保存点及其与 normal run checkpoint identity
的一致性：

- `applyProviderAuthReopenPass()` provider auth reopen 写回。
- `eventProviderRecoveryWaitLimit()` provider recovery wait-limit 写回。
- 两条保存路径与 normal run checkpoint-derived identity 的一致性。
- 新增 catalog drift 回归是否覆盖 provider auth reopen 与 provider recovery wait
  limit 的 evidence identity。

未新建 audit run。未修改业务代码。未读取或输出 `.env` secret。报告写入既有
审计目录的 `agent-b` 子目录。

轻量验证：

- PASS: `node --check scripts/graphrag/batch-epub-workflow.mjs`
- PASS: `node --check scripts/graphrag/batch-checkpoint-hydration.mjs`
- PASS: `git diff --check`
- PASS: `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot
  --testTimeout 120000 test/cli.test.ts -t "normal run uses checkpoint identity
  after catalog drift|provider auth reopen preserves checkpoint identity during
  catalog drift|provider recovery wait limit preserves checkpoint identity during
  catalog drift"`，结果为 3 passed、206 skipped。

## 总体结论

PASS。

上一轮 agent-b FAIL 的两个阻断点已经收口：

1. `applyProviderAuthReopenPass()` 在 locked write callback 内用
   `runtimeItemForCheckpoint(item, current)` 派生 `activeItem`，并用
   `activeItem` 同时调用 `withBuildStatusSnapshot()` 与
   `reopenProviderAuthCheckpoint()`。因此 reopen 写回不再用 discovery item 重算
   `qmdBuildStatus` 或 `graphBuildStatus`。
2. `eventProviderRecoveryWaitLimit()` 在保存前用
   `runtimeItemForCheckpoint(item, checkpoint)` 派生 `activeItem`，随后调用
   `saveCheckpoint(activeItem, updated)`。因此 wait-limit 写回不再用 discovery
   item 重算 build evidence。

这两条路径保留 checkpoint-derived `sourceIdentityPath`、`sourceHash`、
`normalizedPath`、`bookId`，且 qmd/GraphRAG evidence snapshot 基于同一身份重算。
新增回归在 catalog drift 下覆盖了 provider auth reopen、provider recovery wait
limit 与 normal run 三条关键路径。未发现本复审范围内的残余阻断。

## 固定 10 条审计基准

### C1. 独立 qmd 构建证据

结论：PASS。

基准：`qmdBuildStatus` 必须从
`books/<bookId>/qmd/qmd_build_manifest.json` 重新计算，不得信任 checkpoint 中
持久化的旧字段。

证据：

- `withBuildStatusSnapshot()` 每次按传入 item 调用 `qmdBuildEvidence(item)` 覆盖
  `qmdBuildStatus`：`scripts/graphrag/batch-epub-workflow.mjs:2262` 至
  `2268`。
- qmd evidence locator 来自 `item.bookId`：
  `scripts/graphrag/batch-epub-workflow.mjs:2551` 至 `2556`。
- `qmdBuildEvidence()` 读取 qmd build manifest，并校验 `runId`、`itemId`、
  `bookId`、`sourceRelativePath`、`sourceHash`、`normalizedPath`、qmd index、
  config 和 command check fingerprint：
  `scripts/graphrag/batch-epub-workflow.mjs:3452` 至 `3539`。
- 两个目标保存点现在传入 checkpoint-derived `activeItem`，因此 qmd evidence
  重算使用 checkpoint `bookId/normalizedPath`：
  `scripts/graphrag/batch-epub-workflow.mjs:1335` 至 `1339`、
  `5255` 至 `5271`。

### C2. 固定命令检查集合

结论：PASS。

基准：`commandCheckStatus` 必须从固定 qmd CLI 子命令集合重新计算。缺失、重复、
意外或失败检查均不得通过完成门。

证据：

- `commandCheckSetEvidence()` 要求总数、唯一名称、缺失项、意外项和失败项全部满足
  固定集合要求才返回 `succeeded`：
  `scripts/graphrag/batch-epub-workflow.mjs:3587` 至 `3621`。
- `validateCommandChecks()` 在 normal run 中再次要求 command check 集合完整：
  `scripts/graphrag/batch-epub-workflow.mjs:4930` 至 `4948`。
- `writeQmdBuildManifest()` 写 qmd manifest 前要求 command check evidence 成功：
  `scripts/graphrag/batch-epub-workflow.mjs:3370` 至 `3383`。
- normal run catalog drift 回归断言最终 checkpoint 的 command check 名称等于固定
  required set：`test/cli.test.ts:10105` 至 `10107`。

### C3. 闭环完成门

结论：PASS。

基准：只有 qmd build、GraphRAG build、GraphRAG query 和全部命令检查同时成功，
单书 checkpoint 才能写入 `completed`。

证据：

- `downgradeCompletedIfClosedLoopInvalid()` 同时检查 command check、qmd build、
  GraphRAG build、GraphRAG query；任一不成功都会 reopen completed checkpoint：
  `scripts/graphrag/batch-epub-workflow.mjs:3667` 至 `3737`。
- `runItem()` 在 normal run 中先写 qmd manifest，再重算 qmd、GraphRAG build 和
  GraphRAG query evidence；任一不成功均抛出失败，不写 completed：
  `scripts/graphrag/batch-epub-workflow.mjs:5033` 至 `5086`。
- `runItem()` 只有在三类 evidence 均成功后才构造 `status: "completed"` 并保存：
  `scripts/graphrag/batch-epub-workflow.mjs:5087` 至 `5110`。
- normal run catalog drift 回归断言 completed checkpoint 同时具有 succeeded
  qmd、GraphRAG build、GraphRAG query evidence：
  `test/cli.test.ts:10090` 至 `10104`。

### C4. 旧完成状态降级

结论：PASS。

基准：`--migrate-only`、`--status-json` 和正式运行都不得信任旧 `completed`。
闭环证据无效时必须 reopen，证据缺口不得被写成停止态 retry exhaustion。

证据：

- `loadCheckpoint()` 对已有 checkpoint 先 hydrate，再调用
  `downgradeCompletedIfClosedLoopInvalid()`，并按 checkpoint-derived evidence item
  重算 evidence：`scripts/graphrag/batch-epub-workflow.mjs:2214` 至 `2258`。
- `downgradeCompletedIfClosedLoopInvalid()` 在闭环证据不全时将 completed 改为
  `pending`，并设置 `recoveryDecision`，不是写成不可恢复 exhaustion：
  `scripts/graphrag/batch-epub-workflow.mjs:3686` 至 `3737`。
- provider auth reopen 与 provider recovery wait-limit 两个目标保存点均不把
  evidence 缺口写成 completed；reopen 写成 pending，wait-limit 保持 pending：
  `scripts/graphrag/batch-epub-workflow.mjs:1254` 至 `1276`、
  `5256` 至 `5271`。

### C5. checkpoint 身份保留

结论：PASS。

基准：已存在 checkpoint 的证据重算必须优先使用 checkpoint 实际 `bookId` 和
`normalizedPath`，避免 catalog drift 造成误 pending、误 stale 或误成功。

证据：

- hydration helper 优先保留 checkpoint 的 `sourceIdentityPath`、`sourceHash`、
  `normalizedPath`、`bookId`：
  `scripts/graphrag/batch-checkpoint-hydration.mjs:39` 至 `47`。
- runtime schema 要求 checkpoint 持久化四个身份字段：
  `src/contracts/batch-run.ts:82` 至 `92`。
- `evidenceItemForCheckpoint()` 从 checkpoint 投影四个身份字段：
  `scripts/graphrag/batch-epub-workflow.mjs:2168` 至 `2181`。
- `runtimeItemForCheckpoint()` 基于 checkpoint evidence item 派生 runtime item，并把
  checkpoint `normalizedPath` 解析为可执行路径：
  `scripts/graphrag/batch-epub-workflow.mjs:2188` 至 `2195`。
- provider auth reopen 保存点在 lock 内用 `runtimeItemForCheckpoint(item, current)`
  派生 `activeItem`，再用 `activeItem` 重算 build snapshot：
  `scripts/graphrag/batch-epub-workflow.mjs:1335` 至 `1339`。
- provider recovery wait-limit 保存点用
  `runtimeItemForCheckpoint(item, checkpoint)` 后
  `saveCheckpoint(activeItem, updated)`：
  `scripts/graphrag/batch-epub-workflow.mjs:5255` 至 `5271`。

### C6. GraphRAG 书级产物隔离

结论：PASS。

基准：GraphRAG 产物和 producer manifest 必须限定在
`books/<bookId>/output`。共享输出、host absolute locator 和跨书产物必须 fail
closed。

证据：

- GraphRAG output locator 固定为 `books/${bookId}/output`：
  `scripts/graphrag/batch-epub-workflow.mjs:2547` 至 `2548`。
- `graphBuildEvidence(item)` 从 `stateRoot/books/${item.bookId}` 读取 stage
  checkpoint、artifact catalog 和 producer manifest：
  `scripts/graphrag/batch-epub-workflow.mjs:3157` 至 `3177`。
- GraphRAG producer manifest 必须匹配 `item.bookId`、`item.sourceHash`、
  content hash、provider fingerprint 和 `books/<bookId>/output`：
  `scripts/graphrag/batch-epub-workflow.mjs:3216` 至 `3261`。
- provider auth reopen catalog drift 回归断言 `graphBuildStatus.artifactIds` 全部包含
  persisted `bookId`，且不包含 drift `bookId`：
  `test/cli.test.ts:6933` 至 `6937`。
- provider recovery wait-limit catalog drift 回归执行同类断言：
  `test/cli.test.ts:3848` 至 `3852`。

### C7. GraphRAG producer lineage 对齐

结论：PASS。

基准：GraphRAG build 成功必须要求 stage checkpoint、artifact `producerRunId`、
stage fingerprint、provider fingerprint、内容身份和
`qmd_output_manifest.json` producer lineage 一致。

证据：

- `graphBuildEvidence()` 为每个 completion stage 调用
  `validateGraphStageEvidence()`，传入 stage fingerprint、provider fingerprint、
  corpus content hash 和 stage producer run id：
  `scripts/graphrag/batch-epub-workflow.mjs:3184` 至 `3214`。
- producer manifest 必须含有完整 stage producer run ids，且与对应 stage checkpoint
  `runId` 对齐：
  `scripts/graphrag/batch-epub-workflow.mjs:3218` 至 `3226`。
- producer stage fingerprints 必须存在并匹配 expected fingerprints：
  `scripts/graphrag/batch-epub-workflow.mjs:3227` 至 `3231`。
- 若 job、producer、book identity、source hash、content hash、provider fingerprint、
  output locator、stage producer run 或 fingerprint 不匹配，GraphRAG evidence 返回
  `stale`：
  `scripts/graphrag/batch-epub-workflow.mjs:3232` 至 `3261`。

### C8. provider transient 恢复投影

结论：PASS。

基准：transient provider/network failure 必须保留同一 `runId` 恢复能力，保留
retry/wait metadata，并在 summary 中清晰投影恢复状态。

证据：

- provider recovery wait-limit 只处理 `pending`、`retryable: true`、
  `failureKind: "transient"`、`waitingForProviderRecovery: true` 且等待次数已达上限
  的 checkpoint：`scripts/graphrag/batch-epub-workflow.mjs:5243` 至 `5253`。
- wait-limit 写回保留 pending retry_same_run_id，并写入
  `providerRecoveryWaitLimitReached`、wait count、max waits、retry budget：
  `scripts/graphrag/batch-epub-workflow.mjs:5256` 至 `5271`。
- recovery summary 对 waiting provider recovery 投影 wait count、max waits、reason
  和 retry metadata：
  `scripts/graphrag/batch-epub-workflow.mjs:3959` 至 `4037`。
- wait-limit catalog drift 回归断言保存后的 checkpoint 仍为 pending、transient、
  retryable、`retry_same_run_id`，并保留 provider wait metadata：
  `test/cli.test.ts:3840` 至 `3852`。

### C9. 旧 provider auth 失败恢复

结论：PASS。

基准：provider auth stop 必须基于当前 readiness、presence、source 和 fingerprint
投影 `--migrate-only` 与 `--status-json` 恢复状态；不得输出原始密钥值。

证据：

- provider auth reopen 决策基于 candidate 条件、当前 provider auth context、
  failure fingerprint、current fingerprint、attempt count 和 readiness：
  `scripts/graphrag/batch-epub-workflow.mjs:1279` 至 `1309`、
  `1328` 至 `1334`。
- provider auth reopen 写回记录 reopen decision、fingerprint、attempt count、
  readiness metadata，并清除 failed 状态回到 pending：
  `scripts/graphrag/batch-epub-workflow.mjs:1188` 至 `1276`。
- reopen 写回现在在 lock 内使用 checkpoint-derived `activeItem`：
  `scripts/graphrag/batch-epub-workflow.mjs:1335` 至 `1339`。
- provider auth repair 回归断言 serialized checkpoint/events/summary 不包含测试
  credential value：
  `test/cli.test.ts:6685` 至 `6687`。
- provider auth reopen catalog drift 回归断言 reopened checkpoint 保留 persisted
  `bookId/sourceIdentityPath/normalizedPath`，qmd evidence 使用 persisted book，GraphRAG
  artifact ids 不含 drift book：
  `test/cli.test.ts:6925` 至 `6937`。

### C10. 契约、文档和回归一致性

结论：PASS。

基准：runtime schema、操作文档和 focused regression 必须表达与实现相同的不变量。

证据：

- checkpoint contract 要求 `sourceIdentityPath`、`sourceHash`、`normalizedPath`、
  `bookId`：
  `src/contracts/batch-run.ts:82` 至 `92`。
- workflow checkpoint schema 同样要求四个身份字段：
  `scripts/graphrag/batch-epub-workflow.mjs:421` 至 `424`。
- 新增 provider recovery wait-limit drift 回归构造 persisted identity 与 drift
  catalog，并断言保存后 checkpoint/evidence 仍使用 persisted identity：
  `test/cli.test.ts:3695` 至 `3852`。
- 新增 provider auth reopen drift 回归构造 persisted identity 与 drift catalog，并断言
  reopen 写回 checkpoint/evidence 仍使用 persisted identity：
  `test/cli.test.ts:6690` 至 `6937`。
- normal run catalog drift 回归断言 resume runner 收到 persisted
  `sourceIdentityPath/normalizedPath`，最终 completed checkpoint 仍使用 persisted
  `bookId`：
  `test/cli.test.ts:9895` 至 `10108`。

## 目标保存点复审结论

### `applyProviderAuthReopenPass()`

结论：PASS。

`lockedReadWriteTypedJson()` callback 内的 `item` 仍来自 discovery item，但它只用于
`itemPath(item)` 定位 checkpoint 文件；`itemPath()` 仅依赖 `item.itemId`，不是 identity
evidence 来源：`scripts/graphrag/batch-epub-workflow.mjs:2090` 至 `2092`、
`1311` 至 `1314`。

关键写回已经改为：

- `current = loaded ?? checkpoint` 后重新判定 reopen eligibility：
  `scripts/graphrag/batch-epub-workflow.mjs:1315` 至 `1334`。
- `activeItem = runtimeItemForCheckpoint(item, current)`：
  `scripts/graphrag/batch-epub-workflow.mjs:1335`。
- `withBuildStatusSnapshot(activeItem, reopenProviderAuthCheckpoint(activeItem,
  current, currentDecision))`：
  `scripts/graphrag/batch-epub-workflow.mjs:1336` 至 `1339`。

因此 `reopenProviderAuthCheckpoint()` event metadata 与保存 snapshot 使用同一
checkpoint-derived identity。

### `eventProviderRecoveryWaitLimit()`

结论：PASS。

该分支仍从 discovery `items` 构造 `{ item, checkpoint }`，但保存前已显式派生
checkpoint-derived active item：

- wait-limit candidate filter 只筛选 pending transient provider recovery checkpoint：
  `scripts/graphrag/batch-epub-workflow.mjs:5243` 至 `5253`。
- 保存前执行 `const activeItem = runtimeItemForCheckpoint(item, checkpoint)`：
  `scripts/graphrag/batch-epub-workflow.mjs:5255`。
- 写回执行 `saveCheckpoint(activeItem, updated)`：
  `scripts/graphrag/batch-epub-workflow.mjs:5271`。
- `saveCheckpoint()` 会用传入 item 调用 `withBuildStatusSnapshot(item,
  checkpoint)`：
  `scripts/graphrag/batch-epub-workflow.mjs:2281` 至 `2286`。

因此 wait-limit 写盘 evidence snapshot 使用 checkpoint-derived
`bookId/sourceHash/normalizedPath`，不再使用 discovery drift item。

## 残余风险

未发现本复审范围内的阻断风险。

一个非阻断实现细节是 `eventProviderRecoveryWaitLimit()` 在写盘后执行
`checkpoints.set(item.itemId, updated)`，未使用 `saveCheckpoint()` 的返回值：
`scripts/graphrag/batch-epub-workflow.mjs:5271` 至 `5272`。本项不构成本次 FAIL：
`updated` 由已 hydrate 的 checkpoint 展开而来，仍保留 checkpoint 顶层 identity；后续
`buildRecoverySummary()` 也按传入 checkpoint 的 `bookId/sourceHash/normalizedPath`
重新计算 evidence：`scripts/graphrag/batch-epub-workflow.mjs:3959` 至 `3983`。
