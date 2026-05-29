# r5 agent-b checkpoint identity 修复复审结果

## 范围

复审对象：

- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/operations/graphrag-epub-resume-boost.md`
- `docs/operations/graphrag-epub-resume-commands.md`

固定基准复用：
`audit/graphrag-qmd-build-gate-dev-run_20260527_r5__open/agent-b/audit_criteria.md`。

本次为静态复审（static review）。未运行测试；原因是本任务限制只允许写入
`agent-b` 审计目录，而相关 focused tests 会写入 `.tmp-tests`。未读取或输出
`.env` secret 值。

## 总结

结论：PASS。

r5 agent-b 原 FAIL 已收口。`hydrateBatchCheckpoint` 现在通过统一
`checkpointIdentityFields` 保留 persisted checkpoint 的 `bookId`、
`normalizedPath`、`sourceIdentityPath` 和 `sourceHash`，三条 hydration 分支均使用同
一规则。`loadCheckpoint` 在 `--status-json`、`--migrate-only` 和普通运行路径中
均先 hydrate，再用 checkpoint identity 重算 completed 闭环证据；新增回归覆盖
catalog/default `bookId` drift 下的 completed 保持与按 persisted invalid book
identity 降级。

未发现阻塞真实 EPUB 处理的残余问题。

## C1. 独立 qmd 构建证据

状态：PASS

依据：

- `qmdBuildStatus` 的 locator 固定为
  `books/${item.bookId}/qmd/qmd_build_manifest.json`：
  `scripts/graphrag/batch-epub-workflow.mjs:2530`。
- `qmdBuildEvidence` 只读取并校验 qmd build manifest，校验 run id、item id、
  book id、source path/hash、normalized path/hash、qmd index、config、
  command names 和 fingerprint：
  `scripts/graphrag/batch-epub-workflow.mjs:3431`、
  `scripts/graphrag/batch-epub-workflow.mjs:3462`。
- `withBuildStatusSnapshot` 每次持久化或 status projection 都用
  `qmdBuildEvidence(item)` 覆盖 checkpoint 中的旧 `qmdBuildStatus`：
  `scripts/graphrag/batch-epub-workflow.mjs:2241`。
- `graphQueryStatus` 独立从 GraphRAG query command checks 计算，不混入 qmd
  manifest 结果：
  `scripts/graphrag/batch-epub-workflow.mjs:3521`。
- recovery summary 单独投影 `qmdBuildStatus`、`commandCheckStatus`、
  `graphBuildStatus` 和 `graphQueryStatus`：
  `scripts/graphrag/batch-epub-workflow.mjs:3938`。
- runbook 明确 `qmdBuildStatus` 来自独立 qmd build manifest：
  `docs/operations/graphrag-epub-batch-runbook.md:120`、
  `docs/operations/graphrag-epub-batch-runbook.md:440`。

残余风险：未发现阻塞风险。

## C2. 固定命令检查集合

状态：PASS

依据：

- 固定命令集合为 27 个名称：
  `scripts/graphrag/batch-epub-workflow.mjs:186`。
- `commandCheckSetEvidence` 要求检查总数、唯一名称数、缺失项、意外项和失败项
  全部满足要求才返回 `succeeded`：
  `scripts/graphrag/batch-epub-workflow.mjs:3566`。
- `writeQmdBuildManifest` 在写 qmd build manifest 前再次要求固定 command check
  set 成功：
  `scripts/graphrag/batch-epub-workflow.mjs:3349`。
- recovery summary schema 和实现均包含独立 `commandCheckStatus`：
  `src/contracts/batch-run.ts:227`、
  `scripts/graphrag/batch-epub-workflow.mjs:552`。
- 文档命令附录用同一 27 项集合计算快速汇总：
  `docs/operations/graphrag-epub-resume-commands.md:89`。
- incomplete/failed command check focused regressions 覆盖：
  `test/cli.test.ts:9774`、`test/cli.test.ts:10053`。

残余风险：`docs/operations/graphrag-epub-resume-commands.md` 的快速汇总脚本只做
本地近似统计，不替代 runtime `commandCheckSetEvidence`。未发现阻塞风险。

## C3. 闭环完成门

状态：PASS

依据：

- `runItem` 在写 completed 前依次执行 resume、CLI checks、qmd build manifest
  写入，并重新计算 qmd build、GraphRAG build、GraphRAG query：
  `scripts/graphrag/batch-epub-workflow.mjs:4969`。
- qmd build、GraphRAG build、GraphRAG query 任一非 `succeeded` 均抛错，不写
  completed：
  `scripts/graphrag/batch-epub-workflow.mjs:4977`、
  `scripts/graphrag/batch-epub-workflow.mjs:4999`、
  `scripts/graphrag/batch-epub-workflow.mjs:5019`。
- command check set 不完整时，qmd build manifest 写入会失败：
  `scripts/graphrag/batch-epub-workflow.mjs:3349`。
- completed checkpoint 只在上述门全部通过后构造并保存：
  `scripts/graphrag/batch-epub-workflow.mjs:5029`。
- legacy completed 降级路径也要求 `commandCheckStatus`、`qmdBuildStatus`、
  `graphBuildStatus`、`graphQueryStatus` 全部成功才保留 completed：
  `scripts/graphrag/batch-epub-workflow.mjs:3646`。
- resume boost 文档定义同一完成门：
  `docs/operations/graphrag-epub-resume-boost.md:262`、
  `docs/operations/graphrag-epub-resume-boost.md:310`。

残余风险：未发现阻塞风险。

## C4. 旧完成状态降级

状态：PASS

依据：

- `loadCheckpoint` 在已存在 checkpoint 时先 hydrate，再调用
  `downgradeCompletedIfClosedLoopInvalid`：
  `scripts/graphrag/batch-epub-workflow.mjs:2193`。
- `--migrate-only` 路径使用同一降级函数，并在写回前重算 build status：
  `scripts/graphrag/batch-epub-workflow.mjs:2195`。
- 普通路径和 `--status-json` 路径也使用同一降级函数：
  `scripts/graphrag/batch-epub-workflow.mjs:2218`。
- `statusJson` 下 event 不写文件，typed JSON 写入函数只返回 parsed value，
  `updateManifest` 也不落盘：
  `scripts/graphrag/batch-epub-workflow.mjs:1822`、
  `scripts/graphrag/batch-epub-workflow.mjs:1915`、
  `scripts/graphrag/batch-epub-workflow.mjs:3907`。
- `main` 在 `--status-json` 下打印 summary 后退出，不执行 migrate 或正常工作；
  `--migrate-only` 不执行 EPUB/GraphRAG/provider/qmd CLI 外部工作：
  `scripts/graphrag/batch-epub-workflow.mjs:5332`、
  `scripts/graphrag/batch-epub-workflow.mjs:5338`。
- 降级后的缺失/不完整证据走 `continue_pending`，不会写成 retry exhaustion：
  `scripts/graphrag/batch-epub-workflow.mjs:3603`、
  `scripts/graphrag/batch-epub-workflow.mjs:3672`。
- focused regressions 覆盖 migrate-only 缺证据降级、GraphRAG query failed、
  incomplete checks、non-transient failed checks 和 stale producer lineage：
  `test/cli.test.ts:8677`、`test/cli.test.ts:9480`、
  `test/cli.test.ts:9774`、`test/cli.test.ts:10053`、
  `test/cli.test.ts:10140`。

残余风险：`--migrate-only` 会重写 manifest/checkpoint 和迁移事件日志，符合
“无外部工作”边界；不是完全只读模式。未发现阻塞风险。

## C5. checkpoint 身份保留

状态：PASS

依据：

- 新增 `checkpointIdentityFields`，优先保留 `checkpoint.sourceIdentityPath`、
  `checkpoint.sourceHash`、`checkpoint.normalizedPath` 和 `checkpoint.bookId`，仅在
  legacy 缺失时回退到 item/default：
  `scripts/graphrag/batch-checkpoint-hydration.mjs:39`。
- repair-only blocked、local artifact repair completed、普通 hydration 三条分支均
  使用同一 identity helper：
  `scripts/graphrag/batch-checkpoint-hydration.mjs:85`、
  `scripts/graphrag/batch-checkpoint-hydration.mjs:113`、
  `scripts/graphrag/batch-checkpoint-hydration.mjs:199`。
- `loadCheckpoint` 先 hydrate，再用 `evidenceItemForCheckpoint` 生成证据重算
  item，避免 hydrated checkpoint identity 被 catalog/default drift 覆盖：
  `scripts/graphrag/batch-epub-workflow.mjs:2131`、
  `scripts/graphrag/batch-epub-workflow.mjs:2167`、
  `scripts/graphrag/batch-epub-workflow.mjs:2193`。
- `evidenceItemForCheckpoint` 在重算 qmd/GraphRAG evidence 时优先使用
  checkpoint 的 `bookId` 和 `normalizedPath`：
  `scripts/graphrag/batch-epub-workflow.mjs:2167`。
- `--migrate-only`、`--status-json` 和普通路径在降级后都再用 checkpoint-derived
  evidence item 写入或投影 build status：
  `scripts/graphrag/batch-epub-workflow.mjs:2202`、
  `scripts/graphrag/batch-epub-workflow.mjs:2224`。
- 正例回归证明 catalog drift 到错误 `bookId` 时，persisted completed checkpoint
  仍按原 `bookId` 保持 completed：
  `test/cli.test.ts:9247`。
- 负例回归证明 persisted `bookId` 下 qmd manifest 缺失时，即使 drift book 下存在
  证据，也按 persisted identity 降级为 pending：
  `test/cli.test.ts:9333`。
- resume boost 文档记录本 open 审计项和收口规则：
  `docs/operations/graphrag-epub-resume-boost.md:71`。

残余风险：新增回归重点覆盖 `bookId` drift；未单独构造
`sourceIdentityPath/sourceHash` drift 的 focused test。当前实现保留 checkpoint 的
source identity 字段，且现有 itemId 由 source hash/path 派生，未发现会阻塞当前真实
EPUB 批次的 source identity 覆盖路径。

## C6. GraphRAG 书级产物隔离

状态：PASS

依据：

- GraphRAG output locator 固定为 `books/${bookId}/output`：
  `scripts/graphrag/batch-epub-workflow.mjs:2526`。
- GraphRAG build evidence 从 `books/<bookId>/checkpoints.yaml`、
  `books/<bookId>/artifacts.yaml` 和
  `books/<bookId>/output/qmd_output_manifest.json` 读取：
  `scripts/graphrag/batch-epub-workflow.mjs:3136`。
- artifact validation 拒绝 book mismatch、不可读路径和 vault 外 realpath：
  `scripts/graphrag/batch-epub-workflow.mjs:2821`。
- stage artifact path 必须位于 `books/<bookId>/output/`，embed lancedb 必须精确
  位于 `books/<bookId>/output/lancedb`：
  `scripts/graphrag/batch-epub-workflow.mjs:2933`、
  `scripts/graphrag/batch-epub-workflow.mjs:2994`。
- producer manifest `outputDir` 必须等于 book-scoped locator：
  `scripts/graphrag/batch-epub-workflow.mjs:3195`。
- runbook 明确 host absolute outputDir 和共享 output 不得通过：
  `docs/operations/graphrag-epub-batch-runbook.md:137`、
  `docs/operations/graphrag-epub-batch-runbook.md:258`。
- portable book-scoped GraphRAG evidence 回归覆盖：
  `test/cli.test.ts:8929`。

残余风险：未发现阻塞风险。

## C7. GraphRAG producer lineage 对齐

状态：PASS

依据：

- stage checkpoint 必须匹配 stage、status、book id、content hash、stage
  fingerprint、provider fingerprint 和 producer run id：
  `scripts/graphrag/batch-epub-workflow.mjs:3024`。
- artifact selection 校验 artifact producer run、stage fingerprint、provider
  fingerprint、corpus content hash 和 book-scoped path：
  `scripts/graphrag/batch-epub-workflow.mjs:2933`。
- producer manifest 必须提供 `stageProducerRunIds`，且与对应 stage checkpoint
  `runId` 一致：
  `scripts/graphrag/batch-epub-workflow.mjs:3197`。
- producer manifest 还校验 `bookId`、`sourceHash`、`documentId`、`contentHash`、
  `providerFingerprint`、`outputDir` 和 stage fingerprints：
  `scripts/graphrag/batch-epub-workflow.mjs:3211`。
- stale producer lineage 回归覆盖：
  `test/cli.test.ts:10140`。
- runbook 对 producer lineage 和 stage run id 一致性有同等要求：
  `docs/operations/graphrag-epub-batch-runbook.md:149`、
  `docs/operations/graphrag-epub-batch-runbook.md:153`。

残余风险：顶层 `qmd_output_manifest.json.producerRunId` 仍偏信息性，严格对齐集中在
`stageProducerRunIds`。该边界与 runbook 当前要求一致，未发现阻塞风险。

## C8. provider transient 恢复投影

状态：PASS

依据：

- transient provider/network failure 在 `recoverProviderTransientCheckpoint` 中保留
  same-run recovery：`status=pending`、`failureKind=transient`、
  `retryable=true`、`retryExhausted=false`、
  `recoveryDecision=retry_same_run_id`：
  `scripts/graphrag/batch-epub-workflow.mjs:3777`。
- recovery metadata 保留 `nextRetryAt`、`retryDelaySeconds`、wait count、
  max waits 和 reason：
  `scripts/graphrag/batch-epub-workflow.mjs:3792`、
  `scripts/graphrag/batch-epub-workflow.mjs:3817`。
- recovery summary 投影 provider wait count、max waits 和 reason：
  `scripts/graphrag/batch-epub-workflow.mjs:3947`。
- provider recovery wait limit 不把 item 写成 completed，仍保留 pending same-run
  recovery；对应事件路径存在：
  `scripts/graphrag/batch-epub-workflow.mjs:5185`。
- focused regressions 覆盖 exhausted transient、legacy transient 和 Jina
  transient recovery：
  `test/cli.test.ts:3394`、`test/cli.test.ts:3695`、
  `test/cli.test.ts:3815`。

残余风险：未运行测试确认当前环境结果。静态路径未发现阻塞风险。

## C9. 旧 provider auth 失败恢复

状态：PASS

依据：

- provider auth context 只投影 readiness、required names、presence、credential
  source、shadowing、dotenv presence 和 redacted/fingerprint fields：
  `scripts/graphrag/batch-epub-workflow.mjs:902`。
- readiness 同时阻断 missing required keys/endpoints、provider config unreadable
  和 shell env shadow：
  `scripts/graphrag/batch-epub-workflow.mjs:936`。
- reopen decision 要求 failed + stop_until_fixed + provider auth evidence，并检查
  readiness、current fingerprint、attempt limit、unchanged fingerprint 和已重开
  fingerprint：
  `scripts/graphrag/batch-epub-workflow.mjs:1031`。
- legacy missing failure fingerprint 只走有界 reopen，并标记
  `legacyProviderAuthFingerprintMissing`：
  `scripts/graphrag/batch-epub-workflow.mjs:1041`、
  `scripts/graphrag/batch-epub-workflow.mjs:1094`。
- summary projection 以当前 context 重算，不信任 stale reopen metadata：
  `scripts/graphrag/batch-epub-workflow.mjs:1106`。
- reopen 会重置为 pending、清空 command checks、要求重新进入正常闭环：
  `scripts/graphrag/batch-epub-workflow.mjs:1188`、
  `scripts/graphrag/batch-epub-workflow.mjs:1254`。
- redaction 覆盖 process env、dotenv parsed secret、Bearer、API key/base URL 和
  URL credentials：
  `scripts/graphrag/batch-epub-workflow.mjs:1649`、
  `scripts/graphrag/batch-epub-workflow.mjs:1787`。
- focused regressions 覆盖 shell env shadow、endpoint shadow、missing base URL、
  missing API key、unreadable config、attempt limit、same fingerprint、already
  reopened fingerprint 和 completed stale metadata：
  `test/cli.test.ts:6530`、`test/cli.test.ts:6609`、
  `test/cli.test.ts:6948`、`test/cli.test.ts:7026`、
  `test/cli.test.ts:7143`、`test/cli.test.ts:7211`、
  `test/cli.test.ts:7288`、`test/cli.test.ts:7361`、
  `test/cli.test.ts:7542`。
- resume boost 文档明确 `env -u`、shadow 阻断、missing key/base URL、fingerprint
  和 attempt limit 行为：
  `docs/operations/graphrag-epub-resume-boost.md:170`、
  `docs/operations/graphrag-epub-resume-boost.md:192`。

残余风险：未发现密钥值持久化路径；本复审未读取 `.env`。未发现阻塞风险。

## C10. 契约、文档和回归一致性

状态：PASS

依据：

- `BatchBuildStatusSchema` 包含 evidence locator、producer run id、book/source
  identity 和 normalized content hash 字段：
  `src/contracts/batch-run.ts:49`。
- checkpoint schema 要求 source identity、source hash、normalized path 和 book id：
  `src/contracts/batch-run.ts:82`。
- persisted checkpoint schema 要求 qmd/GraphRAG/query build statuses：
  `src/contracts/batch-run.ts:130`。
- recovery summary schema 包含 qmd、command、GraphRAG、query、provider transient、
  provider auth 和 recovery metadata 字段：
  `src/contracts/batch-run.ts:221`。
- workflow runtime schema 与契约字段保持同向扩展，包含 `commandCheckStatus` 和
  provider auth projection 字段：
  `scripts/graphrag/batch-epub-workflow.mjs:546`、
  `scripts/graphrag/batch-epub-workflow.mjs:601`。
- docs 更新为独立 qmd build manifest、独立 command check status、四门 completed
  条件和 status-json/migrate-only 行为：
  `docs/operations/graphrag-epub-batch-runbook.md:120`、
  `docs/operations/graphrag-epub-batch-runbook.md:343`、
  `docs/operations/graphrag-epub-batch-runbook.md:437`。
- resume boost 文档记录当前 open 审计目录、禁止新建 r6/r7、同一 runId 续跑、
  provider auth 投影和最终完成判定：
  `docs/operations/graphrag-epub-resume-boost.md:58`、
  `docs/operations/graphrag-epub-resume-boost.md:86`、
  `docs/operations/graphrag-epub-resume-boost.md:216`、
  `docs/operations/graphrag-epub-resume-boost.md:310`。
- resume commands 附录暴露 status-json、provider auth 识别、写入续跑和快速汇总命令：
  `docs/operations/graphrag-epub-resume-commands.md:3`、
  `docs/operations/graphrag-epub-resume-commands.md:22`、
  `docs/operations/graphrag-epub-resume-commands.md:41`、
  `docs/operations/graphrag-epub-resume-commands.md:69`。
- 新增 checkpoint identity 正反例回归与实现不变量一致：
  `test/cli.test.ts:9247`、`test/cli.test.ts:9333`。

残余风险：`docs/operations/graphrag-epub-resume-commands.md` 的快速汇总脚本读取
checkpoint 文件，不能完全等价替代 `--status-json` summary projection；其中
provider wait 观察字段更适合以 `--status-json` 为准。该问题不影响 r5 build gate
修复和真实 EPUB 处理闭环。

## 最终结论

PASS。
