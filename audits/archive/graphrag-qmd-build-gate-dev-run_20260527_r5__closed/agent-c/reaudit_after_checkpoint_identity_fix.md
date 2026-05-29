# GraphRAG QMD Build Gate 修复后复审

## 审计结论

最终结论：FAIL。

`--status-json` 与 `--migrate-only` 的 completed 证据重算已使用 hydrated
checkpoint 的 `bookId` 与 `normalizedPath`，可以避免只读投影被 catalog/default
drift 误导。但 normal load 写入路径仍未把 hydrated checkpoint identity 贯穿到实际
runner：调度器在重开后继续用 discovery `item` 进入 `markItemRunning()` 和
`runItem()`，而 `runItem()` 又用 discovery `item.sourceIdentityPath` 与
`item.normalizedPath` 规范化 EPUB、调用单书 resume、写 qmd build manifest。若
catalog/default identity drift 已发生，真实写入续跑可能用漂移后的 normalized input
执行，却把 completed checkpoint 保留为 persisted normalizedPath，形成完成状态与
持久身份不一致的 gate 缺陷。

该问题属于本轮必须重点确认的
checkpoint identity preservation through hydration，覆盖 normal load 路径，阻塞
真实 EPUB 处理收口。

## 审计约束

- 未读取或输出 `.env` secret 值。
- 未修改实现代码或测试代码。
- 写入范围仅限
  `audit/graphrag-qmd-build-gate-dev-run_20260527_r5__open/agent-c/`。
- 已执行静态语法检查：
  - `node --check scripts/graphrag/batch-checkpoint-hydration.mjs`
  - `node --check scripts/graphrag/batch-epub-workflow.mjs`
- 未运行 vitest。原因是本轮指令只允许写入 agent-c 审计目录，测试会创建或修改
  `.tmp-tests` 等审计目录外文件。

## 逐条复审

### C1. 独立证据优先（independent evidence first）

判定：FAIL。

证据：

- `scripts/graphrag/batch-checkpoint-hydration.mjs:39` 至 `47` 新增
  `checkpointIdentityFields()`，优先保留 checkpoint 的 `sourceIdentityPath`、
  `sourceHash`、`normalizedPath` 和 `bookId`。
- `scripts/graphrag/batch-checkpoint-hydration.mjs:88`、`115`、`202` 在各
  hydration 分支展开该身份字段，避免直接以 item/default 覆盖 checkpoint identity。
- `scripts/graphrag/batch-epub-workflow.mjs:2167` 至 `2174` 的
  `evidenceItemForCheckpoint()` 只把 checkpoint 的 `bookId` 与 `normalizedPath`
  投入证据重算；未带入 checkpoint 的 `sourceIdentityPath`。
- `scripts/graphrag/batch-epub-workflow.mjs:2193` 至 `2229` 的
  `loadCheckpoint()` 在 `--status-json`、`--migrate-only` 和普通加载的 completed
  降级判断中使用 `evidenceItemForCheckpoint()`，只读/迁移投影路径对
  `bookId/normalizedPath` 的重算已修复。
- 但 normal run 后续调度仍在
  `scripts/graphrag/batch-epub-workflow.mjs:5599`、`5625` 至 `5626` 使用原始
  discovery `item` 调用 `markItemRunning(item, ...)` 和 `runItem(item, ...)`。
- `scripts/graphrag/batch-epub-workflow.mjs:5095` 至 `5110` 的
  `markItemRunning()` 用 `withBuildStatusSnapshot(item, ...)` 重算快照，而不是
  checkpoint identity item。
- `scripts/graphrag/batch-epub-workflow.mjs:4969` 至 `4976` 的 `runItem()` 用
  discovery `item` 执行 `normalizeEpubToMarkdown()`、`runGraphResume()`、
  `runCliChecks()` 和 `writeQmdBuildManifest()`。
