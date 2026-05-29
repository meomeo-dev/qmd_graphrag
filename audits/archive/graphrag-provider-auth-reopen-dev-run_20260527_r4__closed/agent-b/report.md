# r4 开发审计报告 agent-b

## 结论

FAIL

实现已经覆盖 GraphRAG 产物隔离、remote running/orphan recovery、
provider-auth reopen 和状态投影的大部分关键路径，但未满足“每本书必须真实
qmd build succeeded 后才 completed”的硬门。当前 `qmdBuildStatus=succeeded`
由 25 个非 GraphRAG qmd command checks 推导，未看到独立的 qmd build 命令、
qmd build checkpoint、qmd build artifact 或可验证的 qmd build producer
evidence。因此最终结论为 FAIL。

## 1. 真实阶段成功门

状态：FAIL

证据：

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:4719)
  在 `runItem()` 中先执行 EPUB normalize、`runGraphResume()`、`runCliChecks()`，
  然后检查 `qmdBuildStatus`、`graphBuildStatus`、`graphQueryStatus`，三者均
  succeeded 后才写 `status: "completed"`。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:4726)
  `qmdBuildStatus` 来自 `qmdBuildEvidence({ commandChecks })`，不是单独的
  qmd build 执行证据。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3222)
  `qmdBuildEvidence()` 只筛选 `qmdNativeCommandCheckNames`，当这些检查全通过且
  数量匹配时返回 `status: "succeeded"`。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:186)
  固定命令集包括 `qmd-update`、`qmd-embed`、`qmd-query-json` 等，但没有
  `qmd-build` 或等价独立 build check。
- [bin/qmd](/Users/jin/projects/qmd_graphrag/bin/qmd:46) 只在发布包缺少
  `dist/cli/qmd.js` 时提示 “qmd is not built”，不是每书 qmd build 阶段证据。
- `rg -n "qmd build|build succeeded|qmd_build" src scripts test docs` 未发现
  每书 qmd build producer/checkpoint/artifact gate；只发现 `qmdBuildStatus`
  相关推导和文档表述。

测试证据：

- `npm run test:node -- test/cli.test.ts -t "keeps transient and permanent provider recovery decisions typed|provider auth|remote running|orphaned running|reopens completed|portable book-scoped GraphRAG producer evidence|keeps GraphRAG resume failures out of qmd build evidence|status-json projects stale remote running items|normal run recovers stale remote running items|status-json does not steal fresh remote running items|normal run does not steal fresh remote running items"`：
  28 passed。
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:3064)
  明确测试 “keeps GraphRAG resume failures out of qmd build evidence”，说明 qmd
  build evidence 是从 qmd command checks 侧投影，而不是 GraphRAG resume
  失败。

风险：

- 只要固定 qmd command checks 被测试替身或局部路径满足，`qmdBuildStatus`
  就可为 succeeded；这不能证明“真实 qmd build succeeded”。
- 文档和运行状态会把 command-check aggregate 称为 qmd build succeeded，可能
  误导 operator 对闭环完成质量的判断。

must-fix：

- 增加独立、可重算的 qmd build gate：要么执行真实 `qmd build`/等价构建命令，
  要么记录并验证 qmd corpus/index build checkpoint 与 build artifacts。
- `qmdBuildEvidence()` 不得仅由 command check 子集推导 succeeded；必须绑定
  qmd build producer/run/book/content hash 或明确改名为 command-check evidence，
  并新增单独 qmd build evidence。
- `completed` 写入前必须同时要求独立 qmd build evidence succeeded 与 27 个
  command checks 全 passed。

## 2. 命令检查完整门

状态：PASS

证据：

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:186)
  定义固定 `requiredCommandCheckNames`，共 27 项。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:4659)
  `validateCommandChecks()` 要求总数等于 `expectedCommandCheckCount`、唯一项等于
  expected count、无 missing、无 unexpected、无 failed，否则抛错。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:4680)
  `runCliChecks()` 顺序执行 27 个 qmd commands 并在返回前调用
  `validateCommandChecks(checks)`。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3318)
  `commandCheckSetEvidence()` 对 persisted completed item 重新计算 exact check
  set，失败或缺失会给 pending/failed evidence。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3398)
  `downgradeCompletedIfClosedLoopInvalid()` 对 completed item 重算 command check
  set、qmd build、GraphRAG build、GraphRAG query，任一不成功则 reopen 为 pending。

