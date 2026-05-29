# r5 checkpoint identity 修复后复审结果

## 范围

本次复审使用原固定基准
`audit/graphrag-qmd-build-gate-dev-run_20260527_r5__open/agent-a/audit_criteria.md`。
审计对象限定为：

- `scripts/graphrag/batch-checkpoint-hydration.mjs`
- `scripts/graphrag/batch-epub-workflow.mjs`
- `src/contracts/batch-run.ts`
- `test/cli.test.ts`
- `docs/operations/graphrag-epub-batch-runbook.md`
- `docs/operations/graphrag-epub-resume-boost.md`
- `docs/operations/graphrag-epub-resume-commands.md`

未读取或输出 `.env` secret 值。未修改实现代码或测试代码。

## C1 完成状态闭环原则

状态：PASS。

依据：

- `scripts/graphrag/batch-epub-workflow.mjs:3646` 到 `3657` 的
  `downgradeCompletedIfClosedLoopInvalid` 仅在 `commandCheckStatus`、
  `qmdBuildStatus`、`graphBuildStatus` 和 `graphQueryStatus` 全部为
  `succeeded` 时保留 `completed`。
- `scripts/graphrag/batch-epub-workflow.mjs:4969` 到 `5052` 的正常完成路径
  先执行 EPUB normalize、GraphRAG resume、27 个 CLI checks、qmd build
  manifest 写入，再校验 qmd build、GraphRAG build 和 GraphRAG query，最后才
  写入 `completed`。
- `test/cli.test.ts:9480` 到 `9772` 覆盖 GraphRAG query failed 时旧
  `completed` 降级为 `pending`，并保留 `retry_same_run_id`。
- `test/cli.test.ts:9774` 到 `10051` 覆盖 command check 缺项时旧
  `completed` 降级为 `pending`。
- `docs/operations/graphrag-epub-batch-runbook.md:437` 到 `443` 明确
  completed 必须同时具备四类成功证据。

残余风险：未来新增 command check 或 GraphRAG stage 时，需要同步固定集合、
manifest fingerprint、fixture 和文档。当前未发现旧 checkpoint 字段绕过完成门。

## C2 独立 qmd build 证据原则

状态：PASS。

依据：

- `scripts/graphrag/batch-epub-workflow.mjs:304` 到 `325` 定义独立
  `QmdBuildManifestSchema`，包含 runId、itemId、bookId、source hash、
  normalized hash、qmd index hash、config hash、command check names 和
  fingerprint。
- `scripts/graphrag/batch-epub-workflow.mjs:2530` 到 `2535` 将 qmd build
  evidence 固定定位到 `books/<bookId>/qmd/qmd_build_manifest.json`。
- `scripts/graphrag/batch-epub-workflow.mjs:3431` 到 `3518` 的
  `qmdBuildEvidence` 从当前书的 manifest 重新计算状态，并校验 identity、
  locator、content hash、index、config 和 command check fingerprint。
- `scripts/graphrag/batch-epub-workflow.mjs:2241` 到 `2247` 在 checkpoint
  持久化或投影时重新计算 `qmdBuildStatus`，不信任历史字段。
- `test/cli.test.ts:3133` 到 `3274` 覆盖 GraphRAG resume failure 不会混入
  qmd build evidence。
- `docs/operations/graphrag-epub-batch-runbook.md:120` 到 `123` 明确
  `qmdBuildStatus` 来自独立 qmd build manifest。

残余风险：`scripts/graphrag/batch-epub-workflow.mjs:3294` 到 `3343` 仍保留
未调用的 `qmdCommandCheckEvidence` 旧辅助函数。当前未参与 `qmdBuildStatus`，
不构成阻断。

## C3 固定 command check 集合原则

状态：PASS。

依据：

- `scripts/graphrag/batch-epub-workflow.mjs:186` 到 `222` 固定 27 个
  `requiredCommandCheckNames`，并以数组长度定义 `expectedCommandCheckCount`。
- `scripts/graphrag/batch-epub-workflow.mjs:3566` 到 `3600` 的
  `commandCheckSetEvidence` 校验数量、名称唯一性、缺失项、未知项和失败项。
- `scripts/graphrag/batch-epub-workflow.mjs:4909` 到 `4928` 的
  `validateCommandChecks` 在正常运行完成前强校验同一固定集合。
