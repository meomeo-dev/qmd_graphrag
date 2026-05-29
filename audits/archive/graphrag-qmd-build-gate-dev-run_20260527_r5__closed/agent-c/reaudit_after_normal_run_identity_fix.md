# GraphRAG QMD Build Gate 正常写路径身份修复复审

## 总体结论

总体结论：PASS。

上一轮 agent-c FAIL 指出的正常写路径身份问题已收口。当前实现把
checkpoint-derived identity 作为 `sourceIdentityPath`、`sourceHash`、
`normalizedPath`、`bookId` 的权威来源，并通过 `runtimeItemForCheckpoint()`
接入 normal run 调度、`markItemRunning()`、`runItem()`、失败保存和 provider
wait 保存路径。`--status-json`、`--migrate-only` 与 normal write path 的 evidence
item 语义已统一到 checkpoint identity；GraphRAG resume 若返回与 checkpoint
不同的 `bookId`，normal run 会 fail closed，不会写入 completed checkpoint。

未发现会导致高成本 GraphRAG/qmd build 证据与持久 checkpoint 身份不一致的阻断
缺陷。保留一个非阻断测试缺口：已有测试覆盖 normal run catalog drift 下的
checkpoint identity 贯穿，但未单独覆盖 resume runner 返回不同 `bookId` 的失败
分支；该分支已有静态 fail-closed 代码证据。

## 审计约束与验证

- 未读取、打印或总结 `.env` secret 值。
- 未修改业务代码、测试代码或配置。
- 未创建新的 audit run；报告写入既有目录：
  `audit/graphrag-qmd-build-gate-dev-run_20260527_r5__open/agent-c/`。
- 执行的轻量验证：
  - `node --check scripts/graphrag/batch-checkpoint-hydration.mjs`
  - `node --check scripts/graphrag/batch-epub-workflow.mjs`
  - `npm run test:types`
  - `CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose --testTimeout 60000 test/cli.test.ts -t "checkpoint identity|normal run uses checkpoint identity"`

## 固定审计基准

### C1. checkpoint identity 优先原则

判定：PASS。

基准：hydration 必须优先保留 persisted checkpoint 的
`sourceIdentityPath`、`sourceHash`、`normalizedPath`、`bookId`。catalog item 或
default identity 只能作为 legacy 缺失字段的回退值。

证据：

- `scripts/graphrag/batch-checkpoint-hydration.mjs:39` 到 `47` 的
  `checkpointIdentityFields()` 对四个身份字段均以 checkpoint 为第一来源。
- `scripts/graphrag/batch-checkpoint-hydration.mjs:85` 到 `88`、
  `113` 到 `115`、`199` 到 `202` 的三条 hydration 返回分支全部展开同一
  identity helper。
- `src/contracts/batch-run.ts:82` 到 `92` 要求 item checkpoint 持久 schema
  必须具备 `sourceIdentityPath`、`sourceHash`、`normalizedPath`、`bookId`。

结论：旧 checkpoint 进入运行前不会被 catalog/default drift 覆盖身份。

### C2. evidence item 派生一致原则

判定：PASS。

基准：所有 completed evidence 重算必须从 hydrated checkpoint 派生 evidence item，
不得直接使用 discovery item 的漂移身份。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2167` 到 `2180` 的
  `evidenceItemForCheckpoint()` 从 checkpoint 提取 `sourceIdentityPath`、
  `sourceHash`、`bookId`、`normalizedPath`，缺失时才回退到 discovery item。
- `scripts/graphrag/batch-epub-workflow.mjs:2214` 到 `2227` 在
  `--migrate-only` 路径中用 checkpoint-derived item 执行 completed downgrade
  与 build status snapshot。
- `scripts/graphrag/batch-epub-workflow.mjs:2238` 到 `2258` 在 normal load 与
  `--status-json` 路径中使用同一 checkpoint-derived evidence item。
- `scripts/graphrag/batch-epub-workflow.mjs:2261` 到 `2267` 的
  `withBuildStatusSnapshot()` 始终从传入 item 重新计算 qmd、GraphRAG build、
  GraphRAG query 状态。

结论：status-json、migrate-only 和 normal load 的 evidence item 语义一致。

### C3. normal run runtime item 原则

判定：PASS。

基准：正常运行的高成本工作必须使用 checkpoint-derived runtime item，而不是
discovery item。`normalizedPath` 必须转成运行时绝对路径，持久化时再保持
project-relative locator。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2187` 到 `2194` 的
  `runtimeItemForCheckpoint()` 先调用 `evidenceItemForCheckpoint()`，再将
  checkpoint `normalizedPath` 解析为运行时绝对路径，并同步 `normalizedRel`。
- `scripts/graphrag/batch-epub-workflow.mjs:5457` 在每个 item 循环入口先构造
  checkpoint-derived `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5661` 到 `5689` 在 pending/default
  处理分支中以 `activeItem` 调用 `markItemRunning()` 和 `runItem()`。