- `scripts/graphrag/batch-epub-workflow.mjs:4636` 至 `4645` 的
  `runGraphResume()` 将 `item.sourceIdentityPath` 与 `item.normalizedPath`
  传给单书 resume，而非 hydrated checkpoint 的 persisted identity。
- `scripts/graphrag/batch-epub-workflow.mjs:4974` 只把 `bookId` 替换为
  `resolvedBookId`；未把 `normalizedPath` 或 `sourceIdentityPath` 替换为
  checkpoint identity。

残余风险：

当 catalog 对同一 source hash/source identity 追加漂移后的 `bookId` 或
`normalizedPath`，旧 completed 若被降级为 pending，normal run 会用漂移后的
discovery normalized path 跑实际工作；completed checkpoint 仍通过 `...checkpoint`
保留 persisted normalizedPath。随后 qmd build manifest 与 checkpoint identity 可
出现不一致，下一次加载又会重新判 stale，甚至本轮 manifest 计数已按 completed
统计。该路径会影响真实 EPUB 续跑，不只是显示层问题。

### C2. 命令检查独立（command checks separated）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:186` 至 `214` 定义固定 27 个
  `requiredCommandCheckNames`。
- `scripts/graphrag/batch-epub-workflow.mjs:3566` 至 `3600` 的
  `commandCheckSetEvidence()` 单独检查 command check 数量、唯一性、缺项、额外项
  和失败项。
- `scripts/graphrag/batch-epub-workflow.mjs:3350` 至 `3361` 中
  `writeQmdBuildManifest()` 先要求 27 个 command checks 成功，但
  `commandCheckStatus` 仍由 `commandCheckSetEvidence()` 独立投影。
- `scripts/graphrag/batch-epub-workflow.mjs:3938` 至 `3962` 在 recovery summary
  中分别投影 `qmdBuildStatus`、`commandCheckStatus`、`graphBuildStatus` 和
  `graphQueryStatus`。

残余风险：

未发现 `qmdBuildStatus` 与 27 个 command checks 混同的问题。

### C3. Completed 严格闭环（strict completed gate）

判定：FAIL。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:3646` 至 `3657` 的
  `downgradeCompletedIfClosedLoopInvalid()` 对既有 completed checkpoint 的保留条件
  是 `commandCheckStatus`、`qmdBuildStatus`、`graphBuildStatus`、
  `graphQueryStatus` 全部 `succeeded`。
- `scripts/graphrag/batch-epub-workflow.mjs:3665` 至 `3716` 在任一证据失败时将
  completed 降级为 pending。
- `scripts/graphrag/batch-epub-workflow.mjs:4977` 至 `5028` 的 normal run 完成前
  会检查 qmd build、GraphRAG build 和 GraphRAG query 成功；`runCliChecks()` 又在
  `scripts/graphrag/batch-epub-workflow.mjs:4909` 至 `4928` 要求 27 个命令检查全部
  passed。
- 但该 normal run 的检查对象是 `resolvedItem`。`resolvedItem` 只替换
  `bookId`，保留 discovery `normalizedPath/sourceIdentityPath`，见
  `scripts/graphrag/batch-epub-workflow.mjs:4974`。
- `scripts/graphrag/batch-epub-workflow.mjs:5029` 至 `5044` 构造 completed 时以
  `...checkpoint` 保留 persisted checkpoint 字段，再只覆盖 `status/bookId` 与状态
  快照。若 `resolvedItem.normalizedPath` 与 checkpoint.normalizedPath 不同，实际
  gate 检查和持久 checkpoint identity 不同源。

残余风险：

strict completed gate 对只读重算成立，但 normal run 仍可能在 identity drift 后用
漂移 identity 通过 gate，再写出携带旧 persisted normalizedPath 的 completed
checkpoint。该 completed 不能证明 persisted checkpoint identity 对应的
qmd build manifest 已成功。

### C4. 旧状态不可继承（legacy status is not authority）

判定：FAIL。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2193` 至 `2229` 已保证加载旧
  checkpoint 后，`--migrate-only`、`--status-json` 和普通加载都会先走
  `downgradeCompletedIfClosedLoopInvalid()`。
