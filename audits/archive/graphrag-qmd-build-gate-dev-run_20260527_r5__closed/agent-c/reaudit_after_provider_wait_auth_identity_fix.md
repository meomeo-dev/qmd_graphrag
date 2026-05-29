# provider wait/auth identity 修复后复审报告

## 范围

复审范围限定为上一轮 FAIL 的两个正常写入保存点：

- `applyProviderAuthReopenPass()` provider auth reopen 写回。
- `eventProviderRecoveryWaitLimit()` provider recovery wait limit 写回。

同时检查这两个保存点与 normal run checkpoint identity 的一致性。未读取或输出
`.env` secret。未修改业务代码。未创建新的 audit run；本报告写入当前已打开审计
目录 `audit/graphrag-qmd-build-gate-dev-run_20260527_r5__open/agent-c/`。

轻量验证：

- PASS: `node --check scripts/graphrag/batch-epub-workflow.mjs`。
- PASS: `node --check scripts/graphrag/batch-checkpoint-hydration.mjs`。
- PASS: `node --check src/contracts/batch-run.ts`。
- PASS: `git diff --check -- scripts/graphrag/batch-epub-workflow.mjs
  test/cli.test.ts scripts/graphrag/batch-checkpoint-hydration.mjs
  src/contracts/batch-run.ts`。
- PASS: `CI=true node ./node_modules/vitest/vitest.mjs run
  --reporter=verbose --testTimeout 120000 test/cli.test.ts -t
  "normal run uses checkpoint identity after catalog drift|provider auth reopen
  preserves checkpoint identity during catalog drift|provider recovery wait limit
  preserves checkpoint identity during catalog drift"`，结果为 3 passed、206 skipped。

## 总体结论

总体结论：PASS。

上一轮 agent-a/agent-b/agent-c 指出的两个阻断点已收口。provider auth reopen
锁内写回现在先用 `runtimeItemForCheckpoint(item, current)` 生成 active item，再用
active item 调用 `reopenProviderAuthCheckpoint()` 和 `withBuildStatusSnapshot()`。
provider recovery wait limit 批量出口现在先用
`runtimeItemForCheckpoint(item, checkpoint)` 生成 active item，再调用
`saveCheckpoint(activeItem, updated)`。

这两个保存点不再用 discovery/catalog item 重算 `qmdBuildStatus` 或
`graphBuildStatus`。在 catalog drift 下，checkpoint 顶层
`sourceIdentityPath/sourceHash/normalizedPath/bookId` 与 qmd/GraphRAG evidence
snapshot 均保持 checkpoint-derived identity。

## 固定 10 条审计基准与结论

### 1. Checkpoint 身份优先原则

结论：PASS。

基准：已有 checkpoint 的 `sourceIdentityPath`、`sourceHash`、`normalizedPath`、
`bookId` 必须优先来自 persisted checkpoint；catalog/default 只能作为 legacy
缺字段回退。

证据：

- `scripts/graphrag/batch-checkpoint-hydration.mjs:39` 到 `47` 的
  `checkpointIdentityFields()` 对四个身份字段均优先取 checkpoint。
- `scripts/graphrag/batch-checkpoint-hydration.mjs:85` 到 `88`、`112` 到
  `115`、`199` 到 `202` 的 hydration 返回分支均展开同一 helper。
- `src/contracts/batch-run.ts:82` 到 `92` 将
  `sourceIdentityPath/sourceHash/normalizedPath/bookId` 定义为 checkpoint 持久
  schema 的必需字段。

结论：复审目标保存点接收的 checkpoint 已在 hydration 层保留 persisted identity。

### 2. Evidence item 派生一致原则

结论：PASS。

