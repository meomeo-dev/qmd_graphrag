# r5 agent-b normal run identity 修复复审报告

## 范围与方法

复审范围限定为 agent-c 上一轮 FAIL 指出的正常写路径身份问题：

- 正常 `run/load/write` 路径是否使用 checkpoint-derived identity，而不是
  catalog/default drift identity。
- `markItemRunning`、`runItem`、failure save、provider wait save 是否传播
  `sourceIdentityPath`、`sourceHash`、`normalizedPath`、`bookId`。
- `--status-json`、`--migrate-only`、normal write path 对 evidence item 的身份语义
  是否一致。
- GraphRAG resume、qmd manifest、checkpoint completed evidence 是否不会出现高成本
  构建证据与持久 checkpoint 身份不一致。
- resume runner 返回 `bookId` 与 checkpoint `bookId` 不同是否 fail closed。

未读取或输出 `.env` secret。未修改业务代码。仅写入本报告。

轻量验证：

- PASS: `node --check scripts/graphrag/batch-checkpoint-hydration.mjs`
- PASS: `node --check scripts/graphrag/batch-epub-workflow.mjs`
- PASS: `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot
  --testTimeout 120000 test/cli.test.ts -t "normal run uses checkpoint identity
  after catalog drift|status-json preserves completed checkpoint book identity
  during catalog drift|status-json reopens completed checkpoint using persisted
  invalid book identity"`，结果为 3 passed、204 skipped。

## 总体结论

FAIL。

agent-c 指出的主 normal runner 路径已基本修复：`runtimeItemForCheckpoint()` 已进入
主循环，`markItemRunning()`、`runItem()`、常规 failure save 和 catch 中的 provider
wait save 均使用 checkpoint-derived execution item。`runItem()` 也已在 resume runner
返回 `bookId` 与 checkpoint `bookId` 不同时 fail closed。

但仍有正常写路径残留使用 discovery item 重算并保存 evidence snapshot：

1. `eventProviderRecoveryWaitLimit()` 在 provider wait-limit 批次出口保存 checkpoint
   时仍调用 `saveCheckpoint(item, updated)`。这里的 `item` 来自 discovery item，而不是
   `runtimeItemForCheckpoint(item, checkpoint)`。
2. `applyProviderAuthReopenPass()` 在 provider auth reopen 写回时仍使用 discovery item
   调用 `withBuildStatusSnapshot(item, ...)`。

这两个路径不会覆盖 checkpoint 顶层 `bookId/sourceIdentityPath/sourceHash/
normalizedPath` 字段，但会把 `qmdBuildStatus` 和 `graphBuildStatus` 按 drift identity
重算后写入同一个 checkpoint 文件，形成持久 checkpoint identity 与持久 evidence
snapshot 不一致。因此本轮复审不能判定 normal write path identity 闭环完全收口。

## 固定审计基准

### C1. Hydration 保留 checkpoint 身份

结论：PASS。

基准：已有 checkpoint 被加载后，`sourceIdentityPath`、`sourceHash`、
`normalizedPath`、`bookId` 必须优先来自 checkpoint，仅 legacy 缺字段时才回退到
item/default。

证据：

- `scripts/graphrag/batch-checkpoint-hydration.mjs:39` 至 `47` 的
  `checkpointIdentityFields()` 优先取 checkpoint 四个身份字段。
- `scripts/graphrag/batch-checkpoint-hydration.mjs:85` 至 `89`、
  `113` 至 `116`、`199` 至 `203` 在三条 hydration 分支均展开同一 helper。
- `src/contracts/batch-run.ts:82` 至 `92` 要求 checkpoint schema 持久化
  `sourceIdentityPath`、`sourceHash`、`normalizedPath` 和 `bookId`。

残余风险：未发现本项残余阻塞。

### C2. Evidence item 使用 checkpoint-derived identity

结论：PASS。