- `test/cli.test.ts:9480` 到 `9690` 的回归测试证明 catalog drift 后 normal run
  仍把 persisted `sourceIdentityPath` 与 persisted `normalizedPath` 传给 resume
  runner，并最终保持 persisted `bookId`。

结论：上一轮 FAIL 中 discovery item 进入 normal write path 的问题已修复。

### C4. running checkpoint 写入身份原则

判定：PASS。

基准：`markItemRunning()` 必须在 checkpoint identity 上写 running 状态、attempts
和 runner metadata，不得把 catalog/default identity 写回 checkpoint。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5146` 到 `5153` 的
  `markItemRunning()` 以调用方传入的 item 和 checkpoint 做锁内读取。
- `scripts/graphrag/batch-epub-workflow.mjs:5166` 到 `5198` 在写 running 时展开
  `current` checkpoint，仅追加运行状态、attempts、retry policy、runner
  metadata，并通过传入 item 重算 evidence snapshot。
- `scripts/graphrag/batch-epub-workflow.mjs:5201` 到 `5204` 将 running checkpoint
  放回内存 map 并记录 `item_start`。
- `scripts/graphrag/batch-epub-workflow.mjs:5688` 传给 `markItemRunning()` 的
  item 是 `runtimeItemForCheckpoint()` 生成的 `activeItem`。

结论：running checkpoint 写入继承 checkpoint identity，未见 catalog/default
identity 覆盖。

### C5. GraphRAG resume 身份与 fail-closed 原则

判定：PASS。

基准：GraphRAG resume 调用必须传递 checkpoint-derived `sourceIdentityPath`、
`sourceHash`、`normalizedPath`、`bookId` 语义；若 resume runner 返回的 `bookId`
与 checkpoint `bookId` 不同，必须 fail closed。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:4649` 到 `4687` 的
  `runGraphResume()` 使用 item 的 `sourceIdentityPath` 与 `normalizedPath`
  作为 resume runner 参数；该 item 在 normal path 中来自
  `runtimeItemForCheckpoint()`。
- `scripts/graphrag/batch-epub-workflow.mjs:4989` 到 `5005` 的 `runItem()` 在
  resume 后构造 `resolvedItem`，继续以 checkpoint 的 `sourceIdentityPath`、
  `sourceHash`、`normalizedPath`、`bookId` 覆盖运行 item。
- `scripts/graphrag/batch-epub-workflow.mjs:5006` 到 `5031` 明确检查
  `resumeResult.bookId !== checkpoint.bookId`，并抛出 permanent failed
  `resume-book` command check。
- `scripts/graphrag/batch-epub-workflow.mjs:5693` 到 `5700` 的 catch 分支会重新
  load running checkpoint 并基于 `activeItem` 保存失败状态，避免 completed 写入。

结论：resume 返回跨书身份时会失败关闭，不会把错误 `bookId` 写成 completed。

### C6. qmd manifest 与 completed evidence 对齐原则

判定：PASS。

基准：normal run 写 qmd build manifest 和 completed checkpoint 前，必须用同一
checkpoint-derived item 计算 qmd build evidence、GraphRAG build evidence 和
GraphRAG query evidence。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5032` 到 `5036` 在 normal run 中以
  `resolvedItem` 运行 CLI checks、写 qmd build manifest，并重算三类 evidence。
- `scripts/graphrag/batch-epub-workflow.mjs:3369` 到 `3448` 的
  `writeQmdBuildManifest()` 将 `bookId`、`sourceHash`、`normalizedPath`、
  normalized content hash、qmd index hash、config hash 和 command check
  fingerprint 写入 manifest。
- `scripts/graphrag/batch-epub-workflow.mjs:3451` 到 `3538` 的
  `qmdBuildEvidence()` 校验 manifest 的 runId、itemId、bookId、source hash、
  normalized path/hash、qmd index、config 和 command fingerprint。
- `scripts/graphrag/batch-epub-workflow.mjs:3156` 到 `3270` 的
  `graphBuildEvidence()` 从 `books/<bookId>/...` 读取 checkpoint、artifact 和
  producer manifest，并校验 producer lineage。
- `scripts/graphrag/batch-epub-workflow.mjs:5086` 到 `5109` 只在 qmd build、
  GraphRAG build、GraphRAG query 全部 succeeded 后构造并保存 completed。

结论：高成本 build evidence 与最终 completed checkpoint 使用同一 checkpoint
book identity 与 normalized input。

### C7. 失败保存与 provider wait 身份原则

判定：PASS。

基准：normal run 的失败保存、recoverable transient 保存、provider recovery wait
保存和 provider wait limit 保存必须继承 running checkpoint identity。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:5693` 到 `5698` 在错误处理入口用
  `loadCheckpoint(activeItem, ...)` 重新取得 running checkpoint，再用
  `runtimeItemForCheckpoint()` 重建 active item。
- `scripts/graphrag/batch-epub-workflow.mjs:5703` 到 `5711` 的 recoverable
  transient 分支基于 `running` 构造 checkpoint，并用 `saveCheckpoint(activeItem,
  recoverable)` 保存。