基准：所有基于 checkpoint 重算 qmd/GraphRAG evidence 的路径必须先从 checkpoint
派生 evidence item，不得直接使用 discovery/catalog drift identity。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2168` 到 `2181` 的
  `evidenceItemForCheckpoint()` 从 checkpoint 投影 `sourceIdentityPath`、
  `sourceHash`、`bookId`、`normalizedPath`，缺失时才回退到 item。
- `scripts/graphrag/batch-epub-workflow.mjs:2188` 到 `2195` 的
  `runtimeItemForCheckpoint()` 基于 evidence item 构造运行时 item，并把
  checkpoint `normalizedPath` 转为绝对路径与 `normalizedRel`。
- `scripts/graphrag/batch-epub-workflow.mjs:2262` 到 `2268` 的
  `withBuildStatusSnapshot()` 使用传入 item 重新计算 qmd、GraphRAG build、
  GraphRAG query evidence；因此调用方已改为 active item 是关键修复点。

结论：本轮两个保存点都接入了 checkpoint-derived item。

### 3. Provider auth reopen 锁内 active item 原则

结论：PASS。

基准：`applyProviderAuthReopenPass()` 必须在 locked write callback 内基于当前
loaded checkpoint 生成 active item，并用 active item 执行 reopen 与 snapshot。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1311` 到 `1327` 在
  `lockedReadWriteTypedJson()` 内重新读取 checkpoint，并比较 status、attempts、
  failedAt、recoveryDecision、runnerSessionId、runnerHeartbeatAt，避免并发重复
  reopen。
- `scripts/graphrag/batch-epub-workflow.mjs:1328` 到 `1334` 在锁内对 `current`
  重新计算 provider auth reopen decision。
- `scripts/graphrag/batch-epub-workflow.mjs:1335` 到 `1339` 在锁内执行
  `const activeItem = runtimeItemForCheckpoint(item, current)`，并用 active item
  调用 `reopenProviderAuthCheckpoint(activeItem, current, currentDecision)` 与
  `withBuildStatusSnapshot(activeItem, ...)`。
- `scripts/graphrag/batch-epub-workflow.mjs:1188` 到 `1276` 的
  `reopenProviderAuthCheckpoint()` 只展开原 checkpoint 并改写 pending/reopen
  metadata，不重新从 discovery item 派生核心身份字段。

结论：provider auth reopen 写回已消除 discovery item 重算 evidence 的残留。

### 4. Provider recovery wait limit active item 原则

结论：PASS。

基准：`eventProviderRecoveryWaitLimit()` 在保存 wait-limit checkpoint 前必须调用
`runtimeItemForCheckpoint(item, checkpoint)`，随后 `saveCheckpoint(activeItem,
updated)`。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5243` 到 `5252` 仅筛选符合
  provider recovery wait limit 的 pending checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:5254` 到 `5271` 在每个 limited item
  中先生成 `activeItem = runtimeItemForCheckpoint(item, checkpoint)`，再构造
  `updated` 并调用 `saveCheckpoint(activeItem, updated)`。
- `scripts/graphrag/batch-epub-workflow.mjs:2281` 到 `2286` 的
  `saveCheckpoint()` 会用传入 item 触发 `withBuildStatusSnapshot()`；当前调用点
  已传入 active item。

结论：provider recovery wait limit 写回不再用 discovery item 重算 qmd/GraphRAG
evidence。

### 5. 核心身份字段保留原则

结论：PASS。