基准：所有 completed 证据重算必须基于 checkpoint-derived evidence item，不得被
catalog/default drift item 替换。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2167` 至 `2180` 的
  `evidenceItemForCheckpoint()` 会从 checkpoint 投影 `sourceIdentityPath`、
  `sourceHash`、`bookId` 和 `normalizedPath`。
- `scripts/graphrag/batch-epub-workflow.mjs:2213` 至 `2224` 在
  `--migrate-only` 分支先 hydrate，再以 checkpoint-derived item 降级和重算 evidence。
- `scripts/graphrag/batch-epub-workflow.mjs:2238` 至 `2258` 在普通加载和
  `--status-json` 分支使用同一 checkpoint-derived evidence item。
- `scripts/graphrag/batch-epub-workflow.mjs:2261` 至 `2267` 的
  `withBuildStatusSnapshot()` 会按传入 item 重新计算 qmd/GraphRAG evidence，因此上游
  item identity 是关键不变量。

残余风险：本项对 load/status/migrate 成立；normal write 的残余问题在 C4 和 C5。

### C3. Runtime execution item 进入主 normal runner

结论：PASS。

基准：正常执行 normalize/resume/qmd/checkpoint completed 时，运行时 item 必须由
checkpoint identity 派生，并把 checkpoint `normalizedPath` 转为可执行绝对路径。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2187` 至 `2194` 的
  `runtimeItemForCheckpoint()` 基于 `evidenceItemForCheckpoint()` 构造 runtime item，
  并将 checkpoint `normalizedPath` 解析为绝对路径，同时更新 `normalizedRel`。
- `scripts/graphrag/batch-epub-workflow.mjs:5456` 至 `5458` 在每个 item 循环开始即构造
  `activeItem = runtimeItemForCheckpoint(item, checkpoint)`。
- `scripts/graphrag/batch-epub-workflow.mjs:5660` 至 `5663` 对待执行的
  `starting` checkpoint 再构造 `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5688` 至 `5689` 将 `activeItem` 传给
  `markItemRunning()` 和 `runItem()`。
- `test/cli.test.ts:9480` 至 `9692` 的回归用例证明 catalog drift 后 normal run 调用
  resume runner 时使用 persisted `sourceIdentityPath` 和 `normalizedPath`，最终
  checkpoint 仍为 persisted `bookId`。

残余风险：未发现主 normal runner 的残余阻塞。

### C4. mark/running/failure/provider-wait 保存传播身份

结论：FAIL。

基准：所有正常写路径保存 checkpoint 时，`saveCheckpoint()` 和
`withBuildStatusSnapshot()` 的 item 参数必须是 checkpoint-derived active item。

通过证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5146` 至 `5204` 的
  `markItemRunning()` 会用传入 item 重算 evidence。主循环已在
  `5688` 传入 `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5492` 至 `5494`、`5517` 至 `5520`、
  `5568`、`5612` 至 `5616`、`5636` 至 `5640`、`5694` 至 `5711`、
  `5794`、`5900` 显示 skipped reopen、local repair、transient recovery、
  normal failure save 和 catch 内 provider wait save 已使用 `activeItem`。

失败证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5242` 至 `5253` 的
  `eventProviderRecoveryWaitLimit()` 从 discovery `items` 映射出 `{ item,
  checkpoint }`。
- `scripts/graphrag/batch-epub-workflow.mjs:5254` 至 `5268` 构造 `updated` 时保留
  checkpoint 顶层身份字段。
- `scripts/graphrag/batch-epub-workflow.mjs:5269` 仍调用 `saveCheckpoint(item,
  updated)`，没有先构造 `runtimeItemForCheckpoint(item, checkpoint)`。
- `scripts/graphrag/batch-epub-workflow.mjs:2280` 至 `2285` 的 `saveCheckpoint()`
  会调用 `withBuildStatusSnapshot(item, checkpoint)`；因此 `5269` 会按 discovery
  `item.bookId` 和 `item.normalizedPath` 重算并持久化 build evidence。