- `test/cli.test.ts:9774` 到 `10051` 覆盖缺少 `qmd-cleanup` 时
  `commandCheckStatus.status=pending`，旧 `completed` 被投影为 `pending`。
- `docs/operations/graphrag-epub-resume-commands.md:89` 到 `113` 的快速汇总
  使用同一 27 项集合计算 `commandCheckStatus`。

残余风险：测试 helper 和文档中存在固定集合镜像，后续修改集合时必须同步。
当前未发现缺失、重复、未知名称或失败项可通过完成门。

## C4 GraphRAG producer lineage 原则

状态：PASS。

依据：

- `scripts/graphrag/batch-epub-workflow.mjs:397` 到 `408` 定义
  `GraphRagOutputProducerManifestSchema`，包含 bookId、sourceHash、
  documentId、contentHash、stageFingerprints、providerFingerprint、
  `outputDir`、producerRunId 和 `stageProducerRunIds`。
- `scripts/graphrag/batch-epub-workflow.mjs:3024` 到 `3133` 的
  `validateGraphStageEvidence` 校验 stage checkpoint、bookId、content hash、
  stage fingerprint、provider fingerprint、producer runId 和 artifact 内容。
- `scripts/graphrag/batch-epub-workflow.mjs:3136` 到 `3250` 的
  `graphBuildEvidence` 要求 `graph_extract`、`community_report`、`embed` 和
  `query_ready` 全部具备当前书的 succeeded evidence，并校验 producer
  manifest identity、outputDir、stage runId 和 fingerprint。
- `test/cli.test.ts:10140` 到 `10425` 覆盖 stale producer lineage，断言
  `stage_artifact_producer_run_mismatch:community_report` 导致 status-json 投影
  为 `pending`，原 checkpoint 保持只读未改写。
- `docs/operations/graphrag-epub-batch-runbook.md:137` 到 `158` 记录
  GraphRAG build succeeded 的 producer lineage 条件。

残余风险：producer manifest 生成端未来若改字段，需要同步 evidence 读取端和测试。
当前未发现 stale lineage 可支持 `completed`。

## C5 book-scoped artifact 隔离原则

状态：PASS。

依据：

- `scripts/graphrag/batch-epub-workflow.mjs:2526` 到 `2527` 定义合法
  GraphRAG output locator 为 `books/<bookId>/output`。
- `scripts/graphrag/batch-epub-workflow.mjs:2821` 到 `2870` 的
  `validateArtifactContent` 校验 artifact bookId、realpath、hash、Parquet 和
  LanceDB 内容。
- `scripts/graphrag/batch-epub-workflow.mjs:2994` 到 `2999` 要求 artifact 路径
  位于当前书 `books/<bookId>/output/`，embed 精确为
  `books/<bookId>/output/lancedb`。
- `scripts/graphrag/batch-epub-workflow.mjs:3211` 到 `3239` 要求 producer
  manifest 的 `outputDir` 等于 `books/<bookId>/output`。
- `scripts/graphrag/batch-epub-workflow.mjs:3253` 到 `3281` 的迁移只在历史
  absolute `outputDir` 解析到当前书 book-scoped output 时重写为 portable
  locator。
- `test/cli.test.ts:2878` 到 `3000` 覆盖 migrate-only 将合法历史 absolute
  outputDir 重写为 `books/<bookId>/output`。

残余风险：未见共享 output、跨书 artifact、host absolute `outputDir` 或 realpath
越界可发布 graph capability 或支持 `completed`。

## C6 旧 completed 重开原则

状态：PASS。

依据：

- `scripts/graphrag/batch-checkpoint-hydration.mjs:39` 到 `47` 的
  `checkpointIdentityFields` 对 `sourceIdentityPath`、`sourceHash`、
  `normalizedPath` 和 `bookId` 均优先使用 persisted checkpoint 值。
- `scripts/graphrag/batch-checkpoint-hydration.mjs:85` 到 `107`、
  `113` 到 `133`、`199` 到 `238` 的三个 hydration 返回分支均展开
  `checkpointIdentityFields`，不再用 catalog/default bookId 覆盖 persisted
  identity。
- `scripts/graphrag/batch-epub-workflow.mjs:2167` 到 `2175` 的
  `evidenceItemForCheckpoint` 在重算证据前用 checkpoint `bookId` 和
  `normalizedPath` 构造 evidence item。