测试证据：

- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:1042)
  测试侧固定 27 个 required command check names。
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:9432)
  “status-json reopens completed items with incomplete command check set” 验证缺少
  `qmd-cleanup` 时 completed 被投影为 pending。
- 聚焦测试命令中该用例通过。

风险：

- command check 完整门本身通过，但它不能替代第 1 条独立 qmd build 门。

must-fix：

- 无。

## 3. 生产者与运行隔离

状态：PASS

证据：

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2440)
  `graphStageArtifactKinds` 定义每个 GraphRAG 阶段所需 artifact kinds；
  `graphProducerStages` 限定 `graph_extract`、`community_report`、`embed`。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2952)
  `validateGraphStageEvidence()` 要求 checkpoint stage/status/bookId/content
  hash/stage fingerprint/provider fingerprint/producer run id 全部匹配。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2861)
  `selectValidStageArtifacts()` 要求 artifact producerRunId、stageFingerprint、
  providerFingerprint、corpusContentHash 和 book-scoped path 匹配。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3064)
  `graphBuildEvidence()` 读取 checkpoint catalog、artifact catalog 和
  `qmd_output_manifest.json` 后按所有 completion stages 逐项验证。
- [src/job-state/graphrag-book.ts](/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1289)
  `writeGraphRagOutputProducerManifest()` 写入 bookId、sourceHash、documentId、
  contentHash、stageFingerprints、providerFingerprint、producerRunId 和
  stageProducerRunIds。

测试证据：

- `npm run test:node -- test/graphrag-book-state.test.ts -t "assertGraphRagStageArtifactsReady|stage report|producer|query_ready|book-scoped|content hash|row count|producer run"`：
  5 passed。
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:9777)
  “status-json reopens completed items with stale GraphRAG producer lineage” 构造
  wrong producer run 和 absolute outputDir，summary 将 item 投影为 pending。
- 聚焦 CLI 测试命令中该用例通过。

风险：

- `status-json` 只读投影发现 stale producer lineage 但不写 checkpoint；这是预期。
  operator 必须用正常写入 runner 完成 reopen。

must-fix：

- 无。

## 4. 内容哈希隔离

状态：PASS

证据：

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1975)
  item discovery 使用 source file sha256 生成 `sourceHash`。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2749)
  `validateArtifactContent()` 校验 artifact path、realpath、LanceDB、Parquet、
  JSON object 和 actual hash；hash mismatch 返回 `content_hash_mismatch`。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2991)
  checkpoint contentHash 必须等于 expected corpus content hash。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2915)
  GraphRAG/LanceDB artifact metadata `corpusContentHash` 必须等于 expected corpus
  content hash。
- [src/job-state/artifact-validation.ts](/Users/jin/projects/qmd_graphrag/src/job-state/artifact-validation.ts:402)
  shared validator 校验 artifact stage、vault-relative path、actual content hash、
  Parquet magic/footer/row count、JSON object 和 LanceDB completeness。

测试证据：

- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:8844)
  “status-json accepts portable book-scoped GraphRAG producer evidence” 先接受有效
  evidence，再清空 `documents.parquet`，summary 报
  `stage_artifact_invalid:content_hash_mismatch`。
- 聚焦 CLI 测试命令中该用例通过。

风险：

- qmd build 侧没有同等 producer/content hash evidence，风险已归入第 1 条。

must-fix：

- 无。

## 5. 书级路径隔离

状态：PASS

证据：

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1676)
  `ensureDirs()` 要求 `--log-root` 不在 graph vault 内，并校验 realpath。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2749)
  artifact realpath 必须位于 `stateRoot` 内。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2922)
  GraphRAG artifacts 要求 `books/<bookId>/output/`，LanceDB 要求
  `books/<bookId>/output/lancedb`。
- [src/job-state/artifact-validation.ts](/Users/jin/projects/qmd_graphrag/src/job-state/artifact-validation.ts:668)
  `isBookScopedGraphOutputArtifact()` 对 GraphRAG parquet/json 和 LanceDB 执行
  book-scoped path 检查。
- [scripts/graphrag/resume-book-workspace.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:532)
  `syncCurrentBook()` 使用 `graphRagBookInputDir()` 和 `graphRagBookOutputDir()`
  建立书级 scoped input/output。

测试证据：

- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:8844)
  portable book-scoped evidence 用例验证 vault-relative `books/<bookId>/output`
  可接受。
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:9777)
  stale producer lineage 用例使用 host absolute `outputDir`，summary 投影为 stale。
- 聚焦 CLI 测试命令中相关用例通过。

风险：

- 无新增风险。

must-fix：

- 无。

## 6. query_ready 可追溯性

状态：PASS

证据：

- [scripts/graphrag/resume-book-workspace.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:199)
  `queryReadyProducerArtifacts()` 要求 `graph_extract`、`community_report`、`embed`
  checkpoint 均 succeeded 且具有 runId。
- [scripts/graphrag/resume-book-workspace.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:234)
  调用 `assertGraphRagStageArtifactsReady()`，传入 expected producer run ids、
  stage fingerprints、provider fingerprint 和 corpus content hash。
- [src/job-state/graphrag-book.ts](/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1492)
  `assertQueryReadyProducerArtifacts()` 对 query_ready producer artifacts 逐阶段
  验证 completed GraphRAG producer run id、fingerprint 和 artifact set。
- [src/job-state/graphrag-book.ts](/Users/jin/projects/qmd_graphrag/src/job-state/graphrag-book.ts:1551)
  query_ready readiness 要求 `graph_extract`、`community_report`、`embed` 的 run ids、
  fingerprints、provider fingerprint 和 corpus content hash。
- [scripts/graphrag/resume-book-workspace.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/resume-book-workspace.mjs:1165)
  query_ready 阶段只完成 readiness checkpoint，不重跑 producer stages。

测试证据：

- `test/graphrag-book-state.test.ts` 聚焦命令中
  “publishes query-ready from book-scoped validated artifacts” 通过。
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:9150)
  completed item 如果 GraphRAG query check failed，status-json 将其 reopen 为
  pending，`graphQueryStatus.status=failed`。
- 聚焦 CLI 测试命令中该用例通过。

风险：

- projection repair 逻辑较复杂，但已通过 source checks 和测试覆盖主要边界。

must-fix：

- 无。

## 7. 远程运行与孤儿恢复

状态：PASS

证据：

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1536)
  `runningCheckpointIsOrphaned()` 将缺少 ownership、heartbeat 过期、same-host dead
  PID 判为 orphan；fresh remote heartbeat 返回 false。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3471)
  `recoverOrphanedRunningCheckpoint()` 将 orphan running 降级为 pending、
  `failureKind=transient`、`retryable=true`、`recoveryDecision=retry_same_run_id`。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:5316)
  对仍 running 的 checkpoint 仅发 `item_running_observed` 并 continue。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:5341)
  `activeRunningBookCheckpoint()` 防止同一 book 下另一个 active running item 被抢占。

测试证据：

- 聚焦 CLI 测试命令中以下用例通过：`status-json recovers orphaned running item to
  retryable pending`、`status-json does not steal fresh remote running items`、
  `status-json projects stale remote running items as retryable pending`、
  `normal run does not steal fresh remote running items`、`normal run recovers stale
  remote running items before processing`。

风险：

- remote process liveness 只能通过 heartbeat TTL 判断，无法跨 host 直接验证；这是
  当前设计取舍。

must-fix：

- 无。

## 8. 错误分类与重试预算

状态：PASS

证据：

- [scripts/graphrag/batch-failure-classifier.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:1)
  `classifyFailure()` 将 429/5xx 分类为 transient，将其他 4xx 分类为 permanent，
  并提取 retry-after。
- [scripts/graphrag/batch-failure-classifier.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-failure-classifier.mjs:61)
  transient 文本覆盖 rate limit、timeout、OpenAI stream、LiteLLM/Jina connection、
  DNS/TLS/connect/reset 等。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:686)
  `transientBudgetAvailable()` 使用 `retryStartedAt` 与 `retryBudgetSeconds` 控制
  transient retry budget。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:701)
  provider recovery wait count 受 `maxProviderRecoveryWaits` 约束。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:781)
  401/403 或 auth 文本识别为 unrecoverable provider auth failure。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1005)
  `providerAuthReopenDecision()` 要求 failed、retryable false、stop_until_fixed、
  auth failure，并检查 readiness、fingerprint change、attempt limit 和 already
  reopened fingerprints。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:5500)
  runtime provider auth refailure 记录 auth metadata，并保持 stop_until-fixed。