影响：

若 provider wait-limit 触发时 catalog/default 已 drift，checkpoint 顶层身份仍可能是
persisted `bookId/sourceIdentityPath/sourceHash/normalizedPath`，但文件中的
`qmdBuildStatus`、`graphBuildStatus` 可能按 drift book/path 重算。该状态不是
completed，但属于 normal write path 的持久 checkpoint/evidence 不一致。

修复建议：

- 在 `eventProviderRecoveryWaitLimit()` 中改为：
  `const activeItem = runtimeItemForCheckpoint(item, checkpoint)`，随后
  `const saved = saveCheckpoint(activeItem, updated)`，并用 `saved` 或同等
  checkpoint-derived snapshot 更新 `checkpoints` map。
- 增加 catalog/default `bookId` 和 `normalizedPath` drift 下的 provider wait-limit
  回归，断言持久 checkpoint 顶层身份和 `qmdBuildStatus.bookId/evidenceLocator` 都来自
  checkpoint-derived identity。

### C5. Provider auth reopen 写回不漂移 evidence

结论：FAIL。

基准：normal write path 中的 provider auth reopen 保存也必须使用 checkpoint-derived
active item 重算 evidence snapshot。

失败证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1279` 至 `1284` 的
  `applyProviderAuthReopenPass()` 遍历 discovery `items`，并从 map 中取 checkpoint。
- `scripts/graphrag/batch-epub-workflow.mjs:1311` 至 `1314` 使用 `itemPath(item)` 加锁。
  该路径本身只依赖 `itemId`，不是问题。
- `scripts/graphrag/batch-epub-workflow.mjs:1335` 至 `1338` 保存时调用
  `withBuildStatusSnapshot(item, reopenProviderAuthCheckpoint(item, current,
  currentDecision))`，其中 `item` 仍是 discovery item，不是
  `runtimeItemForCheckpoint(item, current)`。
- `scripts/graphrag/batch-epub-workflow.mjs:2261` 至 `2267` 表明该调用会用 discovery
  item 重算 `qmdBuildStatus` 和 `graphBuildStatus`。

影响：

provider auth reopen 会把 failed checkpoint 改回 pending，使后续主循环可以使用
`activeItem` 正常补跑；但 reopen 写回这一刻的 checkpoint 文件仍可能持有
checkpoint 顶层 identity 与 drift evidence snapshot。该路径也属于 normal write path，
因此与本次身份传播基准不一致。

修复建议：

- 在 `applyProviderAuthReopenPass()` 中为每个 checkpoint 构造 active item，并在
  `reopenProviderAuthCheckpoint()` 与 `withBuildStatusSnapshot()` 中使用该 active item。
- 增加 provider auth failed checkpoint 在 catalog/default drift 后 reopen 的 focused
  regression，断言写回 checkpoint 的 identity 和 build evidence 均来自 checkpoint。

### C6. status-json、migrate-only、normal write 身份语义一致

结论：FAIL。

基准：三类路径应使用同一 checkpoint-derived identity 语义；只读投影、迁移写回和
正常写回不应产生不同的 evidence 身份来源。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2215` 至 `2236` 的 `--migrate-only`
  路径使用 checkpoint-derived item 重算并写回。
- `scripts/graphrag/batch-epub-workflow.mjs:2244` 至 `2258` 的普通加载和
  `--status-json` 路径使用 checkpoint-derived item；`--status-json` 在
  `2245` 至 `2250` 只 parse 内存对象，不写文件。
- `scripts/graphrag/batch-epub-workflow.mjs:5391` 至 `5393` 在 `--status-json`
  输出后直接返回；`5395` 至 `5415` 的 `--migrate-only` 不执行正常工作。
- 但 C4 与 C5 的 normal write 子路径仍使用 discovery item 保存 evidence snapshot，
  因此三类路径不完全一致。