- `scripts/graphrag/batch-epub-workflow.mjs:2177` 到 `2238` 的
  `loadCheckpoint` 在 `--migrate-only`、`--status-json` 和普通加载路径都先
  hydrate，再用 checkpoint identity 执行 completed downgrade。
- `scripts/graphrag/batch-epub-workflow.mjs:3646` 到 `3716` 对 stale 或
  invalid completed 降级为 `pending`，清除 `completedAt`，保留四类证据投影和
  recovery decision。
- `test/cli.test.ts:9247` 到 `9331` 覆盖 catalog bookId drift 时 status-json
  仍使用 persisted checkpoint bookId，保持 `completed`。
- `test/cli.test.ts:9333` 到 `9478` 覆盖 persisted checkpoint bookId 下缺少
  qmd build manifest 时，即使 drift bookId 有证据，也按 persisted identity 重开
  为 `pending`。
- `test/cli.test.ts:8677` 到 `8810` 覆盖 migrate-only 将缺少真实闭环证据的旧
  `completed` 降级为 `pending`。

残余风险：普通写入续跑在真正重新处理 pending item 时仍以当前 source discovery
驱动实际工作；这不会让旧 completed 通过证据门，但未来若要严格锁定重跑 identity，
应增加 normal-run catalog drift 回归。当前阻塞项已修复。

## C7 migrate-only 审计迁移原则

状态：PASS。

依据：

- `scripts/graphrag/batch-epub-workflow.mjs:2195` 到 `2216` 的 migrate-only
  load path 对 checkpoint 执行 completed downgrade 和 build status snapshot 后
  才持久化。
- `scripts/graphrag/batch-epub-workflow.mjs:5338` 到 `5358` 的 main 分支只执行
  event log 迁移、raw log 迁移、book-scoped raw report 断言、summary 和迁移
  event，然后返回，不进入 `runItem`。
- `scripts/graphrag/batch-epub-workflow.mjs:4969` 到 `4976` 显示 EPUB
  normalize、GraphRAG resume、CLI checks 和 qmd build manifest 写入只存在于
  `runItem`，migrate-only 分支不会调用。
- `test/cli.test.ts:8677` 到 `8810` 验证 migrate-only 重开缺证据 completed，
  manifest completedItems 从 1 降为 0。
- `docs/operations/graphrag-epub-batch-runbook.md:321` 到 `323` 明确
  `--migrate-only` 不执行 EPUB、GraphRAG、OpenAI Responses、Jina 或 qmd CLI
  子命令。

残余风险：migrate-only 会写 schema/manifest/checkpoint/event/summary 迁移结果，
这是该模式的定义内行为。未见外部 provider 或真实 EPUB 处理被触发。

## C8 status-json 只读投影原则

状态：PASS。

依据：

- `scripts/graphrag/batch-epub-workflow.mjs:1702` 到 `1727` 的 status-json
  `ensureDirs` 分支只校验 state root 和 log-root 边界，不创建目录。
- `scripts/graphrag/batch-epub-workflow.mjs:1836` 的 `event` 在 status-json 下
  直接返回，不写 event log。
- `scripts/graphrag/batch-epub-workflow.mjs:1905` 到 `1911` 的
  `lockedReadWriteTypedJson` 在 status-json 下只执行 callback，不落盘。
- `scripts/graphrag/batch-epub-workflow.mjs:1915` 到 `1921` 的 `writeTypedJson`
  在 status-json 下只返回 parsed value，不写文件。
- `scripts/graphrag/batch-epub-workflow.mjs:3907` 到 `3911` 的 `updateManifest`
  只在非 status-json 下写 manifest 和 recovery summary。
- `scripts/graphrag/batch-epub-workflow.mjs:5332` 到 `5336` 在 status-json 下不
  迁移 producer manifest，打印 summary 后返回。
- `test/cli.test.ts:3003` 到 `3131` 覆盖 status-json 不改 checkpoint、不写
  recovery-summary。
- `test/cli.test.ts:10140` 到 `10425` 覆盖 status-json 对 stale producer
  completed 只投影 pending，不改原 checkpoint、不写 event log。

残余风险：未见 status-json 进入 `runItem` 或外部命令路径。当前只读投影满足基准。

## C9 provider auth 恢复安全原则

状态：PASS。

依据：

- `scripts/graphrag/batch-epub-workflow.mjs:902` 到 `971` 的
  `providerAuthContext` 只输出 readiness、present/missing、source、
  fingerprint 和 dotenv present 状态。