- `scripts/graphrag/batch-epub-workflow.mjs:5332` 至 `5338` 在 status-json 输出前
  只做内存投影，migrate-only 单独退出，不进入真实工作路径。
- `test/cli.test.ts:8677` 至 `8810` 覆盖 `--migrate-only` 对缺少 closed-loop
  evidence 的 completed item 降级为 pending。
- `test/cli.test.ts:9247` 至 `9478` 覆盖 status-json 在 catalog drift 下保留或
  降级 completed checkpoint，且不写回 checkpoint。

残余风险：

旧状态不再直接继承；问题在于 normal load 降级后继续执行时没有继续使用
hydrated checkpoint identity。也就是说，旧 completed 能被正确 reopen，但 reopen
之后的真实补跑仍可能切回 discovery identity。

### C5. GraphRAG 产物书级隔离（book-scoped artifacts）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2526` 至 `2528` 将 GraphRAG output
  locator 固定为 `books/${bookId}/output`。
- `scripts/graphrag/batch-epub-workflow.mjs:2911` 至 `2930` 以 `item.bookId`
  过滤 stage candidate artifacts。
- `scripts/graphrag/batch-epub-workflow.mjs:2994` 至 `2999` 要求 embed artifact
  精确位于 `books/<bookId>/output/lancedb`，其他 artifact 必须位于
  `books/<bookId>/output/`。
- `scripts/graphrag/batch-epub-workflow.mjs:3211` 至 `3235` 要求 producer manifest
  的 `bookId/sourceHash/documentId/contentHash/providerFingerprint/outputDir` 与当前
  book identity 对齐。
- `docs/operations/graphrag-epub-batch-runbook.md:258` 至 `288` 描述 book-scoped
  output、producer lineage 和 sidecar repair 的必要约束。

残余风险：

GraphRAG 产物校验本身能拒绝共享 output、host absolute path 和跨书 artifact。该项
不抵消 C1/C3 的 normal run identity 贯穿缺陷。

### C6. Producer lineage 对齐（producer lineage alignment）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:2957` 至 `2971` 校验 stage artifact
  的 producer run 与 expected producer run 或 producer manifest 对齐。
- `scripts/graphrag/batch-epub-workflow.mjs:2972` 至 `2991` 校验 stage
  fingerprint、provider fingerprint 和 corpus content hash。
- `scripts/graphrag/batch-epub-workflow.mjs:3024` 至 `3103` 校验 stage checkpoint
  的 stage、status、bookId、contentHash、fingerprint、provider fingerprint 和
  producer run。
- `test/cli.test.ts:10140` 至 `10424` 覆盖 stale GraphRAG producer lineage，并
  断言 reason 包含 `stage_artifact_producer_run_mismatch:community_report`。

残余风险：

未发现 producer lineage 校验被绕过。主要残余风险仍是 normal run 的输入 identity
来源可能先发生漂移。

### C7. Provider auth 恢复有界且保留投影（bounded auth repair）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:902` 至 `972` 计算 provider auth
  context，只投影 readiness、presence、source 和 fingerprint。
- `scripts/graphrag/batch-epub-workflow.mjs:1031` 至 `1104` 的
  `providerAuthReopenDecision()` 要求 failed、`retryable=false`、
  `stop_until_fixed`、provider auth failure，并受 readiness、fingerprint、already
  reopened 和 `maxProviderAuthReopenAttempts` 控制。
- `scripts/graphrag/batch-epub-workflow.mjs:1188` 至 `1276` 的 reopen 只改回
  `pending` 与 `continue_pending`，清空 `commandChecks`，并写
  `normalCommandChecksRequired=true`。