- `scripts/graphrag/batch-epub-workflow.mjs:5752` 到 `5795` 的 provider wait
  limit 分支展开 `running` checkpoint，保留原身份字段后保存到 `activeItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:5830` 到 `5901` 的普通 failed 或
  provider recovery wait 分支同样展开 `running` checkpoint 并用 `activeItem`
  保存。
- `scripts/graphrag/batch-epub-workflow.mjs:2280` 到 `2285` 的 `saveCheckpoint()`
  使用传入 item 重新计算 snapshot；normal failure/provider wait 调用点传入的
  item 均来自 checkpoint-derived active item。

结论：失败和 provider wait 保存路径未发现 identity drift。

### C8. status-json 只读一致原则

判定：PASS。

基准：`--status-json` 必须使用 checkpoint-derived evidence item 做投影，同时不写
manifest、checkpoint、event log 或 summary。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1905` 到 `1921` 中
  `lockedReadWriteTypedJson()` 与 `writeTypedJson()` 在 status-json 下不落盘。
- `scripts/graphrag/batch-epub-workflow.mjs:2244` 到 `2250` 的 status-json 分支
  使用 checkpoint-derived evidence item 返回 parsed checkpoint projection。
- `scripts/graphrag/batch-epub-workflow.mjs:5391` 到 `5393` 在 status-json 下直接
  `printStatusAndExit()`，不执行 normal run。
- `scripts/graphrag/batch-epub-workflow.mjs:4089` 到 `4092` 的
  `printStatusAndExit()` 只向 stdout 输出 `buildRecoverySummary()`。
- `test/cli.test.ts:9247` 到 `9331` 覆盖 catalog drift 下 status-json 仍按
  persisted checkpoint `bookId` 保持 completed。
- `test/cli.test.ts:9333` 到 `9478` 覆盖 persisted invalid identity 下，即使 drift
  book 有证据，也按 persisted checkpoint identity 降级 pending。

结论：status-json 身份语义与 normal load 一致，并保持只读。

### C9. migrate-only 身份保持原则

判定：PASS。

基准：`--migrate-only` 可写迁移结果，但 completed downgrade、snapshot 和 summary
必须使用 checkpoint-derived identity，且不得进入真实 EPUB/GraphRAG/qmd 工作。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2215` 到 `2236` 的 migrate-only
  分支使用 checkpoint-derived evidence item 执行 downgrade、snapshot 和写回。
- `scripts/graphrag/batch-epub-workflow.mjs:5395` 到 `5415` 的 migrate-only 主分支
  只执行 event log migration、raw log migration、book-scoped raw report 断言、
  recovery summary 和 migration event，然后返回。
- `scripts/graphrag/batch-epub-workflow.mjs:4989` 到 `5109` 的真实 normalize、
  GraphRAG resume、CLI checks、qmd manifest、completed 写入均封装在
  `runItem()`，migrate-only 分支不会调用。
- `test/cli.test.ts:8677` 到 `8810` 覆盖 migrate-only 对缺少真实闭环 evidence
  的旧 completed 降级为 pending。

结论：migrate-only 的写入身份语义与 status-json/normal load 一致。

### C10. 合约与回归覆盖原则

判定：PASS。

基准：schema、实现和回归测试必须共同覆盖 checkpoint identity preservation、
normal run catalog drift、status-json drift projection 和 completed evidence gate。

证据：

- `src/contracts/batch-run.ts:49` 到 `60` 的 `BatchBuildStatusSchema` 包含
  evidence locator、producer run、bookId、sourceHash、normalized content hash
  等 evidence identity 字段。
- `src/contracts/batch-run.ts:221` 到 `230` 的
  `BatchRecoverySummaryItemSchema` 独立暴露 `qmdBuildStatus`、
  `commandCheckStatus`、`graphBuildStatus`、`graphQueryStatus`。
- `src/contracts/batch-run.ts:340` 到 `359` 的 `parseBatchItemCheckpoint()` 只在
  legacy 输入缺字段时注入 default `sourceIdentityPath`、`sourceHash`、`bookId`。
- `test/cli.test.ts:9247` 到 `9478` 覆盖 status-json 对 persisted checkpoint
  identity 的正反两类 drift 投影。
- `test/cli.test.ts:9480` 到 `9690` 覆盖 normal run 在 catalog drift 后仍使用
  checkpoint identity，并断言最终 checkpoint 不采用 drift `bookId`。
- 本次 focused vitest 对 `normal run uses checkpoint identity after catalog drift`
  通过。

结论：本轮修复具备 schema 与回归测试支撑。建议后续补充 resume runner
`bookId` mismatch 的专门负例测试，但当前静态实现已经 fail closed，不构成阻断。

## 修复建议

无阻断修复建议。

后续建议补充一个 focused regression：fake resume runner 返回与 checkpoint
`bookId` 不同的值，断言 run 失败、checkpoint 保持 failed/pending 且不写 completed。
该建议用于提高覆盖率，不影响本轮 PASS 结论。