测试证据：

- 聚焦 CLI 测试命令中 provider auth、failure classifier、retry budget 相关用例
  通过，包括 `keeps transient and permanent provider recovery decisions typed`、
  `unrecoverable provider auth failure stops before next book`、`provider auth repair
  reopens legacy checkpoint once and reruns closed loop`、shadowing/missing key/limit/
  unchanged/already reopened/refailure 等。
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:2172)
  分类测试覆盖 400、409、429、5xx、timeout、Jina connection、Responses transient、
  local artifact gate mixed provider transient 等。
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:6228)
  provider auth reopen 测试验证 legacy auth failure 修复后重跑完整闭环，并断言序列化
  状态不包含测试 credential values。

风险：

- provider auth fingerprint 是 12/24 hex 短 fingerprint，适合观测，不应作为安全
  边界。

must-fix：

- 无。

## 9. 状态投影不可误导

状态：PASS

证据：

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2141)
  `loadCheckpoint()` 在 status-json 下返回 parsed snapshot，不写 checkpoint；非
  status-json 才 write typed json。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:2169)
  非 migrateOnly 路径会依次执行 completed downgrade、orphan recovery、transient
  recovery，再在 status-json 中只返回 projected snapshot。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3398)
  completed item 的闭环状态由 recomputed evidence 决定，失败则投影为 pending。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:3690)
  recovery summary 每次重新计算 qmd/GraphRAG build/query status，并只展示
  provider recovery/auth projection。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:5052)
  `main()` 在 `statusJson` 为 true 时 `printStatusAndExit()` 后立即 return。

测试证据：

- 聚焦 CLI 测试命令中 completed reopen、provider auth stale projection、remote
  running projection 相关用例通过。
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:9977)
  stale GraphRAG producer lineage 用例断言 status-json 输出 pending/stale，但原
  checkpoint 仍为 completed 且不创建 event log，证明只读投影。
- [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:7461)
  stale provider auth reopen metadata 不会在 completed item 上误投影。

风险：

- 第 1 条 qmd build gate 命名误导仍会影响投影语义：summary 显示
  `qmdBuildStatus=succeeded` 时实际只是 qmd native command check set succeeded。

must-fix：

- 修复第 1 条后，同步调整 status-json/recovery summary 的 qmd build 投影字段语义
  或 evidence 来源。

## 10. 秘密最小披露

状态：PASS

证据：

- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1592)
  URL credential key pattern 覆盖 api key、token、authorization、secret、
  password 等。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1608)
  `redacted()` 对 exact env values、absolute paths、Bearer、OPENAI/JINA env
  assignments、`sk-...` 进行 redaction。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1623)
  `redactLog()` 写命令 stdout/stderr 前执行 redaction。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:1761)
  `.env` 解析后只注册 exact redactions；provider auth projection 只输出 presence、
  source、fingerprint、readiness，不输出 secret value。
- [scripts/graphrag/batch-epub-workflow.mjs](/Users/jin/projects/qmd_graphrag/scripts/graphrag/batch-epub-workflow.mjs:876)
  `providerAuthContext()` 使用 keyPresence、credentialSources、fingerprints、
  missing/shadowed names 表达 auth 状态。
- 本次审计未读取、打印、摘要真实 `.env` secret 值。

测试证据：

- 聚焦 CLI 测试命令中 provider auth reopen 用例通过，并在
  [test/cli.test.ts](/Users/jin/projects/qmd_graphrag/test/cli.test.ts:6444)
  断言序列化 checkpoint/events/summary 不包含测试 API key 字符串。

风险：

- 测试 fixture 中使用了非真实示例 key 字符串；产品路径使用 fingerprint/redacted
  语义，未发现真实 secret 输出。

must-fix：

- 无。

## must-fix 汇总

1. 增加独立、真实、可重算的 qmd build succeeded 证据，不能只由 25 个 qmd native
   command checks 推导。
2. 将 `completed` 准入改为同时要求独立 qmd build evidence succeeded、
   GraphRAG build evidence succeeded、GraphRAG query evidence succeeded、以及 27 个
   command checks 全通过。
3. 调整 `qmdBuildStatus` 字段语义或来源：若继续保留该字段，其 `succeeded` 必须
   绑定 qmd build producer/run/book/content hash；否则应新增明确字段承载 command
   check aggregate，避免状态投影误导。