- `scripts/graphrag/batch-epub-workflow.mjs:1634` 至 `1682` 对消息、日志、URL
  credential、Bearer、API key/base URL 和已解析 dotenv secret 做脱敏。
- `test/cli.test.ts:6303` 至 `6528` 覆盖 legacy provider auth reopen 并断言状态
  中不包含测试密钥值。
- `test/cli.test.ts:6530` 至 `6682` 覆盖 shell env shadow 与 endpoint shadow。
- `test/cli.test.ts:6948` 至 `7091` 覆盖缺 OpenAI base URL 与缺 OpenAI API key。
- `test/cli.test.ts:7211` 至 `7359` 覆盖 attempt limit 与 already reopened
  fingerprint。
- `test/cli.test.ts:7361` 至 `7540` 覆盖 unchanged fingerprint 与 refailure 投影。

残余风险：

未发现 provider auth 修复泄露密钥或无界重开的问题。

### C8. 只读投影无副作用（read-only projection has no writes）

判定：PASS。

证据：

- `scripts/graphrag/batch-epub-workflow.mjs:1702` 至 `1728` 的 status-json
  `ensureDirs()` 只校验 state root 与 log root 关系，不创建 batch/item/log 目录。
- `scripts/graphrag/batch-epub-workflow.mjs:1836` 使 `event()` 在 status-json 下直接
  返回内存事件，不写 `events.jsonl`。
- `scripts/graphrag/batch-epub-workflow.mjs:1905` 至 `1921` 使 locked read/write 和
  typed write 在 status-json 下不写文件。
- `scripts/graphrag/batch-epub-workflow.mjs:2225` 至 `2230` 的 status-json 分支只
  parse 带 snapshot 的 checkpoint 对象，不写回。
- `scripts/graphrag/batch-epub-workflow.mjs:5332` 至 `5336` 在 status-json 下跳过
  producer manifest migration，并直接输出状态。
- `scripts/graphrag/batch-epub-workflow.mjs:4069` 至 `4072` 的
  `printStatusAndExit()` 只向 stdout 输出 `buildRecoverySummary()`。
- `docs/operations/graphrag-epub-batch-runbook.md:338` 至 `341` 和
  `docs/operations/graphrag-epub-resume-boost.md:127` 至 `129` 均说明
  `--status-json` 不执行外部工作且不写 manifest、checkpoint 或 event log。

残余风险：

status-json 会在内存中投影降级与 provider auth readiness；该行为符合只读审计。

### C9. 文档与 schema 一致（docs and schema agree）

判定：PASS。

证据：

- `src/contracts/batch-run.ts:221` 至 `230` 的
  `BatchRecoverySummaryItemSchema` 包含 `qmdBuildStatus`、`commandCheckStatus`、
  `graphBuildStatus` 和 `graphQueryStatus`。
- `scripts/graphrag/batch-epub-workflow.mjs:546` 至 `555` 的运行时 summary schema
  与 contract 同步包含上述字段。
- `docs/operations/graphrag-epub-batch-runbook.md:343` 至 `348` 说明
  `recovery-summary.json` 与 `--status-json` 均受 `BatchRecoverySummarySchema`
  约束，并记录 `commandCheckStatus`。
- `docs/operations/graphrag-epub-batch-runbook.md:437` 至 `443` 明确 completed
  checkpoint 必须包含 27 个命令检查，且四类状态全部 succeeded；其中
  `qmdBuildStatus` 来自独立 qmd build manifest，`commandCheckStatus` 来自 27 个
  CLI 子命令检查。
- `docs/operations/graphrag-epub-resume-commands.md:99` 至 `128` 的快速汇总已补充
  从 raw `commandChecks` 计算 `commandCheckStatus`，并输出 `commandCheckCount`。
- `docs/operations/graphrag-epub-resume-boost.md:216` 至 `249` 列出 provider auth
  投影字段，并说明只保存 present/missing、source 和 redacted fingerprint。