基准：provider auth reopen 与 provider recovery wait limit 写回必须保留
checkpoint-derived `sourceIdentityPath`、`sourceHash`、`normalizedPath`、`bookId`。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1254` 到 `1276` 的 provider auth
  reopen 返回对象以 `...checkpoint` 为基底，只清理 failure/retry/runtime 字段并写入
  metadata，不覆盖四个核心身份字段。
- `scripts/graphrag/batch-epub-workflow.mjs:5256` 到 `5270` 的 wait-limit
  `updated` 同样以 `...checkpoint` 为基底，只更新 retry/recovery metadata。
- `scripts/graphrag/batch-epub-workflow.mjs:2168` 到 `2195` 保证用于 snapshot 与
  save 的 active item 继承 checkpoint 的四个核心身份字段。
- `test/cli.test.ts:3775` 到 `3804` 和 `3840` 到 `3848` 覆盖 wait-limit
  catalog drift 下持久 checkpoint 仍保留 persisted `bookId`、
  `sourceIdentityPath`、`normalizedPath`。
- `test/cli.test.ts:6820` 到 `6845` 和 `6925` 到 `6933` 覆盖 auth reopen
  catalog drift 下持久 checkpoint 仍保留 persisted `bookId`、
  `sourceIdentityPath`、`normalizedPath`。

结论：两个保存点不会覆盖 checkpoint-derived identity。

### 6. QMD evidence snapshot 同源原则

结论：PASS。

基准：两个保存点写入的 `qmdBuildStatus` 必须基于同一 checkpoint-derived
`bookId/sourceHash/normalizedPath`，不得按 drift catalog item 重算。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3370` 到 `3448` 的
  `writeQmdBuildManifest()` 将 `bookId`、`sourceHash`、`normalizedPath`、qmd index
  hash、config hash、command check fingerprint 写入 qmd build manifest。
- `scripts/graphrag/batch-epub-workflow.mjs:3452` 到 `3539` 的
  `qmdBuildEvidence()` 校验 manifest 的 runId、itemId、bookId、source hash、
  normalized path/hash、qmd index、config 和 command fingerprint，并在 succeeded
  evidence 中返回 manifest `bookId/sourceHash/normalizedContentHash`。
- `scripts/graphrag/batch-epub-workflow.mjs:1335` 到 `1339` 与 `5254` 到 `5271`
  证明两个复审保存点均用 active item 触发 snapshot。
- `test/cli.test.ts:3840` 到 `3847` 断言 wait-limit 后 `qmdBuildStatus` 为
  `{ status: "succeeded", bookId: persistedBookId }`。
- `test/cli.test.ts:6925` 到 `6931` 断言 auth reopen 后 `qmdBuildStatus` 为
  `{ status: "succeeded", bookId: persistedBookId }`。

结论：两个保存点的 qmd evidence snapshot 与 checkpoint identity 同源。

### 7. GraphRAG evidence snapshot 同源原则

结论：PASS。

基准：两个保存点写入的 `graphBuildStatus` 必须按 checkpoint-derived
`bookId/sourceHash` 读取 `books/<bookId>` 下的 GraphRAG producer evidence，不得接受
drift book evidence。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3157` 到 `3177` 的
  `graphBuildEvidence(item)` 从 `stateRoot/books/<item.bookId>/...` 读取 checkpoint、
  artifact、producer manifest 和 graph job。
- `scripts/graphrag/batch-epub-workflow.mjs:3232` 到 `3243` 校验 producer
  `bookId/sourceHash/documentId/contentHash/providerFingerprint/outputDir` 与当前 item
  identity 对齐。
- `scripts/graphrag/batch-epub-workflow.mjs:3263` 到 `3271` 只在 query_ready
  checkpoint succeeded 且 lineage 校验通过后返回 succeeded。
- `test/cli.test.ts:3845` 到 `3852` 断言 wait-limit 后 `graphBuildStatus` succeeded，
  artifactIds 均包含 persisted bookId，且 serialized graphBuildStatus 不包含
  driftBookId。
- `test/cli.test.ts:6930` 到 `6937` 断言 auth reopen 后 `graphBuildStatus`
  succeeded，artifactIds 均包含 persisted bookId，且 serialized graphBuildStatus
  不包含 driftBookId。

结论：GraphRAG evidence snapshot 与 checkpoint identity 同源。

### 8. Normal run checkpoint identity 一致原则

结论：PASS。

基准：本轮两个保存点必须与 normal run 主路径一致，均以 checkpoint-derived
runtime item 进入 mark/running/run/save，不得只在主路径修复而在 provider 分支漂移。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5458` 到 `5460` 在 normal item 循环
  入口构造 `activeItem = runtimeItemForCheckpoint(item, checkpoint)`。