修复建议：把 C4/C5 两个 normal write 保存点改成 checkpoint-derived active item 后，
再用同一 drift fixture 分别覆盖 `--status-json`、`--migrate-only`、normal write。

### C7. qmd build manifest 与 command check gate 使用执行身份

结论：PASS。

基准：qmd manifest 写入和 qmd build evidence 重算必须绑定 normal execution item 的
`bookId/sourceHash/normalizedPath`，并要求 27 个固定 command checks 全部通过。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:4930` 至 `4947` 要求 command check 名称
  集合完整、唯一、无意外项且全部 passed。
- `scripts/graphrag/batch-epub-workflow.mjs:5032` 至 `5034` 在 `runItem()` 中用
  `resolvedItem` 执行 CLI checks、写 qmd build manifest、再重算 qmd evidence。
- `scripts/graphrag/batch-epub-workflow.mjs:3369` 至 `3382` 在写 qmd manifest 前再次
  要求 command check set succeeded。
- `scripts/graphrag/batch-epub-workflow.mjs:3424` 至 `3448` 的 qmd manifest 写入
  `bookId`、`sourceHash`、`normalizedPath`、normalized content hash、qmd index 和
  config hash。
- `scripts/graphrag/batch-epub-workflow.mjs:3483` 至 `3509` 的 qmd evidence 校验
  `runId/itemId/bookId/sourceRelativePath/sourceHash/normalizedPath/qmd index/config/
  command names/fingerprint`。
- `docs/operations/graphrag-epub-batch-runbook.md:437` 至 `443` 记录 completed
  checkpoint 必须同时满足 qmd、command、GraphRAG build 和 query evidence。

残余风险：qmd manifest schema 当前没有 `sourceIdentityPath` 字段；该身份通过
checkpoint 顶层字段和 `bookId` 间接绑定。未发现 completed path 的阻塞问题。

### C8. GraphRAG resume、producer manifest 与 completed checkpoint 对齐

结论：PASS。

基准：GraphRAG 高成本构建证据、producer manifest、qmd manifest 和 completed
checkpoint 必须绑定同一书级身份。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:4649` 至 `4687` 的 `runGraphResume()`
  使用传入 item 的 `sourceIdentityPath`、`normalizedPath`、`sourcePath` 和 state root
  调用 resume runner。
- `scripts/graphrag/batch-epub-workflow.mjs:4994` 至 `5005` 的 `resolvedItem` 从
  checkpoint 覆盖 `sourceIdentityPath`、`sourceHash`、`normalizedPath` 和 `bookId`。
- `scripts/graphrag/batch-epub-workflow.mjs:5034` 至 `5086` 在写 completed 前要求
  qmd build、GraphRAG build、GraphRAG query 全部 succeeded。
- `scripts/graphrag/batch-epub-workflow.mjs:5086` 至 `5108` 只在上述门通过后写
  completed checkpoint，并保存 `qmdBuildStatus`、`graphBuildStatus`、
  `graphQueryStatus` 和 command checks。
- `scripts/graphrag/batch-epub-workflow.mjs:3156` 至 `3175` 的 GraphRAG evidence 从
  `books/<bookId>/checkpoints.yaml`、`books/<bookId>/artifacts.yaml` 和
  `books/<bookId>/output/qmd_output_manifest.json` 读取。
- `scripts/graphrag/batch-epub-workflow.mjs:3231` 至 `3255` 要求 producer manifest 的
  `bookId/sourceHash/documentId/contentHash/providerFingerprint/outputDir` 和 stage
  fingerprints 与当前 item/job 一致。
- `docs/operations/graphrag-epub-batch-runbook.md:149` 至 `154` 记录 producer manifest
  identity 和 stage producer run ids 必须与当前书一致。

残余风险：C4/C5 的失败路径保存仍会产生 pending checkpoint evidence snapshot 漂移；
completed 写入路径未发现同类问题。

### C9. Resume bookId mismatch fail closed