- `docs/operations/graphrag-epub-resume-boost.md:310` 至 `329` 的完成判定包含
  `qmdBuildStatus`、`graphBuildStatus`、`graphQueryStatus`、`commandCheckStatus`
  和 27 command checks。

残余风险：

文档已修复 agent-c 先前提出的快速汇总缺口。当前 FAIL 是实现路径问题，不是
schema/docs 不一致。

### C10. 回归测试覆盖失败模式（regression coverage for gate failures）

判定：FAIL。

证据：

- qmd manifest 缺失和 migrate-only reopen：
  `test/cli.test.ts:8677` 至 `8810`。
- status-json 接受 book-scoped producer evidence：
  `test/cli.test.ts:8929` 至 `9244`。
- status-json catalog drift 下保留 checkpoint identity：
  `test/cli.test.ts:9247` 至 `9331`。
- status-json catalog drift 下按 persisted invalid identity reopen：
  `test/cli.test.ts:9333` 至 `9478`。
- GraphRAG query failed reopen：
  `test/cli.test.ts:9480` 至 `9776`。
- incomplete command check set reopen：
  `test/cli.test.ts:9774` 至 `10053`。
- stale producer lineage：
  `test/cli.test.ts:10140` 至 `10424`。
- provider auth repair、shadow、missing key/base URL、attempt limit、fingerprint：
  `test/cli.test.ts:6303` 至 `7540`。

残余风险：

新增 checkpoint identity drift 回归测试均为 `--status-json` 只读路径。未见 normal
write-path 回归：例如 completed 被 reopen 后，catalog/default `bookId` 或
`normalizedPath` drift 时，写入 runner 必须使用 checkpoint `bookId`、
`normalizedPath` 和 `sourceIdentityPath` 执行 normalize/resume/qmd manifest，并且最终
completed checkpoint 的持久身份与重新计算证据一致。该覆盖缺口与 C1/C3 的实现缺陷
直接对应，因此本项 FAIL。

## 阻塞问题

1. normal load 写入路径未贯穿 checkpoint identity。

   位置：

   - `scripts/graphrag/batch-epub-workflow.mjs:5599`
   - `scripts/graphrag/batch-epub-workflow.mjs:5625` 至 `5626`
   - `scripts/graphrag/batch-epub-workflow.mjs:5095` 至 `5110`
   - `scripts/graphrag/batch-epub-workflow.mjs:4636` 至 `4645`
   - `scripts/graphrag/batch-epub-workflow.mjs:4969` 至 `4976`
   - `scripts/graphrag/batch-epub-workflow.mjs:5029` 至 `5051`

   影响：

   - `--status-json` 与 `--migrate-only` 可按 checkpoint identity 重算 evidence。
   - normal run 一旦需要补跑 reopened checkpoint，会重新使用 discovery item 的
     `sourceIdentityPath/normalizedPath` 执行实际工作。
   - 若 catalog/default drift 修改了 normalized locator，qmd build manifest 可按漂移
     path 写入，而 completed checkpoint 仍保留 persisted normalizedPath。
   - 该 completed 不能证明 persisted checkpoint identity 对应的 closed loop 全成功。

   修复方向：

   - 在进入 `markItemRunning()`、`runItem()`、`runGraphResume()`、
     `normalizeEpubToMarkdown()` 和 `writeQmdBuildManifest()` 前，构造一个
     checkpoint-authoritative execution item。
   - execution item 至少应保留 checkpoint 的 `bookId`、`normalizedPath`、
     `sourceIdentityPath` 和 `sourceHash`，并只在 checkpoint 缺失这些字段时回退到
     discovery item/default。
   - completed 写入前应重新按同一 execution item 计算 qmd/GraphRAG evidence，并让
     持久 checkpoint identity 与 evidence item 完全一致。
   - 增加 normal write-path 回归测试，覆盖 catalog/default `bookId` 与
     `normalizedPath` drift 后 reopened checkpoint 的补跑。

## 最终结论

FAIL