- `scripts/graphrag/batch-epub-workflow.mjs:5690` 到 `5692` 用 active item 调用
  `markItemRunning()` 与 `runItem()`。
- `scripts/graphrag/batch-epub-workflow.mjs:5696` 到 `5713` 在 catch 分支从 loaded
  running checkpoint 重新构造 active item，并用 active item 保存 recoverable
  transient checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:5754` 到 `5797` 和 `5832` 到 `5903`
  在 provider wait 与普通 failed 保存中展开 running checkpoint 并用 active item
  保存。
- `scripts/graphrag/batch-epub-workflow.mjs:5980` 到 `5983` 触发 batch-level
  provider wait limit 后进入已修复的 `eventProviderRecoveryWaitLimit()`。
- `test/cli.test.ts:9895` 到 `10108` 覆盖 normal run catalog drift 下 resume runner
  接收 persisted `sourceIdentityPath` 和 persisted `normalizedPath`，最终 checkpoint
  保持 persisted book identity。

结论：provider auth reopen、provider recovery wait limit 与 normal run 主路径的
identity 语义一致。

### 9. 参数名不作为身份证据原则

结论：PASS。

基准：审计必须区分函数参数名 `item` 与实际传入对象。`markItemRunning(item, ...)`
内部参数名为 `item` 不代表 discovery item；应以调用点是否传入 active item 为准。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5146` 到 `5204` 的
  `markItemRunning(item, checkpoint, checkpoints, manifest)` 内部参数名为 `item`，
  但该函数会用调用方传入 item 重算 snapshot。
- `scripts/graphrag/batch-epub-workflow.mjs:5690` 到 `5691` 的调用点传入的是
  `markItemRunning(activeItem, starting, checkpoints, manifest)`，不是 discovery
  item。
- `scripts/graphrag/batch-epub-workflow.mjs:1335` 到 `1339` 与 `5254` 到 `5271`
  本轮两个目标保存点也显式构造并传入 active item。

结论：未按变量名字符串误判；实际调用对象已是 checkpoint-derived active item。

### 10. 回归测试覆盖 catalog drift identity 原则

结论：PASS。

基准：新增测试必须覆盖 provider auth reopen 与 provider recovery wait limit 在
catalog drift 下的 evidence identity，并与 normal run checkpoint identity 测试形成闭环。

证据：

- `test/cli.test.ts:3695` 到 `3853` 的
  `provider recovery wait limit preserves checkpoint identity during catalog drift`
  构造 persisted book 与 drift catalog book，断言 checkpoint 顶层 identity、
  `qmdBuildStatus.bookId`、`graphBuildStatus.artifactIds` 均使用 persisted bookId。
- `test/cli.test.ts:6690` 到 `6943` 的
  `provider auth reopen preserves checkpoint identity during catalog drift` 构造 provider
  auth failed checkpoint 与 drift catalog book，断言 reopen 后 checkpoint 顶层
  identity、`qmdBuildStatus.bookId`、`graphBuildStatus.artifactIds` 均使用 persisted
  bookId，并确认触发 `item_provider_auth_reopened`。
- `test/cli.test.ts:9895` 到 `10108` 的
  `normal run uses checkpoint identity after catalog drift` 覆盖 normal run 对
  persisted `sourceIdentityPath`、`normalizedPath`、`bookId` 的贯穿。
- 本次 focused vitest 命令通过，结果为 3 passed、206 skipped。

结论：测试覆盖了本轮两个保存点和 normal run identity 的关键 catalog drift 风险。

## 复审结论

PASS。两个上一轮阻断保存点均已改为 checkpoint-derived active item 写回；在
catalog drift 下，持久 checkpoint 核心身份字段与 qmd/GraphRAG evidence snapshot
保持同源。未发现本复审范围内的阻断缺陷。