结论：PASS。

基准：resume runner 返回 `bookId` 与 checkpoint `bookId` 不同，必须 fail closed，不得
继续写 qmd manifest 或 completed checkpoint。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5006` 至 `5010` 显式比较
  `resumeResult.bookId` 与 `checkpoint.bookId`。
- `scripts/graphrag/batch-epub-workflow.mjs:5011` 至 `5030` 在不一致时抛出
  `GraphRAG resume book id mismatch`，并附带 permanent、non-retryable、
  `stop_until_fixed` command check。
- `scripts/graphrag/batch-epub-workflow.mjs:5032` 之后才运行 CLI checks 和写 qmd
  manifest，因此 mismatch 会阻断后续高成本证据写入。

残余风险：当前未见专门覆盖 mismatch 的 focused regression。建议补充一个 fake resume
runner 返回不同 `bookId` 的测试，断言 checkpoint failed 且 qmd build manifest 未写入。
实现路径本身满足 fail-closed。

### C10. 回归覆盖与残余缺口

结论：FAIL。

基准：回归测试必须覆盖已知身份漂移失败模式，包括只读、迁移和正常写路径。

已覆盖证据：

- `test/cli.test.ts:9247` 至 `9331` 覆盖 `--status-json` 在 catalog drift 下保留
  completed checkpoint book identity。
- `test/cli.test.ts:9333` 至 `9478` 覆盖 `--status-json` 使用 persisted invalid book
  identity 降级，而不是采信 drift book evidence。
- `test/cli.test.ts:9480` 至 `9692` 覆盖 normal run 在 catalog drift 后使用 persisted
  `sourceIdentityPath`、`normalizedPath` 和 `bookId`。
- 本次轻量 vitest 运行上述 3 个 focused tests，全部通过。

缺口证据：

- `test/cli.test.ts:3562` 至 `3693` 的 provider wait-limit 回归只断言状态和 wait
  metadata，没有构造 catalog/default drift，也没有断言持久 build evidence snapshot 的
  `bookId/evidenceLocator` 仍来自 checkpoint identity。
- 当前未见 provider auth reopen 在 checkpoint identity drift 下的 focused regression。
- 当前未见 resume returned `bookId` mismatch 的 focused regression。

修复建议：

- 新增 provider wait-limit drift 测试，覆盖 C4。
- 新增 provider auth reopen drift 测试，覆盖 C5。
- 新增 resume returned `bookId` mismatch 测试，覆盖 C9 的 fail-closed 行为。

## 阻塞问题

1. Provider wait-limit 保存仍用 discovery item 重算持久 evidence。

   位置：

   - `scripts/graphrag/batch-epub-workflow.mjs:5242` 至 `5269`
   - `scripts/graphrag/batch-epub-workflow.mjs:2280` 至 `2285`

   修复方向：

   - 在 `eventProviderRecoveryWaitLimit()` 中使用
     `runtimeItemForCheckpoint(item, checkpoint)`。
   - 用 checkpoint-derived active item 调用 `saveCheckpoint()`。
   - 用保存后的 checkpoint 或同等 identity-consistent snapshot 更新 `checkpoints` map。

2. Provider auth reopen 保存仍用 discovery item 重算持久 evidence。

   位置：

   - `scripts/graphrag/batch-epub-workflow.mjs:1279` 至 `1338`
   - `scripts/graphrag/batch-epub-workflow.mjs:2261` 至 `2267`

   修复方向：

   - 在 `applyProviderAuthReopenPass()` 中使用
     `runtimeItemForCheckpoint(item, checkpoint)`。
   - 用 active item 调用 `reopenProviderAuthCheckpoint()` 与
     `withBuildStatusSnapshot()`。
   - 增加 drift 回归，断言 reopen 写回后的 checkpoint 顶层身份与
     `qmdBuildStatus/graphBuildStatus` evidence 来源一致。

## 最终结论

FAIL