- `scripts/graphrag/batch-epub-workflow.mjs:1031` 到 `1104` 的
  `providerAuthReopenDecision` 要求 checkpoint 为 failed、non-retryable、
  `stop_until_fixed`、provider auth failure、当前 context ready、fingerprint 已
  变化、未超重开上限、当前 fingerprint 未被重复使用。
- `scripts/graphrag/batch-epub-workflow.mjs:1188` 到 `1276` 的
  `reopenProviderAuthCheckpoint` 只把 item 改回 `pending` 和 `continue_pending`，
  清空 commandChecks，设置 `normalCommandChecksRequired=true`，不写 completed。
- `scripts/graphrag/batch-epub-workflow.mjs:1756` 到 `1805` 解析 dotenv 后仅将
  secret exact value 加入内存脱敏集合；输出使用 redaction/fingerprint。
- `src/contracts/batch-run.ts:276` 到 `302` 的 recovery summary 契约包含
  provider auth decision、readiness、presence、source、fingerprint 和 attempt
  count 字段，不包含 secret value 字段。
- `test/cli.test.ts:6948` 到 `7093` 覆盖缺 OpenAI base URL/API key 阻断。
- `test/cli.test.ts:7211` 到 `7428` 覆盖 attempt limit、当前 fingerprint 已重开
  和 fingerprint 未变化阻断。
- `test/cli.test.ts:7542` 到 `7618` 覆盖 completed item 不投影 stale provider
  auth reopen state。
- `docs/operations/graphrag-epub-resume-boost.md:192` 到 `249` 记录 provider auth
  恢复边界和不保存 `.env` 值的约束。

残余风险：未见密钥值泄露路径。provider auth reopen 仍依赖当前 provider config
解析成功；配置不可读时 fail-closed，符合基准。

## C10 恢复语义保持原则

状态：PASS。

依据：

- `scripts/graphrag/batch-epub-workflow.mjs:3603` 到 `3643` 的
  `reopenRecoveryFromStatus` 对 transient failed command check 保留
  `retry_same_run_id`、`retryable=true`、`retryExhausted=false`、`nextRetryAt` 和
  `retryDelaySeconds`。
- `scripts/graphrag/batch-epub-workflow.mjs:3777` 到 `3850` 的
  `recoverProviderTransientCheckpoint` 将 transient failed/pending checkpoint 投影为
  pending，并保留 bounded provider recovery wait。
- `scripts/graphrag/batch-epub-workflow.mjs:3881` 到 `3900` 的 `updateManifest`
  在 provider recovery wait limit reached 时把批次置为 `incomplete`，item 保持
  pending 和 `retry_same_run_id`。
- `scripts/graphrag/batch-epub-workflow.mjs:5679` 到 `5755` 保持 provider/network
  transient failure 的 pending、`retry_same_run_id` 和 next retry projection。
- `test/cli.test.ts:9480` 到 `9772` 覆盖旧 completed 的 GraphRAG query
  transient failure 被重开为 pending，且 recoveryDecision 为 `retry_same_run_id`。
- `docs/operations/graphrag-epub-batch-runbook.md:242` 到 `256` 记录 bounded wait
  后同一 runId 恢复。

残余风险：未见 transient provider/network failure 被误标 completed 或终止态。
缺失本地证据和非 transient command check 均不会阻断补跑为永久终态。

## 验证

通过以下定向测试：

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=verbose \
  --testTimeout 60000 test/cli.test.ts \
  -t "checkpoint book identity|persisted invalid book identity|GraphRAG query check failed|incomplete command check set|stale GraphRAG producer lineage|without real closed-loop evidence"
```

结果：1 个测试文件通过，6 个目标用例通过，200 个用例因过滤跳过。

```bash
CI=true node ./node_modules/vitest/vitest.mjs run --reporter=dot \
  --testTimeout 60000 test/cli.test.ts \
  -t "provider auth status-json blocks missing OpenAI base URL|provider auth status-json blocks missing OpenAI API key|provider auth reopen respects attempt limit without count downgrade|provider auth status-json blocks already reopened current fingerprint|provider auth status-json blocks unchanged current fingerprint|status-json does not project stale provider auth reopen state on completed item"
```

结果：1 个测试文件通过，6 个目标用例通过，200 个用例因过滤跳过。

## 最终结论

PASS
